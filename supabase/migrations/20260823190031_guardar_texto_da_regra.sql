-- O texto da regra, guardado sob o hash dele: `market_rule_texts`.
--
-- ---------------------------------------------------------------------------
-- O que se está impedindo
-- ---------------------------------------------------------------------------
--
-- `market_rule_digests` guarda `description_sha256` e NUNCA o texto. O texto só
-- existe em `events.description`, que é a versão ATUAL, sobrescrita no lugar
-- toda vez que a Polymarket edita a descrição.
--
-- No dia em que uma descrição é editada, o texto digerido deixa de existir em
-- qualquer lugar. Todo achado daquele texto vira citação de um documento que
-- ninguém possui: o trecho não casa com nada, a tela de regra o joga em
-- `naoLocalizados` — corretamente, porque ela não consegue mais provar que
-- aquela passagem esteve na regra.
--
-- A garantia deste projeto é "o achado aponta para o trecho literal". Sem
-- guardar o texto, a garantia tem data de validade, e quem a marca é a
-- Polymarket.
--
-- ---------------------------------------------------------------------------
-- Ainda não aconteceu, e é esse o argumento
-- ---------------------------------------------------------------------------
--
-- Medido em 23/08/2026, lendo `market_rule_digests` inteira e conferindo cada
-- hash contra `events.description`:
--
--   linhas (leituras)              1264
--   pares (mercado, texto)         1033
--   TEXTOS DISTINTOS (sha256)       267
--   textos recuperáveis hoje       267 de 267   (100,0%)
--   mercados sem descrição            0
--
-- Nenhum foi perdido ainda. O backfill de hoje tem taxa de sucesso de 100%, e
-- essa é a maior que ele jamais terá: cada dia sem esta tabela é mais digestão
-- cuja evidência pode sumir em silêncio, e nada recupera um texto depois que a
-- coluna foi sobrescrita.
--
-- ---------------------------------------------------------------------------
-- Por que tabela própria, e não uma coluna em `market_rule_digests`
-- ---------------------------------------------------------------------------
--
-- O custo NÃO decide isto, e fingir que decide seria desonesto. O corpus
-- inteiro tem 326.437 bytes — 318,8 KiB, mediana de 945 caracteres, p90 de
-- 2.079, máximo de 5.456. Como tabela por hash são 267 linhas e ~0,37 MB em
-- disco; como coluna seriam 1.264 linhas e ~1,6 MB. A diferença é 1,2 MB num
-- banco cujo `events` sozinho tem 711 MB. Cresce ~1,2 KB por texto novo: seriam
-- ~83 mil regulamentos distintos para chegar a 100 MB.
--
-- O que decide é DE QUEM O TEXTO É.
--
-- 1. O texto pertence ao HASH, não à leitura. São 267 textos para 1.264 linhas:
--    uma coluna guardaria 4,73 cópias de cada um, e nada garantiria que as 4,73
--    são iguais. É a mesma classe de defeito que `description_sha256` nasceu
--    para evitar — estado derivado que continua parecendo válido. Com o hash
--    como chave primária, "duas cópias divergentes" é impossível por
--    construção, não por disciplina.
--
-- 2. O multiplicador cresce sozinho. O nivelamento mira 3 leituras por texto e
--    o degrau 2 põe um segundo modelo ao lado. Cada um multiplica as cópias e
--    nenhum multiplica a informação.
--
-- 3. É a pergunta que a tela faz. `ColunaDireita` quer "o texto do sha X":
--    lookup por chave primária numa tabela de 267 linhas. Pela coluna seria
--    filtro por coluna não-única devolvendo até cinco linhas com cinco cópias
--    do mesmo texto, e escolher qual.
--
-- 4. O projeto já trata texto-por-hash como entidade. `digest_contradicoes` é
--    "defeito de TEXTO"; `mercados_do_texto` conta mercados por texto; a
--    propagação de achados casa por `description_sha256`. Faltava só a tabela
--    onde essa entidade mora.
--
-- ---------------------------------------------------------------------------
-- Por que `market_rule_texts` e não `digest_textos`
-- ---------------------------------------------------------------------------
--
-- O texto não é filho da digestão: é a ENTRADA dela. O regulamento existe antes
-- de alguém o ler, e um nome com prefixo `digest_` inverteria a direção da
-- dependência bem na tabela para onde a FK aponta. As duas tabelas-filhas
-- (`digest_pegadinhas`, `digest_ambiguidades`) são saída da digestão e por isso
-- carregam o prefixo; esta não é.
--
-- A coluna chama `description`, não `texto`. A chave já se chama
-- `description_sha256` — é o hash DA description. Ter as duas lado a lado torna
-- a relação óbvia sem comentário nenhum, e amarra a coluna à origem real do
-- dado, que é `events.description`.
--
-- ---------------------------------------------------------------------------
-- Por que `guardado_por` e não `origem`
-- ---------------------------------------------------------------------------
--
-- `origem` já significa outra coisa neste banco, e não uma: duas.
--
--   `digest_achados_por_mercado.achados[].origem` e
--   `digest_contradicoes.mercados[].origem` valem `acusado | herdado` — a
--   PROVENIÊNCIA DO ACHADO: o modelo leu este mercado, ou o achado veio de um
--   irmão com o mesmo texto (`20260817033302_...sql:166`).
--
--   `v_radar.preco_origem` vale `'derivado (1 - lado coletado)'` e afins — de
--   que lado do livro o preço saiu (`20260814151752_...sql:351`).
--
-- Aqui a coluna diz COMO A LINHA ENTROU: guardada no instante da digestão, ou
-- recuperada depois pelo backfill. É um terceiro conceito, e o terceiro sentido
-- da mesma palavra no mesmo schema é o que faz alguém escrever
-- `where origem = 'acusado'` contra a tabela errada daqui a três meses e obter
-- zero linhas sem erro nenhum.
--
-- `guardado_por` responde a pergunta que a coluna de fato responde — "quem
-- guardou este texto?" — e não colide com nada.

-- ---------------------------------------------------------------------------
-- pgcrypto, e a guarda que troca um erro obscuro por um erro escrito
-- ---------------------------------------------------------------------------
--
-- O CHECK do hash chama `extensions.digest`. Sem ela resolvida no instante do
-- apply, o erro seria `function extensions.digest(text, text) does not exist`
-- no meio de um `create table` — verdadeiro e inútil.
--
-- Não há `create extension` aqui. pgcrypto JÁ está instalada em `extensions`
-- neste banco — consultado em 23/08/2026, `extnamespace = extensions` — e um
-- `create extension if not exists` sobre extensão presente não acrescenta nada
-- além de uma checagem de privilégio que pode falhar sozinha.
--
-- A guarda abaixo pergunta ao pg_proc as DUAS coisas de que o CHECK depende, e
-- é ela a lição desta migration virada código: `convert_to` foi lido como
-- imutável no fonte do PostgreSQL e este banco respondeu `s`. Ler não
-- substitui perguntar — então aqui quem pergunta é a própria migration, antes
-- de tentar criar coisa nenhuma.
--
-- ## Por assinatura, e não por `pronargs = 2`
--
-- pgcrypto declara DUAS sobrecargas de dois argumentos: `digest(bytea, text)` e
-- `digest(text, text)`. Um filtro por `proname` e `pronargs` casa as duas, e um
-- `select ... into` sobre duas linhas pega a primeira e descarta a segunda em
-- silêncio — aprovando um CHECK a partir da volatilidade de uma função que o
-- CHECK não chama. Hoje daria no mesmo porque as duas são `i`; num banco onde
-- só uma fosse, a guarda diria sim para a errada.
--
-- É a mesma família do teste que afirma só o estado final: a asserção passa sem
-- nunca ter tocado no que ela existia para travar.
--
-- `to_regprocedure` resolve a assinatura EXATA — a mesma que
-- `digest(description, 'sha256')` vai resolver no CHECK, porque `description` é
-- `text` e casa `digest(text, text)` sem cast, enquanto a outra sobrecarga
-- exigiria um `text` → `bytea` que o Postgres não faz implicitamente. Depois
-- disso o `into` é seguro, e por um motivo que mudou: o filtro passou a ser a
-- chave primária de `pg_proc`, onde "a primeira linha" e "a linha" são a mesma
-- coisa.
do $$
declare
  alvo regprocedure := to_regprocedure('extensions.digest(text, text)');
  volatilidade "char";
begin
  if alvo is null then
    raise exception
      'extensions.digest(text, text) nao existe: pgcrypto esta ausente ou em outro schema. Rode "select oid::regprocedure, provolatile from pg_proc where proname = ''digest''" para ver as sobrecargas e onde elas moram, e qualifique o CHECK market_rule_texts_hash_confere com o schema da que recebe (text, text).';
  end if;

  select provolatile into volatilidade from pg_proc where oid = alvo;

  if volatilidade <> 'i' then
    raise exception
      'extensions.digest(text, text) e provolatile=%, e CHECK so aceita IMMUTABLE. O CHECK market_rule_texts_hash_confere nao pode existir neste banco: apague a constraint e esta guarda, e registre no PR que a issue #9 fecha sem ela.', volatilidade;
  end if;
end $$;

create table if not exists public.market_rule_texts (
  -- Chave PRIMÁRIA, e é ela que faz o resto funcionar: o mesmo regulamento
  -- compartilhado por dez mercados é UMA linha, e a FK lá embaixo tem em que se
  -- apoiar. Endereçamento por conteúdo — o hash não é atributo da linha, é o
  -- nome dela.
  description_sha256 text primary key,

  -- O texto, exatamente como foi digerido: `events.description` passada por
  -- `trim()`, que é o que `readMarketsToDigest` entrega ao modelo e o que
  -- `hashDescription` hasheia. Um trim a mais ou a menos aqui e a linha deixa de
  -- casar com a própria chave — e agora isso não é mais um risco descrito em
  -- comentário, é uma linha que o banco recusa (ver o CHECK do hash).
  description text not null,

  -- Como esta LINHA entrou. `digestao` = guardada no instante em que o modelo
  -- leu o texto, que é o caminho que fecha o vazamento. `backfill` = recuperada
  -- depois de `events.description`, com o hash conferido, que é o caminho que
  -- limpa o passado e existe uma vez só.
  --
  -- Não é decorativo: no dia em que `backfill` voltar a aparecer com data nova,
  -- é porque uma digestão entrou sem trazer o texto junto — o vazamento
  -- reaberto.
  guardado_por text not null,

  created_at timestamptz not null default now(),

  -- sha256 em hex, sempre 64 caracteres. O mesmo CHECK de
  -- `market_rule_digests`, pelo mesmo motivo: pega o dia em que alguém gravar o
  -- hash truncado (ou o texto no lugar dele) e a busca por chave passar a nunca
  -- casar.
  constraint market_rule_texts_sha256_hex
    check (description_sha256 ~ '^[0-9a-f]{64}$'),

  -- Texto em branco não é texto. Uma linha vazia aqui seria pior que linha
  -- nenhuma: a tela concluiria "o regulamento está guardado" e mostraria nada —
  -- exatamente o estado que esta migration existe para impedir, disfarçado de
  -- sucesso.
  --
  -- O conjunto de brancos é EXPLÍCITO e não o default do `btrim`, que corta só
  -- espaço. `String.prototype.trim()` do JavaScript corta tabulação, quebra de
  -- linha, retorno de carro e mais — então uma descrição feita só de `\t` chega
  -- aqui como string vazia pelo lado do TypeScript, e o `btrim` default a
  -- deixaria passar como se tivesse conteúdo.
  constraint market_rule_texts_nao_vazio
    check (length(btrim(description, E' \t\n\r\f\v')) > 0),

  -- A lista fechada, no banco e não na boa vontade do script. Sem ela a coluna
  -- aceita 'batata', e a pergunta "quantos textos ainda vieram de backfill"
  -- passa a ter uma resposta que não é a verdade nem o erro — é o silêncio.
  constraint market_rule_texts_guardado_por
    check (guardado_por in ('digestao', 'backfill')),

  -- ---------------------------------------------------------------------------
  -- O CHECK que torna a linha incapaz de mentir sobre o próprio hash
  -- ---------------------------------------------------------------------------
  --
  -- Esta tabela existe para uma promessa: o texto guardado sob um hash É o texto
  -- que produziu aquele hash. Sem este CHECK, a promessa mora em três lugares de
  -- código (`planBackfill`, a carga, o backfill) e vale enquanto os três
  -- estiverem certos. Com ele, a linha errada não existe.
  --
  -- ## Por que não precisa replicar o `trim()` do TypeScript
  --
  -- É a pergunta que derruba a maioria das tentativas deste tipo, e a resposta
  -- aqui é que ELE NÃO NORMALIZA NADA. `hashDescription` hasheia a string já
  -- passada por `trim()` em `readMarketsToDigest`, e é ESSA MESMA string que vai
  -- para a coluna `description`. O trim aconteceu uma vez, antes das duas
  -- coisas, do lado de fora. O banco não refaz o corte: ele hasheia o que está
  -- gravado, byte a byte.
  --
  -- Um `btrim` dentro desta expressão é que quebraria a paridade — o `trim()` do
  -- JavaScript corta NBSP (U+00A0), BOM (U+FEFF) e a categoria Zs inteira, e
  -- nenhum `btrim` do Postgres corta esse conjunto. É por isso que o CHECK de
  -- vazio acima usa `btrim` e este aqui não usa: um pergunta "sobrou alguma
  -- coisa?", o outro pergunta "isto é exatamente aquilo?".
  --
  -- ## A paridade que sobra é de ENCODING, e é uma só
  --
  -- `createHash('sha256').update(str)` no Node, sem segundo argumento, hasheia os
  -- bytes UTF-8 da string. `digest(text, 'sha256')` do pgcrypto hasheia os bytes
  -- do valor NA CODIFICAÇÃO DO BANCO. Os dois coincidem porque este banco é
  -- UTF-8, e isso foi CONSULTADO, não suposto: `show server_encoding` devolveu
  -- `UTF8` em 23/08/2026.
  --
  -- É a única premissa deste CHECK que mora fora do arquivo. Um banco restaurado
  -- em LATIN1 faria toda linha nova ser recusada — alto e imediato, não
  -- silencioso, que é o modo certo de essa premissa quebrar.
  --
  -- Postgres não normaliza texto na entrada (não há NFC/NFD automático) e o Node
  -- também não, então não há terceira diferença possível.
  --
  -- Sobra um caso e ele é benigno: `text` do Postgres não aceita U+0000, e uma
  -- descrição com NUL seria recusada no INSERT, antes deste CHECK. Falha alta,
  -- não silenciosa.
  --
  -- ## O que isto pega além da mentira
  --
  -- Corrupção de transporte. Se um dia a serialização JSON entre o script e o
  -- PostgREST mutilar um caractere, o texto gravado deixa de hashear para a
  -- chave e a linha é RECUSADA — em vez de entrar parecendo evidência. Esse é o
  -- caso que nenhuma quantidade de conferência no cliente pega, porque a
  -- conferência do cliente acontece antes do transporte.
  --
  -- ## Por que pgcrypto e não o `sha256()` do core — leia antes de "otimizar"
  --
  -- A forma bonita seria `encode(sha256(convert_to(description, 'UTF8')), 'hex')`:
  -- três funções do core, todas em `pg_catalog`, resolvendo sempre, sem depender
  -- de extensão nenhuma. **Ela não pode ser criada neste banco**, e a razão não
  -- se descobre lendo código:
  --
  --   CHECK só aceita função IMMUTABLE, e aqui `convert_to` é STABLE.
  --
  -- Isto foi CONSULTADO em 23/08/2026:
  --
  --   select provolatile from pg_proc where proname = 'convert_to' and pronargs = 2;
  --   -- devolveu: s
  --
  -- E o registro que importa para quem vier depois: a leitura do `pg_proc.dat` do
  -- fonte do PostgreSQL levou à conclusão OPOSTA — que o default de
  -- `provolatile` ali é `i` e que `convert_to` não o sobrescreve. O catálogo
  -- deste banco diz `s`. Ler o fonte NÃO substituiu perguntar ao sistema, e foi
  -- perguntar ao sistema que evitou uma migration que falharia no apply.
  --
  -- Faz sentido que seja `s`: a conversão parte da codificação do banco, que é
  -- propriedade do banco e não da expressão. Mas o que decide não é o que faz
  -- sentido — é o que o `pg_proc` responde, no banco em que a migration vai
  -- rodar.
  --
  -- Então: antes de trocar isto pelo `sha256()` do core, rode a consulta acima.
  -- Se ela ainda devolver `s`, a troca não compila.
  --
  -- O preço de usar pgcrypto é a dependência de schema: a extensão mora em
  -- `extensions` no Supabase, e um CHECK só é criado se a função resolver NO
  -- INSTANTE do apply — por isso a chamada é qualificada e por isso existe a
  -- guarda logo acima do `create table`.
  constraint market_rule_texts_hash_confere
    check (encode(extensions.digest(description, 'sha256'), 'hex') = description_sha256)
);

comment on table public.market_rule_texts is
  'O texto da regra guardado sob o sha256 dele. Enderecado por conteudo: o mesmo regulamento compartilhado por dez mercados e uma linha so. Existe para a garantia "o achado aponta para o trecho literal" nao expirar quando a Polymarket editar events.description.';

comment on column public.market_rule_texts.description_sha256 is
  'Chave primaria: sha256 hex do texto ja passado por trim(), a MESMA conta de hashDescription em src/digest/digest.ts. E o nome da linha, nao um atributo dela — e o CHECK market_rule_texts_hash_confere garante que a linha nao pode mentir sobre ele.';

comment on column public.market_rule_texts.description is
  'events.description como foi digerida, ja com trim(). O trim acontece no TypeScript, UMA vez, antes do hash e antes da gravacao — por isso o CHECK do hash nao refaz corte nenhum.';

comment on column public.market_rule_texts.guardado_por is
  'digestao = guardado quando o modelo leu; backfill = recuperado depois de events.description com o hash conferido. NAO confundir com origem (acusado|herdado) das views de achado, nem com v_radar.preco_origem: aqui a pergunta e como a LINHA entrou. backfill com data nova depois desta migration significa digestao entrando sem trazer o texto — o vazamento reaberto.';

-- Mesmo desenho das outras tabelas do digest: RLS ligada, sem policy, e a tela
-- chega pelo proxy do Vite com a service key (ver `web/src/lib/supabase.ts`).
alter table public.market_rule_texts enable row level security;

revoke all on public.market_rule_texts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- A FK, e por que ela é `not valid` e `on delete restrict`
-- ---------------------------------------------------------------------------
--
-- `not valid` porque no instante deste apply a tabela está VAZIA e as 1.264
-- linhas de `market_rule_digests` violariam a constraint todas de uma vez. Ela
-- passa a valer para escrita NOVA — que é onde o vazamento acontece — sem
-- exigir que o passado já esteja arrumado. Depois do backfill, uma segunda
-- migration de uma linha faz o resto — é a
-- `20260823200344_validar_texto_guardado.sql`, e ela só foi escrita DEPOIS de o
-- backfill rodar, para um `db push` não ter como aplicar as duas na mesma
-- passada com a tabela ainda vazia.
--
-- `on delete restrict` porque cascata aqui seria a perda de evidência desta
-- issue chegando por outra porta: apagar um texto levaria junto as digestões
-- que o citam. Quem precisar apagar um texto tem que lidar com as digestões
-- primeiro, conscientemente. Não há caminho em que essa decisão seja automática.
--
-- Consequência assumida, e ela é o ponto: enquanto esta constraint existir,
-- gravar digestão sem o texto guardado é IMPOSSÍVEL. Estrutura restringe,
-- instrução não — o mesmo desenho de
-- `digest_pegadinhas_cenario_sustenta_severidade`. Por isso
-- `scripts/carregar-digest.ts` passou a gravar o texto ANTES dos digests, e a
-- recusar no dry-run a entrada cujo texto não existe em lugar nenhum.
alter table public.market_rule_digests
  add constraint market_rule_digests_texto_guardado
  foreign key (description_sha256)
  references public.market_rule_texts (description_sha256)
  on delete restrict
  not valid;

comment on constraint market_rule_digests_texto_guardado on public.market_rule_digests is
  'Digestao nova so entra se o texto dela estiver guardado. not valid: as 1264 linhas anteriores ao backfill nao sao conferidas no apply. on delete restrict: apagar texto citado por digestao exige lidar com as digestoes primeiro.';

-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
--
-- 1. Não guarda texto nenhum. A tabela nasce vazia; quem a enche é
--    `npm run backfill:texto-da-regra -- --confirmar`, que é do dono.
-- 2. Não valida a FK sobre as 1.264 linhas existentes. Isso é a
--    `20260823200344_validar_texto_guardado.sql`, depois do backfill.
-- 3. Não toca em `events`. `events.description` continua sendo a descrição
--    ATUAL e continua podendo ser sobrescrita — esta tabela existe justamente
--    porque ela pode.
--
-- ---------------------------------------------------------------------------
-- Verificação ANTES do apply
-- ---------------------------------------------------------------------------
--
-- Duas perguntas decidem se o CHECK do hash é criável, e as duas JÁ FORAM
-- RESPONDIDAS contra este banco em 23/08/2026. Ficam escritas porque a resposta
-- é do banco e não do arquivo — outro banco pode responder diferente, e a guarda
-- `do $$` lá em cima existe para que ele responda antes de tentar criar nada.
--
--   -- 1. a funcao do CHECK e imutavel? Pela ASSINATURA, nao por pronargs = 2:
--   --    pgcrypto tem digest(bytea,text) e digest(text,text), e a pergunta e
--   --    sobre a segunda, que e a que o CHECK chama.
--   select provolatile from pg_proc
--    where oid = to_regprocedure('extensions.digest(text, text)');
--   -- devolveu: i     (schema confirmado por extnamespace em pg_extension: extensions)
--
--   -- 2. o banco é UTF-8? É a única paridade de que o CHECK depende.
--   show server_encoding;
--   -- devolveu: UTF8
--
-- Uma terceira consulta seria "a conta bate no dado real?", e ela NÃO está aqui
-- de propósito: em SQL o corte teria que ser `btrim`, que tira só espaço,
-- enquanto o `trim()` do JavaScript tira tabulação, quebra de linha, NBSP e a
-- categoria Zs. Uma descrição com `\n` na ponta sairia `false` sem nada estar
-- errado, e um probe que dá falso negativo é pior que probe nenhum.
--
-- Essa pergunta já foi respondida do lado certo: `npm run medir:texto-perdido`
-- refaz a conta com o MESMO `trim()` e o MESMO sha256 da digestão, e em
-- 23/08/2026 devolveu 267 de 267 conferindo. É lá que ela se responde.
--
-- Num banco em que (1) devolva `s`, o CHECK do hash não pode existir de forma
-- nenhuma — nem por pgcrypto nem pelo core — e a garantia volta a morar só no
-- código: apague a constraint `market_rule_texts_hash_confere` e a guarda
-- `do $$`, e registre no PR que a issue #9 fecha sem ela.
--
-- Num banco em que (1) devolva outro `nspname`, é só qualificar o CHECK com ele.
--
-- Nos dois casos a guarda já para o apply com a instrução escrita, então estas
-- consultas são conforto, não requisito.
--
-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- 1. a tabela existe e está vazia
--   select count(*) from public.market_rule_texts;
--
--   -- 2. as quatro constraints estão lá, e a FK marcada como não validada
--   select conname, contype, convalidated
--     from pg_constraint
--    where conrelid = 'public.market_rule_texts'::regclass
--       or conname = 'market_rule_digests_texto_guardado';
--
--   -- 3. o CHECK do hash não é decorativo. Isto tem que FALHAR:
--   --    ERROR: new row violates check constraint "market_rule_texts_hash_confere"
--   insert into public.market_rule_texts (description_sha256, description, guardado_por)
--   values (repeat('0', 64), 'um texto que nao hasheia para essa chave', 'backfill');
--
--   -- 4. DEPOIS do backfill: digestão apontando para texto que não existe.
--   --    Espera 0 — e é a mesma pergunta que a validação da FK faz.
--   select count(*)
--     from public.market_rule_digests d
--     left join public.market_rule_texts t using (description_sha256)
--    where t.description_sha256 is null;
--
--   -- 5. de onde vieram os textos. Depois do backfill: 267 em `backfill`,
--   --    e `digestao` crescendo a cada passada nova.
--   select guardado_por, count(*), min(created_at), max(created_at)
--     from public.market_rule_texts group by guardado_por;
