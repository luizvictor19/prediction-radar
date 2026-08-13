-- A retenção comeria a série do radar. Esta migration é o que impede.
--
-- ---------------------------------------------------------------------------
-- O diagnóstico, em duas linhas
-- ---------------------------------------------------------------------------
--
-- `run_snapshot_retention_batch` tem dois ramos, e os dois só pulam o que estiver
-- em `esports_event_ids()` — events cujo slug casa com `cs2-`, `lol-`, `dota2-`.
-- Um mercado do radar não casa com nenhum deles. Então:
--
--   ramo `old`        apaga qualquer snapshot com `captured_at` mais velho que
--                     `snapshot_retention_days * 24h`. A coluna vale 1 hoje:
--                     a série do radar viveria 24 HORAS.
--
--   ramo `finalized`  apaga TODO snapshot de event com status resolved,
--                     closed_manual ou inactive, SEM condição de idade. No
--                     instante em que o mercado resolve, a série inteira dele
--                     vai embora — inclusive a parte anterior à resolução.
--
-- O segundo é literalmente o defeito que o README registra como dano permanente:
-- "of 1,755 resolved matches probed for recoverable history, zero have a usable
-- price series". A retenção não foi consertada naquela ocasião; ela ganhou uma
-- EXCEÇÃO para esports. Quem entrar de novo sem exceção repete o dano inteiro.
--
-- Vigiar preço para julgar a resolução exige exatamente a série que os dois
-- ramos apagam: a semana antes do desfecho e o instante do desfecho, juntos.
-- Sem esta migration aplicada, ligar coleta do radar é produzir dado com prazo
-- de validade de um dia.
--
-- ---------------------------------------------------------------------------
-- Por que uma coluna nova, e não `events.tracked`
-- ---------------------------------------------------------------------------
--
-- `tracked` existe desde a 001 e nasceu `default true`. Pior: `normalize.ts` e o
-- `early-markets-collector` gravam `tracked: true` em tudo que coletam. Usá-la
-- como marca de proteção protegeria virtualmente a tabela inteira, e a retenção
-- deixaria de apagar qualquer coisa — trocaria perder dado por não ter mais
-- ponta velha, que é como `polymarket_snapshots` chegou aos 156 MB com índice de
-- 1492 MB da spec 000.
--
-- Antes de confiar nesta frase, quem aplicar pode conferir — mas NÃO com
-- `count(*)` sobre `events` pelo PostgREST, que é seq scan de 711 MB dentro de
-- um orçamento de 8s. No SQL editor, sob os 120s do statement_timeout:
--
--   select tracked, count(*) from public.events group by tracked;
--
-- `radar_tracked` nasce `false` e só vira `true` por decisão explícita. Marcar é
-- escrita, e escrita é do dono: esta migration cria a coluna, não popula.
--
-- ---------------------------------------------------------------------------
-- 1. A marca
-- ---------------------------------------------------------------------------

alter table public.events
  add column if not exists radar_tracked boolean not null default false;

comment on column public.events.radar_tracked is
  'Marca de vigilancia do radar. true = a serie deste event NUNCA e apagada pela retencao, nem por idade nem por resolucao. Nasce false; marcar e decisao do dono. Nao confundir com tracked, que nasce true para tudo e nao serve como protecao.';

-- Índice parcial, e não índice comum: o conjunto marcado é dezenas de linhas
-- numa tabela de 551k. Um B-tree cheio custaria as 551k entradas para responder
-- sobre 40; o parcial indexa só o que é `true` e cabe em poucos KB. É o mesmo
-- desenho de `idx_events_category`, que já é parcial em `tracked = true`.
create index if not exists idx_events_radar_tracked
  on public.events (id)
  where radar_tracked;

-- ---------------------------------------------------------------------------
-- 2. O conjunto protegido do radar
-- ---------------------------------------------------------------------------
--
-- Função separada de `esports_event_ids()`, e não um `OR` dentro dela, por dois
-- motivos. O primeiro é o plano: aquela ali usa SQL dinâmico para transformar os
-- prefixos em literal e alcançar `idx_events_slug_prefix`; esta é um scan de
-- índice parcial e não precisa de nada disso. Misturar as duas devolveria ao
-- planner uma expressão que ele não indexa por inteiro. O segundo é de leitura:
-- quando o número de linhas protegidas surpreender alguém, o `EXPLAIN` diz qual
-- das duas fontes cresceu.

create or replace function public.radar_event_ids ()
  RETURNS uuid[]
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $function$
  SELECT coalesce(array_agg(e.id), ARRAY[]::uuid[])
    FROM public.events e
   WHERE e.radar_tracked;
$function$;

comment on function public.radar_event_ids() is
  'Ids de events marcados para o radar. Resolvido uma vez por chamada da retencao e comparado por id, igual a esports_event_ids(). Lista vazia e estado valido: significa que nada foi marcado ainda.';

revoke all on function public.radar_event_ids() from public, anon, authenticated;

grant execute on function public.radar_event_ids() to service_role;

-- ---------------------------------------------------------------------------
-- 3. A retenção passa a somar as duas proteções
-- ---------------------------------------------------------------------------
--
-- O corpo abaixo é o da 20260807230005 sem uma vírgula de diferença, exceto a
-- linha do `DECLARE`. Os dois ramos já comparavam contra `protected_ids`; o que
-- muda é o que entra nele.
--
-- Diferença deliberada entre as duas fontes: `esports_event_ids()` levanta
-- exceção se a lista de prefixos vier vazia, porque lá vazio significa bug e
-- apagaria esports inteiro. Aqui vazio é o estado NORMAL enquanto nada foi
-- marcado — levantar exceção derrubaria a retenção do dia em que a coluna foi
-- criada até o dia em que o dono aprovar a lista.

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
  protected_ids uuid[] := public.esports_event_ids() || public.radar_event_ids();
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
  'Retencao em lote de polymarket_snapshots. NUNCA apaga snapshot de esports (slug com prefixo de vertical) nem de event marcado com radar_tracked. A protecao e resolvida uma vez por chamada e comparada por id — events nao e tocada no ramo old, que era onde o LIKE ANY nao indexavel estourava o timeout de 8s do PostgREST. Spec 000 item 8, mais a protecao do radar.';

-- ---------------------------------------------------------------------------
-- O que isto NÃO conserta, dito em voz alta
-- ---------------------------------------------------------------------------
--
-- 1. O ramo `finalized` continua sem condição de idade para quem NÃO está
--    protegido. Um mercado não marcado que resolva às 14h perde a série inteira
--    na execução das 3h da manhã seguinte, e é irrecuperável — a API não devolve
--    orderbook histórico. Isso é o defeito original do README, e ele segue
--    inteiro para todo mercado fora das duas listas. Consertar de verdade seria
--    trocar a exceção por uma regra ("guarda N dias depois de resolvido"), e
--    isso muda o volume da tabela para todo mundo — decisão maior que esta
--    migration, e que não cabe embutir de contrabando numa que existe para
--    proteger 40 mercados.
--
-- 2. A proteção é PERMANENTE. Marcar 40 events com `radar_tracked` cria 40 séries
--    que nunca envelhecem. A ordem de grandeza cabe — um snapshot por minuto por
--    mercado por dois meses são ~86k linhas, contra as ~96k que a tabela já
--    carrega hoje — mas ela cresce com o número de marcados, não com o tempo de
--    retenção. Se a lista virar centenas, o destino é o mesmo dos esports:
--    tabela particionada, não retenção mais esperta.
--
-- 3. Nada aqui marca nada. Depois do apply, `radar_event_ids()` devolve lista
--    vazia e a retenção se comporta exatamente como antes. A proteção só passa a
--    existir quando o dono marcar — o que é a intenção, não um passo esquecido.
--
-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- 1. a coluna e o índice existem, e nada foi marcado ainda
--   select count(*) from public.events where radar_tracked;   -- espera 0
--
--   -- 2. o plano do ramo `old` não regrediu: sem acesso a `events`
--   explain (analyze, buffers)
--   select public.run_snapshot_retention_batch('old', 24, 5000);
--
--   -- 3. depois de marcar um event de teste, a série dele sobrevive à execução
--   select count(*) from public.polymarket_snapshots
--    where event_id = '<id marcado>' and captured_at < now() - interval '24 hours';
