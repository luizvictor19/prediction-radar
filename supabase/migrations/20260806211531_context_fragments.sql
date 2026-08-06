-- Spec 001, item 4 (Parte A5) — `context_fragments`: o registro append-only do
-- contexto de cada partida.
--
-- Cria uma tabela, dois triggers de guarda e duas funções de retenção. Nenhuma
-- tabela existente é alterada e nenhum job passa a chamar nada: aplicar isto não
-- muda comportamento nenhum em produção. O que ele faz é abrir a porta para o
-- item 5 — sem esta tabela, todo enricher escreveria no vazio.
--
-- ---------------------------------------------------------------------------
-- Por que antes de existir enricher algum
-- ---------------------------------------------------------------------------
--
-- Dataset de eval só pode ser montado a partir do instante em que se começou a
-- gravar. Não há re-busca que reconstrua "o que se sabia às 14h de ontem": as
-- fontes de contexto ou não têm histórico, ou têm e reescrevem. Cada dia sem
-- esta tabela é uma linha de série que não existirá nunca — e é por isso que a
-- spec pede este item antes de qualquer integração, e não depois.

-- ---------------------------------------------------------------------------
-- A tabela
-- ---------------------------------------------------------------------------
--
-- `enricher_id` é text livre, sem FK: o registro de enrichers vive no código
-- (`src/verticals/enricher.ts`), não no banco. Uma tabela de enrichers seria uma
-- segunda fonte de verdade sobre quem existe, que divergiria do código no
-- primeiro deploy. Quem garante a unicidade do id é `registerEnricher`.
--
-- `kind` também fica sem CHECK de vocabulário, pela mesma razão que
-- `market_match_links.market_role`: cada enricher novo traz uma família nova, e
-- restringir aqui transformaria "chegou um enricher" em erro de migration.

create table if not exists public.context_fragments (
  id           bigserial primary key,
  match_id     uuid        not null references public.esports_matches (id) on delete cascade,
  enricher_id  text        not null,
  kind         text        not null,
  as_of        timestamptz not null,
  observed_at  timestamptz not null default now(),
  payload      jsonb       not null,
  summary      text        not null,
  confidence   numeric(3,2) not null default 1.0,

  constraint context_fragments_confidence_range
    check (confidence >= 0 and confidence <= 1),

  -- Summary vazio passa em `not null` e não carrega nada: é o texto que o LLM
  -- lê, e uma linha sem ele engorda o dataset sem informar. O runner já recusa
  -- o fragmento antes de enviar; isto é o fundo do poço, para quem escrever por
  -- fora dele.
  constraint context_fragments_summary_not_blank
    check (length(btrim(summary)) > 0),

  -- A única combinação dos dois tempos que é impossível por definição: saber de
  -- um fato ANTES de ele ser verdade.
  --
  -- A folga de 1h existe porque `as_of` é carimbado pelo processo Node e
  -- `observed_at` pelo servidor do Postgres. São relógios diferentes, e uma
  -- diferença de segundos entre eles não pode virar erro de gravação — enquanto
  -- uma diferença de horas é fabricação de conhecimento futuro, que é o que este
  -- CHECK existe para recusar.
  --
  -- O runner já descarta esse fragmento antes de enviar, e com margem menor (5
  -- min). A diferença de papel importa: lá o fragmento ruim é descartado sozinho;
  -- aqui ele derruba o chunk inteiro, porque cada lote é uma transação. Este
  -- CHECK é o fundo do poço para quem escrever por fora do runner, não a primeira
  -- linha de defesa.
  constraint context_fragments_as_of_not_ahead
    check (as_of <= observed_at + interval '1 hour')
);

comment on table public.context_fragments is
  'Fragmentos de contexto por partida, APPEND-ONLY: informacao nova e linha nova, nunca UPDATE (garantido por trigger). Base do dataset de eval. Spec 001, A5.';

-- ---------------------------------------------------------------------------
-- `as_of` e `observed_at`: duas colunas porque são dois fatos diferentes
-- ---------------------------------------------------------------------------
--
--   `as_of`       = quando o fato era verdade. O roster foi anunciado às 14h.
--   `observed_at` = quando NÓS soubemos. Nosso fetch rodou às 18h.
--
-- Replay de eval filtra por `observed_at <= T`. NUNCA por `as_of`. A diferença é
-- a linha entre um backtest e uma mentira: fontes fazem backfill, e um fragmento
-- com `as_of` de 14h só entrou no nosso banco às 18h. Filtrar por `as_of`
-- entregaria ao modelo, no instante T=15h, uma informação que naquele instante
-- ninguém tinha — e o eval devolveria um número que a operação real nunca
-- reproduz.
--
-- Colapsar as duas em uma só coluna parece economia até o primeiro enricher com
-- backfill. Aí não há como separar, e o histórico inteiro fica contaminado sem
-- sintoma visível.

comment on column public.context_fragments.as_of is
  'Momento a que a INFORMACAO se refere (roster anunciado as 14h). Pode ser muito anterior a observed_at quando a fonte faz backfill. NUNCA usar como filtro de replay.';

comment on column public.context_fragments.observed_at is
  'Momento em que NOS coletamos. Carimbado pelo servidor via trigger, nunca pelo cliente. E o unico filtro valido de replay: observed_at <= T. Spec 001, A5.';

comment on column public.context_fragments.enricher_id is
  'Id do enricher que produziu a linha. Sem FK: o registro vive em src/verticals/enricher.ts, e registerEnricher e quem garante unicidade.';

comment on column public.context_fragments.kind is
  'Familia do fragmento: roster, map_pool, h2h, odds, news. Sem CHECK — enricher novo traz familia nova, e isso nao pode ser erro de migration.';

comment on column public.context_fragments.summary is
  'Texto curto (1-3 frases) que o LLM le. O payload guarda o dado estruturado; este campo guarda a leitura dele.';

comment on column public.context_fragments.confidence is
  'Confianca na fonte, [0,1]. Texto gerado por LLM de terceiro entra baixo (<= 0.4, ver Parte D da spec); fonte primaria entra em 1.0.';

-- ---------------------------------------------------------------------------
-- Append-only, garantido pelo banco e não pela boa vontade do código
-- ---------------------------------------------------------------------------
--
-- O trigger faz duas coisas, e as duas fecham buracos que um comentário não
-- fecharia:
--
-- 1. UPDATE levanta exceção. "Informação nova é linha nova" é o que dá sentido à
--    série: um fragmento corrigido em UPDATE apaga o que nós de fato sabíamos
--    quando decidimos, e o replay passa a ler a versão corrigida como se ela
--    estivesse lá desde o começo. Isso vale para UPSERT também
--    (`ON CONFLICT DO UPDATE` dispara este trigger e falha) — que é o modo mais
--    provável de o erro entrar sem ninguém perceber.
--
-- 2. `observed_at` é carimbado aqui, sobrescrevendo o que vier do cliente. É a
--    única forma de a coluna ser inforjável, e o erro que ela introduz tem
--    direção conhecida: o carimbo do servidor é sempre >= o instante real do
--    fetch (a linha viaja depois de coletada). `observed_at` tarde demais faz o
--    replay CONSIDERAR MENOS do que sabíamos naquele T. Subestimar conhecimento
--    é conservador; superestimar é vazamento. O erro que sobra é o inofensivo.
--
-- DELETE continua livre — a retenção lá embaixo depende dele. A assimetria é
-- proposital: apagar o fim da série encurta o histórico, reescrever o meio dele
-- corrompe.
--
-- Se um dia houver importação legítima de fragmentos históricos (migrar de outro
-- store, por exemplo), ela exige DROP deste trigger, de propósito. O atrito é o
-- ponto: backdatear `observed_at` é exatamente a operação que envenena o eval, e
-- ela tem que ser uma decisão consciente e não um INSERT a mais.

create or replace function public.context_fragments_guard ()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public
  AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'context_fragments e append-only: informacao nova e linha nova, nunca UPDATE (spec 001, A5)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.observed_at := now();
  RETURN NEW;
END;
$function$;

comment on function public.context_fragments_guard() is
  'Recusa UPDATE em context_fragments e carimba observed_at com o relogio do servidor. Spec 001, A5.';

drop trigger if exists context_fragments_guard on public.context_fragments;

create trigger context_fragments_guard
  before insert or update on public.context_fragments
  for each row execute function public.context_fragments_guard();

-- ---------------------------------------------------------------------------
-- Índices: um para o replay, um para a retenção
-- ---------------------------------------------------------------------------
--
-- O do replay é o acesso de todo leitor — os fragmentos de UMA partida até um
-- instante T: `where match_id = ? and observed_at <= T`. Serve também às buscas
-- do `on delete cascade`, então não há índice separado para a FK.
--
-- O da retenção existe porque `observed_at` não é prefixo do primeiro. Sem ele,
-- a varredura diária percorreria a tabela inteira (a linha carrega jsonb, então
-- é heap gordo por linha) para achar alguns milhares de linhas vencidas. Custo
-- de manter: ~3 mil inserções/dia. Não é decisão difícil.

create index if not exists idx_fragments_replay
  on public.context_fragments (match_id, observed_at);

create index if not exists idx_fragments_retention
  on public.context_fragments (observed_at);

alter table public.context_fragments enable row level security;

-- As default privileges deste banco dão DML a `anon` e `authenticated` em toda
-- tabela nova do schema public — mesmo achado das migrations 20260805142957 e
-- 20260806183705. RLS sem policy não cobre quem chega pelo PostgREST com a chave
-- pública; o revoke é o que fecha. A sequence do bigserial entra junto: sem ela,
-- `anon` continua podendo consumir ids.
revoke all on public.context_fragments from anon, authenticated;

revoke all on sequence public.context_fragments_id_seq from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Por que NÃO é particionada, e o que faria mudar de ideia
-- ---------------------------------------------------------------------------
--
-- `esports_snapshots` é particionada por um motivo específico e medido:
-- 231 mil linhas/dia entrando e saindo por DELETE inflaram um índice para
-- 1492 MB sobre 80 MB de dado real. Lá a partição não é organização, é a única
-- forma de a limpeza ser DROP TABLE em vez de DELETE.
--
-- Aqui a ordem de grandeza é outra. Partindo das ~5.100 partidas/ano que a
-- migration 20260806032316 usou para dimensionar a retenção:
--
--   linha: 24 B de header + 8 (id) + 16 (match_id) + ~24 (enricher_id, kind)
--          + 16 (dois timestamptz) + ~10 (numeric) + ~200 (summary)
--          + ~500 B-2 KB (payload jsonb)  ->  ~1,5 KB de heap
--   índices: ~40 B (replay) + ~24 B (retenção) por linha — ruído, aqui
--
--   cenário conservador   2 enrichers x ~12 execuções x 2 fragmentos
--                         =  48 linhas/partida  ->  245k linhas/ano  ->  ~0,4 GB
--   cenário generoso      5 enrichers x ~24 execuções x 2 fragmentos
--                         = 240 linhas/partida  ->  1,2M linhas/ano  ->  ~1,8 GB
--
--   Em linhas por dia: ~670 a ~3.400. Contra as 231.000/dia de
--   `esports_snapshots` — entre 1/70 e 1/340 do volume que justificou a partição.
--
-- A esse ritmo o DELETE diário remove alguns milhares de tuplas por index range
-- scan, e o autovacuum devolve as páginas ao mesmo working set em regime
-- permanente. Não há bloat a evitar porque não há ciclo de churn massivo.
--
-- O que a partição custaria, para administrar ~2 GB: um segundo job diário de
-- DDL, uma partição default para vigiar, o RLS e o revoke repetidos em cada
-- partição nova, e um segundo lugar onde a retenção pode falhar em silêncio.
-- Superfície operacional real, em troca de nada mensurável.
--
-- O número que decide isso depois, e não a intuição: `total_bytes` no retorno de
-- `run_context_fragment_retention`. Se a tabela passar de ~20 GB, ou se o
-- `deleted` bater no teto do lote em execuções consecutivas (sinal de que a
-- limpeza não acompanha a entrada), a conta acima estava errada e a conversão
-- vale. Converter depois é migration de verdade — criar particionada, copiar,
-- trocar — mas sobre ~2 GB isso são minutos, não janela de manutenção. É por
-- isso que o erro barato é começar simples e o erro caro é o contrário.

-- ---------------------------------------------------------------------------
-- Retenção: 365 dias, e o número vem de `esports_snapshot_retention_days`
-- ---------------------------------------------------------------------------
--
-- Não é uma coluna de config nova, é a MESMA. O motivo é que fragmento e série
-- de preço não têm valor separados: o fragmento descreve o contexto de uma
-- partida cuja curva de preço é a feature e o rótulo do backtest. Sem a série,
-- o fragmento não responde a pergunta nenhuma; sem o fragmento, a série perde o
-- porquê. Guardar um sem o outro é guardar metade de um par.
--
-- Uma coluna própria daria duas retenções que começam iguais e divergem no dia
-- em que alguém mexer numa e esquecer da outra. As duas direções da divergência
-- são ruins: fragmento vivendo mais que a série é lixo que ocupa disco;
-- fragmento morrendo antes é dado apagado enquanto a série que ele explica ainda
-- está lá. Uma fonte só, e o alinhamento deixa de depender de disciplina.
--
-- O piso de 30 dias é o mesmo de `manage_esports_partitions`, pela mesma razão:
-- ele não protege de uma decisão, protege de um dígito digitado errado.

create or replace function public.context_fragment_retention_days ()
  RETURNS integer
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $function$
DECLARE
  fallback constant integer := 365;
  min_days constant integer := 30;
  days integer;
BEGIN
  SELECT c.esports_snapshot_retention_days
    INTO days
    FROM public.system_config c
   ORDER BY c.id
   LIMIT 1;

  IF days IS NULL THEN
    RETURN fallback;
  END IF;

  RETURN greatest(days, min_days);
EXCEPTION WHEN others THEN
  -- Coluna ausente ou config ilegível. O fallback é o próprio valor da política
  -- (365), então falhar a leitura aplica exatamente o que estava combinado — não
  -- é o caso de `esports_slug_patterns`, onde o erro podia liberar apagamento.
  RETURN fallback;
END;
$function$;

comment on function public.context_fragment_retention_days() is
  'Dias de retencao de context_fragments, lidos de system_config.esports_snapshot_retention_days — a MESMA config da serie de preco, de proposito: fragmento sem a serie correspondente nao serve para backtest. Piso de 30 dias. Spec 001, A5.';

-- A retenção é em lote e por `observed_at`, nunca por `as_of`.
--
-- `as_of` é do fato, e uma fonte com backfill produz fragmento novo com `as_of`
-- de dois anos atrás: apagar por ele jogaria fora, no mesmo dia, o que acabou de
-- ser coletado. `observed_at` é monotônico com a entrada dos dados — carimbado
-- pelo trigger — e é o mesmo eixo do replay. A tabela vira um FIFO em cima de um
-- só eixo, e isso é o que torna a limpeza previsível.
--
-- Precisão que não perseguimos: o corte de fragmento não cai no mesmo dia do
-- DROP da partição de snapshot da partida correspondente — um fragmento coletado
-- três dias antes do jogo vence três dias antes da série dele. Alinhar de
-- verdade exigiria join com `esports_matches.scheduled_at` em toda passada, para
-- um deslocamento de dias sobre uma janela de um ano.

create or replace function public.run_context_fragment_retention (
  batch_size integer DEFAULT 5000
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $function$
DECLARE
  days          integer := public.context_fragment_retention_days();
  cutoff        timestamptz := now() - (days || ' days')::interval;
  limit_rows    integer := greatest(coalesce(batch_size, 5000), 1);
  deleted_count integer := 0;
BEGIN
  WITH to_delete AS (
    SELECT f.id
      FROM public.context_fragments f
     WHERE f.observed_at < cutoff
     ORDER BY f.observed_at
     LIMIT limit_rows
  ),
  deleted AS (
    DELETE FROM public.context_fragments
     WHERE id IN (SELECT id FROM to_delete)
    RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM deleted;

  RETURN jsonb_build_object(
    'deleted', deleted_count,
    'retention_days', days,
    'cutoff', cutoff,
    -- `deleted` igual a `batch_size` significa que sobrou fila: o chamador
    -- repete até vir menos que o teto.
    'batch_size', limit_rows,
    -- O número que decide a conversão para tabela particionada. Consulta de
    -- catálogo, custo desprezível, e é o que evita que essa decisão seja tomada
    -- por impressão daqui a um ano.
    'total_bytes', pg_total_relation_size('public.context_fragments')
  );
END;
$function$;

comment on function public.run_context_fragment_retention(integer) is
  'Retencao em lote de context_fragments, por observed_at (nunca as_of: fonte com backfill gravaria as_of antigo em linha recem-coletada). Retorna total_bytes, que e o numero que decide se um dia vale particionar. Spec 001, A5.';

revoke all on function public.context_fragment_retention_days()
  from public, anon, authenticated;

grant execute on function public.context_fragment_retention_days()
  to service_role;

revoke all on function public.run_context_fragment_retention(integer)
  from public, anon, authenticated;

grant execute on function public.run_context_fragment_retention(integer)
  to service_role;

-- Nenhum job chama `run_context_fragment_retention` ainda, e isso é deliberado:
-- a tabela nasce vazia e o primeiro corte só aconteceria daqui a um ano. Ligar
-- agora seria ligar uma limpeza que não tem o que limpar. O lugar de ligá-la,
-- quando houver volume, é `src/jobs/retention.ts` — que já roda diário e já tem
-- o laço de lote com teto de iterações.
