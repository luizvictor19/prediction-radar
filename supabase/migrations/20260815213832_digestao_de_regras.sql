-- A digestão de regras: `market_rule_digests` + a config que a governa.
--
-- ---------------------------------------------------------------------------
-- O que se está guardando
-- ---------------------------------------------------------------------------
--
-- Todo mercado da Polymarket publica a REGRA DE RESOLUÇÃO — o texto que decide
-- o dinheiro. Mediana de 1.262 caracteres, com condição, cláusula de anulação,
-- fonte nomeada e critério de desempate; preenchida em 100% dos mercados. Quase
-- ninguém lê. Foram mais de 1.150 mercados disputados em 2026, já acima do ano
-- inteiro de 2025, e num caso de US$ 60 milhões a briga foi se "vendeu até 31 de
-- maio" significava a venda ou a divulgação dela.
--
-- Esta tabela é esse texto virado campo. Uma linha por (mercado, texto, modelo,
-- versão de prompt).
--
-- ---------------------------------------------------------------------------
-- A coluna que faz a tabela não envelhecer em silêncio
-- ---------------------------------------------------------------------------
--
-- `description_sha256`. Regra não muda, então digere uma vez e reusa para
-- sempre — mas "não muda" é quase-sempre: a Polymarket edita descrição. Sem o
-- hash, a digestão de agosto continuaria valendo sobre um texto de outubro que
-- ninguém releu, e o defeito só apareceria quando um mercado resolvesse contra
-- o que a nossa linha dizia.
--
-- Com o hash gravado, texto editado tem hash diferente, a digestão antiga não
-- casa e o mercado volta para a fila SOZINHO. Ninguém precisa lembrar de
-- conferir, que é a única forma de conferência que sobrevive a seis meses.
--
-- É o mesmo defeito que este projeto já pagou para aprender em outros lugares:
-- estado derivado que continua parecendo válido depois que a origem mudou.
--
-- ---------------------------------------------------------------------------
-- Por que o modelo entra na chave
-- ---------------------------------------------------------------------------
--
-- A chave é (event_id, description_sha256, model, prompt_version), e não só as
-- duas primeiras. Sem `model` na chave, rodar o mesmo texto em dois modelos LADO
-- A LADO — que é o degrau 2 da escada de adoção — seria impossível: o segundo
-- colidiria com o primeiro e a comparação não teria onde existir.
--
-- Consequência assumida: trocar de modelo redigere tudo e a fila enche de novo.
-- É o preço certo. Digestão de modelo A e digestão de modelo B são dados
-- diferentes, e uma coluna que os misturasse tornaria qualquer medida por modelo
-- impossível de fazer depois.

create table if not exists public.market_rule_digests (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,

  -- A identidade do texto digerido. sha256 completo (64 hex): aqui o hash decide
  -- se uma digestão de meses atrás ainda vale, e colisão parcial sairia cara.
  description_sha256 text not null,

  -- --- o contrato de saída -------------------------------------------------
  --
  -- `text[]` e não jsonb: são listas de frases, sem estrutura interna, e o que
  -- se vai querer fazer com elas é ler, contar e procurar palavra. Array de
  -- texto faz as três coisas com operador nativo; jsonb pediria cast em toda
  -- consulta para responder "quantas pegadinhas por mercado".
  resolve_sim  text[] not null,
  resolve_nao  text[] not null default '{}',

  -- Anulável de propósito nos dois: `null` quer dizer "a regra não nomeia
  -- fonte" e "a regra não dá prazo". A omissão é achado, não falha da extração —
  -- é justamente onde nasce disputa.
  fonte  text,
  prazo  text,

  anula_se text[] not null default '{}',

  -- `pegadinhas` e `ambiguidades` NÃO estão aqui: são tabelas-filhas, logo
  -- abaixo. Ver a nota "Por que duas tabelas-filhas".

  -- --- telemetria ----------------------------------------------------------
  --
  -- `model` e `prompt_version` gravados por linha, não deduzidos da config no
  -- momento da leitura, pelo mesmo motivo de `esports_analyses`: a config muda e
  -- a linha antiga precisa continuar dizendo com o que foi feita. Sem isso
  -- nenhuma comparação entre modelos é possível — e a comparação entre modelos é
  -- a razão de esta tabela nascer com o modelo na chave.
  model          text not null,
  prompt_version text not null,
  tokens_input       integer,
  tokens_output      integer,
  tokens_cache_read  integer,
  tokens_cache_write integer,
  cost_usd  numeric(10,6),
  latency_ms integer,

  created_at timestamptz not null default now(),

  constraint market_rule_digests_one_per_text_and_model
    unique (event_id, description_sha256, model, prompt_version),

  -- O CHECK que faz "nunca gravar linha ruim" ser propriedade do banco e não da
  -- boa vontade do código: digestão sem condição de resolução SIM não é
  -- digestão, é extração que falhou.
  constraint market_rule_digests_tem_resolucao
    check (array_length(resolve_sim, 1) >= 1),

  -- sha256 em hex, sempre 64 caracteres. Pega o dia em que alguém gravar o hash
  -- truncado (ou o texto no lugar dele) e a deduplicação passar a nunca casar —
  -- falha que se manifestaria como fatura, redigerindo tudo a cada passada.
  constraint market_rule_digests_sha256_hex
    check (description_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table public.market_rule_digests is
  'Uma linha por (mercado, texto da regra, modelo, versao de prompt): a regra de resolucao virada campo. Chaveada pelo HASH do texto — descricao editada tem hash novo e volta para a fila sozinha.';

comment on column public.market_rule_digests.description_sha256 is
  'sha256 hex de events.description no momento da digestao. E o que impede a digestao de envelhecer em silencio: texto editado nao casa e o mercado volta para a fila.';

comment on column public.market_rule_digests.fonte is
  'Quem decide, nomeado como a regra o nomeia. NULL = a regra nao nomeia ninguem, que e achado e nao falha da extracao.';

comment on column public.market_rule_digests.model is
  'Gravado por linha e presente na chave: digestao do modelo A e do modelo B sao dados diferentes, e rodar os dois lado a lado e o degrau 2 da adocao.';

alter table public.market_rule_digests enable row level security;

revoke all on public.market_rule_digests from anon, authenticated;

-- A pergunta do laço, uma vez por mercado: "já digeri ESTE texto com ESTE
-- modelo?". A unique acima já a responde; este índice existe para a outra
-- pergunta, a da leitura: "a digestão deste mercado, a mais recente primeiro".
create index if not exists idx_rule_digests_event
  on public.market_rule_digests (event_id, created_at desc);

-- O teto de gasto soma `cost_usd` sobre a janela do dia. Sem índice seria uma
-- varredura da tabela inteira uma vez por ciclo.
create index if not exists idx_rule_digests_spend
  on public.market_rule_digests (created_at);

-- ---------------------------------------------------------------------------
-- Por que duas tabelas-filhas, e não duas colunas de array
-- ---------------------------------------------------------------------------
--
-- Este arquivo teve `pegadinhas text[]` e `ambiguidades text[]` até a v2 do
-- prompt. Mudou porque a pergunta mudou, e o mesmo argumento de
-- `analysis_claims` vale palavra por palavra: a pergunta que vem depois é por
-- ITEM, não por digestão.
--
-- A leitura das 10 primeiras digestões mostrou os mesmos padrões repetindo entre
-- mercados — "ET" sem dizer se é EST ou EDT em 4 de 9; "consensus of credible
-- reporting" como fonte em 5 de 9. Padrão que repete é coisa que se conta, e a
-- contagem é o produto: mais de 1.150 mercados foram disputados em 2026, e o
-- caso de US$ 60 milhões foi exatamente ambiguidade de data.
--
--   select tipo, count(*) from public.digest_ambiguidades group by tipo;
--
-- Com array de texto essa pergunta pede `jsonb_array_elements` ou `unnest` em
-- toda consulta, e a lista fechada vira promessa do código em vez de garantia do
-- banco. Com tabela, contar é `group by` e a categoria errada é rejeitada por
-- CHECK — que é o que faz a contagem valer alguma coisa.
--
-- O `ordinal` preserva a ordem em que o modelo escreveu. Não é decorativo: o
-- primeiro item de uma lista costuma ser o mais forte, e essa é uma hipótese que
-- só se mede se a ordem sobreviver à gravação.

create table if not exists public.digest_pegadinhas (
  id        bigserial primary key,
  digest_id uuid    not null references public.market_rule_digests (id) on delete cascade,
  ordinal   integer not null,
  texto     text    not null,

  -- Anulável porque a v1 do prompt não pedia severidade. NULL é AUSENTE, não
  -- "detalhe": tratar o material não classificado como detalhe inflaria a
  -- categoria mais fraca com tudo que veio antes de a pergunta existir.
  --
  -- muda_resultado = decide SIM contra NÃO.
  -- muda_timing    = o desfecho é o mesmo, o capital destrava em outra data.
  -- detalhe        = nuance de leitura, não muda decisão.
  severidade text,

  -- A PASSAGEM da regra que cria a armadilha, literal. Anulável só por causa
  -- das v1 e v2, que não a pediam.
  --
  -- É o mecanismo que substituiu uma instrução que não funcionava. A v2 pediu em
  -- texto que o modelo não enchesse a lista, e a contagem não se moveu: 23
  -- pegadinhas na v1, 23 na v2, nos mesmos mercados. Com o trecho obrigatório e
  -- CONFERIDO contra `events.description`, o número de pegadinhas deixa de ser
  -- escolha do modelo e passa a ser o número de passagens distintas da regra que
  -- criam armadilha. Não existe trecho que sustente "market cap não é receita" —
  -- a regra só diz market cap.
  trecho text,

  -- A situação concreta em que a leitura ingênua e a regra divergem. Obrigatório
  -- para `muda_resultado` e `muda_timing`; sem ele a severidade cai para
  -- `detalhe` antes de chegar aqui.
  --
  -- Existe porque 75% das pegadinhas da v2 vieram marcadas `muda_resultado`, e
  -- isso é alto demais para ser verdade: quando o nível mais forte não custa
  -- nada, o nível mais forte é o que sai. O cenário é o custo.
  cenario text,

  created_at timestamptz not null default now(),

  constraint digest_pegadinhas_ordinal unique (digest_id, ordinal),
  constraint digest_pegadinhas_not_blank check (length(btrim(texto)) > 0),
  constraint digest_pegadinhas_severidade
    check (severidade is null or severidade in ('muda_resultado', 'muda_timing', 'detalhe')),

  -- A regra do cenário, no banco e não só no código. Uma linha marcada
  -- `muda_resultado` sem cenário é uma severidade que ninguém sustentou, e o
  -- CHECK garante que ela não existe mesmo que um insert futuro esqueça a poda.
  constraint digest_pegadinhas_cenario_sustenta_severidade
    check (
      severidade not in ('muda_resultado', 'muda_timing')
      or (cenario is not null and length(btrim(cenario)) > 0)
    )
);

comment on table public.digest_pegadinhas is
  'Uma pegadinha por linha: algo que a regra diz e o titulo esconde. E o produto do componente. Digestao sem nenhuma e resposta legitima e frequente — regra simples existe, e exigir item cheio manda o modelo inventar.';

comment on column public.digest_pegadinhas.severidade is
  'muda_resultado | muda_timing | detalhe. NULL = digerido pela v1 do prompt, que nao pedia severidade. muda_timing existe por caso real: o mercado resolve na eliminacao matematica, nao no fim da temporada — mesmo desfecho, capital destravado meses antes.';

comment on column public.digest_pegadinhas.trecho is
  'A passagem LITERAL de events.description que cria a armadilha, conferida em codigo contra o texto. E o mecanismo que substituiu a instrucao que nao funcionava: com ele o numero de pegadinhas deixa de ser escolha do modelo e passa a ser o numero de passagens distintas da regra. NULL nas rodadas v1 e v2.';

comment on column public.digest_pegadinhas.cenario is
  'A situacao concreta em que a leitura ingenua e a regra divergem. Obrigatorio em muda_resultado e muda_timing (CHECK): sem cenario a severidade cai para detalhe. Existe porque 75% das pegadinhas da v2 vieram no nivel mais forte — quando o nivel mais forte nao custa nada, e ele que sai.';

alter table public.digest_pegadinhas enable row level security;

revoke all on public.digest_pegadinhas from anon, authenticated;

revoke all on sequence public.digest_pegadinhas_id_seq from anon, authenticated;

create index if not exists idx_digest_pegadinhas_digest
  on public.digest_pegadinhas (digest_id);

-- Para "quantas pegadinhas mudam resultado no radar inteiro" sem varrer a
-- tabela. Parcial: a pergunta é sobre o que foi classificado, e as linhas da v1
-- (severidade nula) só ocupariam espaço no índice.
create index if not exists idx_digest_pegadinhas_severidade
  on public.digest_pegadinhas (severidade)
  where severidade is not null;

create table if not exists public.digest_ambiguidades (
  id        bigserial primary key,
  digest_id uuid    not null references public.market_rule_digests (id) on delete cascade,
  ordinal   integer not null,

  -- A lista fechada. Anulável pelo mesmo motivo da severidade: a v1 não pedia
  -- tipo. `outro` NÃO é o mesmo que NULL — `outro` é "classifiquei e não coube",
  -- NULL é "nunca foi classificado". Misturar os dois faria a taxa de `outro`
  -- (o sinal de que a lista está incompleta) medir outra coisa.
  tipo text,

  -- O trecho literal da regra que causa a ambiguidade. Sem ele nada disso é
  -- auditável: uma categoria sem o texto que a motivou é uma afirmação sobre a
  -- regra que ninguém consegue conferir. NULL só nas linhas da v1.
  trecho text,

  -- A SEGUNDA passagem, a que contradiz a primeira. Só existe em
  -- `contradicao_interna`, e lá é obrigatória — ver o CHECK no fim da tabela.
  --
  -- Uma contradição é uma afirmação sobre DUAS passagens do texto ao mesmo
  -- tempo: "estas duas, juntas, se contradizem". Com um campo de trecho só, o
  -- modelo cita uma e descreve a outra em prosa, e a afirmação deixa de ser
  -- conferível — que foi como a v3 produziu uma leitura B já RECONCILIANDO as
  -- duas passagens ("apenas afastamento permanente conta, conforme esclarece a
  -- regra"), quando o achado era justamente que a regra não reconcilia.
  trecho_conflito text,

  -- As duas leituras. `leitura_b` é anulável só por causa da v1, que pedia uma
  -- frase solta. Nas versões seguintes as duas existem, e o formato é o que
  -- impede o modelo de dizer qual delas vence — decisão de quem resolve o
  -- mercado, não de quem o lê.
  leitura_a text not null,
  leitura_b text,

  created_at timestamptz not null default now(),

  constraint digest_ambiguidades_ordinal unique (digest_id, ordinal),
  constraint digest_ambiguidades_not_blank check (length(btrim(leitura_a)) > 0),
  constraint digest_ambiguidades_tipo
    check (
      tipo is null
      or tipo in (
        'contradicao_interna', 'precedencia_de_fonte', 'criterio_discricionario',
        'fonte_vaga', 'fuso_ausente', 'momento_ambiguo', 'data_ambigua',
        'janela_inclusiva', 'escopo_de_entidade', 'limiar_de_borda',
        'formato_do_mercado', 'outro'
      )
    ),

  -- Os dois trechos da contradição, no banco e não só no código.
  --
  -- O CHECK é dos DOIS LADOS de propósito: `contradicao_interna` sem a segunda
  -- passagem é uma contradição que ninguém consegue conferir, e um
  -- `trecho_conflito` em qualquer outro tipo é campo decorativo que faria
  -- `select ... where trecho_conflito is not null` deixar de ser a lista das
  -- contradições. É o mesmo desenho de `digest_pegadinhas_cenario_sustenta_severidade`:
  -- estrutura restringe, instrução não.
  --
  -- `case` e não `and`/`or`: com `tipo` NULL (as linhas da v1) a comparação
  -- devolveria NULL, e CHECK que devolve NULL passa. O `else` explícito faz a
  -- linha antiga cair na regra certa — sem segundo trecho — em vez de escapar.
  constraint digest_ambiguidades_conflito_so_na_contradicao
    check (
      case
        when tipo = 'contradicao_interna'
          then trecho_conflito is not null and length(btrim(trecho_conflito)) > 0
        else trecho_conflito is null
      end
    )
);

comment on table public.digest_ambiguidades is
  'Uma ambiguidade por linha, com tipo de lista fechada e o trecho que a causa. E o embriao do score de risco de disputa: padrao que repete entre mercados e coisa que se conta, e a contagem e um group by.';

comment on column public.digest_ambiguidades.tipo is
  'Lista fechada. NULL = digerido pela v1, que nao pedia tipo. outro = classificado e nao coube — e diferente de NULL, e a taxa de outro acima de 20% diz que a lista esta incompleta. momento_ambiguo entrou na v3, dos dois casos que caíram em outro na v2 ("as of market close" sem dizer qual fechamento): e sobre QUAL INSTANTE, distinto de fuso_ausente (o fuso) e de data_ambigua (qual data). contradicao_interna, precedencia_de_fonte e criterio_discricionario entraram na v4, lendo os 7 outro da v3 um a um.';

comment on column public.digest_ambiguidades.trecho is
  'O trecho LITERAL da regra que causa a ambiguidade. Sem ele a categoria e uma afirmacao sobre a regra que ninguem consegue conferir.';

comment on column public.digest_ambiguidades.trecho_conflito is
  'A SEGUNDA passagem literal, a que contradiz a primeira. Obrigatoria em contradicao_interna e NULL em todo o resto, os dois por CHECK. contradicao_interna e a categoria de maior valor da lista: regra que se contradiz e a forma exata da disputa — o oraculo vai ter que legislar, e isso se enxerga hoje no texto, sem esperar o evento.';

alter table public.digest_ambiguidades enable row level security;

revoke all on public.digest_ambiguidades from anon, authenticated;

revoke all on sequence public.digest_ambiguidades_id_seq from anon, authenticated;

create index if not exists idx_digest_ambiguidades_digest
  on public.digest_ambiguidades (digest_id);

-- O índice do produto: `group by tipo` sobre o radar inteiro. Parcial pelo mesmo
-- motivo do de severidade.
create index if not exists idx_digest_ambiguidades_tipo
  on public.digest_ambiguidades (tipo)
  where tipo is not null;

-- ---------------------------------------------------------------------------
-- Config
-- ---------------------------------------------------------------------------
--
-- Não há coluna `digest_enabled`, e a ausência é decisão. Não existe cron que
-- digira: quem roda é `scripts/digerir-regras.ts`, à mão, com degrau explícito
-- no argumento. Uma flag que nada lê é pior que flag nenhuma — ela promete um
-- desligamento que não existe. No dia em que houver job, a flag entra junto com
-- ele, nascendo `false` como a do analista e pelo mesmo motivo: este é o segundo
-- componente do sistema que gasta dinheiro por ciclo.

alter table public.system_config
  add column if not exists digest_model text not null default 'deepseek-v4-flash';

comment on column public.system_config.digest_model is
  'Modelo da digestao. O codigo so aceita modelo cujo preco ele conhece (src/digest/digest.ts): sem preco nao ha teto de gasto, e sem teto nao roda. deepseek-chat e deepseek-reasoner foram aposentados em 24/07/2026 e nao estao na tabela de preco.';

alter table public.system_config
  add column if not exists digest_prompt_version text not null default 'v1';

comment on column public.system_config.digest_prompt_version is
  'Versao do prompt, resolvida no registro de src/digest/prompts.ts. Rollback e UPDATE aqui, sem redeploy — o que exige que a versao anterior continue no codigo.';

alter table public.system_config
  add column if not exists digest_daily_budget_usd numeric(10,2) not null default 5.00;

-- Parada dura, não throttle — o mesmo desenho de `analyst_daily_budget_usd`, e
-- pelo mesmo motivo: throttle transforma estouro de orçamento em degradação
-- silenciosa, que é como se descobre o problema pela fatura.
--
-- O valor vem de MEDIÇÃO, e o degrau 1 mudou a ordem de grandeza. Medido em
-- 10 mercados com `deepseek-v4-flash`: US$ 0,00151 por digestão, com 1.056
-- tokens de entrada e 4.832 de saída na mediana (a saída inclui o raciocínio do
-- modelo, não só o JSON). Extrapolando para os 744 mercados do radar que têm
-- regra, a passada completa dá ~US$ 1,12 — quatro vezes o que a conta de guardanapo
-- previa. O default de 1,00 que este arquivo trazia antes BARRARIA a própria
-- passada completa, e teria barrado o degrau 2 (~US$ 4 com o Claude ao lado).
--
-- 5,00 é o mesmo teto do analista: cabe a passada completa três vezes no dia,
-- e ainda é apertado o bastante para segurar um laço descontrolado.
comment on column public.system_config.digest_daily_budget_usd is
  'Teto de gasto por dia UTC da digestao. Parada DURA: atingido, nenhuma chamada nova. Medido no degrau 1: US$ 0,00151 por digestao em deepseek-v4-flash, ~US$ 1,12 para os 744 mercados do radar.';

alter table public.system_config
  add column if not exists digest_timeout_ms integer not null default 300000;

-- 300s contra os 90s do analista, e a diferença é medida e não folga: a v3 do
-- prompt tem mediana de 84s de latência em `deepseek-v4-flash`, com a saída
-- chegando a 16 mil tokens (trecho e cenário em cada pegadinha, mais o
-- raciocínio). Os 120s que este arquivo trazia antes derrubaram uma chamada de
-- dez — e a falha aparece como `api_error` do fornecedor quando é o nosso prazo.
--
-- Sem retry, pelo mesmo argumento de sempre — retry multiplica o prazo pelo
-- número de tentativas, e é assim que um laço de centenas de chamadas fica
-- pendurado.
comment on column public.system_config.digest_timeout_ms is
  'Prazo de UMA digestao, via AbortSignal. 300s por medicao: a v3 tem mediana de 84s e a saida chega a 16 mil tokens. Sem retry: retry multiplicaria o prazo pelo numero de tentativas dentro de um laco de centenas de chamadas.';

alter table public.system_config
  add constraint system_config_digest_ranges
  check (digest_daily_budget_usd >= 0 and digest_timeout_ms > 0);

-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
--
-- 1. Não liga nada. Não há cron de digestão; quem roda é o script, à mão.
-- 2. Não digere nada. A tabela nasce vazia.
-- 3. Não toca em `events`. A digestão lê `description`, que existe desde a 001.
--
-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- 1. as três tabelas existem e estão vazias
--   select count(*) from public.market_rule_digests;
--   select count(*) from public.digest_pegadinhas;
--   select count(*) from public.digest_ambiguidades;
--
--   -- 1b. o produto, depois da primeira passada: o score de risco de disputa
--   select tipo, count(*) from public.digest_ambiguidades group by tipo order by 2 desc;
--   select severidade, count(*) from public.digest_pegadinhas group by severidade order by 2 desc;
--
--   -- 1c. o achado que vale dinheiro, isolado: as regras que se contradizem.
--   --     Duas passagens do MESMO texto, aplicadas ao mesmo cenario, com
--   --     resolucoes opostas. Nao e mercado dificil de prever — e mercado onde
--   --     quem resolve vai ter que legislar.
--   select d.event_id, a.trecho, a.trecho_conflito, a.leitura_a, a.leitura_b
--     from public.digest_ambiguidades a
--     join public.market_rule_digests d on d.id = a.digest_id
--    where a.tipo = 'contradicao_interna'
--    order by d.created_at desc;
--
--   -- 2. a config está com os defaults
--   select digest_model, digest_prompt_version, digest_daily_budget_usd,
--          digest_timeout_ms
--     from public.system_config where id = 1;
--
--   -- 3. quantos mercados do radar têm regra para digerir
--   --    (indice parcial idx_events_radar_tracked; nao varre a tabela)
--   select count(*) from public.events
--    where radar_tracked and description is not null and length(btrim(description)) > 0;
