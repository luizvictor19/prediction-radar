-- Particionar `polymarket_snapshots` ANTES de a coleta do radar começar.
--
-- ---------------------------------------------------------------------------
-- Por que agora, com 96 mil linhas, e não depois com 10 milhões
-- ---------------------------------------------------------------------------
--
-- Esta tabela nasceu comum na 001 e nunca foi convertida. `esports_snapshots`
-- (20260805142957) é particionada justamente porque esta não é, e o número que
-- motivou aquela migration foi medido aqui: 2.087 MB de tabela, sendo 1.492 MB
-- de UM índice (`idx_snapshots_event_time`) sobre 80 MB de dado real. Não era
-- volume, era bloat — B-tree não devolve página ao sistema depois de DELETE, e a
-- retenção deleta em ciclo.
--
-- O que muda agora: a série do radar é ISENTA da retenção (`radar_tracked`,
-- migration 20260813210119). Nada a apaga, nunca. Com o teto de 300 mercados e
-- foto a cada 15 min são ~28,8 mil linhas/dia, ~10,5 milhões/ano — e um índice
-- único cobrindo isso só cresce.
--
-- Converter hoje custa segundos porque a tabela tem 96 mil linhas. Converter
-- depois de um ano de coleta é operação de risco em produção, com a série que
-- ninguém pode perder dentro. Esta é a janela.
--
-- ---------------------------------------------------------------------------
-- 1. A chave de partição: RANGE (captured_at), por MÊS
-- ---------------------------------------------------------------------------
--
-- Por `captured_at` porque é a única coluna monotônica da tabela: linha nova
-- sempre entra na partição mais recente, e partição antiga para de receber
-- escrita — que é exatamente a condição para o índice dela parar de inchar.
--
-- Por MÊS e não por dia, ao contrário de `esports_snapshots`, e a diferença tem
-- causa. Lá a partição de dia existe para ser DROPADA todo dia: a retenção é
-- `DROP PARTITION`, e o dia é a granularidade da poda. Aqui **nada é dropado** —
-- a série do radar é permanente. Partição de dia daria 365 tabelas por ano que
-- nunca somem; em três anos são mais de mil, e planejamento de query cresce com
-- o número de partições mesmo com pruning. Por mês são 12 por ano, cada uma com
-- ~900 mil linhas no teto de hoje: índice de dezenas de MB, não de 1,5 GB.
--
-- ---------------------------------------------------------------------------
-- O que o particionamento resolve aqui — e o que ele NÃO resolve
-- ---------------------------------------------------------------------------
--
-- RESOLVE, e é o motivo de existir:
--
--   1. O bloat fica CONFINADO ao mês corrente. Quem deleta em ciclo é o ramo
--      `old` da retenção, e ele só alcança linha desprotegida — que na prática é
--      o `open_legs_collector`, com 24h de validade. Ou seja: o DELETE toca a
--      partição do mês atual e nunca mais volta às anteriores. O índice de um mês
--      fechado nasce compacto e fica.
--   2. O índice deixa de ser um objeto único gigante. `REINDEX` volta a ser
--      viável: uma partição por vez, minutos em vez de horas, sem tocar o resto.
--   3. Leitura de janela curta (que é toda leitura de série) pruna para uma ou
--      duas partições em vez de varrer o histórico inteiro.
--
-- NÃO RESOLVE, e dizer isso é metade do valor deste comentário:
--
--   A retenção continua sendo DELETE, não `DROP PARTITION`. Não dá para dropar
--   uma partição de mês porque dentro dela convivem os dois regimes: linha
--   protegida (radar e esports legado, que nunca podem sumir) e linha
--   descartável (open_legs, 24h). Dropar o mês levaria as duas.
--
--   Fazer a retenção virar DROP exigiria separar os regimes NA CHAVE — por
--   exemplo `PARTITION BY LIST (origem)` e, dentro de cada uma, `BY RANGE
--   (captured_at)`. É o desenho certo para o problema, e não está aqui de
--   propósito: exige coluna nova preenchida por TODOS os produtores (coletor,
--   open_legs, early_markets, radar), e essa é uma migration com mudança de
--   código junto, não uma conversão de tabela. Fica registrado como o caminho,
--   não como pendência esquecida.
--
-- ---------------------------------------------------------------------------
-- 2. O que acontece com as 96 mil linhas, e por quanto tempo a tabela trava
-- ---------------------------------------------------------------------------
--
-- Postgres não converte tabela comum em particionada no lugar. O caminho é
-- renomear, criar a nova particionada e COPIAR as linhas — o que este arquivo
-- faz, em UMA transação. Detalhes que decidem o horário do apply:
--
--   * A transação inteira segura ACCESS EXCLUSIVE sobre o nome
--     `polymarket_snapshots`. Enquanto ela roda, quem escreve ou lê ESPERA (e
--     estoura se passar do timeout de 8s do PostgREST).
--   * O trabalho real é um `INSERT ... SELECT` de 96 mil linhas com dois índices
--     a manter. Ordem de grandeza: **poucos segundos** — conte com até 30 s de
--     folga num banco ocupado. Não é uma janela de madrugada; é uma janela de
--     cafezinho.
--   * Quem escreve nesta tabela hoje é só o `open_legs_collector`, a cada 10 s,
--     e ele já trata falha de chunk como erro logado que não derruba o ciclo. O
--     pior caso é uma foto de posição perdida. O coletor do radar está
--     desligado, e é por isso que a ordem certa é **particionar antes de ligar**.
--   * A tabela antiga **não é dropada aqui**. Ela fica como
--     `polymarket_snapshots_legado`, com as 96 mil linhas originais intactas, e o
--     `drop` é um comando manual depois da conferência — está no fim do arquivo.
--     Conversão sem volta não se faz no mesmo comando que a conferência.
--
-- ---------------------------------------------------------------------------
-- 3. O que muda no CONTRATO da tabela (e é pouco, mas não é nada)
-- ---------------------------------------------------------------------------
--
--   a) A PK vira `(id, captured_at)`. Postgres exige que toda unique constraint
--      de tabela particionada contenha a chave de partição. `id` continua único
--      na prática (vem da mesma sequence) e continua indexado como coluna à
--      esquerda da PK, então busca por `id` sozinho segue usando índice.
--   b) `captured_at` vira NOT NULL. Já era na prática — todo produtor carimba, e
--      quem não carimbasse pegava o `default now()`. Coluna de particionamento
--      com NULL só cairia na partição default, que é rede de segurança e não
--      destino.
--   c) A sequence é a MESMA (`polymarket_snapshots_id_seq`), então os ids
--      continuam a série de onde pararam e os grants existentes sobre ela seguem
--      valendo.
--   d) A FK para `events` com `ON DELETE CASCADE` é preservada como estava. Vale
--      dizer em voz alta o que ela significa depois desta migration: uma poda de
--      `events` apaga a série protegida junto, e `radar_tracked` não defende
--      contra isso — ele defende da retenção de snapshots, não do cascade. Não é
--      um defeito novo (existe desde a 001) e não é consertado aqui; é o tipo de
--      coisa que só se paga uma vez, e só se souber.

-- ---------------------------------------------------------------------------
-- A conversão — TEM que ser atômica
-- ---------------------------------------------------------------------------
--
-- Este arquivo não abre transação explícita de propósito: `supabase db push`
-- aplica cada migration dentro de uma, e um `begin`/`commit` aqui dentro
-- comitaria a transação externa no meio do caminho — o oposto do que se quer.
--
-- Mas a exigência é real e vale dizer: entre o `rename` e o `create table` não
-- existe `polymarket_snapshots`. Se o arquivo for aplicado fora de transação e
-- falhar no meio, a tabela some do nome que todo mundo usa e o sistema para.
-- Aplicando à mão, é `psql -1 -f` (o `-1` é a transação única), nunca statement
-- a statement.
--
-- Dependência: `radar_event_ids()`, da 20260813210119, que já está aplicada — a
-- reescrita da retenção lá no fim a chama.

alter table public.polymarket_snapshots
  rename to polymarket_snapshots_legado;

-- Os nomes de índice são globais no schema: sem renomear, o `create table` novo
-- colide com os índices da tabela antiga.
--
-- Feito por consulta ao catálogo em vez de por nome fixo. `polymarket_snapshots_pkey`
-- é o nome que o `bigserial primary key` da 001 gera, mas a tabela passou por um
-- dump de baseline e por um restore, e um nome de índice que não bate derrubaria
-- a migration inteira num ponto em que ela já renomeou a tabela. Renomear o que
-- existe é mais curto do que torcer.
do $$
declare
  idx record;
begin
  for idx in
    select c.relname
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_class t on t.oid = i.indrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'polymarket_snapshots_legado'
       and c.relname not like '%_legado%'
  loop
    execute format('alter index public.%I rename to %I', idx.relname, idx.relname || '_legado');
  end loop;
end $$;

create table public.polymarket_snapshots (
  id          bigint      not null default nextval('public.polymarket_snapshots_id_seq'),
  event_id    uuid        references public.events (id) on delete cascade,
  outcome     text        not null,
  best_bid    numeric(5,4),
  best_ask    numeric(5,4),
  mid_price   numeric(5,4),
  spread      numeric(5,4),
  bid_depth   numeric(14,2),
  ask_depth   numeric(14,2),
  volume_24h  numeric(14,2),
  captured_at timestamptz not null default now(),
  primary key (id, captured_at)
) partition by range (captured_at);

comment on table public.polymarket_snapshots is
  'Serie temporal de preco. Particionada por MES em captured_at desde 20260814. Mes e nao dia porque nada e dropado aqui: a serie do radar (radar_tracked) e isenta da retencao. O particionamento confina o bloat de DELETE ao mes corrente — a retencao continua sendo DELETE, nao DROP PARTITION, porque linha protegida e linha descartavel convivem no mesmo intervalo de tempo.';

alter sequence public.polymarket_snapshots_id_seq
  owned by public.polymarket_snapshots.id;

-- O mesmo índice de antes, criado no PAI: o Postgres o replica em toda partição
-- nova, e cada uma indexa só o próprio mês.
create index idx_snapshots_event_time
  on public.polymarket_snapshots (event_id, captured_at desc);

alter table public.polymarket_snapshots
  enable row level security;

-- Grants idênticos aos que a tabela tinha no baseline (20260804054445).
grant delete, insert, select, update on public.polymarket_snapshots to anon;
grant delete, insert, select, update on public.polymarket_snapshots to authenticated;
grant delete, insert, select, update on public.polymarket_snapshots to service_role;

-- ---------------------------------------------------------------------------
-- As partições: uma para todo o passado, uma para cada mês daqui em diante
-- ---------------------------------------------------------------------------
--
-- O limite do passado é calculado na hora do apply, e não escrito à mão, porque
-- ninguém sabe em que dia esta migration vai ser aplicada. Uma data fixa aqui
-- viraria um buraco silencioso se o apply escorregasse para o mês seguinte.

do $$
declare
  inicio_do_mes timestamptz :=
    (date_trunc('month', (now() at time zone 'utc')) at time zone 'utc');
begin
  execute format(
    'create table public.polymarket_snapshots_historico
       partition of public.polymarket_snapshots
       for values from (minvalue) to (%L)',
    inicio_do_mes
  );
  execute 'alter table public.polymarket_snapshots_historico enable row level security';
  execute 'revoke all on public.polymarket_snapshots_historico from anon, authenticated';
end $$;

comment on table public.polymarket_snapshots_historico is
  'Tudo que foi capturado antes do mes em que a particao foi criada. Uma particao so, porque o passado nao cresce mais.';

-- Rede de segurança, no mesmo desenho de `esports_snapshots_default`: sem ela,
-- uma linha com `captured_at` fora de toda partição derruba o CHUNK inteiro do
-- insert (500 linhas). Com ela a linha é gravada e o problema vira número.
-- Não é destino: nada a esvazia, e linha aqui é para investigar.
create table public.polymarket_snapshots_default
  partition of public.polymarket_snapshots default;

alter table public.polymarket_snapshots_default
  enable row level security;

-- As default privileges deste banco dão DML a `anon` em toda tabela nova do
-- schema public, e RLS sem policy só protege quem passa pelo pai. Partição
-- acessada direto pelo PostgREST responde com as próprias permissões.
revoke all on public.polymarket_snapshots_default from anon, authenticated;

-- ---------------------------------------------------------------------------
-- A cópia
-- ---------------------------------------------------------------------------
--
-- Colunas listadas uma a uma de propósito: `insert ... select *` casaria por
-- POSIÇÃO, e a ordem das colunas da tabela nova não é obrigada a ser a da antiga
-- para sempre. Um `spread` gravado em `bid_depth` não daria erro — daria série
-- errada.
--
-- `coalesce(captured_at, now())` porque a coluna era nullable e agora é chave de
-- partição. Se houver linha antiga sem carimbo (não deveria haver), ela entra com
-- o instante da conversão em vez de derrubar a migration inteira.

insert into public.polymarket_snapshots
  (id, event_id, outcome, best_bid, best_ask, mid_price, spread,
   bid_depth, ask_depth, volume_24h, captured_at)
select
  id, event_id, outcome, best_bid, best_ask, mid_price, spread,
  bid_depth, ask_depth, volume_24h, coalesce(captured_at, now())
from public.polymarket_snapshots_legado;

-- A sequence continua de onde estava, mas o `setval` é a garantia: se ela tiver
-- ficado para trás por qualquer motivo, o próximo insert colidiria com um id já
-- usado — agora que a PK é (id, captured_at), a colisão nem sempre erra, e o que
-- sai disso é id duplicado em silêncio.
select setval(
  'public.polymarket_snapshots_id_seq',
  greatest(coalesce((select max(id) from public.polymarket_snapshots), 0), 1),
  true
);

-- ---------------------------------------------------------------------------
-- Manutenção: criar os meses seguintes. NUNCA dropar.
-- ---------------------------------------------------------------------------
--
-- A diferença mais importante em relação a `manage_esports_partitions`: aquela
-- cria E dropa; esta só cria. Não há retenção por partição aqui, e um `drop`
-- levaria série protegida junto. Se um dia for preciso podar, o caminho é a
-- separação por regime descrita lá em cima — não acrescentar um drop nesta
-- função.
--
-- SECURITY DEFINER porque cria tabela; por isso o EXECUTE é revogado de `anon` e
-- `authenticated` no fim.

create or replace function public.manage_polymarket_snapshot_partitions (
  lookahead_months integer DEFAULT 2
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $function$
DECLARE
  mes_atual    date := date_trunc('month', (now() at time zone 'utc'))::date;
  passo        integer;
  mes          date;
  part_name    text;
  created      text[] := '{}';
  errors       text[] := '{}';
  default_rows integer;
BEGIN
  FOR passo IN 0..greatest(coalesce(lookahead_months, 2), 1) LOOP
    mes := (mes_atual + (passo || ' months')::interval)::date;
    part_name := 'polymarket_snapshots_p' || to_char(mes, 'YYYYMM');

    CONTINUE WHEN EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = part_name
    );

    BEGIN
      -- Limites em UTC explícito: o nome vem do mês UTC, e deixar o fuso da
      -- sessão decidir faria os dois discordarem na virada.
      EXECUTE format(
        'create table public.%I partition of public.polymarket_snapshots for values from (%L) to (%L)',
        part_name,
        mes::timestamp at time zone 'utc',
        (mes + interval '1 month')::timestamp at time zone 'utc'
      );
      EXECUTE format('alter table public.%I enable row level security', part_name);
      EXECUTE format('revoke all on public.%I from anon, authenticated', part_name);
      created := created || part_name;
    EXCEPTION WHEN others THEN
      -- Falha típica: linha na partição default dentro do intervalo do mês novo.
      -- Um mês que falha não pode impedir os outros de serem criados.
      errors := errors || format('create %s: %s', part_name, sqlerrm);
    END;
  END LOOP;

  -- Contagem limitada: se a default encheu, o que importa é saber que encheu —
  -- não pagar um count(*) completo para descobrir.
  EXECUTE 'select count(*)::int from (select 1 from public.polymarket_snapshots_default limit 1000) s'
    INTO default_rows;

  RETURN jsonb_build_object(
    'month_utc', to_char(mes_atual, 'YYYY-MM'),
    'created', to_jsonb(created),
    -- > 0 = linha fora de toda partição de mês. Ou o job ficou parado meses, ou
    -- chegou `captured_at` com data absurda.
    'default_rows_at_least', default_rows,
    'errors', to_jsonb(errors)
  );
END;
$function$;

comment on function public.manage_polymarket_snapshot_partitions(integer) is
  'Cria as particoes de mes de polymarket_snapshots. NUNCA dropa: a serie do radar e isenta da retencao e um drop levaria linha protegida junto. Chamada pelo job esports_partitions, no mesmo cron diario.';

revoke all on function public.manage_polymarket_snapshot_partitions(integer)
  from public, anon, authenticated;

grant execute on function public.manage_polymarket_snapshot_partitions(integer) to service_role;

-- Cria as partições do mês corrente e dos dois seguintes já no apply: sem isto,
-- o primeiro insert depois da conversão cairia na default até o job diário rodar.
select public.manage_polymarket_snapshot_partitions(2);

-- ---------------------------------------------------------------------------
-- A retenção continua funcionando — e passa a PRUNAR
-- ---------------------------------------------------------------------------
--
-- O corpo abaixo é o da 20260813210119 (a que soma `radar_event_ids()` à
-- proteção) com UMA diferença, e ela é sobre partição: o `DELETE` deixa de casar
-- só por `id` e passa a casar por `(id, captured_at)`.
--
-- Por quê: `DELETE ... WHERE id IN (...)` numa tabela particionada não tem como
-- prunar — o planner não sabe em qual mês cada id está, e sonda o índice das
-- DOZE partições para cada lote de 5.000. Com `captured_at` no join, cada linha
-- vai direto na partição dela.
--
-- A proteção é idêntica: `esports_event_ids() || radar_event_ids()`, comparada
-- por id, resolvida uma vez por chamada. Nada muda para `radar_tracked`.

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
      SELECT s.id, s.captured_at
        FROM public.polymarket_snapshots s
       WHERE s.captured_at < NOW() - (retention_hours || ' hours')::interval
         AND NOT EXISTS (
           SELECT 1 FROM protected p WHERE p.event_id = s.event_id
         )
       ORDER BY s.captured_at
       LIMIT batch_size
    ),
    deleted AS (
      DELETE FROM public.polymarket_snapshots s
       USING to_delete d
       WHERE s.id = d.id
         AND s.captured_at = d.captured_at
      RETURNING 1
    )
    SELECT count(*) INTO deleted_count FROM deleted;

  ELSIF delete_type = 'finalized' THEN
    WITH protected AS MATERIALIZED (
      SELECT unnest(protected_ids) AS event_id
    ),
    to_delete AS (
      SELECT s.id, s.captured_at
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
      DELETE FROM public.polymarket_snapshots s
       USING to_delete d
       WHERE s.id = d.id
         AND s.captured_at = d.captured_at
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
  'Retencao em lote de polymarket_snapshots, agora particionada por mes. NUNCA apaga snapshot de esports nem de event com radar_tracked. O DELETE casa por (id, captured_at) para prunar particao — so por id, o planner sondaria o indice de todas. Spec 000 item 8, mais a protecao do radar.';

-- ---------------------------------------------------------------------------
-- Verificação depois do apply, ANTES de ligar a coleta
-- ---------------------------------------------------------------------------
--
--   -- 1. as partições existem e a contagem bate com a tabela antiga
--   select count(*) as novo from public.polymarket_snapshots;
--   select count(*) as legado from public.polymarket_snapshots_legado;
--   -- os dois números têm que ser iguais
--
--   -- 2. onde as linhas caíram
--   select tableoid::regclass as particao, count(*)
--     from public.polymarket_snapshots group by 1 order by 1;
--   -- espera tudo em _historico; ZERO em _default
--
--   -- 3. o índice está em cada partição, e a leitura de série pruna
--   explain (analyze, buffers)
--   select * from public.polymarket_snapshots
--    where event_id = (select id from public.events limit 1)
--      and captured_at > now() - interval '2 days'
--    order by captured_at desc limit 10;
--   -- espera Index Scan em UMA ou DUAS partições, não em todas
--
--   -- 4. a retenção roda e continua protegendo
--   select public.run_snapshot_retention_batch('old', 24, 100);
--   select count(*) from public.polymarket_snapshots s
--     join public.events e on e.id = s.event_id where e.radar_tracked;
--   -- o segundo número não pode cair (hoje é 0, porque nada foi marcado ainda)
--
--   -- 5. escrita nova entra na partição do mês
--   select max(captured_at), tableoid::regclass
--     from public.polymarket_snapshots group by 2;
--
--   -- 6. o PostgREST enxerga a tabela nova. O Supabase recarrega o cache de
--   --    schema sozinho no DDL, mas se algum cliente responder 404 ou
--   --    PGRST205 para `polymarket_snapshots`, é isto e não pânico:
--   notify pgrst, 'reload schema';
--
-- Só depois disso, e só se os cinco passarem:
--
--   drop table public.polymarket_snapshots_legado;
--
-- A tabela antiga fica de propósito até esse comando. Ela ocupa ~20 MB e é a
-- única volta atrás que existe — conversão não tem desfazer, e conferir com o
-- original ainda no disco custa menos que descobrir depois.
--
-- O `drop` é seguro para a sequence: o `alter sequence ... owned by` acima
-- transferiu a posse dela para a tabela nova, então ela NÃO vai junto. Sem essa
-- linha, dropar o legado levaria a sequence e o próximo insert erraria — é o
-- tipo de detalhe que só aparece semanas depois, quando ninguém mais liga uma
-- coisa à outra.
