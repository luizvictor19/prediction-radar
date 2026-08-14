-- As 91.728 linhas foram para a partição DEFAULT, não para `_historico`.
--
-- ---------------------------------------------------------------------------
-- O que aconteceu, e é ordem de statement, não erro de desenho
-- ---------------------------------------------------------------------------
--
-- A 20260814014541 faz, nesta ordem:
--
--   1. cria `_historico`   for values from (minvalue) to (date_trunc('month', now()))
--   2. cria `_default`
--   3. INSERT ... SELECT das 91.728 linhas vindas do legado
--   4. select manage_polymarket_snapshot_partitions(2)   <- cria p202608, p202609, p202610
--
-- No passo 3 as ÚNICAS partições que existem são `_historico` e `_default`. E o
-- limite superior de `_historico` é o começo do mês CORRENTE — 2026-08-01. Toda
-- linha copiada tem `captured_at` em 2026-08-05 (medido: mínimo
-- 2026-08-05T04:45Z, máximo 2026-08-05T22:57Z, nenhuma antes de 2026-08-01).
-- Ou seja: nenhuma delas cabe em `_historico`, e as 91.728 foram roteadas para
-- `_default`, que é rede de segurança e não destino.
--
-- No passo 4, criar `p202608` para [2026-08-01, 2026-09-01) exige provar que a
-- default não contém linha daquele intervalo. Contém 91.728. O Postgres levanta
--
--   updated partition constraint for default partition
--   "polymarket_snapshots_default" would be violated by some row
--
-- e a função ENGOLE o erro de propósito (`EXCEPTION WHEN others`, para que um mês
-- que falha não impeça os outros). O erro voltou no jsonb `errors`, e o `select`
-- solto no fim da migration descartou o jsonb. Falha silenciosa, migration verde.
--
-- `p202609` e `p202610` foram criadas normalmente: não há linha nesses meses.
--
-- Nada se perdeu — `polymarket_snapshots` e `polymarket_snapshots_legado` têm as
-- mesmas 91.728 linhas e o mesmo `max(id)` = 91.520.295. O defeito é de LUGAR.
--
-- ---------------------------------------------------------------------------
-- Por que isso não pode ficar como está
-- ---------------------------------------------------------------------------
--
--   1. Enquanto houver linha de agosto na default, `p202608` NUNCA pode ser
--      criada. O job diário vai tentar e falhar todo dia, para sempre.
--   2. Com o coletor ligado agora (agosto), toda foto nova cai na default também
--      — a default vira a partição de agosto de facto, sem poder ser destacada,
--      reindexada ou dumpada como as outras. É exatamente o objeto único que
--      cresce sozinho que a partição existe para não ter.
--   3. `default_rows_at_least > 0` marca o job de partições como `partial` todo
--      dia. Alarme permanente é alarme desligado.
--
-- A partir de setembro o roteamento volta ao normal sozinho (p202609 existe), o
-- que torna isto uma janela: consertar agora custa um `insert` de 91.728 linhas;
-- consertar em outubro custa mover um mês de coleta do radar junto.
--
-- ---------------------------------------------------------------------------
-- A ordem certa, para quem reler a 20260814014541
-- ---------------------------------------------------------------------------
--
-- O conserto de raiz naquele arquivo é uma linha de lugar: `select
-- manage_polymarket_snapshot_partitions(2)` tem que vir ANTES do `INSERT ...
-- SELECT`, não depois. Aquela migration já foi aplicada e não se reescreve —
-- este arquivo é o conserto, e o registro de por quê.
--
-- (`_historico` fica como está: vazia e correta. Ela cobre "antes do mês da
-- conversão", e não havia nada lá. Quem apagou o passado foi a retenção, muito
-- antes desta conversão.)
--
-- ---------------------------------------------------------------------------
-- Como este arquivo conserta
-- ---------------------------------------------------------------------------
--
-- Não dá para criar `p202608` com a default cheia, e não dá para esvaziar a
-- default sem ter para onde mandar as linhas. O caminho é DETACH:
--
--   1. `detach` a default    -> ela vira tabela comum, e o pai fica sem default
--   2. `create` p202608      -> agora não há default para validar; passa
--   3. `insert ... select`   -> reinsere pelo PAI, que roteia para p202608
--   4. `truncate` a default  -> ela está fora do pai, isto não toca a série
--   5. `attach` de volta     -> a rede de segurança volta ao lugar, vazia
--
-- IDEMPOTENTE de propósito: se `p202608` já existir e a default já estiver
-- vazia, o bloco não faz nada e a migration passa. Vale para o caso de o
-- conserto ter sido feito à mão antes deste apply.
--
-- ATÔMICO, e a exigência é real: entre o `detach` e o `attach` a tabela fica sem
-- partição default, e uma linha com `captured_at` fora de todo mês seria
-- REJEITADA em vez de acolhida. Aplicando à mão é `psql -1 -f`, nunca statement
-- a statement. (Este arquivo não abre transação explícita porque o `db push` já
-- aplica cada migration dentro de uma; um `begin` aqui comitaria a de fora.)
--
-- Quem escreve nesta tabela hoje é o `open_legs_collector`, a cada 10 s, e ele
-- trata falha de chunk como erro logado. O coletor do radar continua desligado.
-- O trabalho real é um `insert` de 91.728 linhas com dois índices a manter:
-- poucos segundos. Janela de cafezinho, como a conversão foi.

do $$
declare
  p_agosto  text := 'polymarket_snapshots_p' || to_char(
    date_trunc('month', (now() at time zone 'utc'))::date, 'YYYYMM');
  inicio    timestamptz := (date_trunc('month', (now() at time zone 'utc')) at time zone 'utc');
  fim       timestamptz := ((date_trunc('month', (now() at time zone 'utc')) + interval '1 month') at time zone 'utc');
  presas    bigint;
  movidas   bigint;
begin
  -- Quantas linhas estão na default DENTRO do mês corrente. É a pergunta exata:
  -- linha de outro mês na default é outro problema (data absurda) e não se
  -- conserta movendo para cá.
  execute format(
    'select count(*) from public.polymarket_snapshots_default where captured_at >= %L and captured_at < %L',
    inicio, fim
  ) into presas;

  if presas = 0 and to_regclass('public.' || p_agosto) is not null then
    raise notice 'nada a fazer: % existe e a default nao tem linha do mes', p_agosto;
    return;
  end if;

  raise notice 'movendo % linhas da default para %', presas, p_agosto;

  -- 1. A default sai do pai. Ela continua existindo como tabela comum, com as
  --    linhas dentro — nada é apagado neste passo.
  alter table public.polymarket_snapshots
    detach partition public.polymarket_snapshots_default;

  -- 2. Agora a partição do mês pode nascer: não há mais default a validar.
  if to_regclass('public.' || p_agosto) is null then
    execute format(
      'create table public.%I partition of public.polymarket_snapshots for values from (%L) to (%L)',
      p_agosto, inicio, fim
    );
    execute format('alter table public.%I enable row level security', p_agosto);
    -- As default privileges deste banco dão DML a `anon` em toda tabela nova do
    -- schema public, e partição acessada direto pelo PostgREST responde com as
    -- proprias permissoes. Mesmo revoke das outras partições.
    execute format('revoke all on public.%I from anon, authenticated', p_agosto);
  end if;

  -- 3. Reinserção pelo PAI — é o pai que roteia. Colunas listadas uma a uma
  --    pelo mesmo motivo da conversão: `select *` casaria por POSIÇÃO, e um
  --    `spread` gravado em `bid_depth` não daria erro, daria série errada.
  --
  --    Só o que é do mês: se houver linha com data absurda na default, ela FICA
  --    lá para ser investigada, que é para isso que a default serve.
  insert into public.polymarket_snapshots
    (id, event_id, outcome, best_bid, best_ask, mid_price, spread,
     bid_depth, ask_depth, volume_24h, captured_at)
  select
    id, event_id, outcome, best_bid, best_ask, mid_price, spread,
    bid_depth, ask_depth, volume_24h, captured_at
  from public.polymarket_snapshots_default
  where captured_at >= inicio and captured_at < fim;

  get diagnostics movidas = row_count;

  if movidas <> presas then
    -- Nunca deveria acontecer dentro da mesma transação. Se acontecer, é melhor
    -- abortar com a default intacta do que apagar o que não foi copiado.
    raise exception 'copiadas % de % linhas — abortando com a default intacta', movidas, presas;
  end if;

  -- 4. A default está fora do pai; apagar aqui não toca a série, que já está em
  --    p202608. `delete` e não `truncate`: preserva linha de mês estranho.
  delete from public.polymarket_snapshots_default
   where captured_at >= inicio and captured_at < fim;

  -- 5. A rede de segurança volta, vazia.
  alter table public.polymarket_snapshots
    attach partition public.polymarket_snapshots_default default;

  raise notice 'ok: % linhas em %, default de volta ao pai', movidas, p_agosto;
end $$;

-- A sequence, de novo. O `insert` acima usa ids explícitos e não a toca; este
-- `setval` é a mesma garantia da conversão, e custa uma leitura de índice.
select setval(
  'public.polymarket_snapshots_id_seq',
  greatest(coalesce((select max(id) from public.polymarket_snapshots), 0), 1),
  true
);

comment on table public.polymarket_snapshots_default is
  'Rede de seguranca: linha com captured_at fora de toda particao de mes. NAO e destino — linha aqui e para investigar. Em 20260814 ela recebeu as 91.728 linhas da conversao por ordem de statement (a particao do mes ainda nao existia no momento do insert) e foi esvaziada por 20260814024742.';

-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- 1. onde as linhas estão agora
--   select tableoid::regclass as particao, count(*), min(captured_at), max(captured_at)
--     from public.polymarket_snapshots group by 1 order by 1;
--   -- espera: tudo em _p202608; ZERO em _default; _historico vazia
--
--   -- 2. o total não mudou
--   select count(*) from public.polymarket_snapshots;    -- 91728
--   select count(*) from public.polymarket_snapshots_legado;  -- 91728
--
--   -- 3. a default está de volta como default do pai
--   select c.relname, pg_get_expr(c.relpartbound, c.oid) as bound
--     from pg_class c
--     join pg_inherits i on i.inhrelid = c.oid
--    where i.inhparent = 'public.polymarket_snapshots'::regclass
--    order by 1;
--   -- espera: _default DEFAULT, _historico FROM (MINVALUE) TO ('2026-08-01...'),
--   --         _p202608, _p202609, _p202610
--
--   -- 4. o job diário para de reclamar
--   select public.manage_polymarket_snapshot_partitions(2);
--   -- espera: created [] (ou o mês que faltava), errors [], default_rows_at_least 0
--
--   -- 5. a retenção continua protegendo
--   select public.run_snapshot_retention_batch('old', 24, 100);
--
-- Só depois disso, e só se os cinco passarem, o drop do legado da 20260814014541:
--
--   drop table public.polymarket_snapshots_legado;
