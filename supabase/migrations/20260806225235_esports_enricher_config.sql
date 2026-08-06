-- Spec 001, item 5 — config do job de enriquecimento.
--
-- Cinco colunas em `system_config`. Nenhuma tabela nova, nenhum dado migrado.
-- É a migration que dá ao dono os botões do `esports_enricher`, o job que chama
-- `runEnrichers` para as partidas próximas e escreve em `context_fragments`.
--
-- ---------------------------------------------------------------------------
-- O que ligar isto faz com o volume — que é a pergunta que decide os defaults
-- ---------------------------------------------------------------------------
--
-- A migration 20260806211531 deixou `context_fragments` SEM particionamento, e
-- a decisão foi tomada sobre uma estimativa de 0,4 a 1,8 GB/ano. Esses números
-- pressupunham uma cadência que, até agora, não existia em lugar nenhum: não
-- havia job. É aqui que ela passa a existir, então é aqui que ela precisa bater
-- com aquela conta.
--
-- Com os defaults abaixo:
--
--   janela             1440 + 360 = 1800 min = 30h por partida
--   intervalo mínimo   30 min  ->  até 60 rodadas por partida
--   fragmentos/rodada  ~2-3 (`odds` + `liquidity`, mais `series_consistency`
--                      quando o best_of se resolve; `polymarket-context` quase
--                      sempre suprimido, porque o texto não mudou)
--
--   ~120-180 fragmentos por partida  x  ~14 partidas/dia  ->  ~2.000 linhas/dia
--   ->  ~730k linhas/ano  ->  ~1,1 GB/ano
--
-- Dentro da faixa que sustentou a decisão de não particionar. **O parâmetro que
-- pode derrubá-la é `esports_enricher_min_interval_minutes`**: baixá-lo para 5
-- multiplica tudo por 6 (~6,6 GB/ano) e leva a tabela para perto do limiar de
-- ~20 GB em que a conversão para particionada passa a valer. Quem mexer nesse
-- número está mexendo naquela decisão, e é para isso que este comentário existe.
--
-- ---------------------------------------------------------------------------
-- Por que a cadência do fragmento não é a cadência do tick
-- ---------------------------------------------------------------------------
--
-- `context_fragments` NÃO é uma segunda cópia da série de preço. A série vive em
-- `esports_snapshots`, com resolução de 12s no ao vivo, e é de lá que qualquer
-- backtest lê tick. O fragmento é a LEITURA dela num instante de decisão —
-- movimento em 1h/6h/24h, liquidez, consistência série x games.
--
-- Por isso a cadência certa é a de decisão, não a de tick. Gravar um fragmento a
-- cada 5 minutos duplicaria a série em formato pior (jsonb, com texto) sem
-- acrescentar nada que `esports_snapshots` não responda melhor.

alter table public.system_config
  add column if not exists esports_enricher_enabled boolean not null default true;

-- Ligado por default, como `esports_resolver_enabled` e pelo mesmo motivo: o
-- componente é novo e o pedido é que ele comece a rodar. E ligado não
-- surpreende, porque o runner sonda `context_fragments` antes de chamar enricher
-- nenhum e não faz nada enquanto a migration 20260806211531 não estiver
-- aplicada. Quem decide quando ele começa a escrever continua sendo quem aplica
-- aquela migration, não esta.
comment on column public.system_config.esports_enricher_enabled is
  'Liga o job de enriquecimento de esports (ciclo de 5 min). Desligar aqui para o componente sem deploy. Spec 001, item 5.';

-- ---------------------------------------------------------------------------
-- A janela: por que ela é própria e não a da watchlist
-- ---------------------------------------------------------------------------
--
-- A watchlist já tem faixas (`watchlist_soon_window_minutes`,
-- `watchlist_live_max_minutes`) e seria tentador reusá-las. Não são a mesma
-- pergunta: as da watchlist decidem COM QUE FREQUÊNCIA reler o preço de um
-- mercado, e as daqui decidem PARA QUAIS PARTIDAS existe registro de contexto no
-- dataset de eval. Amarrar as duas faria um ajuste de cadência de coleta mudar,
-- em silêncio, o formato do dataset — e o dataset é a única coisa aqui que não
-- dá para reconstruir depois.
--
-- 24h à frente porque é a maior janela que `market-history` mede (o movimento de
-- 24h). Uma partida que entra no radar em T-24h já tem série suficiente para
-- todas as janelas serem preenchidas — a watchlist coleta desde a criação do
-- mercado, muito antes disso.
--
-- Partida com `scheduled_at` nulo fica de fora, e não há como ser diferente: sem
-- horário não existe "próxima". São os eventos sem `game_start_time`, e quem
-- resolve isso é a coleta, não este job.

alter table public.system_config
  add column if not exists esports_enricher_lookahead_minutes integer not null default 1440;

comment on column public.system_config.esports_enricher_lookahead_minutes is
  'Quanto antes de scheduled_at a partida entra no enriquecimento. 1440 = 24h, que e a maior janela medida por market-history. Spec 001, item 5.';

alter table public.system_config
  add column if not exists esports_enricher_lookbehind_minutes integer not null default 360;

-- 6h depois do início cobre a partida inteira (uma série BO5 de CS2 passa de 3h)
-- mais a cauda até a resolução. É o mesmo teto que `watchlist_live_max_minutes`
-- usa para o ao vivo, por coincidência de fato e não por acoplamento: os dois
-- descrevem "quanto tempo depois do horário marcado a partida ainda está
-- acontecendo".
comment on column public.system_config.esports_enricher_lookbehind_minutes is
  'Quanto depois de scheduled_at a partida continua sendo enriquecida. 360 = a partida inteira mais a cauda ate a resolucao. Spec 001, item 5.';

-- ---------------------------------------------------------------------------
-- O intervalo mínimo, que é o parâmetro de volume
-- ---------------------------------------------------------------------------
--
-- O cron tica a cada 5 min; este número é o que decide se a partida é
-- enriquecida naquele tick. Mesmo desenho da watchlist (tick de 5s, faixas de
-- 12-300s): o tick só precisa ser mais rápido que o intervalo, e quem manda na
-- cadência é a config.
--
-- 0 faz o job enriquecer toda partida da janela em todo tick. É legítimo para um
-- teste curto e é a forma mais rápida de multiplicar a tabela por 6 — ver a
-- conta de volume no topo antes de usar.

alter table public.system_config
  add column if not exists esports_enricher_min_interval_minutes integer not null default 30;

comment on column public.system_config.esports_enricher_min_interval_minutes is
  'Intervalo minimo entre dois enriquecimentos da MESMA partida. E o parametro que governa o volume de context_fragments: baixa-lo multiplica a tabela e pode derrubar a decisao de nao particionar (ver 20260806211531). Spec 001, item 5.';

-- Teto de partidas por ciclo. Não é o número esperado — com ~14 partidas/dia, a
-- janela de 30h costuma trazer ~17 — é o freio para o dia em que a janela crescer
-- ou uma vertical nova for habilitada. O job reporta `truncated` quando o teto
-- corta, então o freio nunca é silencioso.
alter table public.system_config
  add column if not exists esports_enricher_batch_size integer not null default 50;

comment on column public.system_config.esports_enricher_batch_size is
  'Teto de partidas enriquecidas por ciclo. O job reporta truncated quando corta, para o freio nunca ser silencioso. Spec 001, item 5.';

alter table public.system_config
  add constraint system_config_esports_enricher_batch_positive
  check (esports_enricher_batch_size > 0);

alter table public.system_config
  add constraint system_config_esports_enricher_window_nonneg
  check (
    esports_enricher_lookahead_minutes >= 0
    and esports_enricher_lookbehind_minutes >= 0
    and esports_enricher_min_interval_minutes >= 0
  );
