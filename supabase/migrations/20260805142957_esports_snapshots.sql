-- Spec 000, item 3 — `esports_snapshots`: tabela dedicada, estreita e particionada.
--
-- O que esta migration existe para impedir: `idx_snapshots_event_time` chegou a
-- 1492 MB sobre 80 MB de dado real em `polymarket_snapshots`. Não era volume, era
-- bloat de índice — B-tree não devolve página ao sistema depois de DELETE, e a
-- retenção deleta em ciclo. Com partição por dia a limpeza é DROP TABLE: o índice
-- vai junto com a partição, instantâneo e sem bloat.
--
-- Volume que justifica: a watchlist já grava ~650k snapshots/dia (883 markets a
-- cada 3 min) e o item 7 (cadência de 10-15s ao vivo) multiplica isso.

-- ---------------------------------------------------------------------------
-- A tabela
-- ---------------------------------------------------------------------------

create table if not exists public.esports_snapshots (
  event_id    uuid        not null,
  captured_at timestamptz not null,
  outcome     text        not null,
  best_bid    numeric(6,4),
  best_ask    numeric(6,4),
  mid_price   numeric(6,4),
  volume_24h  numeric(14,2),
  liquidity   numeric(14,2)
) partition by range (captured_at);

-- Três ausências deliberadas em relação a `polymarket_snapshots`:
--
-- 1. Sem `id bigserial`. A pkey sozinha custava 514 MB lá e não servia a nenhuma
--    query — ninguém busca snapshot por id. A chave natural é
--    (event_id, captured_at, outcome).
--
--    E sem PRIMARY KEY sobre essa tripla também: seria um segundo índice quase do
--    tamanho do primeiro, pago em toda linha de um insert de 650k/dia, para
--    impedir uma duplicata que só apareceria se dois coletores lessem o mesmo
--    market no mesmo instante em microssegundos. A chave é natural e documentada,
--    não declarada.
--
-- 2. Sem FK para `events`. `on delete cascade` transformaria a poda de `events`
--    (item 5) em DELETE dentro das partições — exatamente o bloat que o
--    particionamento existe para evitar. Snapshot órfão aqui é aceitável: a
--    partição inteira morre por idade, não por integridade referencial.
--
-- 3. Sem `spread`. É `best_ask - best_bid`, derivável exatamente quando os dois
--    lados existem, e uma coluna a menos em 650k linhas/dia.
--
-- `numeric(6,4)` nos preços porque preço de prediction market vive em [0,1].
-- `liquidity` é nova: o mercado de esports nasce com liquidez de ~US$ 17 e essa
-- curva é sinal, não ruído — a série de descoberta de preço é o produto aqui.

comment on table public.esports_snapshots is
  'Serie temporal de preco dos mercados de esports (spec 000, item 3). Particionada por dia em captured_at: a limpeza e DROP PARTITION, nunca DELETE. Chave natural (event_id, captured_at, outcome), sem pkey declarada.';

alter table public.esports_snapshots
  enable row level security;

-- Índice único da tabela, criado no pai: o Postgres o replica em toda partição
-- nova. É o acesso que todo leitor faz — série de um event, do mais recente para
-- trás. Não há índice global aqui; cada partição indexa só o próprio dia, e é por
-- isso que a leitura de uma janela curta não paga o tamanho do histórico inteiro.
create index if not exists idx_esports_snapshots_event_time
  on public.esports_snapshots (event_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- Partição default: rede de segurança, não destino
-- ---------------------------------------------------------------------------
--
-- Sem ela, uma linha com `captured_at` fora de qualquer partição derruba o chunk
-- inteiro do insert (500 linhas), e para isso basta o job de partição falhar dois
-- dias seguidos. Com ela a linha é gravada e o problema vira número:
-- `manage_esports_partitions` reporta quantas linhas caíram aqui.
--
-- Não é destino porque nada a esvazia — a retenção dropa partições de dia, e esta
-- não é de dia nenhum. Linha aqui é para investigar, não para ignorar.
create table if not exists public.esports_snapshots_default
  partition of public.esports_snapshots default;

alter table public.esports_snapshots_default
  enable row level security;

-- As default privileges deste banco dão DML a `anon` em toda tabela nova do
-- schema public, e RLS sem policy só protege quem passa pelo pai. Uma partição
-- acessada diretamente pelo PostgREST responde com as próprias permissões.
revoke all on public.esports_snapshots_default from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Manutenção das partições
-- ---------------------------------------------------------------------------
--
-- Roda pelo job `esports_partitions` (src/jobs/esports-partitions.ts), diário.
-- Toda a manipulação de DDL mora aqui, em uma função só: o job chama por RPC e
-- não monta SQL.
--
-- SECURITY DEFINER porque cria e dropa tabela. Por isso o EXECUTE é revogado de
-- `anon` e `authenticated` no fim — sem isso, as default privileges do banco
-- entregariam um `drop table` a quem tem a chave pública.

create or replace function public.manage_esports_partitions (
  lookahead_days integer DEFAULT 2,
  retention_days integer DEFAULT 3650,
  max_drops      integer DEFAULT 16
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $function$
DECLARE
  -- Piso de retenção. `esports_snapshot_retention_days` é config editável, e a
  -- diferença entre 3650 e 3 é um dígito digitado errado. Do outro lado do erro
  -- está a série temporal que sustenta o backtest, e DROP PARTITION não tem
  -- desfazer. O piso não protege de uma decisão, protege de um deslize.
  min_retention_days constant integer := 30;

  today          date := (now() at time zone 'utc')::date;
  effective_days integer;
  clamped        boolean := false;
  part_day       date;
  part_name      text;
  created        text[] := '{}';
  dropped        text[] := '{}';
  errors         text[] := '{}';
  eligible       integer := 0;
  drop_budget    integer := greatest(coalesce(max_drops, 0), 0);
  default_rows   integer;
  part           record;
BEGIN
  effective_days := coalesce(retention_days, 3650);
  IF effective_days < min_retention_days THEN
    effective_days := min_retention_days;
    clamped := true;
  END IF;

  -- Criação: hoje mais a folga. O dia seguinte é o que a spec pede; a folga extra
  -- é para que uma execução perdida não vire linha na partição default.
  FOR part_day IN
    SELECT generate_series(
             today,
             today + greatest(coalesce(lookahead_days, 2), 1),
             interval '1 day'
           )::date
  LOOP
    part_name := 'esports_snapshots_p' || to_char(part_day, 'YYYYMMDD');

    CONTINUE WHEN EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = part_name
    );

    BEGIN
      -- Limites em UTC explícito: o nome da partição é derivado do dia UTC, e
      -- deixar o fuso da sessão decidir faria os dois discordarem.
      EXECUTE format(
        'create table public.%I partition of public.esports_snapshots for values from (%L) to (%L)',
        part_name,
        part_day::timestamp at time zone 'utc',
        (part_day + 1)::timestamp at time zone 'utc'
      );
      EXECUTE format('alter table public.%I enable row level security', part_name);
      EXECUTE format('revoke all on public.%I from anon, authenticated', part_name);
      created := created || part_name;
    EXCEPTION WHEN others THEN
      -- Falha típica: linha na partição default dentro do intervalo do dia novo.
      -- Um dia que falha não pode impedir os outros de serem criados.
      errors := errors || format('create %s: %s', part_name, sqlerrm);
    END;
  END LOOP;

  -- Retenção: DROP TABLE por partição vencida. É aqui que o problema do índice
  -- de 1492 MB deixa de existir — o índice da partição some junto com ela, sem
  -- página morta e sem vacuum.
  FOR part IN
    SELECT c.relname,
           to_date(right(c.relname, 8), 'YYYYMMDD') AS day
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'public'
      AND p.relname = 'esports_snapshots'
      AND c.relname ~ '^esports_snapshots_p[0-9]{8}$'
    ORDER BY 2
  LOOP
    CONTINUE WHEN part.day >= today - effective_days;

    eligible := eligible + 1;

    -- Teto por execução. Uma retenção reduzida por engano apaga no máximo
    -- `max_drops` dias por rodada, e `drop_eligible` no retorno denuncia a
    -- diferença antes que o resto vá junto.
    CONTINUE WHEN coalesce(array_length(dropped, 1), 0) >= drop_budget;

    BEGIN
      EXECUTE format('drop table public.%I', part.relname);
      dropped := dropped || part.relname;
    EXCEPTION WHEN others THEN
      errors := errors || format('drop %s: %s', part.relname, sqlerrm);
    END;
  END LOOP;

  -- Contagem limitada de propósito: se a default encheu, o que importa é saber
  -- que encheu — não pagar um count(*) completo para descobrir.
  EXECUTE 'select count(*)::int from (select 1 from public.esports_snapshots_default limit 1000) s'
    INTO default_rows;

  RETURN jsonb_build_object(
    'today_utc', today,
    'created', to_jsonb(created),
    'dropped', to_jsonb(dropped),
    -- Maior que `dropped` significa que o teto por execução segurou o resto.
    'drop_eligible', eligible,
    'retention_days', effective_days,
    -- true = o valor em system_config está abaixo do piso e foi ignorado.
    'retention_clamped', clamped,
    -- Maior que 0 = linha gravada fora de qualquer partição de dia. Ou o job
    -- ficou parado, ou algum `captured_at` chegou com data absurda.
    'default_rows_at_least', default_rows,
    'errors', to_jsonb(errors)
  );
END;
$function$;

comment on function public.manage_esports_partitions(integer, integer, integer) is
  'Cria as particoes dos proximos dias e dropa as vencidas de esports_snapshots (spec 000, item 3). Chamada pelo job esports_partitions.';

revoke all on function public.manage_esports_partitions(integer, integer, integer)
  from public, anon, authenticated;

grant execute on function public.manage_esports_partitions(integer, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Retenção em config
-- ---------------------------------------------------------------------------
--
-- 3650 dias é "não apague" com uma porta de saída. Para esports a série é a
-- matéria-prima do backtest: o valor de um snapshot pré-partida não vence,
-- cresce. A estimativa da spec é ~25 MB/dia (~9 GB/ano) e o combinado é
-- reavaliar em 3 meses — com o número de disco na mão, não com a projeção.
alter table public.system_config
  add column if not exists esports_snapshot_retention_days integer default 3650;

comment on column public.system_config.esports_snapshot_retention_days is
  'Dias de historico mantidos em esports_snapshots. Piso de 30 dias aplicado em manage_esports_partitions. Ver spec 000, item 3.';

-- Cria as partições do dia da aplicação em diante. Sem isto, todo insert entre o
-- apply e a primeira execução do job cairia na partição default.
-- `max_drops => 0`: aplicar migration nunca apaga dado.
select public.manage_esports_partitions(lookahead_days => 3, retention_days => 3650, max_drops => 0);
