-- `digest_contradicoes`: propagar o defeito para todo mercado que recebeu o
-- MESMO texto de regra, marcando quem acusou e quem herdou.
--
-- ---------------------------------------------------------------------------
-- Por que propagar
-- ---------------------------------------------------------------------------
--
-- A contradição é propriedade do TEXTO, não do mercado. Dois mercados com o
-- mesmo `description_sha256` receberam a mesma regra byte a byte — é o que o
-- hash quer dizer —, então uma contradição que existe no texto de um existe no
-- texto do outro. Que o modelo tenha acusado só num deles é fato sobre o
-- modelo, não sobre o mercado.
--
-- Isso foi MEDIDO antes de virar view, e a medida é o que autoriza a
-- propagação (`npm run medir-consistencia`, relatório em
-- `probes/digest/consistencia-degrau-3-v4.md`):
--
--   - 79 grupos de mercados com regra idêntica cobrem 616 dos 728 mercados
--     digeridos (84,6%).
--   - `contradicao_interna` NUNCA apareceu em todos os membros de um grupo:
--     em 14 grupos ela apareceu em uns e não em outros.
--   - Nesses 14 grupos, as 16 acusações foram conferidas contra o texto: em
--     16 de 16 as DUAS passagens citadas existem literalmente na regra
--     (`includes` cru, sem normalizar espaço nem aspas; as passagens têm de 62
--     a 289 caracteres, não é casamento trivial).
--
-- Ou seja: o defeito do modelo é de RECALL (deixou passar), não de PRECISÃO
-- (inventou). A lista de contradições estava correta e incompleta. Propagar
-- completa; não corrige, porque não havia o que corrigir.
--
-- ---------------------------------------------------------------------------
-- Por que `origem` e não uma contagem só
-- ---------------------------------------------------------------------------
--
-- Herdado e acusado não são a mesma evidência. No acusado o modelo leu aquele
-- mercado e escreveu as duas leituras para ele; no herdado a única coisa que se
-- sabe é que o texto é o mesmo. Colapsar os dois numa contagem só faria a
-- propagação parecer detecção — e a próxima pessoa a ler a lista não teria como
-- desfazer isso.
--
-- Por isso `origem` vem em CADA mercado do jsonb, `mercados_acusados` e
-- `mercados_herdados` vêm separados, e `leitura_a`/`leitura_b` são NULAS no
-- herdado. Nulo aqui é honesto: não existem leituras daquele mercado, e copiar
-- as do vizinho seria inventar dado que ninguém produziu.
--
-- ---------------------------------------------------------------------------
-- Os limites, que também são medidos
-- ---------------------------------------------------------------------------
--
-- 1. Só se propaga para mercado DIGERIDO. O grupo de hash sai de
--    `market_rule_digests`, e um mercado cuja regra nunca foi digerida não tem
--    hash em lugar nenhum. Hashear `events.description` na view resolveria no
--    papel e seria varredura dos 711 MB da tabela a cada select — não se faz.
--    Consequência prática: a cobertura da propagação é a da última passada.
--
-- 2. A propagação ATRAVESSA modelo e versão de prompt. É de propósito: o hash é
--    do texto, e o texto não muda porque o prompt mudou. Um mercado digerido em
--    v3 herda defeito acusado em v4, e deve mesmo — a contradição está na regra
--    que os dois leram. A deduplicação por `event_id` impede que ele conte duas
--    vezes.
--
-- 3. O agrupamento de defeitos continua sendo por PAR de passagens
--    (`least`/`greatest` sobre os dois trechos normalizados). O limite descrito
--    em `20260816181722_contradicoes_por_defeito.sql` segue valendo: par igual
--    não colapsa os casos que compartilham só UMA das duas passagens, como o
--    boilerplate da Binance.
--
-- ---------------------------------------------------------------------------
-- Por que `drop` e não `create or replace`
-- ---------------------------------------------------------------------------
--
-- A primeira versão desta migration usava `create or replace` e o `db push`
-- recusou:
--
--   cannot change name of view column "liquidez_total" to "mercados_acusados"
--
-- `create or replace view` só sabe ACRESCENTAR coluna no fim: não renomeia nem
-- reordena. As colunas novas (`mercados_acusados`, `mercados_herdados`,
-- `liquidez_acusada`) entram no meio da lista, então a única saída é recriar.
--
-- O `drop` leva junto duas coisas que NÃO são parte da definição da view e
-- teriam de ser redeclaradas de qualquer jeito:
--
--   1. `security_invoker`. Sem ele a view roda como o dono (postgres) e o RLS
--      das tabelas de origem deixa de valer para quem consulta.
--
--   2. O `revoke` de `anon`/`authenticated` da `20260816181722`. Este é o que
--      cala fundo: a `20260816181722` não concedeu grant NENHUM — ela só
--      revogou. As default privileges deste banco
--      (`20260804054445_remote_schema.sql`) dão `DELETE, INSERT, SELECT,
--      UPDATE` a `anon` e a `authenticated` em todo objeto novo do schema
--      public, então a view recriada nasce EXPOSTA, e a falha é silenciosa no
--      pior sentido: nada quebra, a view responde, e o `anon` passa a ler.
--      É a mesma lição da partição `polymarket_snapshots_default`.
--
-- `service_role` não precisa de grant explícito aqui — as mesmas default
-- privileges já o cobrem, e era assim antes deste drop também.
--
-- O `drop` vai sem `cascade` de propósito: se algum objeto passar a depender
-- desta view, é melhor a migration falhar do que derrubar o dependente calado.

drop view if exists public.digest_contradicoes;

create view public.digest_contradicoes with (security_invoker = true) as
with acusacoes as (
  select
    a.trecho,
    a.trecho_conflito,
    a.leitura_a,
    a.leitura_b,
    d.event_id,
    d.description_sha256,
    -- Mesma normalização da conferência de trecho em `src/digest/digest.ts`:
    -- tolera grafia, não tolera paráfrase.
    lower(regexp_replace(btrim(a.trecho), '\s+', ' ', 'g'))           as n1,
    lower(regexp_replace(btrim(a.trecho_conflito), '\s+', ' ', 'g'))  as n2
  from public.digest_ambiguidades a
  join public.market_rule_digests d on d.id = a.digest_id
  where a.tipo = 'contradicao_interna'
    -- O CHECK já garante, mas a view não depende dele: `trecho_conflito` nulo
    -- aqui produziria uma chave md5 nula e um defeito fantasma.
    and a.trecho is not null
    and a.trecho_conflito is not null
),
chaveadas as (
  select *,
         md5(least(n1, n2) || '||' || greatest(n1, n2)) as defeito_id
  from acusacoes
),
-- Em que TEXTOS o defeito foi acusado. É a ponte da propagação: o defeito deixa
-- de pertencer a um mercado e passa a pertencer a um hash de regra.
defeito_texto as (
  select distinct defeito_id, description_sha256
  from chaveadas
),
-- Todo mercado digerido, com o hash do texto que ele recebeu. `distinct` porque
-- o mesmo mercado pode ter digestões de vários modelos ou versões sobre o mesmo
-- texto — e ele é UM mercado.
mercado_texto as (
  select distinct description_sha256, event_id
  from public.market_rule_digests
),
-- A propagação: o defeito × todo mercado do mesmo grupo de hash.
atingidos as (
  select dt.defeito_id, dt.description_sha256, mt.event_id
  from defeito_texto dt
  join mercado_texto mt on mt.description_sha256 = dt.description_sha256
),
-- As leituras de quem ACUSOU, uma por (defeito, mercado). O mesmo par citado
-- duas vezes no mesmo mercado — redigestão em outro modelo — é uma acusação só.
leituras as (
  select distinct on (defeito_id, event_id)
         defeito_id, event_id, trecho, trecho_conflito, leitura_a, leitura_b
  from chaveadas
  order by defeito_id, event_id
),
por_mercado as (
  select
    atg.defeito_id,
    atg.description_sha256,
    atg.event_id,
    e.slug,
    e.title,
    e.radar_tema,
    e.liquidity,
    case when l.event_id is null then 'herdado' else 'acusado' end as origem,
    l.trecho,
    l.trecho_conflito,
    l.leitura_a,
    l.leitura_b
  from atingidos atg
  join public.events e on e.id = atg.event_id
  left join leituras l
         on l.defeito_id = atg.defeito_id
        and l.event_id   = atg.event_id
)
select
  defeito_id,
  -- O total é acusados + herdados, e as três contagens ficam visíveis para que
  -- ninguém precise acreditar na soma.
  count(*)                                                        as mercados_atingidos,
  count(*) filter (where origem = 'acusado')                      as mercados_acusados,
  count(*) filter (where origem = 'herdado')                      as mercados_herdados,
  -- Quantos textos distintos carregam este defeito. > 1 significa que o mesmo
  -- par de passagens aparece em boilerplates diferentes.
  count(distinct description_sha256)                              as textos_de_regra,
  -- `null` de liquidez é ignorado pela soma — não vira zero. Ver
  -- `liquidez_desconhecida`: sem essa coluna, um defeito em três mercados sem
  -- liquidez coletada apareceria como US$ 0 e desceria para o fim da lista como
  -- se fosse irrelevante.
  sum(liquidity)                                                  as liquidez_total,
  -- A exposição que a lista media ANTES da propagação. Fica para que a diferença
  -- entre as duas seja legível, e não uma mudança silenciosa de número.
  sum(liquidity) filter (where origem = 'acusado')                as liquidez_acusada,
  max(liquidity)                                                  as liquidez_maior,
  count(*) filter (where liquidity is null)                       as liquidez_desconhecida,
  -- As passagens vêm de um mercado que ACUSOU — o herdado não tem trecho, por
  -- construção. Entre os acusados os pares são equivalentes (a chave é o par
  -- normalizado); o que muda é só grafia, e escolhe-se a do mais líquido.
  (array_agg(trecho order by liquidity desc nulls last)
     filter (where origem = 'acusado'))[1]                        as trecho,
  (array_agg(trecho_conflito order by liquidity desc nulls last)
     filter (where origem = 'acusado'))[1]                        as trecho_conflito,
  -- A lista de mercados atingidos. `origem` viaja em cada item: é o que impede
  -- que a propagação seja lida como detecção. `leitura_a`/`leitura_b` são nulas
  -- no herdado porque não existem — o modelo nunca escreveu nada sobre ele.
  jsonb_agg(
    jsonb_build_object(
      'slug',      slug,
      'titulo',    title,
      'tema',      radar_tema,
      'liquidez',  liquidity,
      'origem',    origem,
      'url',       case when slug is null then null
                        else 'https://polymarket.com/event/' || slug end,
      'leitura_a', leitura_a,
      'leitura_b', leitura_b
    )
    order by (origem = 'acusado') desc, liquidity desc nulls last
  )                                                               as mercados
from por_mercado
group by defeito_id
order by liquidez_total desc nulls last;

comment on view public.digest_contradicoes is
  'Um DEFEITO de texto por linha, com TODOS os mercados que receberam a mesma regra — nao so os que o modelo acusou. A contradicao e propriedade do texto: mercados com o mesmo description_sha256 leram a regra byte a byte igual. A propagacao foi autorizada por medida, nao por suposicao: nos 14 grupos em que a acusacao saiu dividida, as 16 acusacoes tiveram as DUAS passagens conferidas como literalmente presentes no texto (16/16) — defeito de recall do modelo, nao de precisao. origem=acusado significa que o modelo leu aquele mercado e escreveu as leituras; origem=herdado significa apenas que o texto e o mesmo, e leitura_a/leitura_b sao nulas. Limite: so se propaga para mercado ja digerido.';

-- ---------------------------------------------------------------------------
-- Acesso: repor o que o `drop` levou
-- ---------------------------------------------------------------------------
--
-- `security_invoker` já foi declarado no `create` acima. Falta o revoke, que a
-- `20260816181722` tinha e o drop apagou. Sem esta linha a view volta legível
-- pelo `anon` por causa das default privileges do banco.

revoke all on public.digest_contradicoes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- as duas trancas, ANTES de olhar qualquer número: sem isto, um resultado
--   -- bonito abaixo não quer dizer nada.
--   select reloptions from pg_class
--    where oid = 'public.digest_contradicoes'::regclass;   -- {security_invoker=true}
--
--   -- tem que voltar VAZIO: nenhum privilégio de anon/authenticated na view
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name   = 'digest_contradicoes'
--      and grantee in ('anon', 'authenticated');
--
--   -- os defeitos, do mais caro para o mais barato, com a propagação visível
--   select defeito_id, mercados_atingidos, mercados_acusados, mercados_herdados,
--          liquidez_total, liquidez_acusada, left(trecho, 60)
--     from public.digest_contradicoes;
--
--   -- os acusados da view têm que bater com as linhas cruas.
--   -- Só divergem se o MESMO par foi citado duas vezes no mesmo mercado
--   -- (redigestão em outro modelo), que a view colapsa de propósito.
--   select (select sum(mercados_acusados) from public.digest_contradicoes) as na_view,
--          (select count(*) from public.digest_ambiguidades
--            where tipo = 'contradicao_interna')                           as linhas_cruas;
--
--   -- herdado NUNCA pode ter leitura: se isto voltar linha, a view está
--   -- copiando leitura de vizinho, que é o defeito que a coluna existe para
--   -- tornar impossível.
--   select defeito_id, m->>'slug'
--     from public.digest_contradicoes, jsonb_array_elements(mercados) m
--    where m->>'origem' = 'herdado'
--      and (m->>'leitura_a' is not null or m->>'leitura_b' is not null);
--
--   -- o tamanho da propagação, que é o número a discutir antes de confiar nela
--   select sum(mercados_acusados) as acusados,
--          sum(mercados_herdados) as herdados,
--          sum(mercados_atingidos) as total
--     from public.digest_contradicoes;
