-- Conserto do ramo `old` de `run_snapshot_retention_batch`.
--
-- Sintoma: `Batch 'old' failed at iteration 0: canceling statement due to
-- statement timeout`. Não completa nem o primeiro lote. O ramo `finalized` do
-- mesmo dia continua passando — e essa assimetria é o que aponta a causa.
--
-- ---------------------------------------------------------------------------
-- O que custa caro, e não é o que parece
-- ---------------------------------------------------------------------------
--
-- A suspeita de que o `NOT EXISTS` da 20260806032316 encareceu a query está
-- certa. Mas não pelo anti-join em si: pelo predicado que vai junto.
--
--     AND NOT EXISTS (
--       SELECT 1 FROM events e
--        WHERE e.id = s.event_id
--          AND e.slug LIKE ANY (esports)   -- <- aqui
--     )
--
-- `esports` é variável de plpgsql. O plano é cacheado com ela como Param, não
-- como Const. E a otimização de prefixo do Postgres (`match_pattern_prefix`,
-- que reescreve `slug LIKE 'cs2-%'` em `slug ~>=~ 'cs2-' AND slug ~<~ 'cs2.'`)
-- **só dispara com pattern constante**. Com Param ela não dispara, e
-- `idx_events_slug_prefix (slug text_pattern_ops)` — criado na 20260805222523
-- exatamente para esse LIKE — fica sem uso.
--
-- Sem índice do lado de `events`, sobram dois planos, e os dois estouram:
--
--   Hash anti-join — build side é seq scan dos 711 MB / 551k linhas de `events`
--   aplicando o LIKE linha a linha. O hash é construído INTEIRO antes de a
--   primeira linha sair, então o `LIMIT batch_size` lá fora não corta nada.
--
--   Nested loop anti-join — até 96k sondagens de PK numa heap de 711 MB com
--   localidade aleatória (uuid). São 96k page fetches fora de cache.
--
-- O orçamento não é o `statement_timeout` de 120s do Postgres: é o timeout
-- próprio do PostgREST, 8s (spec 000, "Causa raiz dos timeouts"). Os dois planos
-- passam disso com folga.
--
-- Por que `finalized` sobrevive à mesma expressão: aquele ramo é dirigido por
-- `events` via `idx_events_status_volume (status, volume_24h desc)` — `status`
-- é coluna líder e o `IN` é sargable. O LIKE ali é filtro sobre linha já
-- buscada, não predicado de junção, e o LIMIT corta cedo de verdade.
--
-- ---------------------------------------------------------------------------
-- Por que o LIMIT 5000 não salvou o ramo `old`
-- ---------------------------------------------------------------------------
--
-- A própria 20260806032316 previu isto, sem ligar os pontos:
--
--   "as linhas de esports que ficarem em polymarket_snapshots passam a ser
--    puladas em TODA execução, para sempre (...) o trecho pulado cresce"
--
-- É o mecanismo do timeout. Depois que a proteção entrou, o que sobra na ponta
-- velha de `polymarket_snapshots` é justamente o que está protegido. A varredura
-- raramente encontra 5000 linhas deletáveis cedo: ela percorre a tabela toda
-- pagando a sondagem em `events` a cada linha. `batch_size` não é o problema —
-- baixá-lo teria escondido o plano ruim sem tornar uma única linha mais barata.
--
-- O bloat entra como multiplicador, não como causa: 96k linhas ocupando 156 MB
-- são ~14x o que a linha (~110 B) justifica. É o mesmo B-tree que a spec 000
-- registrou em 1492 MB. Ele faz o seq scan ler muito mais página do que 96k
-- linhas sugerem, mas mesmo sem bloat os 711 MB de `events` decidiriam sozinhos.
--
-- ---------------------------------------------------------------------------
-- A correção: tirar `events` do laço quente
-- ---------------------------------------------------------------------------
--
-- 96k linhas é pouco. 551k linhas a 1,3 KB é o caro. Então a proteção deixa de
-- ser junção por linha e passa a ser resolvida UMA VEZ por chamada, com índice.

-- ---------------------------------------------------------------------------
-- 1. O conjunto protegido, resolvido por índice
-- ---------------------------------------------------------------------------
--
-- SQL dinâmico não é enfeite aqui: é o que transforma o pattern em Const e
-- devolve `idx_events_slug_prefix` ao planner. Três prefixos viram três index
-- range scans no lugar de um seq scan de 711 MB.
--
-- Injeção: os prefixos vêm de `system_config.discovery_slug_prefixes`, que é
-- dado do próprio banco, e `%L` cita como literal. Vale dizer porque a função é
-- SECURITY DEFINER.
--
-- A direção do erro é oposta à de `esports_slug_patterns()`, de propósito. Lá,
-- falha ao ler a config cai no fallback embutido, porque lista vazia de padrões
-- liberaria o apagamento. Aqui NÃO existe fallback: array vazio é resposta
-- legítima ("ainda não há event de esports") e indistinguível de "a varredura
-- falhou". Então a exceção sobe, o job registra erro e nada é apagado. Falhar
-- fechado custa um ciclo de retenção; falhar aberto custa a série.

create or replace function public.esports_event_ids ()
  RETURNS uuid[]
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $function$
DECLARE
  patterns  text[] := public.esports_slug_patterns();
  predicate text;
  ids       uuid[];
BEGIN
  SELECT string_agg(format('e.slug LIKE %L', p), ' OR ')
    INTO predicate
    FROM unnest(patterns) AS p
   WHERE p IS NOT NULL;

  -- `esports_slug_patterns()` nunca devolve vazio. Se devolver, é bug lá, e o
  -- efeito aqui seria proteger nada — que é exatamente o que não pode passar
  -- em silêncio.
  IF predicate IS NULL THEN
    RAISE EXCEPTION
      'esports_event_ids: esports_slug_patterns() devolveu lista vazia';
  END IF;

  EXECUTE format(
    'SELECT coalesce(array_agg(e.id), ARRAY[]::uuid[]) FROM public.events e WHERE %s',
    predicate
  ) INTO ids;

  RETURN ids;
END;
$function$;

comment on function public.esports_event_ids() is
  'Ids de events de esports, resolvidos uma vez por chamada. SQL dinamico com pattern literal para que idx_events_slug_prefix seja usado: LIKE ANY com pattern em Param nao e indexavel. Sem fallback — excecao sobe e a retencao nao apaga nada. Spec 000, item 8.';

revoke all on function public.esports_event_ids() from public, anon, authenticated;

grant execute on function public.esports_event_ids() to service_role;

-- ---------------------------------------------------------------------------
-- 2. Índice que dá ponta velha à varredura
-- ---------------------------------------------------------------------------
--
-- `idx_snapshots_event_time (event_id, captured_at desc)` não serve a um filtro
-- só por `captured_at`: a coluna líder é outra. Sem índice em `captured_at`
-- sozinho o ramo `old` só tem seq scan, e o LIMIT vira sorte.
--
-- Com ele mais o `ORDER BY captured_at` acrescentado abaixo, o plano passa a ser
-- index scan na ordem do tempo -> anti-join contra um hash minúsculo -> Limit,
-- que para de verdade ao juntar `batch_size` linhas.
--
-- O custo que este índice traz de volta, dito em voz alta: ele é B-tree numa
-- tabela que apaga em ciclo, então ele bloata como `idx_snapshots_event_time`
-- bloatou (spec 000: 1492 MB). A diferença de escala é o que torna aceitável —
-- 96k entradas de 8 B são ~3 MB, contra os 156 MB da tabela hoje — e o destino
-- desta tabela é encolher, não crescer: o volume de esports migra para
-- `esports_snapshots`, que é particionada e não bloata (spec 000, item 3c).
--
-- Sem CONCURRENTLY pelo mesmo motivo da 20260805222523: `supabase db push` roda
-- as migrations em transação e `CREATE INDEX CONCURRENTLY` não roda em bloco de
-- transação (SQLSTATE 25001). Aqui isso é barato de verdade — 96k linhas, build
-- em menos de um segundo, ao contrário dos 711 MB de `events`.
--
-- Cuidado ao conferir: `if not exists` casa por NOME, não por definição.
--
--   select indexdef from pg_indexes where indexname = 'idx_snapshots_captured_at';

create index if not exists idx_snapshots_captured_at
  on public.polymarket_snapshots (captured_at);

comment on index public.idx_snapshots_captured_at is
  'Ponta velha de polymarket_snapshots para o ramo old da retencao. idx_snapshots_event_time nao serve: event_id e a coluna lider.';

-- ---------------------------------------------------------------------------
-- 3. A função em lote
-- ---------------------------------------------------------------------------
--
-- Assinatura preservada de novo: `src/jobs/retention.ts` chama por RPC com os
-- mesmos três argumentos e não precisa de redeploy para esta parte.
--
-- `protected` é CTE MATERIALIZED sobre um array de alguns milhares de uuids
-- (2307 events de esports medidos na 20260806183705). O planner hasheia isso em
-- microssegundos, e `events` não é tocada no ramo `old`. MATERIALIZED é
-- explícito para o planner não reexpandir o unnest dentro do laço.
--
-- Semântica idêntica à anterior, conferida caso a caso — nenhuma linha muda de
-- lado:
--
--   ramo `old`
--     event_id NULL              -> apagado    (antes: NOT EXISTS true)
--     event com slug NULL        -> apagado    (antes: AND com NULL, sem linha)
--     event com slug casando     -> protegido
--     event com slug sem casar   -> apagado
--
--   ramo `finalized`
--     slug NULL                  -> PRESERVADO
--
-- O `e.slug IS NOT NULL` novo no ramo `finalized` existe só para isso. Era o
-- `NOT (e.slug LIKE ANY (...))` que preservava event sem slug, por NULL virar
-- falso no WHERE — a 20260806032316 registrou isso como escolha ("na dúvida,
-- preserva"). Trocar por `NOT EXISTS (protected)` sem o guarda inverteria a
-- decisão em silêncio, na direção que apaga.
--
-- O ramo `finalized` não estava falhando. Ele muda junto porque depende do mesmo
-- LIKE não indexável, e hoje só escapa porque `idx_events_status_volume` o
-- dirige. No dia em que `status` deixar de ser seletivo — e ele deixa, conforme
-- os events finalizados se acumulam — ele cai pelo mesmo motivo. Consertar um
-- ramo só deixaria a próxima falha parecendo nova.

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
  protected_ids uuid[] := public.esports_event_ids();
BEGIN
  IF delete_type = 'old' THEN
    WITH protected AS MATERIALIZED (
      SELECT unnest(protected_ids) AS event_id
    ),
    to_delete AS (
      SELECT s.id
        FROM public.polymarket_snapshots s
       WHERE s.captured_at < NOW() - (retention_hours || ' hours')::interval
         AND NOT EXISTS (
           SELECT 1 FROM protected p WHERE p.event_id = s.event_id
         )
       ORDER BY s.captured_at
       LIMIT batch_size
    ),
    deleted AS (
      DELETE FROM public.polymarket_snapshots
       WHERE id IN (SELECT id FROM to_delete)
      RETURNING 1
    )
    SELECT count(*) INTO deleted_count FROM deleted;

  ELSIF delete_type = 'finalized' THEN
    WITH protected AS MATERIALIZED (
      SELECT unnest(protected_ids) AS event_id
    ),
    to_delete AS (
      SELECT s.id
        FROM public.polymarket_snapshots s
       INNER JOIN public.events e ON e.id = s.event_id
       WHERE e.status IN ('resolved', 'closed_manual', 'inactive')
         AND e.slug IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM protected p WHERE p.event_id = e.id
         )
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
  'Retencao em lote de polymarket_snapshots. NUNCA apaga snapshot de mercado de esports. A protecao e resolvida uma vez por chamada em esports_event_ids() e comparada por id — events nao e tocada no ramo old, que era onde o LIKE ANY nao indexavel estourava o timeout de 8s do PostgREST. Spec 000, item 8.';

-- `run_snapshot_retention` (sem lote) fica como está: continua usando o LIKE ANY
-- caro, e continua correta. Ela não passa por PostgREST — é uso manual, sob os
-- 120s do `statement_timeout` do Postgres — e nada em `src/` a chama. Reescrever
-- as duas dobraria a superfície desta migration para consertar o que não quebra.
-- A semântica de slug NULL das duas segue a mesma; não há divergência nova.

-- ---------------------------------------------------------------------------
-- O que isto NÃO conserta
-- ---------------------------------------------------------------------------
--
-- O trecho pulado continua crescendo. Enquanto o fallback de
-- `writeEsportsSnapshots` e o `open-legs-collector` gravarem série de esports em
-- `polymarket_snapshots`, a varredura passa por cima de mais linhas a cada dia —
-- só que agora a um custo que cabe no orçamento, e não mais multiplicado por uma
-- sondagem em 711 MB.
--
-- O fim disso é o item 3c da spec 000: mover a série para `esports_snapshots` e
-- parar o `open-legs` de escrever aqui. `esports_legacy_snapshot_events()` já
-- mede o quanto falta, e o `retention_job` já registra o número a cada execução
-- em `legacy_esports_events`. Enquanto ele não cair, esta migration é o que
-- mantém o job de pé — não o que resolve o problema de fundo.
--
-- Verificação depois do apply, antes de confiar:
--
--   EXPLAIN (ANALYZE, BUFFERS)  no corpo do ramo `old` com batch_size=5000.
--   O que tem que aparecer: Index Scan em idx_snapshots_captured_at, Hash Anti
--   Join com `protected` do lado do hash, e NENHUM acesso a `events`. Se
--   `events` aparecer no plano do ramo `old`, o conserto não pegou.
