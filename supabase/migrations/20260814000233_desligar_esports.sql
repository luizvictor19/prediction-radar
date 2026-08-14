-- Desligar a coleta de esports. CS2, LoL e Dota saem.
--
-- ---------------------------------------------------------------------------
-- O que esta migration desliga, e o que ela NÃO toca
-- ---------------------------------------------------------------------------
--
-- Desliga: descoberta, watchlist, resolver, propagação de desfecho e enricher —
-- os cinco componentes que só existem por causa de esports e que, sem coleta,
-- ficariam rodando à toa contra o Postgres e a Gamma.
--
-- NÃO apaga nada. `esports_snapshots` continua inteira, `esports_matches`,
-- `market_match_links`, `context_fragments` e os `events` de esports continuam
-- onde estão. A retenção deles continua exatamente como está — inclusive o
-- `esports_snapshot_retention_days = 365`, que é o que segura a série já
-- coletada, e o job de partições, que continua criando e dropando partição no
-- ritmo dele.
--
-- A tese de esports morreu; o dado dela custou meses e não custa nada guardar.
-- São 14,1 milhões de linhas em `esports_snapshots` — a única série longa e
-- densa que este projeto tem, e a única capaz de responder perguntas que ainda
-- não foram feitas.
--
-- ---------------------------------------------------------------------------
-- 1. A chave que desliga descoberta e watchlist ao mesmo tempo
-- ---------------------------------------------------------------------------
--
-- Os dois leem `discovery_slug_prefixes` e saem na primeira linha quando a lista
-- está vazia — é o contrato de desligamento que já existe, e é por isso que não
-- há flag nova aqui. Esvaziar a lista para os dois de uma vez.
--
-- `collect_only_prefixes` vai junto porque ela é a DECLARAÇÃO de "estes
-- prefixos são coletados de propósito sem vertical habilitada". Sem coleta, a
-- declaração deixa de descrever qualquer coisa; deixá-la povoada manteria o
-- resolver silenciando um aviso sobre prefixo que ninguém mais coleta.

update public.system_config
   set discovery_slug_prefixes = '{}',
       collect_only_prefixes = '{}'
 where id = 1;

-- ---------------------------------------------------------------------------
-- A armadilha que este UPDATE quase arma, e por que ele é seguro
-- ---------------------------------------------------------------------------
--
-- `esports_slug_patterns()` (20260806032316) lê `discovery_slug_prefixes` para
-- decidir QUAIS SNAPSHOTS A RETENÇÃO NÃO PODE APAGAR. Uma lista vazia poderia
-- significar "nada é esports, pode apagar tudo" — e o ramo `finalized` da
-- retenção apaga sem olhar idade.
--
-- Não significa, e isso está escrito na própria função:
--
--     IF patterns IS NULL OR array_length(patterns, 1) IS NULL THEN
--       RETURN fallback;   -- array['cs2-%', 'lol-%', 'dota2-%']
--
-- `array_agg` sobre zero linhas devolve NULL, cai no fallback embutido, e a
-- proteção continua valendo para os três prefixos. Foi escrito assim de
-- propósito ("nunca devolve lista vazia, porque lista vazia autorizaria a
-- retenção a apagar tudo"), e é o motivo de este UPDATE não vir acompanhado de
-- nenhum cuidado extra com a retenção.
--
-- Confirmar depois do apply, ANTES de dormir tranquilo:
--
--   select public.esports_slug_patterns();
--   -- espera {cs2-%,lol-%,dota2-%}, e NÃO {}
--
-- ---------------------------------------------------------------------------
-- 2. Os três jobs que têm flag própria
-- ---------------------------------------------------------------------------
--
-- `esports_resolver_enabled` desliga TRÊS crons, não um: o resolver dos 10 min,
-- o recompute semanal de domingo e a propagação de desfecho dos 10 min
-- (`esports-match-outcome.ts` lê a mesma flag, de propósito — "uma flag própria
-- custaria mais do que resolve").
--
-- `esports_enricher_enabled` desliga o enricher dos 5 min, e com ele os dois
-- enrichers de fonte externa (Liquipedia e OddsPapi), que já estão em `false`.
--
-- O analista já está desligado desde a 20260813210118. Fica assim.

update public.system_config
   set esports_resolver_enabled = false,
       esports_enricher_enabled = false
 where id = 1;

-- ---------------------------------------------------------------------------
-- 3. O alerta de coletor parado precisa parar de vigiar quem foi desligado
-- ---------------------------------------------------------------------------
--
-- Sem isto, o monitor avisaria para sempre que a descoberta e a watchlist estão
-- paradas — o que é verdade e é o estado pretendido. Alerta que dispara por
-- estado esperado não informa nada; pior, treina o leitor a ignorar a linha, e
-- junto com ela some a capacidade de notar o dia em que o silêncio NÃO era
-- esperado.
--
-- `0` é o desligamento documentado da vigilância por componente. Os outros dois
-- limiares ficam: `resolved_detector` e `open_legs_collector` continuam rodando,
-- e o `radar_collector` entra vigiado pela migration do coletor.

update public.system_config
   set health_stale_discovery_minutes = 0,
       health_stale_watchlist_minutes = 0
 where id = 1;

-- ---------------------------------------------------------------------------
-- Como confirmar que desligou (e não que quebrou)
-- ---------------------------------------------------------------------------
--
--   -- 1. a config está como se espera
--   select discovery_slug_prefixes, collect_only_prefixes,
--          esports_resolver_enabled, esports_enricher_enabled,
--          health_stale_discovery_minutes, health_stale_watchlist_minutes
--     from public.system_config where id = 1;
--
--   -- 2. a proteção da série antiga NÃO foi junto
--   select public.esports_slug_patterns();   -- {cs2-%,lol-%,dota2-%}
--
--   -- 3. em até 5 min, cada componente registra que está desligado. Uma linha
--   --    a cada 6h por componente (logDisabled), não uma por tick.
--   select component, status, message, created_at
--     from public.system_logs
--    where component in ('discovery_collector','watchlist_collector',
--                        'esports_resolver','esports_match_outcome','esports_enricher')
--      and created_at > now() - interval '15 minutes'
--    order by created_at desc;
--   -- espera: "disabled: discovery_slug_prefixes is empty" e equivalentes
--
--   -- 4. e o batimento continua fresco — desligado por config BATE. Se estas
--   --    linhas pararem de avançar, o processo caiu; não é o desligamento.
--   select component, last_cycle_at, last_status, last_detail
--     from public.collector_heartbeats order by component;
--
--   -- 5. a série antiga continua lá (14,1 M de linhas na última medição)
--   select count(*) from public.esports_snapshots;
--
--   -- 6. e nenhuma linha nova entra depois do apply
--   select max(captured_at) from public.esports_snapshots;
--   -- roda de novo em 10 min: o valor não pode ter mudado
--
-- ---------------------------------------------------------------------------
-- O que fica rodando de propósito
-- ---------------------------------------------------------------------------
--
--   `esports_partitions`  cria e dropa partição de `esports_snapshots`. Sem ele,
--                         a poda por idade para de acontecer e a tabela vira
--                         imutável — o oposto de "não mexer na retenção".
--   `retention_job`       continua podando `polymarket_snapshots` e
--                         `system_logs`, e continua pulando esports e radar.
--   `resolved_detector`   é genérico: resolve qualquer mercado, e o radar
--                         depende dele para saber o desfecho.
--   `open_legs_collector` idem, é sobre posições e não sobre esports.
--
-- Nada aqui derruba código: os componentes desligados continuam no deploy,
-- saindo na primeira linha. Religar é o UPDATE inverso, e o custo de manter o
-- código parado é zero.
