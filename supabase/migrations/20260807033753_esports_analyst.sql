-- Spec 001 — o agente analista: `esports_analyses` + `analysis_claims` + config.
--
-- Topologia single agent: uma chamada por análise, sem orquestração e sem grafo.
-- O que esta migration cria é o registro do que aquela chamada produziu e do que
-- ela custou.
--
-- ---------------------------------------------------------------------------
-- Por que NÃO reusar `ai_analyses`
-- ---------------------------------------------------------------------------
--
-- `ai_analyses` existe desde o schema baseline e foi desenhada para o sistema
-- anterior: chaveada por `signal_id`/`event_id`, com `recommendation`,
-- `recommended_outcome` e `estimated_fair_price`. Três incompatibilidades, e
-- nenhuma é cosmética:
--
--   1. A unidade errada. Aquela tabela analisa um MARKET; esta analisa uma
--      PARTIDA. Uma partida tem dezenas de markets, e a probabilidade de o time
--      A vencer a série não pertence a nenhum deles em particular.
--
--   2. Não há onde pôr point-in-time. Sem `as_of` não dá para dizer a que
--      instante a análise se refere, e sem isso o replay do eval não existe —
--      que é o motivo de toda a camada de fragmentos ter sido construída.
--
--   3. Não há onde pôr a rastreabilidade. `thesis` é texto solto; medir
--      fidelidade depois exige a associação AFIRMAÇÃO -> FRAGMENTO, que é uma
--      relação e precisa de tabela.
--
-- Somando: abstenção, fingerprint, latência e versão de prompt também não têm
-- coluna lá. Seria uma tabela nova disfarçada de reuso. `ai_analyses` fica como
-- está, para o histórico do sistema anterior.

-- ---------------------------------------------------------------------------
-- A análise
-- ---------------------------------------------------------------------------

create table if not exists public.esports_analyses (
  id       uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.esports_matches (id) on delete cascade,

  -- Ponto no tempo, em duas colunas porque são dois fatos.
  --
  -- `checkpoint_minutes` é o horário NOMINAL — quantos minutos antes de
  -- `scheduled_at` esta análise deveria acontecer (negativo = depois do início,
  -- que é a leitura ao vivo). É ele que forma a chave de idempotência.
  --
  -- `as_of` é o instante REAL em que ela aconteceu, e é o que filtra os
  -- fragmentos (`observed_at <= as_of`). Os dois nunca coincidem exatamente: o
  -- cron tica a cada poucos minutos. Guardar só o nominal faria o replay ler um
  -- conjunto de fragmentos que a análise não viu.
  checkpoint_minutes integer     not null,
  as_of              timestamptz not null,

  -- analyzed  = o modelo rodou e devolveu probabilidade e tese
  -- abstained = recusa deliberada, com motivo (ver a nota sobre abstenção)
  -- unchanged = o conjunto de fragmentos é idêntico ao da análise anterior;
  --             nenhuma chamada foi feita
  status text not null,

  -- --- o contrato de saída -------------------------------------------------
  probability numeric(5,4),   -- P(time A vence a série), [0,1]
  thesis      text,           -- 2-4 frases
  confidence  numeric(3,2),   -- [0,1]

  -- Abstenção é desenho, não fallback — ver a nota abaixo.
  abstain_reason text,
  abstain_source text,        -- 'gate' (antes da chamada) | 'model' (durante)

  -- --- de qual lado é a probabilidade --------------------------------------
  --
  -- Sem isto o número é ambíguo, e a ambiguidade só apareceria no backtest.
  team_a_id    uuid references public.esports_teams (id),
  outcome_label text,         -- o rótulo em events.outcomes.values

  -- --- o que o mercado dizia no mesmo instante -----------------------------
  --
  -- Copiado do fragmento `liquidity`, não relido do banco: o gate e o modelo
  -- precisam ver o MESMO instante, e a única forma de garantir isso é os dois
  -- lerem do mesmo conjunto de fragmentos. É também o que permite calcular edge
  -- depois sem re-derivar preço a partir da série.
  market_mid       numeric(6,4),
  market_liquidity numeric(14,2),
  market_spread    numeric(6,4),

  -- --- deduplicação --------------------------------------------------------
  --
  -- Hash do conjunto de fragmentos que entrou no prompt. Igual ao da análise
  -- anterior significa que nada mudou e não há o que reanalisar: mesma entrada,
  -- mesma resposta, e a chamada é pura queima de dinheiro.
  fragment_fingerprint text    not null,
  fragment_count       integer not null,

  -- --- telemetria ----------------------------------------------------------
  --
  -- `model` e `prompt_version` são gravados por análise, e não deduzidos da
  -- config no momento da leitura, porque a config muda: uma linha de setembro
  -- precisa continuar dizendo com que modelo e com que prompt ela foi feita.
  -- Sem isso nenhuma comparação entre versões é possível.
  model             text,
  prompt_version    text not null,
  effort            text,
  tokens_input      integer,
  tokens_output     integer,
  tokens_cache_read integer,
  tokens_cache_write integer,
  cost_usd          numeric(10,6),
  latency_ms        integer,

  created_at timestamptz not null default now(),

  -- Uma análise por checkpoint. É a idempotência do job: o cron pode ticar
  -- quantas vezes quiser dentro da janela do checkpoint que a segunda tentativa
  -- colide aqui em vez de gastar de novo.
  --
  -- No banco e não em memória, ao contrário do cursor do resolver e do mapa de
  -- cadência do enricher — porque aqui um deploy no meio da janela custaria
  -- dinheiro, não uma releitura.
  constraint esports_analyses_one_per_checkpoint unique (match_id, checkpoint_minutes),

  constraint esports_analyses_status
    check (status in ('analyzed', 'abstained', 'unchanged')),

  constraint esports_analyses_probability_range
    check (probability is null or (probability >= 0 and probability <= 1)),

  constraint esports_analyses_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1)),

  constraint esports_analyses_abstain_source
    check (abstain_source is null or abstain_source in ('gate', 'model')),

  -- O CHECK que faz "nunca gravar linha ruim" ser propriedade do banco e não da
  -- boa vontade do código: análise sem probabilidade, sem tese ou sem confiança
  -- não é análise.
  constraint esports_analyses_analyzed_is_complete
    check (
      status <> 'analyzed'
      or (probability is not null and thesis is not null and confidence is not null)
    ),

  -- E abstenção sem motivo é ruído. O motivo é o dataset que permite calibrar o
  -- critério depois.
  constraint esports_analyses_abstained_has_reason
    check (
      status <> 'abstained'
      or (abstain_reason is not null and abstain_source is not null)
    )
);

comment on table public.esports_analyses is
  'Uma linha por analise do agente analista (single agent, uma chamada). Chaveada por (match_id, checkpoint_minutes). Spec 001.';

comment on column public.esports_analyses.checkpoint_minutes is
  'Minutos ANTES de esports_matches.scheduled_at. Negativo = depois do inicio (leitura ao vivo). Horario NOMINAL: o real e as_of.';

comment on column public.esports_analyses.as_of is
  'Instante REAL da analise. E o filtro dos fragmentos (observed_at <= as_of) e o que torna a linha reproduzivel.';

comment on column public.esports_analyses.probability is
  'P(time A vence a serie). O time A e team_a_id, e o rotulo correspondente e outcome_label — sem os dois o numero e ambiguo.';

comment on column public.esports_analyses.fragment_fingerprint is
  'Hash do conjunto de fragmentos que entrou no prompt. Igual ao anterior = nada mudou = nenhuma chamada (status unchanged).';

comment on column public.esports_analyses.abstain_source is
  'gate = recusado antes da chamada, sem gastar token. model = o proprio modelo se absteve, e a chamada foi paga. A razao entre os dois diz se o gate esta calibrado.';

comment on column public.esports_analyses.model is
  'Gravado por analise, nao lido da config na hora da leitura: a config muda e a linha antiga precisa continuar dizendo com o que foi feita.';

alter table public.esports_analyses enable row level security;

revoke all on public.esports_analyses from anon, authenticated;

-- Leitura do job: "o que já analisei para esta partida". E do eval: "todas as
-- análises de uma partida, em ordem de tempo".
create index if not exists idx_analyses_match
  on public.esports_analyses (match_id, checkpoint_minutes);

-- O teto de gasto diário soma esta coluna sobre a janela do dia. Sem índice
-- seria uma varredura da tabela inteira uma vez por ciclo.
create index if not exists idx_analyses_spend
  on public.esports_analyses (created_at);

-- ---------------------------------------------------------------------------
-- A rastreabilidade: uma linha por afirmação, não uma lista de ids
-- ---------------------------------------------------------------------------
--
-- A diferença importa porque a pergunta que virá depois é por AFIRMAÇÃO, não
-- por análise: "esta frase da tese é sustentada pelo fragmento que ela cita?".
-- Uma lista de ids no payload responde "a análise viu estes fragmentos", que é
-- outra pergunta e não mede fidelidade nenhuma.
--
-- Com tabela, medir vira um join. E sobra onde pôr o veredito da conferência
-- quando o eval existir, sem migration de payload.

create table if not exists public.analysis_claims (
  id          bigserial primary key,
  analysis_id uuid    not null references public.esports_analyses (id) on delete cascade,
  ordinal     integer not null,
  claim       text    not null,

  -- `set null` e não `cascade`: `context_fragments` é podada em 365 dias e a
  -- análise vive mais. Perder o ponteiro é aceitável; perder o registro de que
  -- a afirmação foi feita e a que tipo de evidência ela se atribuía, não.
  fragment_id bigint references public.context_fragments (id) on delete set null,

  -- O epitáfio do fragmento. Duas colunas curtas que mantêm a linha legível
  -- depois que a retenção levar o original: sem elas, um `fragment_id` nulo não
  -- distingue "citou o preço" de "citou o roster".
  fragment_enricher_id text not null,
  fragment_kind        text not null,

  created_at timestamptz not null default now(),

  constraint analysis_claims_ordinal unique (analysis_id, ordinal),
  constraint analysis_claims_not_blank check (length(btrim(claim)) > 0)
);

comment on table public.analysis_claims is
  'Uma afirmacao factual da tese por linha, com o fragmento que a sustenta. E a associacao — nao a lista de ids — que permite medir fidelidade depois. Spec 001.';

comment on column public.analysis_claims.fragment_id is
  'Ponteiro vivo para o fragmento citado. NULL depois que a retencao de 365 dias levar o fragmento; fragment_enricher_id e fragment_kind sobrevivem para a linha continuar legivel.';

alter table public.analysis_claims enable row level security;

revoke all on public.analysis_claims from anon, authenticated;

revoke all on sequence public.analysis_claims_id_seq from anon, authenticated;

create index if not exists idx_claims_analysis
  on public.analysis_claims (analysis_id);

-- Para a pergunta inversa — "quais afirmações se apoiaram neste fragmento" —
-- que é como se descobre um enricher que produz fragmento bonito e inútil.
create index if not exists idx_claims_fragment
  on public.analysis_claims (fragment_id) where fragment_id is not null;

-- ---------------------------------------------------------------------------
-- Config
-- ---------------------------------------------------------------------------
--
-- Tudo que decide gasto ou comportamento sai daqui, e não de constante no
-- código. O motivo é operacional e específico: modelo e versão de prompt mudam
-- por decisão, não por deploy — e quando uma versão de prompt regride, o
-- rollback precisa ser um UPDATE, não um redeploy com o código anterior.
--
-- Consequência assumida: as versões de prompt convivem no código
-- (`src/verticals/analyst-prompts.ts`). Voltar para `v1` só funciona porque
-- `v1` continua lá. Versão que sai do código sai da config junto, ou o job
-- recusa rodar — ver `analyst_prompt_version`.

alter table public.system_config
  add column if not exists esports_analyst_enabled boolean not null default false;

-- Nasce DESLIGADO, ao contrário do resolver e do enricher. A diferença é que
-- este componente gasta dinheiro por ciclo. Resolver e enricher só escrevem no
-- Postgres; ligar por engano custa CPU. Ligar este por engano custa fatura, e a
-- primeira vez que o dono souber seria pela cobrança.
comment on column public.system_config.esports_analyst_enabled is
  'Liga o agente analista. Nasce FALSE de proposito: e o unico componente do sistema que gasta dinheiro por ciclo. Spec 001.';

alter table public.system_config
  add column if not exists analyst_model text not null default 'claude-opus-5';

comment on column public.system_config.analyst_model is
  'Modelo da analise. O codigo so aceita modelo cujo preco ele conhece (src/verticals/analyst.ts): sem preco nao ha teto de gasto, e sem teto nao roda.';

alter table public.system_config
  add column if not exists analyst_prompt_version text not null default 'v1';

comment on column public.system_config.analyst_prompt_version is
  'Versao do prompt, resolvida no registro de src/verticals/analyst-prompts.ts. Rollback e UPDATE aqui, sem redeploy — o que exige que a versao anterior continue no codigo.';

alter table public.system_config
  add column if not exists analyst_effort text not null default 'medium';

-- O principal controle de custo depois do modelo, e por isso mora ao lado dele.
-- `medium` porque a tarefa é julgamento sobre um contexto pequeno e já
-- estruturado — os fragmentos chegam com o trabalho de leitura da série já
-- feito. Subir para `high` é uma linha de UPDATE quando houver eval para dizer
-- se compensa.
comment on column public.system_config.analyst_effort is
  'Esforco do modelo: low|medium|high|xhigh|max. Principal controle de custo depois do modelo.';

alter table public.system_config
  add column if not exists analyst_daily_budget_usd numeric(10,2) not null default 5.00;

-- Parada dura, não throttle: ao atingir o teto o job para de chamar até o dia
-- seguinte (UTC). Um throttle transformaria estouro de orçamento em degradação
-- silenciosa, que é como se descobre o problema pela fatura.
--
-- Ordem de grandeza para calibrar: ~14 partidas/dia x 2 checkpoints = ~28
-- analises/dia. A ~US$ 0,06 por analise em Opus 5 (entrada de ~3k tokens,
-- saida curta, mais o pensamento), sao ~US$ 1,70/dia. O default de 5,00 e ~3x
-- de folga — apertado o bastante para segurar um laco descontrolado.
comment on column public.system_config.analyst_daily_budget_usd is
  'Teto de gasto por dia UTC. Parada DURA: atingido, nenhuma chamada nova ate o dia seguinte. Estimativa de regime: ~US$ 1,70/dia em Opus 5.';

alter table public.system_config
  add column if not exists analyst_checkpoints_minutes integer[] not null default '{360,60}';

-- Poucas análises por partida, e é uma decisão de custo antes de ser de
-- desenho: analisar toda partida da janela a cada 30 min daria ~840
-- análises/dia — 30x o volume acima, e inviável em qualquer modelo.
--
-- 360 e 60 são os dois instantes em que a informação muda de natureza: em T-6h
-- o mercado já tem preço formado e o contexto está publicado; em T-1h entra o
-- dinheiro que sabe de escalação. Entre os dois, quase nada acontece que o
-- fingerprint não filtre sozinho.
--
-- Valor NEGATIVO = depois do início. Acrescentar `-15` liga a leitura ao vivo
-- sem deploy; é opcional de propósito, porque ao vivo o preço se move rápido
-- demais para uma análise pontual valer o gasto.
comment on column public.system_config.analyst_checkpoints_minutes is
  'Minutos antes de scheduled_at em que a partida e analisada. Negativo = depois do inicio (ao vivo). Cada checkpoint e uma linha em esports_analyses, no maximo.';

-- ---------------------------------------------------------------------------
-- Os três critérios de abstenção
-- ---------------------------------------------------------------------------
--
-- Abstenção é desenho, não fallback. Um mercado com spread de 0,90 e US$ 67 de
-- liquidez não tem preço formado — não há com o que discordar, e uma
-- probabilidade contra ele não é sinal, é ruído com aparência de convicção.
--
-- Os três valores abaixo são ponto de partida declarado, não medição: não há
-- histórico de abstenção para calibrá-los ainda. É exatamente por isso que
-- `abstain_reason` é gravado — a distribuição dele é o dado que permite
-- ajustá-los depois com evidência em vez de intuição.

alter table public.system_config
  add column if not exists analyst_min_liquidity_usd numeric(14,2) not null default 5000;

comment on column public.system_config.analyst_min_liquidity_usd is
  'Piso de liquidez para o mercado ter preco formado. Abaixo disso o job nem chama o modelo (abstain_source = gate). Ponto de partida: calibrar pela distribuicao de abstain_reason.';

alter table public.system_config
  add column if not exists analyst_max_spread numeric(6,4) not null default 0.15;

comment on column public.system_config.analyst_max_spread is
  'Spread maximo (best_ask - best_bid) para o preco ser considerado formado. Acima disso o mercado nao tem opiniao, tem duas pontas distantes.';

alter table public.system_config
  add column if not exists analyst_min_fragments integer not null default 3;

-- 3 é o piso em que a análise deixa de ser leitura de gráfico: abaixo disso o
-- modelo recebe preço e liquidez e mais nada, e uma tese construída só sobre a
-- própria série é exatamente o que o backtest já faz melhor e de graça.
comment on column public.system_config.analyst_min_fragments is
  'Minimo de fragmentos distintos para valer analisar. Abaixo disso o modelo so teria preco e liquidez, e tese sobre a propria serie nao precisa de LLM.';

alter table public.system_config
  add column if not exists analyst_timeout_ms integer not null default 90000;

-- Timeout explícito, e sem retry. O retry é o que transforma um timeout em
-- ciclo pendurado: com os 2 retries que o SDK faz por padrão, um prazo de 90s
-- vira 4,5 min de relógio. É a versão em miniatura do fetch da Gamma sem
-- timeout que custou 48h de coleta parada.
comment on column public.system_config.analyst_timeout_ms is
  'Prazo de UMA chamada, via AbortSignal. O cliente roda com maxRetries=0: retry multiplicaria o prazo pelo numero de tentativas e e assim que um ciclo fica pendurado.';

alter table public.system_config
  add constraint system_config_analyst_ranges
  check (
    analyst_daily_budget_usd >= 0
    and analyst_min_liquidity_usd >= 0
    and analyst_max_spread >= 0
    and analyst_min_fragments >= 0
    and analyst_timeout_ms > 0
  );

alter table public.system_config
  add constraint system_config_analyst_effort
  check (analyst_effort in ('low', 'medium', 'high', 'xhigh', 'max'));
