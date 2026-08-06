-- Spec 000, item 8 — retenção esports-only.
--
-- Critério de pronto do item: "nenhum snapshot esports apagado". Hoje o oposto
-- acontece, todo dia às 03:00 e a cada deploy.
--
-- ---------------------------------------------------------------------------
-- Onde está o vazamento
-- ---------------------------------------------------------------------------
--
-- Não há sobreposição entre os dois jobs por tabela: `run_snapshot_retention*`
-- só toca `polymarket_snapshots`, `manage_esports_partitions` só toca as
-- partições de `esports_snapshots`. A lacuna é por DADO, e são três fontes que
-- põem série de esports dentro de `polymarket_snapshots`:
--
--   1. O fallback de `writeEsportsSnapshots` (src/lib/esports-snapshots.ts).
--      Enquanto a migration 20260805142957 não estiver aplicada, a descoberta e
--      a watchlist gravam a série inteira lá. É temporário, mas é o volume todo.
--
--   2. O `open-legs-collector`, que grava em `polymarket_snapshots` e não passa
--      por `writeEsportsSnapshots`. Ele coleta exatamente os markets com aposta
--      aberta — que hoje são de esports. Isso NÃO acaba quando a migration for
--      aplicada: é permanente até alguém mudar aquele coletor.
--
--   3. O histórico já gravado por qualquer um dos dois antes deste apply.
--
-- E as duas funções de retenção apagam tudo isso sem distinguir. A pior das
-- duas não é a de idade, é o ramo `finalized`:
--
--     DELETE ... WHERE e.status IN ('resolved','closed_manual','inactive')
--
-- Sem nenhuma condição de idade. Uma partida resolve poucas horas depois de
-- acabar, então a série pré-partida + ao vivo — as features E o rótulo, juntos —
-- é apagada na primeira execução da retenção depois da resolução. Para os
-- markets em que há dinheiro (fonte 2), é a série mais valiosa do banco, e é a
-- que morre primeiro.
--
-- ---------------------------------------------------------------------------
-- Onde a correção mora
-- ---------------------------------------------------------------------------
--
-- Na função de retenção, não nos coletores. Um coletor consertado protege o que
-- ele escreve; a função protege o que qualquer um escrever, inclusive o
-- `open-legs` de hoje e o que for escrito amanhã sem ninguém lembrar deste item.
--
-- O reconhecimento é por prefixo de slug, lido de `system_config` para não
-- exigir migration quando uma vertical entrar (a spec 001 traz futebol).

-- ---------------------------------------------------------------------------
-- O que é esports, em um lugar só
-- ---------------------------------------------------------------------------
--
-- Dois modos de falhar em silêncio, os dois tratados aqui:
--
--   `discovery_slug_prefixes` vazio é o DESLIGAMENTO dos coletores (item 4) —
--   ler isso como "não existe esports" faria desligar a coleta autorizar o
--   apagamento do histórico dela. Vazio cai no default embutido.
--
--   A coluna pode não existir (migration 20260804163956 não aplicada). O
--   EXCEPTION cobre: erro na leitura da config protege tudo, nunca libera.
--
-- A lista embutida é a de hoje. Ela é piso, não teto: o que manda é a config, e
-- o embutido só existe para o caso de a config não responder.

create or replace function public.esports_slug_patterns ()
  RETURNS text[]
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $function$
DECLARE
  fallback constant text[] := array['cs2-%', 'lol-%', 'dota2-%'];
  patterns text[];
BEGIN
  SELECT array_agg(s.prefix || '%')
    INTO patterns
    FROM (
      SELECT unnest(c.discovery_slug_prefixes) AS prefix
        FROM (
          SELECT discovery_slug_prefixes
            FROM public.system_config
           ORDER BY id
           LIMIT 1
        ) c
    ) s
   WHERE s.prefix IS NOT NULL
     AND length(s.prefix) > 0;

  IF patterns IS NULL OR array_length(patterns, 1) IS NULL THEN
    RETURN fallback;
  END IF;

  RETURN patterns;
EXCEPTION WHEN others THEN
  RETURN fallback;
END;
$function$;

comment on function public.esports_slug_patterns() is
  'Padroes LIKE que identificam mercado de esports, lidos de system_config.discovery_slug_prefixes. Config vazia ou ilegivel cai no default embutido: nunca devolve lista vazia, porque lista vazia autorizaria a retencao a apagar tudo. Spec 000, item 8.';

revoke all on function public.esports_slug_patterns() from public, anon, authenticated;

grant execute on function public.esports_slug_patterns() to service_role;

-- ---------------------------------------------------------------------------
-- A retenção em lote — a que o job usa
-- ---------------------------------------------------------------------------
--
-- Assinatura idêntica à anterior de propósito: `src/jobs/retention.ts` chama por
-- RPC com estes três argumentos e continua valendo sem redeploy.
--
-- O que mudou: `NOT EXISTS` contra `events` nos dois ramos. Anti-join por PK,
-- ~batch_size lookups de índice por lote — o ramo `finalized` já pagava um join
-- equivalente.
--
-- Custo que vale dizer em voz alta: as linhas de esports que ficarem em
-- `polymarket_snapshots` passam a ser puladas em TODA execução, para sempre. Não
-- há índice em `captured_at` sozinho (só `idx_snapshots_event_time`), então o
-- ramo `old` já varre a tabela inteira por lote — o anti-join não muda a ordem
-- de grandeza, mas o trecho pulado cresce enquanto o fallback estiver ativo. É
-- mais um motivo para aplicar a 20260805142957 logo, não para relaxar aqui:
-- dado apagado não volta, varredura cara volta a ficar barata depois da poda.
--
-- `SET search_path` é novo. SECURITY DEFINER sem ele deixa quem chama escolher
-- de qual schema vêm `events` e `polymarket_snapshots`.

create or replace function public.run_snapshot_retention_batch (
  delete_type     text,
  retention_hours integer DEFAULT 24,
  batch_size      integer DEFAULT 5000
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $function$
DECLARE
  deleted_count int := 0;
  esports text[] := public.esports_slug_patterns();
BEGIN
  IF delete_type = 'old' THEN
    WITH to_delete AS (
      SELECT s.id
        FROM public.polymarket_snapshots s
       WHERE s.captured_at < NOW() - (retention_hours || ' hours')::interval
         AND NOT EXISTS (
           SELECT 1
             FROM public.events e
            WHERE e.id = s.event_id
              AND e.slug LIKE ANY (esports)
         )
       LIMIT batch_size
    ),
    deleted AS (
      DELETE FROM public.polymarket_snapshots
       WHERE id IN (SELECT id FROM to_delete)
      RETURNING 1
    )
    SELECT count(*) INTO deleted_count FROM deleted;

  ELSIF delete_type = 'finalized' THEN
    WITH to_delete AS (
      SELECT s.id
        FROM public.polymarket_snapshots s
       INNER JOIN public.events e ON e.id = s.event_id
       WHERE e.status IN ('resolved', 'closed_manual', 'inactive')
         AND NOT (e.slug LIKE ANY (esports))
       LIMIT batch_size
    ),
    deleted AS (
      DELETE FROM public.polymarket_snapshots
       WHERE id IN (SELECT id FROM to_delete)
      RETURNING 1
    )
    SELECT count(*) INTO deleted_count FROM deleted;

  ELSE
    RAISE EXCEPTION 'Invalid delete_type: %', delete_type;
  END IF;

  RETURN deleted_count;
END;
$function$;

comment on function public.run_snapshot_retention_batch(text, integer, integer) is
  'Retencao em lote de polymarket_snapshots. NUNCA apaga snapshot de mercado de esports (ver esports_slug_patterns). Spec 000, item 8.';

-- `e.slug` nulo: `NULL LIKE ANY (...)` devolve NULL, e `NOT NULL` também é NULL,
-- que o WHERE trata como falso. Ou seja, event sem slug NÃO é apagado pelo ramo
-- `finalized`. É a direção certa do erro — na dúvida, preserva.

-- ---------------------------------------------------------------------------
-- A versão sem lote
-- ---------------------------------------------------------------------------
--
-- Nada em `src/` chama esta função — o job usa a versão em lote. Ela fica porque
-- é útil à mão em base pequena, e recebe a mesma exclusão: uma função de apagar
-- que conhece a regra pela metade é pior que não existir.
--
-- O que ela continua sendo: um DELETE sem LIMIT, que é o que travou o
-- `retention_job` antes do item 1. Se o dono quiser, `drop function` dela é
-- defensável — não é decisão de migration automática.

create or replace function public.run_snapshot_retention (
  retention_hours integer DEFAULT 24
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $function$
DECLARE
  old_deleted int := 0;
  finalized_deleted int := 0;
  esports text[] := public.esports_slug_patterns();
BEGIN
  WITH deleted AS (
    DELETE FROM public.polymarket_snapshots s
     WHERE s.captured_at < NOW() - (retention_hours || ' hours')::interval
       AND NOT EXISTS (
         SELECT 1
           FROM public.events e
          WHERE e.id = s.event_id
            AND e.slug LIKE ANY (esports)
       )
    RETURNING 1
  )
  SELECT count(*) INTO old_deleted FROM deleted;

  WITH deleted AS (
    DELETE FROM public.polymarket_snapshots s
     WHERE s.event_id IN (
             SELECT e.id
               FROM public.events e
              WHERE e.status IN ('resolved', 'closed_manual', 'inactive')
                AND NOT (e.slug LIKE ANY (esports))
           )
    RETURNING 1
  )
  SELECT count(*) INTO finalized_deleted FROM deleted;

  RETURN jsonb_build_object(
    'old_deleted', old_deleted,
    'finalized_deleted', finalized_deleted,
    'retention_hours', retention_hours,
    'esports_patterns', to_jsonb(esports)
  );
END;
$function$;

comment on function public.run_snapshot_retention(integer) is
  'Retencao sem lote de polymarket_snapshots, para uso manual. NUNCA apaga snapshot de esports. O job usa run_snapshot_retention_batch. Spec 000, item 8.';

-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------
--
-- As duas eram `GRANT ALL ... TO anon` desde o schema baseline: um DELETE em
-- SECURITY DEFINER ao alcance de quem tem a chave pública. O servidor usa
-- service_role, então nada em `src/` perde acesso.

revoke all on function public.run_snapshot_retention_batch(text, integer, integer)
  from public, anon, authenticated;

grant execute on function public.run_snapshot_retention_batch(text, integer, integer)
  to service_role;

revoke all on function public.run_snapshot_retention(integer)
  from public, anon, authenticated;

grant execute on function public.run_snapshot_retention(integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- O número que denuncia
-- ---------------------------------------------------------------------------
--
-- Quantos events de esports ainda têm série presa em `polymarket_snapshots`. É
-- o que separa "o item 8 está pronto" de "a exclusão está protegendo dado que
-- devia estar na tabela particionada".
--
-- Conta pelo lado de `events` (que tem índice de prefixo de slug desde a
-- 20260805222523) e com teto: o objetivo é saber se existe e a ordem de
-- grandeza, não pagar count(*) numa tabela de dezenas de milhões de linhas.
-- Chamada uma vez por execução do `retention_job`.

create or replace function public.esports_legacy_snapshot_events (
  sample_limit integer DEFAULT 500
)
  RETURNS integer
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $function$
  SELECT count(*)::int
    FROM (
      SELECT 1
        FROM public.events e
       WHERE e.slug LIKE ANY (public.esports_slug_patterns())
         AND EXISTS (
           SELECT 1
             FROM public.polymarket_snapshots s
            WHERE s.event_id = e.id
         )
       LIMIT greatest(coalesce(sample_limit, 500), 1)
    ) x;
$function$;

comment on function public.esports_legacy_snapshot_events(integer) is
  'Quantos events de esports ainda tem snapshot em polymarket_snapshots, ate o teto de sample_limit. > 0 significa serie de esports fora da tabela particionada — protegida pela retencao, mas no lugar errado. Spec 000, item 8.';

revoke all on function public.esports_legacy_snapshot_events(integer)
  from public, anon, authenticated;

grant execute on function public.esports_legacy_snapshot_events(integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Retenção de esports: 3650 -> 365 dias
-- ---------------------------------------------------------------------------
--
-- 3650 nunca foi uma decisão medida. A 20260805142957 o registrou como "'não
-- apague' com uma porta de saída" e deixou combinado reavaliar em 3 meses. A
-- reavaliação chegou antes porque o número de volume mudou: o item 7 fechou a
-- cadência e a projeção parou de ser chute.
--
-- Custo, com ~231k linhas/dia (item 7) e a linha de `esports_snapshots` medida
-- por partes — 24 B de header, uuid 16, timestamptz 8, `outcome` ~12, cinco
-- numerics ~45, mais ~40 B da entrada em `idx_esports_snapshots_event_time`:
--
--   ~150 B/linha  ->  ~35 MB/dia  ->  ~12,7 GB/ano
--
--     365 dias   ~12,7 GB    (~5.100 partidas, ~36k séries de mercado)
--     730 dias   ~25 GB
--    3650 dias   ~127 GB
--
-- (A estimativa de ~23 MB/dia que circulou antes contava só o heap, com linha de
-- ~100 B. A de cima inclui o índice, que aqui é 100% do custo de leitura.)
--
-- 127 GB de Postgres para um projeto pessoal não é uma escolha, é o que sobra de
-- não ter escolhido. E o dado do décimo ano não vale o do primeiro:
--
--   O ativo é a PARTIDA, não o dia. 365 dias são ~5.100 partidas e ~36k séries
--   de mercado — amostra suficiente para backtest de moneyline e para treino.
--   Dobrar o histórico dobra o disco e não dobra a qualidade da estimativa.
--
--   O calendário de esports é anual. Um ano cobre cada major, split e playoff
--   uma vez; 180 dias veriam metade dos formatos de torneio, e é isso que
--   desempata contra o valor mais barato.
--
--   Meta e lineup viram em meses. Uma partida de CS2 de três anos atrás não é a
--   mesma distribuição — o modelo aprenderia um jogo que não existe mais.
--
--   A microestrutura do próprio Polymarket muda: taxa, liquidez e quais markets
--   existem. Metade dos `sports_market_type` de hoje não existia há dois anos.
--
-- Se o disco apertar antes dos 12 meses, a saída certa não é cortar dias: é
-- downsample do trecho antigo (barra de 1 min para o que passou de N dias,
-- resolução cheia no recente). O valor de tick-level cai com a idade; o de ter a
-- curva, não. Fica anotado como item futuro, não como parte deste.
--
-- O piso de 30 dias em `manage_esports_partitions` continua valendo, e 365 está
-- longe dele. Aplicar isto hoje não dropa nenhuma partição: a mais antiga é de
-- 2026-08-05. O primeiro DROP por esta regra acontece em agosto de 2027.

alter table public.system_config
  alter column esports_snapshot_retention_days set default 365;

-- O UPDATE só toca quem ainda está no default antigo. Se o dono já escolheu
-- outro valor, a escolha dele não é revertida por uma migration.
update public.system_config
   set esports_snapshot_retention_days = 365
 where esports_snapshot_retention_days = 3650;

comment on column public.system_config.esports_snapshot_retention_days is
  'Dias de historico mantidos em esports_snapshots. 365 = um calendario completo de esports (~5.100 partidas, ~12,7 GB). Piso de 30 dias aplicado em manage_esports_partitions. Spec 000, itens 3 e 8.';

-- O default interno de `manage_esports_partitions` (3650) fica como está: só é
-- alcançável por uma chamada sem argumentos, o job sempre passa o valor da
-- config, e o erro nessa direção é preservar demais.
