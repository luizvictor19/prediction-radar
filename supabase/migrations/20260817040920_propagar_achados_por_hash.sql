-- `digest_achados_por_mercado`: a UNIÃO de tudo que foi achado no texto da
-- regra que o mercado recebeu — pegadinha, ambiguidade e contradição —, não só
-- o que o modelo acusou lendo aquele mercado.
--
-- É a `20260817033302_propagar_contradicoes_por_hash.sql` estendida das
-- contradições para as outras duas classes, e virada do avesso: lá a linha é o
-- DEFEITO e os mercados são a lista; aqui a linha é o MERCADO e os achados são
-- a lista. As duas leem os mesmos fatos por lados opostos, e `achado_id` de
-- classe `contradicao` é o mesmo `defeito_id` de lá de propósito — ver a nota
-- sobre a chave.
--
-- ---------------------------------------------------------------------------
-- Por que a propagação vale para as três classes
-- ---------------------------------------------------------------------------
--
-- O argumento é o mesmo da migration anterior e não fica mais fraco fora da
-- contradição, porque não depende da classe: o achado está ANCORADO num trecho
-- literal do texto da regra, e dois mercados com o mesmo `description_sha256`
-- receberam esse texto byte a byte — é o que o hash quer dizer. A passagem que
-- cria a armadilha existe no texto de um porque existe no texto do outro. Que o
-- modelo tenha escrito a linha só num deles é fato sobre o modelo.
--
-- O que a âncora sustenta e o que ela não sustenta:
--
--   - Sustenta: "esta passagem está aqui". O trecho é conferido contra
--     `events.description` na carga (`src/digest/digest.ts`), e a conferência
--     não depende de qual mercado é — o texto é o mesmo para o grupo inteiro.
--   - Não sustenta: "esta passagem importa TANTO aqui quanto lá". A pergunta do
--     mercado muda em volta da regra igual. É por isso que a classificação
--     viaja e a prosa não — ver `subtipos` e a nota do nulo.
--
-- ---------------------------------------------------------------------------
-- O tamanho disto, medido antes de virar view
-- ---------------------------------------------------------------------------
--
-- Sobre o estado do banco em 17/08/2026: 728 digestões, todas
-- `deepseek-v4-flash`/`v4`, nenhum mercado com mais de um texto, 3.985 achados
-- e NENHUM sem trecho (a v4 sempre ancora; as v1/v2 não ancoravam, e se linhas
-- delas entrarem depois esta view as ignora — ver o limite 4).
--
--   - 191 grupos de hash. 79 têm mais de um mercado e cobrem 616 dos 728.
--   - Por mercado: 5,47 achados ANTES, 17,45 DEPOIS. Ganho médio de +11,97,
--     mediana 11, máximo 32. 615 dos 728 mercados (84,5%) ganham ao menos um.
--     A lista inteira vai de 3.985 para 12.702 itens — 3,19×.
--   - Por classe: pegadinha 2.187 → 6.123, ambiguidade 1.777 → 6.451,
--     contradição 21 → 128. As contradições têm que bater com a soma de
--     `mercados_atingidos` da `digest_contradicoes` — é a conferência cruzada
--     no fim deste arquivo.
--
-- ---------------------------------------------------------------------------
-- Por que `vezes_encontrado` é obrigatório, e não enfeite
-- ---------------------------------------------------------------------------
--
-- Nos 79 textos lidos mais de uma vez há 1.226 achados distintos. Destes:
--
--   - 638 (52,0%) apareceram em UMA leitura só;
--   - 121 (9,9%) apareceram em TODAS.
--
-- Os grupos vão de 2 a 44 leituras, mediana 5. Sem a contagem, "1 de 44" e
-- "44 de 44" chegam ao leitor com exatamente a mesma cara, e a segunda é um
-- achado do texto enquanto a primeira é uma leitura que 43 outras não
-- confirmaram. Propagar sem essa coluna transformaria a instabilidade do modelo
-- em fato sobre o mercado — que é o erro que a `origem` existe para impedir na
-- outra direção.
--
-- Por isso `vezes_encontrado` E `leituras_do_texto` viajam DENTRO de cada item
-- do jsonb, e não só nas colunas da linha: o item é o que vai sozinho para uma
-- mensagem de bot, e lá fora ele precisa carregar o próprio denominador.
--
-- A contagem é de LEITURAS (linhas de `market_rule_digests`), não de mercados.
-- Com uma digestão por mercado — o estado de hoje — os dois números coincidem;
-- no dia do degrau 2, com dois modelos lado a lado, deixam de coincidir e a
-- leitura é a unidade certa: o denominador é quantas vezes alguém leu o texto.
--
-- ---------------------------------------------------------------------------
-- A chave do achado
-- ---------------------------------------------------------------------------
--
--   pegadinha    md5('pegadinha||'   || n(trecho))
--   ambiguidade  md5('ambiguidade||' || tipo || '||' || n(trecho))
--   contradicao  md5(least(n1,n2) || '||' || greatest(n1,n2))
--
-- `n()` é a mesma normalização da conferência de trecho em `src/digest/digest.ts`:
-- minúscula e espaço colapsado. Tolera grafia, não tolera paráfrase.
--
-- Três decisões dentro disso:
--
-- 1. A contradição NÃO leva prefixo, e a fórmula é copiada letra por letra da
--    `20260816181722`. É o que faz `achado_id` casar com
--    `digest_contradicoes.defeito_id` e as duas views se juntarem por igualdade.
--    O preço é que a fórmula difere por classe; a colisão exigiria um trecho de
--    regra que começasse literalmente com `pegadinha||`.
--
-- 2. `tipo` entra na chave da ambiguidade, `severidade` NÃO entra na da
--    pegadinha. Não é assimetria distraída: `tipo` é a afirmação ("esta
--    passagem é ambígua quanto ao FUSO"), e duas afirmações diferentes sobre a
--    mesma passagem são dois achados. `severidade` é a magnitude do mesmo
--    achado, e dois modelos discordando entre `muda_resultado` e `detalhe`
--    continuam falando da mesma armadilha. Consequência assumida: a mesma
--    passagem classificada em dois `tipo` aparece duas vezes, com
--    `vezes_encontrado` dividido entre elas. Fica visível, que é o ponto.
--
-- 3. A discordância de severidade não é resolvida por voto nem escondida:
--    `subtipos` é um ARRAY. `{muda_resultado,detalhe}` diz que os modelos
--    discordaram, e um único elemento diz que não houve o que discordar. Para
--    ambiguidade e contradição o array sempre tem um elemento só, porque o tipo
--    já está na chave.
--
-- ---------------------------------------------------------------------------
-- O nulo do herdado
-- ---------------------------------------------------------------------------
--
-- Regra única, aplicada às três classes: **o que é do TEXTO viaja, o que o
-- modelo escreveu PARA UM MERCADO não.**
--
--   viaja       classe, subtipos, trecho, trecho_conflito, achado_id,
--               vezes_encontrado
--   não viaja   descricao (o `texto` da pegadinha), cenario, leitura_a,
--               leitura_b
--
-- No herdado esses quatro são NULOS, e o nulo é honesto: ninguém escreveu nada
-- sobre aquele mercado. Copiar a prosa do vizinho faria a propagação parecer
-- detecção — a mesma armadilha da view anterior, e pior aqui, porque `cenario`
-- e `leitura_a` são frases sobre A PERGUNTA daquele mercado, e a pergunta é
-- justamente o que difere dentro do grupo de hash.
--
-- Quem quiser a prosa tem por onde: `achado_id` leva aos mercados que acusaram.
--
-- ---------------------------------------------------------------------------
-- Os limites
-- ---------------------------------------------------------------------------
--
-- 1. Só se propaga para mercado DIGERIDO, pelo mesmo motivo da migration
--    anterior: o grupo de hash sai de `market_rule_digests`, e hashear
--    `events.description` na view seria varredura dos 711 MB a cada select. A
--    cobertura é a da última passada.
--
-- 2. A propagação ATRAVESSA modelo e versão de prompt, de propósito: o hash é
--    do texto e o texto não muda porque o prompt mudou.
--
-- 3. Uma linha por (mercado, TEXTO), não por mercado. Hoje dá no mesmo — zero
--    mercados têm mais de um texto. Quando a Polymarket editar uma descrição e
--    o mercado for redigerido, ele aparece duas vezes, e é o certo: os achados
--    do texto velho não são achados do texto novo. A conferência no fim conta
--    quantos `event_id` duplicam.
--
-- 4. Achado sem trecho é EXCLUÍDO, não propagado sem âncora. São as linhas das
--    v1/v2, que não pediam trecho. Hoje não existe nenhuma; se voltarem a
--    existir, somem daqui em silêncio — e é por isso que `achados_sem_ancora`
--    é coluna, e não nota de rodapé.
--
-- 5. Mercado digerido sem nenhum achado CONTINUA na view, com `achados_total`
--    zero e `achados` em `[]`. Regra sem armadilha é resposta legítima e
--    frequente, e um mercado que some da lista é indistinguível de um mercado
--    que nunca foi digerido.

create view public.digest_achados_por_mercado with (security_invoker = true) as
with achados as (
  -- --- pegadinhas ----------------------------------------------------------
  select
    d.id                    as digest_id,
    d.event_id,
    d.description_sha256,
    d.created_at            as digerido_em,
    'pegadinha'::text       as classe,
    p.severidade            as subtipo,
    p.trecho,
    null::text              as trecho_conflito,
    p.texto                 as descricao,
    p.cenario,
    null::text              as leitura_a,
    null::text              as leitura_b,
    md5('pegadinha||' ||
        lower(regexp_replace(btrim(p.trecho), '\s+', ' ', 'g'))) as achado_id
  from public.digest_pegadinhas p
  join public.market_rule_digests d on d.id = p.digest_id
  where p.trecho is not null
    and btrim(p.trecho) <> ''

  union all

  -- --- ambiguidades que não são contradição ---------------------------------
  --
  -- `is distinct from` e não `<>`: `tipo` é nulo nas linhas da v1, e `<>`
  -- devolveria NULL, que o `where` descarta — as linhas da v1 sumiriam por
  -- acidente em vez de por decisão.
  select
    d.id, d.event_id, d.description_sha256, d.created_at,
    'ambiguidade'::text,
    a.tipo,
    a.trecho,
    null::text,
    null::text,           -- ambiguidade não tem texto solto; a prosa são as leituras
    null::text,           -- nem cenário
    a.leitura_a,
    a.leitura_b,
    md5('ambiguidade||' || coalesce(a.tipo, '') || '||' ||
        lower(regexp_replace(btrim(a.trecho), '\s+', ' ', 'g')))
  from public.digest_ambiguidades a
  join public.market_rule_digests d on d.id = a.digest_id
  where a.tipo is distinct from 'contradicao_interna'
    and a.trecho is not null
    and btrim(a.trecho) <> ''

  union all

  -- --- contradições ---------------------------------------------------------
  --
  -- Chave pelo PAR, sem prefixo: é o `defeito_id` da `digest_contradicoes`, e
  -- tem que continuar sendo. O CHECK já garante `trecho_conflito` aqui, mas a
  -- view não depende dele — nulo produziria uma chave md5 nula e um achado
  -- fantasma em todo mercado do grupo.
  select
    d.id, d.event_id, d.description_sha256, d.created_at,
    'contradicao'::text,
    a.tipo,
    a.trecho,
    a.trecho_conflito,
    null::text,
    null::text,
    a.leitura_a,
    a.leitura_b,
    md5(
      least(lower(regexp_replace(btrim(a.trecho),          '\s+', ' ', 'g')),
            lower(regexp_replace(btrim(a.trecho_conflito), '\s+', ' ', 'g')))
      || '||' ||
      greatest(lower(regexp_replace(btrim(a.trecho),          '\s+', ' ', 'g')),
               lower(regexp_replace(btrim(a.trecho_conflito), '\s+', ' ', 'g')))
    )
  from public.digest_ambiguidades a
  join public.market_rule_digests d on d.id = a.digest_id
  where a.tipo = 'contradicao_interna'
    and a.trecho is not null
    and btrim(a.trecho) <> ''
    and a.trecho_conflito is not null
    and btrim(a.trecho_conflito) <> ''
),
-- O denominador de `vezes_encontrado`: quantas vezes este TEXTO foi lido.
-- Sai de `market_rule_digests` e não de `achados` — texto lido e sem nenhum
-- achado também conta como leitura, e é a leitura que mais pesa contra um
-- achado visto uma vez só.
leituras as (
  select
    description_sha256,
    count(*)                  as leituras_do_texto,
    count(distinct event_id)  as mercados_do_texto
  from public.market_rule_digests
  group by description_sha256
),
-- Os subtipos de um achado, deduplicados. Vem em CTE própria, e não como um
-- `array_agg(distinct subtipo)` lá embaixo, para não misturar um agregado com
-- `distinct` e outro com `order by` no mesmo select — o `distinct` sai do
-- subselect, onde não há dúvida sobre o que o planejador aceita.
--
-- A ordenação é por valor: `{detalhe,muda_resultado}` e `{muda_resultado,detalhe}`
-- descreveriam a mesma discordância e não podem ser dois arrays diferentes.
subtipos_do_achado as (
  select description_sha256, achado_id,
         array_agg(subtipo order by subtipo) as subtipos
  from (
    select distinct description_sha256, achado_id, subtipo
    from achados
    where subtipo is not null
  ) s
  group by description_sha256, achado_id
),
-- A ponte da propagação: o achado deixa de pertencer a um mercado e passa a
-- pertencer a um hash de regra.
achado_texto as (
  select
    a.description_sha256,
    a.achado_id,
    -- `classe` é função da chave (o prefixo está dentro do md5), então o
    -- agregado escolhe entre valores idênticos. `min` é o picker, não um
    -- critério.
    min(a.classe)                     as classe,
    count(distinct a.digest_id)       as vezes_encontrado,
    -- `{}` e não NULL quando nenhuma leitura classificou (as linhas da v1):
    -- lista vazia é "ninguém classificou", e é o que o jsonb deve mostrar.
    coalesce(st.subtipos, '{}'::text[]) as subtipos,
    -- As grafias são equivalentes por construção — a chave é o trecho
    -- normalizado, e o que difere é espaço e caixa. Escolhe-se a da leitura
    -- mais recente; o desempate por `digest_id` existe para que dois selects
    -- seguidos não devolvam grafias diferentes.
    (array_agg(a.trecho          order by a.digerido_em desc, a.digest_id))[1] as trecho,
    (array_agg(a.trecho_conflito order by a.digerido_em desc, a.digest_id))[1] as trecho_conflito
  from achados a
  left join subtipos_do_achado st
         on st.description_sha256 = a.description_sha256
        and st.achado_id          = a.achado_id
  group by a.description_sha256, a.achado_id, st.subtipos
),
-- A prosa de quem ACUSOU, uma por (mercado, texto, achado). O mesmo achado
-- citado duas vezes no mesmo mercado — redigestão em outro modelo — é uma
-- acusação só, e vale a mais recente.
proprio as (
  select distinct on (event_id, description_sha256, achado_id)
         event_id, description_sha256, achado_id, digest_id,
         descricao, cenario, leitura_a, leitura_b
  from achados
  order by event_id, description_sha256, achado_id, digerido_em desc, digest_id
),
-- Todo mercado digerido com o hash do texto que ele recebeu. `distinct` porque
-- o mesmo mercado pode ter digestões de vários modelos sobre o mesmo texto — e
-- ele é UM mercado.
mercado_texto as (
  select distinct event_id, description_sha256
  from public.market_rule_digests
),
-- A propagação: todo achado do texto × todo mercado que recebeu o texto.
--
-- `left join` no `achado_texto` por causa do limite 5: mercado digerido sem
-- nenhum achado tem que sobreviver até a linha final. É também por isso que
-- `origem` tem três estados e não dois — nulo ali quer dizer "não há achado
-- nenhum", e sem esse ramo o `case` classificaria o vazio como `herdado` e
-- contaria um achado que não existe.
por_mercado as (
  select
    mt.event_id,
    mt.description_sha256,
    at.achado_id,
    at.classe,
    at.vezes_encontrado,
    at.subtipos,
    at.trecho,
    at.trecho_conflito,
    case
      when at.achado_id is null   then null
      when pr.digest_id is null   then 'herdado'
      else                             'acusado'
    end as origem,
    pr.descricao,
    pr.cenario,
    pr.leitura_a,
    pr.leitura_b
  from mercado_texto mt
  left join achado_texto at
         on at.description_sha256 = mt.description_sha256
  left join proprio pr
         on pr.event_id           = mt.event_id
        and pr.description_sha256 = mt.description_sha256
        and pr.achado_id          = at.achado_id
),
-- Os achados que a v1/v2 deixou sem trecho, contados por mercado. Não entram na
-- lista — sem âncora não há o que propagar —, mas a omissão fica numerada em
-- vez de silenciosa (limite 4).
--
-- `union all` de duas listas e não dois `left join`: com um join por tabela, um
-- digest com 2 pegadinhas e 3 ambiguidades sem trecho produziria as 6
-- combinações e a contagem sairia 6 em vez de 5.
sem_ancora as (
  select d.event_id, d.description_sha256, count(*) as achados_sem_ancora
  from public.market_rule_digests d
  join (
    select digest_id
      from public.digest_pegadinhas
     where trecho is null or btrim(trecho) = ''
    union all
    select digest_id
      from public.digest_ambiguidades
     where trecho is null or btrim(trecho) = ''
        or (tipo = 'contradicao_interna'
            and (trecho_conflito is null or btrim(trecho_conflito) = ''))
  ) s on s.digest_id = d.id
  group by d.event_id, d.description_sha256
)
select
  pm.event_id,
  e.slug,
  e.title,
  e.radar_tema,
  e.liquidity,
  pm.description_sha256,
  lt.leituras_do_texto,
  lt.mercados_do_texto,

  -- `count(coluna)` e não `count(*)`: no mercado sem achado a linha existe com
  -- `achado_id` nulo, e `count(*)` devolveria 1.
  count(pm.achado_id)                                     as achados_total,
  count(*) filter (where pm.origem = 'acusado')           as achados_acusados,
  count(*) filter (where pm.origem = 'herdado')           as achados_herdados,

  count(*) filter (where pm.classe = 'pegadinha')         as pegadinhas,
  count(*) filter (where pm.classe = 'ambiguidade')       as ambiguidades,
  count(*) filter (where pm.classe = 'contradicao')       as contradicoes,

  -- O achado mais forte que ESTE mercado carrega, sem depender de ninguém ter
  -- lido a lista inteira. Contradição é a classe de maior valor (ver o comment
  -- de `digest_ambiguidades.trecho_conflito`); a pegadinha que muda resultado
  -- vem logo atrás.
  count(*) filter (
    where pm.classe = 'pegadinha' and pm.subtipos @> array['muda_resultado']
  )                                                       as pegadinhas_muda_resultado,

  -- Quantas leituras confirmaram o achado mais confirmado deste mercado. Um
  -- mercado cujo máximo é 1 tem uma lista inteira de leituras únicas.
  max(pm.vezes_encontrado)                                as confirmacao_maxima,

  coalesce(sa.achados_sem_ancora, 0)                      as achados_sem_ancora,

  -- A lista. `origem` viaja em cada item — é o que impede a propagação de ser
  -- lida como detecção — e `vezes_encontrado`/`leituras_do_texto` viajam junto,
  -- para que o item solto carregue o próprio denominador.
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'achado_id',         pm.achado_id,
        'classe',            pm.classe,
        'origem',            pm.origem,
        'subtipos',          to_jsonb(pm.subtipos),
        'vezes_encontrado',  pm.vezes_encontrado,
        'leituras_do_texto', lt.leituras_do_texto,
        'trecho',            pm.trecho,
        'trecho_conflito',   pm.trecho_conflito,
        'descricao',         pm.descricao,
        'cenario',           pm.cenario,
        'leitura_a',         pm.leitura_a,
        'leitura_b',         pm.leitura_b
      )
      order by (pm.origem = 'acusado') desc,
               pm.vezes_encontrado desc,
               pm.classe,
               pm.achado_id
    ) filter (where pm.achado_id is not null),
    '[]'::jsonb
  )                                                       as achados
from por_mercado pm
join public.events e   on e.id = pm.event_id
join leituras lt       on lt.description_sha256 = pm.description_sha256
left join sem_ancora sa
       on sa.event_id           = pm.event_id
      and sa.description_sha256 = pm.description_sha256
group by pm.event_id, e.slug, e.title, e.radar_tema, e.liquidity,
         pm.description_sha256, lt.leituras_do_texto, lt.mercados_do_texto,
         sa.achados_sem_ancora
order by e.liquidity desc nulls last, pm.event_id;

comment on view public.digest_achados_por_mercado is
  'Uma linha por (mercado, texto de regra) com a UNIAO de tudo que foi achado naquele texto — pegadinha, ambiguidade e contradicao —, nao so o que o modelo escreveu lendo aquele mercado. O achado esta ancorado num trecho LITERAL da regra, e mercados com o mesmo description_sha256 receberam o texto byte a byte: a passagem existe no texto de um porque existe no de outro. Medido em 17/08/2026: de 5,47 achados por mercado para 17,45 (+11,97 em media, mediana 11, 84,5% dos mercados ganham ao menos um). origem=acusado significa que o modelo leu ESTE mercado e escreveu a prosa; origem=herdado significa apenas que o texto e o mesmo, e descricao/cenario/leitura_a/leitura_b sao NULAS — o que e do texto viaja, o que o modelo escreveu para um mercado nao. vezes_encontrado sobre leituras_do_texto e obrigatorio de ler: nos textos lidos mais de uma vez, 52% dos achados apareceram em UMA leitura so e apenas 9,9% em todas. achado_id de classe contradicao e o mesmo defeito_id da digest_contradicoes. Limites: so propaga para mercado ja digerido, achado sem trecho fica de fora (contado em achados_sem_ancora).';

-- ---------------------------------------------------------------------------
-- Acesso
-- ---------------------------------------------------------------------------
--
-- `security_invoker` está no `create` acima. O `revoke` é pelo motivo que a
-- `20260817033302` documenta: as default privileges deste banco
-- (`20260804054445_remote_schema.sql`) dão `DELETE, INSERT, SELECT, UPDATE` a
-- `anon` e `authenticated` em todo objeto novo do schema public, então view
-- nova nasce EXPOSTA e nada quebra para avisar. `service_role` não precisa de
-- grant explícito — as mesmas default privileges já o cobrem.

revoke all on public.digest_achados_por_mercado from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- 0. as duas trancas, ANTES de olhar qualquer número
--   select reloptions from pg_class
--    where oid = 'public.digest_achados_por_mercado'::regclass;  -- {security_invoker=true}
--
--   select grantee, privilege_type            -- tem que voltar VAZIO
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name   = 'digest_achados_por_mercado'
--      and grantee in ('anon', 'authenticated');
--
--   -- 1. o tamanho da propagação. Esperado no estado de 17/08/2026:
--   --    mercados=728  acusados=3985  herdados=8717  total=12702  media=17,45
--   select count(*)                    as mercados,
--          sum(achados_acusados)       as acusados,
--          sum(achados_herdados)       as herdados,
--          sum(achados_total)          as total,
--          round(avg(achados_total), 2) as media
--     from public.digest_achados_por_mercado;
--
--   -- 2. os acusados têm que bater com as linhas cruas ANCORADAS. Só divergem
--   --    se o mesmo achado foi citado duas vezes no mesmo mercado, que a view
--   --    colapsa de propósito.
--   select (select sum(achados_acusados) from public.digest_achados_por_mercado) as na_view,
--          (select count(*) from public.digest_pegadinhas
--            where trecho is not null and btrim(trecho) <> '')
--        + (select count(*) from public.digest_ambiguidades
--            where trecho is not null and btrim(trecho) <> ''
--              and (tipo is distinct from 'contradicao_interna'
--                   or (trecho_conflito is not null and btrim(trecho_conflito) <> '')))
--                                                                               as linhas_cruas;
--
--   -- 3. conferência cruzada com a view irmã: as contradições desta view têm
--   --    que dar exatamente os mercados atingidos daquela.
--   select (select sum(contradicoes)       from public.digest_achados_por_mercado) as aqui,
--          (select sum(mercados_atingidos) from public.digest_contradicoes)        as la;
--
--   -- 4. herdado NUNCA pode ter prosa. Se isto voltar linha, a view está
--   --    copiando o que o modelo escreveu para o vizinho, que é o defeito que
--   --    a coluna `origem` existe para tornar impossível.
--   select event_id, a->>'achado_id'
--     from public.digest_achados_por_mercado, jsonb_array_elements(achados) a
--    where a->>'origem' = 'herdado'
--      and (a->>'descricao' is not null or a->>'cenario'   is not null
--        or a->>'leitura_a' is not null or a->>'leitura_b' is not null);
--
--   -- 5. o limite 3, contado: quantos mercados aparecem em mais de uma linha
--   --    (descrição editada e redigerida). Esperado hoje: zero.
--   select count(*) from (
--     select event_id from public.digest_achados_por_mercado
--      group by event_id having count(*) > 1
--   ) t;
--
--   -- 6. a distribuição que decide se dá para confiar num achado herdado.
--   --    Esperado: a maior parte da massa em vezes_encontrado = 1.
--   select (a->>'vezes_encontrado')::int as vezes, count(*)
--     from public.digest_achados_por_mercado, jsonb_array_elements(achados) a
--    where (a->>'leituras_do_texto')::int > 1
--    group by 1 order by 1;
--
--   -- 7. onde os modelos discordaram da severidade da mesma pegadinha
--   select event_id, a->>'trecho', a->'subtipos'
--     from public.digest_achados_por_mercado, jsonb_array_elements(achados) a
--    where jsonb_array_length(a->'subtipos') > 1;
