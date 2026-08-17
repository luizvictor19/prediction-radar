-- `digest_contradicoes`: um DEFEITO por linha, com os mercados que ele atinge.
--
-- ---------------------------------------------------------------------------
-- Por que agrupar aqui e não na carga
-- ---------------------------------------------------------------------------
--
-- A passada v4 nos 752 mercados achou 21 `contradicao_interna`, e seis delas
-- são o MESMO defeito de texto — o boilerplate de cripto que nomeia a Binance
-- como fonte e três linhas abaixo exclui "spot markets", que é o que a Binance
-- é. Seis mercados diferentes, um defeito só.
--
-- A tentação é gravar 16 linhas em vez de 21. Não se faz, e a razão não é
-- estética: as 21 linhas são o que o modelo de fato disse sobre cada mercado,
-- cada uma com as leituras que ele escreveu PARA AQUELE mercado. Agrupar na
-- carga jogaria fora 5 pares de leituras que não são cópia uma da outra, e
-- desfazer isso depois custa a rodada inteira de novo — US$ 2,62 e cinco horas.
--
-- A carga grava fato. A view responde pergunta. Uma view errada se corrige com
-- CREATE OR REPLACE; um dado que não foi gravado se corrige pagando de novo.
--
-- ---------------------------------------------------------------------------
-- O que conta como "o mesmo defeito"
-- ---------------------------------------------------------------------------
--
-- O PAR de passagens, normalizado (espaço colapsado, caixa baixa) e SEM ORDEM:
-- `least`/`greatest` sobre os dois trechos fazem com que citar A×B e B×A caia
-- na mesma chave. Sem isso, a mesma contradição vista de dois ângulos viraria
-- dois defeitos, e a contagem — que é o produto — mediria a ordem em que o
-- modelo escreveu.
--
-- LIMITE CONHECIDO, e ele é medido: agrupar por PAR não colapsa os casos em que
-- só UMA das passagens coincide. As seis do boilerplate da Binance compartilham
-- o segundo trecho ("Prices from other exchanges, different trading pairs, or
-- spot markets will not be considered") mas variam o primeiro — "depends solely
-- on the price data from the Binance BTC/USDT trading pair" contra "The
-- resolution source for this market is Binance, specifically the BTC/USDT
-- 'High' prices" —, então saem como ~5 defeitos e não como 1.
--
-- Isso é de propósito: par igual é um critério que se defende (são as mesmas
-- duas frases), e "uma frase igual" agruparia coisas que só dividem uma
-- cláusula comum e se contradizem por motivos diferentes. Quem quiser a visão
-- mais frouxa tem `trecho_conflito` na tabela e um `group by` de uma linha.

create or replace view public.digest_contradicoes as
with linhas as (
  select
    a.trecho,
    a.trecho_conflito,
    a.leitura_a,
    a.leitura_b,
    d.event_id,
    e.slug,
    e.title,
    e.radar_tema,
    e.liquidity,
    -- Mesma normalização da conferência de trecho em `src/digest/digest.ts`:
    -- tolera grafia, não tolera paráfrase.
    lower(regexp_replace(btrim(a.trecho), '\s+', ' ', 'g'))           as n1,
    lower(regexp_replace(btrim(a.trecho_conflito), '\s+', ' ', 'g'))  as n2
  from public.digest_ambiguidades a
  join public.market_rule_digests d on d.id = a.digest_id
  join public.events e               on e.id = d.event_id
  where a.tipo = 'contradicao_interna'
    -- O CHECK já garante, mas a view não depende dele: `trecho_conflito` nulo
    -- aqui produziria uma chave md5 nula e um defeito fantasma.
    and a.trecho is not null
    and a.trecho_conflito is not null
),
chaveadas as (
  select *,
         md5(least(n1, n2) || '||' || greatest(n1, n2)) as defeito_id
  from linhas
),
por_mercado as (
  -- Uma linha por (defeito, mercado). Se o mesmo par aparecer duas vezes no
  -- mesmo mercado — digestões de modelos ou versões diferentes —, a liquidez
  -- dele entra UMA vez na soma. Sem isto, redigerir o radar inflaria o número
  -- que ordena a lista.
  select distinct on (defeito_id, event_id)
         defeito_id, event_id, slug, title, radar_tema, liquidity,
         trecho, trecho_conflito, leitura_a, leitura_b
  from chaveadas
  order by defeito_id, event_id, liquidity desc nulls last
)
select
  defeito_id,
  count(*)                                                       as mercados_atingidos,
  -- Soma sobre mercados DISTINTOS, e `null` de liquidez é ignorado pela soma —
  -- não vira zero. Ver `liquidez_desconhecida`: sem essa coluna, um defeito em
  -- três mercados sem liquidez coletada apareceria como US$ 0 e desceria para o
  -- fim da lista como se fosse irrelevante.
  sum(liquidity)                                                 as liquidez_total,
  max(liquidity)                                                 as liquidez_maior,
  count(*) filter (where liquidity is null)                      as liquidez_desconhecida,
  -- As passagens do mercado MAIS LÍQUIDO representam o defeito. Os pares são
  -- equivalentes por construção (a chave é o par normalizado); o que muda entre
  -- eles é só grafia.
  (array_agg(trecho           order by liquidity desc nulls last))[1] as trecho,
  (array_agg(trecho_conflito  order by liquidity desc nulls last))[1] as trecho_conflito,
  -- A lista de mercados atingidos, com as leituras QUE AQUELE mercado produziu.
  -- É por isso que a carga grava as 21 linhas inteiras: estas leituras não são
  -- cópia umas das outras.
  jsonb_agg(
    jsonb_build_object(
      'slug',      slug,
      'titulo',    title,
      'tema',      radar_tema,
      'liquidez',  liquidity,
      'url',       case when slug is null then null
                        else 'https://polymarket.com/event/' || slug end,
      'leitura_a', leitura_a,
      'leitura_b', leitura_b
    )
    order by liquidity desc nulls last
  )                                                              as mercados
from por_mercado
group by defeito_id
order by liquidez_total desc nulls last;

comment on view public.digest_contradicoes is
  'Um DEFEITO de texto por linha, com os mercados que ele atinge. Agrupa por PAR de passagens normalizado e sem ordem (least/greatest), nao por mercado: a passada v4 achou 21 contradicoes em 752 mercados e seis delas eram o mesmo boilerplate de cripto. O agrupamento e AQUI e nao na carga — a carga grava fato (as 21 linhas, cada uma com as leituras daquele mercado), a view responde pergunta. Limite medido: par igual nao colapsa casos que compartilham so UMA das duas passagens.';

alter view public.digest_contradicoes set (security_invoker = on);

revoke all on public.digest_contradicoes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- os defeitos, do mais caro para o mais barato
--   select defeito_id, mercados_atingidos, liquidez_total, left(trecho, 60)
--     from public.digest_contradicoes;
--
--   -- o boilerplate da Binance: quantos defeitos compartilham o segundo trecho
--   select trecho_conflito, count(*) as defeitos, sum(mercados_atingidos) as mercados
--     from public.digest_contradicoes
--    group by trecho_conflito
--   having count(*) > 1
--    order by mercados desc;
--
--   -- o total tem que bater com as linhas cruas
--   select (select sum(mercados_atingidos) from public.digest_contradicoes)
--        = (select count(*) from public.digest_ambiguidades
--            where tipo = 'contradicao_interna') as bate;
