-- `market_rule_digests.leitura_n`: o índice da leitura dentro da mesma chave.
--
-- ---------------------------------------------------------------------------
-- O problema, que é uma chave que impede o passo seguinte
-- ---------------------------------------------------------------------------
--
-- A `20260815213832` chaveou a tabela em (evento, hash do texto, modelo, versão)
-- e o comentário dela explica bem por quê: sem `model` na chave, rodar dois
-- modelos lado a lado seria impossível. O que a chave não previu é rodar o
-- MESMO modelo, na MESMA versão, sobre o MESMO texto, DE NOVO.
--
-- E é exatamente isso que o passo 2b precisa fazer. A medida que motiva:
--
--   - 191 textos de regra distintos entre as 728 digestões;
--   - 112 deles foram lidos UMA vez só (aparecem em um mercado só);
--   - nos textos lidos mais de uma vez, 52% dos achados apareceram em uma
--     leitura só e apenas 9,9% em todas.
--
-- Ou seja: um mercado com 20 achados e outro com 3 podem ter regulamentos de
-- periculosidade igual e leituras de número diferente — 44 contra 1. Isso é a
-- variação do INSTRUMENTO se disfarçando de variação do MUNDO. O projeto já
-- pagou por essa confusão duas vezes, com os nomes de "ordenar por volume" e de
-- "livro vazio tem mid 0,50".
--
-- Nivelar é ler cada texto no mínimo 3 vezes. Com a chave de 4 colunas, a
-- segunda leitura do mesmo mercado colide, e o insert falha.
--
-- ---------------------------------------------------------------------------
-- Por que uma coluna, e não afrouxar a unique
-- ---------------------------------------------------------------------------
--
-- Tirar a unique resolveria o insert e destruiria a garantia: a proteção contra
-- carregar duas vezes o mesmo artefato — que é o que `carregar-digest` promete
-- quando diz "rodar duas vezes não duplica" — vem dela. Sem unique nenhuma, uma
-- carga repetida dobraria as leituras de tudo, e `vezes_encontrado` da
-- `digest_achados_por_mercado` passaria a medir quantas vezes alguém rodou o
-- script.
--
-- Com `leitura_n` na chave, a leitura 2 é uma linha nova e a leitura 2
-- carregada duas vezes continua sendo uma. A propriedade que se quer é essa, e
-- ela precisa de um número explícito na linha — não de ausência de regra.
--
-- ---------------------------------------------------------------------------
-- Por que `default 1` e não backfill
-- ---------------------------------------------------------------------------
--
-- As 728 linhas existentes são, todas, a primeira leitura da sua chave — a
-- unique antiga garantia isso, não é suposição. `default 1` grava o valor certo
-- em todas elas sem varrer nada e sem UPDATE.
--
-- A unique nova é implicada pela antiga (5 colunas, sendo as 4 primeiras já
-- únicas), então ela não pode falhar sobre os dados existentes. Se falhar, a
-- premissa acima estava errada e é melhor a migration parar.
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
--
-- Não lê nada, não digere nada, não muda prompt, taxonomia, severidade nem
-- view. O passo 2b muda UMA variável — quantas vezes cada texto foi lido — e o
-- critério de sucesso dele só significa alguma coisa se nada mais se mexer
-- junto.

alter table public.market_rule_digests
  add column if not exists leitura_n integer not null default 1;

comment on column public.market_rule_digests.leitura_n is
  'Indice da leitura dentro de (evento, hash, modelo, versao). 1 e a primeira. Existe para que o MESMO texto possa ser lido de novo pelo MESMO modelo na MESMA versao — o nivelamento do passo 2b — sem colidir na unique e sem afrouxa-la. As 728 linhas anteriores sao todas leitura 1, garantido pela unique antiga e nao suposto.';

-- A trava contra o zero e o negativo. `leitura_n = 0` passaria despercebido e
-- faria `count(*)` continuar certo enquanto `max(leitura_n)` mentisse — e é
-- `max(leitura_n) + 1` que o script usa para escolher o índice da próxima.
alter table public.market_rule_digests
  add constraint market_rule_digests_leitura_n_positiva
  check (leitura_n >= 1);

-- A troca da chave. Nesta ordem: a nova é criada DEPOIS da antiga sair porque
-- as duas cobrem o mesmo prefixo de colunas e manter as duas seria um índice a
-- mais mantido em todo insert, sem nada em troca.
alter table public.market_rule_digests
  drop constraint market_rule_digests_one_per_text_and_model;

alter table public.market_rule_digests
  add constraint market_rule_digests_one_per_text_model_and_reading
  unique (event_id, description_sha256, model, prompt_version, leitura_n);

-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- 1. toda linha existente é leitura 1, e são 728
--   select leitura_n, count(*) from public.market_rule_digests group by 1 order by 1;
--
--   -- 2. a chave nova está lá e a antiga saiu
--   select conname from pg_constraint
--    where conrelid = 'public.market_rule_digests'::regclass
--      and contype = 'u';
--   -- esperado: market_rule_digests_one_per_text_model_and_reading, e só ela
--
--   -- 3. o que o nivelamento tem pela frente, contado pelo banco.
--   --    Esperado em 17/08/2026: 191 textos, 130 abaixo de 3 leituras,
--   --    242 chamadas para nivelar.
--   select count(*)                                        as textos,
--          count(*) filter (where leituras < 3)            as abaixo_de_3,
--          coalesce(sum(3 - leituras) filter (where leituras < 3), 0) as chamadas
--     from (
--       select description_sha256, count(*) as leituras
--         from public.market_rule_digests
--        group by description_sha256
--     ) t;
