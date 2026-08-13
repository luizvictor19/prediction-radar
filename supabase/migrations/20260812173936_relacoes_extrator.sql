-- Spec 003 — extrator de relações lógicas.
--
-- ESCRITA E NÃO APLICADA (H4). Quem aplica é o dono do projeto.
--
-- A fase 2 mede em arquivo, não em tabela: `probes/relacoes/*.jsonl`. A escolha
-- foi deliberada — tabela pede migration, migration pede H4, e a medição ficaria
-- bloqueada num humano para produzir um número que não escreve em produção.
--
-- Esta migration existe para o dia em que o extrator DEIXAR de ser medição e
-- virar componente: aí ele precisa de telemetria por chamada, de teto de gasto
-- em config e de rastreabilidade relação → mercados, exatamente como o analista
-- tem em `esports_analyses` e `analysis_claims`.
--
-- Aplicá-la antes de a precisão passar dos 90% seria construir a casa do
-- componente que a Parte I ainda pode reprovar.

-- ---------------------------------------------------------------------------
-- Config
-- ---------------------------------------------------------------------------

alter table public.system_config
  add column if not exists relacoes_enabled boolean not null default false;

comment on column public.system_config.relacoes_enabled is
  'Liga o extrator de relacoes (spec 003). Nasce desligado: a Parte I ainda pode reprovar a frente.';

alter table public.system_config
  add column if not exists relacoes_model text not null default 'claude-sonnet-4-6';

comment on column public.system_config.relacoes_model is
  'Modelo do extrator. Precisa estar na tabela de precos de src/relacoes/extrator.ts — modelo sem preco nao roda, porque sem preco nao ha teto de gasto.';

alter table public.system_config
  add column if not exists relacoes_prompt_version text not null default 'v1';

comment on column public.system_config.relacoes_prompt_version is
  'Versao do prompt do extrator, registrada em src/relacoes/prompts.ts. E o que torna rollback um UPDATE em vez de redeploy. Versao desconhecida faz o runner PARAR, nao cair na v1.';

alter table public.system_config
  add column if not exists relacoes_effort text not null default 'medium';

comment on column public.system_config.relacoes_effort is
  'Esforco de raciocinio. medium foi o medido na fase 2; subir troca custo por qualidade e precisa de nova medicao para valer.';

alter table public.system_config
  add column if not exists relacoes_daily_budget_usd numeric(10,2) not null default 2.00;

comment on column public.system_config.relacoes_daily_budget_usd is
  'Teto DIARIO de gasto do extrator, com parada dura — igual a analyst_daily_budget_usd. Nasce baixo: o universo aberto inteiro custa ~US$ 733 (Parte C) e a carga inicial e decisao humana (H3), nao efeito colateral de ligar o componente.';

-- ---------------------------------------------------------------------------
-- Uma chamada ao modelo
-- ---------------------------------------------------------------------------

create table if not exists public.relacao_extracoes (
  id uuid primary key default gen_random_uuid(),

  -- A identidade do grupo que entrou no prompt.
  --
  -- `grupo_id` e a chave de idempotencia e de retomada: rodar "os 100 primeiros
  -- da fila" duas vezes tem que colidir aqui em vez de gastar de novo. E o
  -- equivalente de esports_analyses_one_per_checkpoint.
  --
  -- `grupo_fingerprint` e o hash dos ids de mercado do grupo, ordenados. Grupo
  -- com o mesmo id mas membros diferentes NAO e o mesmo grupo, e sem esta coluna
  -- a colisao de `grupo_id` esconderia isso.
  grupo_id          text not null,
  grupo_fingerprint text not null,
  camada            smallint not null,
  membros           integer not null,

  -- analisado = o modelo respondeu e a resposta passou na validacao
  -- falhou     = a chamada foi paga e nao produziu linha (ver falha_codigo)
  status text not null,

  falha_codigo   text,
  falha_mensagem text,

  -- --- telemetria por chamada ---------------------------------------------
  --
  -- Gravada por extracao e nao deduzida da config no momento da leitura: a
  -- config muda, e uma linha de agosto precisa continuar dizendo com que modelo
  -- e com que prompt ela foi feita. Sem isso nenhuma comparacao entre versoes e
  -- possivel.
  model              text not null,
  prompt_version     text not null,
  effort             text,
  tokens_input       integer,
  tokens_output      integer,
  tokens_cache_read  integer,
  tokens_cache_write integer,
  cost_usd           numeric(10,6),
  latency_ms         integer,

  created_at timestamptz not null default now(),

  constraint relacao_extracoes_status check (status in ('analisado', 'falhou')),
  constraint relacao_extracoes_falha_coerente
    check ((status = 'falhou') = (falha_codigo is not null)),
  constraint relacao_extracoes_um_por_grupo unique (grupo_id, prompt_version, model)
);

comment on table public.relacao_extracoes is
  'Uma chamada do extrator de relacoes = uma linha. Espelha esports_analyses. A unicidade e por (grupo, versao de prompt, modelo) e nao so por grupo: comparar v1 com v2 exige rodar o MESMO grupo duas vezes, e uma unicidade so por grupo tornaria a comparacao impossivel.';

comment on column public.relacao_extracoes.status is
  'falhou registra a chamada PAGA que nao virou linha — recusa, truncagem, rotulo inventado. Contar so os sucessos esconderia o custo real por relacao util.';

create index if not exists idx_relacao_extracoes_grupo
  on public.relacao_extracoes (grupo_id);

create index if not exists idx_relacao_extracoes_criado
  on public.relacao_extracoes (created_at desc);

-- ---------------------------------------------------------------------------
-- As relações propostas
-- ---------------------------------------------------------------------------

create table if not exists public.relacoes (
  id uuid primary key default gen_random_uuid(),
  extracao_id uuid not null references public.relacao_extracoes (id) on delete cascade,

  -- A lista FECHADA da Parte B. O check e a taxonomia: relacao em texto livre e
  -- exatamente o que a spec recusa, e um `text` sem check deixaria entrar.
  tipo text not null,

  -- Os mercados, POR ORDEM, porque a ordem carrega significado:
  --   implica   [A, B]     — A so acontece se B acontecer
  --   conjuncao [C, A, B]  — C e "A e B"
  -- Guardar como conjunto perderia a direcao da implicacao, que e o erro mais
  -- comum do modelo e o que a conferencia contra o desfecho mede.
  mercado_ids text[] not null,
  rotulos     text[] not null,

  confianca     numeric(3,2) not null,
  justificativa text not null,

  -- null significa "li as regras das duas pontas e nao vi diferenca", NUNCA
  -- "nao olhei" — a distincao esta no prompt e e o que separa o campo de um
  -- enfeite (Parte B).
  ressalva_de_resolucao text,

  -- --- o gabarito automatico ----------------------------------------------
  --
  -- Preenchido so quando TODOS os mercados da relacao ja resolveram e o desfecho
  -- e legivel. `compativel` NAO e `correta`: duas perguntas sem relacao nenhuma
  -- cujos desfechos calharam de nao se contradizer entram como compativeis. E
  -- por isso que existe `rotulo_humano` ao lado.
  veredito        text,
  veredito_motivo text,

  -- --- o rotulo humano (H1) -----------------------------------------------
  --
  -- `ambigua` e resposta valida, e a taxa de ambiguas e um numero a reportar: se
  -- for alta, a taxonomia esta mal desenhada, nao o agente (Parte H).
  rotulo_humano    text,
  rotulo_humano_em timestamptz,

  created_at timestamptz not null default now(),

  constraint relacoes_tipo
    check (tipo in ('implica', 'exclui', 'particiona', 'equivale', 'conjuncao', 'nenhuma')),
  constraint relacoes_confianca_range
    check (confianca >= 0 and confianca <= 1),
  constraint relacoes_veredito
    check (veredito is null or veredito in ('refutada', 'compativel', 'nao_testavel')),
  constraint relacoes_rotulo_humano
    check (rotulo_humano is null or rotulo_humano in ('certa', 'errada', 'ambigua')),
  -- Aridade por tipo, no banco e nao so no parser: `conjuncao` com dois mercados
  -- e forma valida e relacao ilegivel, e a conferencia contra o desfecho
  -- quebraria em runtime em vez de na escrita.
  constraint relacoes_aridade check (
    case tipo
      when 'conjuncao'  then array_length(mercado_ids, 1) = 3
      when 'particiona' then array_length(mercado_ids, 1) >= 2
      else array_length(mercado_ids, 1) = 2
    end
  ),
  constraint relacoes_rotulos_batem
    check (array_length(mercado_ids, 1) = array_length(rotulos, 1))
);

comment on table public.relacoes is
  'Uma relacao logica proposta pelo extrator. E a rastreabilidade da spec 003, equivalente a analysis_claims: a relacao aponta para os mercados que a sustentam, e a justificativa cita o trecho das perguntas.';

comment on column public.relacoes.veredito is
  'Conferencia automatica contra o desfecho, so em mercado resolvido. refutada = o desfecho violou a restricao, objetivo. compativel = nao violou, o que NAO e o mesmo que a relacao existir. nao_testavel = o antecedente nunca disparou.';

create index if not exists idx_relacoes_extracao on public.relacoes (extracao_id);
create index if not exists idx_relacoes_tipo on public.relacoes (tipo);

-- Indice para a pergunta operacional que vem DEPOIS de a precisao passar:
-- "quais relacoes envolvem este mercado?". GIN porque a coluna e array.
create index if not exists idx_relacoes_mercados on public.relacoes using gin (mercado_ids);
