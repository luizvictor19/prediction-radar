-- `v_radar` passa a expor `event_group_slug`.
--
-- ## Por que
--
-- O link "Polymarket" das telas montava `polymarket.com/event/<events.slug>`.
-- `events.slug` e slug de MERCADO — vem de `market.slug` em
-- `src/lib/normalize.ts:118` — e `/event/` e caminho de EVENTO. Medido em
-- 25/08/2026 sobre 55 mercados do roster: essa forma abriu 15/55, e os 15 sao
-- exatamente os eventos de mercado unico, onde os dois slugs coincidem por
-- acaso. Nos 40 divergentes deu 404 em 40.
--
-- O slug de evento ja existe na tabela, em `events.event_group_slug`
-- (`normalize.ts:142`, vindo de `market.events[0].slug`), preenchido em
-- 1.206/1.206 linhas do roster. O que faltava era a VIEW expor a coluna: o CTE
-- `roster` selecionava onze colunas de `events` e essa nao estava entre elas,
-- entao a tela nao tinha como passa-la.
--
-- Com as duas, `src/lib/polymarket-url.ts` monta `/event/<grupo>/<mercado>`,
-- que abriu 55/55 e chegou no mercado certo em 55/55 — contra
-- `/event/<grupo>`, que tambem abre 55/55 mas entrega a LISTA do evento
-- multi-resultado, e 956 dos 1.024 mercados ativos sao multi-resultado.
--
-- Recomputar: `npx tsx scripts/medicoes/url-polymarket.ts`.
--
-- ## Custo
--
-- Uma coluna a mais no CTE `roster`, que ja le `events` por
-- `idx_events_radar_tracked` e ja carrega `description` (a coluna larga). Nao
-- muda join, filtro nem plano: `event_group_slug` sai da mesma linha de
-- `events` que as outras onze.
--
-- ## Enquanto esta migration nao for aplicada
--
-- As telas passam `null` como segundo argumento e a URL cai no fallback
-- `/market/<slug>`, medido abrindo 55/55 no mercado certo. O link funciona; o
-- que ele nao usa e o caminho documentado. Aplicar isto e o que troca o
-- fallback pelo principal, sem mudar codigo de tela.
--
-- A view e recriada inteira porque `create or replace view` no Postgres nao
-- aceita acrescentar coluna no meio da lista de saida — so no fim. A ordem
-- importa aqui: `event_group_slug` fica colado em `slug`, que e onde alguem
-- lendo a view vai procurar. O corpo abaixo e o de
-- `20260814151752_variacao_sem_mid_e_lado_oposto.sql` com duas linhas a mais.

drop view if exists public.v_radar;

create view public.v_radar
with (security_invoker = true) as
with roster as (
  select e.id, e.polymarket_id, e.slug, e.event_group_slug, e.title,
         e.polymarket_category,
         e.radar_tema, e.radar_subject, e.volume_24h, e.liquidity,
         e.end_date, e.description
    from public.events e
   where e.radar_tracked
     and e.status = 'active'
)
select
  -- identidade
  r.id,
  r.polymarket_id,
  r.slug,
  r.event_group_slug,
  r.title                                   as pergunta,
  r.polymarket_category                     as categoria,
  r.radar_tema                              as tema,
  r.radar_subject                           as assunto,

  -- preço agora: a última foto, seja ela de quando for
  agora.outcome,
  agora.best_bid,
  agora.best_ask,
  agora.mid_price,
  agora.spread,
  agora.bid_depth,
  agora.ask_depth,
  agora.captured_at                         as preco_em,
  round((extract(epoch from (now() - agora.captured_at)) / 60)::numeric, 1)
                                            as preco_idade_min,

  -- variação 1h
  v1h.variacao                              as var_1h,
  v1h.base                                  as var_1h_base,
  v1h.ref                                   as ref_1h,
  a1h.captured_at                           as ancora_1h,
  round((extract(epoch from (agora.captured_at - a1h.captured_at)) / 60)::numeric, 1)
                                            as span_1h_min,

  -- variação 24h
  v24h.variacao                             as var_24h,
  v24h.base                                 as var_24h_base,
  v24h.ref                                  as ref_24h,
  a24h.captured_at                          as ancora_24h,
  round((extract(epoch from (agora.captured_at - a24h.captured_at)) / 3600)::numeric, 2)
                                            as span_24h_h,

  -- variação 7d
  v7d.variacao                              as var_7d,
  v7d.base                                  as var_7d_base,
  v7d.ref                                   as ref_7d,
  a7d.captured_at                           as ancora_7d,
  round((extract(epoch from (agora.captured_at - a7d.captured_at)) / 86400)::numeric, 2)
                                            as span_7d_d,

  -- tamanho e prazo
  r.volume_24h,
  agora.volume_24h                          as volume_24h_livro,
  r.liquidity                               as liquidez,
  r.end_date                                as fecha_em,
  round((extract(epoch from (r.end_date - now())) / 86400)::numeric, 2)
                                            as dias_restantes,
  length(r.description)                     as tamanho_regra,

  -- o que eu já fiz neste mercado
  (pos.legs_abertas > 0)                    as tenho_posicao,
  pos.legs_abertas,
  pos.stake_aberto_usd,
  minha.prob_self,
  minha.placed_at                           as prob_self_em,
  minha.estrategia                          as prob_self_estrategia

from roster r

left join lateral (
  select s.outcome, s.best_bid, s.best_ask, s.mid_price, s.spread,
         s.bid_depth, s.ask_depth, s.volume_24h, s.captured_at
    from public.polymarket_snapshots s
   where s.event_id = r.id
   order by s.captured_at desc
   limit 1
) agora on true

-- As âncoras agora trazem `best_bid` e `best_ask` além do mid, porque a base da
-- variação pode ser qualquer um dos três e a escolha precisa dos dois lados nas
-- duas pontas.
left join lateral (
  select s.mid_price, s.best_bid, s.best_ask, s.captured_at
    from public.polymarket_snapshots s
   where s.event_id = r.id
     and s.outcome  = agora.outcome
     and s.captured_at >= agora.captured_at - interval '1 hour' - interval '15 minutes'
     and s.captured_at <= agora.captured_at - interval '1 hour' + interval '15 minutes'
   order by abs(extract(epoch from (s.captured_at - (agora.captured_at - interval '1 hour')))),
            s.captured_at
   limit 1
) a1h on true

left join lateral (
  select s.mid_price, s.best_bid, s.best_ask, s.captured_at
    from public.polymarket_snapshots s
   where s.event_id = r.id
     and s.outcome  = agora.outcome
     and s.captured_at >= agora.captured_at - interval '24 hours' - interval '1 hour'
     and s.captured_at <= agora.captured_at - interval '24 hours' + interval '1 hour'
   order by abs(extract(epoch from (s.captured_at - (agora.captured_at - interval '24 hours')))),
            s.captured_at
   limit 1
) a24h on true

left join lateral (
  select s.mid_price, s.best_bid, s.best_ask, s.captured_at
    from public.polymarket_snapshots s
   where s.event_id = r.id
     and s.outcome  = agora.outcome
     and s.captured_at >= agora.captured_at - interval '7 days' - interval '6 hours'
     and s.captured_at <= agora.captured_at - interval '7 days' + interval '6 hours'
   order by abs(extract(epoch from (s.captured_at - (agora.captured_at - interval '7 days')))),
            s.captured_at
   limit 1
) a7d on true

-- A escolha da base, uma vez por janela. Sem acesso a tabela: é função pura
-- sobre valores que as laterais acima já trouxeram.
left join lateral public.var_com_base(
  agora.mid_price, agora.best_ask, agora.best_bid,
  a1h.mid_price,   a1h.best_ask,   a1h.best_bid
) v1h on true

left join lateral public.var_com_base(
  agora.mid_price, agora.best_ask, agora.best_bid,
  a24h.mid_price,  a24h.best_ask,  a24h.best_bid
) v24h on true

left join lateral public.var_com_base(
  agora.mid_price, agora.best_ask, agora.best_bid,
  a7d.mid_price,   a7d.best_ask,   a7d.best_bid
) v7d on true

left join lateral (
  select count(*) as legs_abertas, sum(l.stake_usd) as stake_aberto_usd
    from public.my_bet_legs l
   where l.event_id = r.id
     and l.closed_at is null
) pos on true

left join lateral (
  select b.prob_self, b.placed_at, b.estrategia
    from public.my_bets b
   where b.event_id = r.id
     and b.prob_self is not null
   order by b.placed_at desc
   limit 1
) minha on true;

comment on view public.v_radar is
  'Uma linha por mercado do roster (radar_tracked e status active). slug e EVENT_GROUP_SLUG sao coisas diferentes: slug e do MERCADO (market.slug) e event_group_slug e do EVENTO pai (market.events[0].slug). Para montar URL do Polymarket use os DOIS, via src/lib/polymarket-url.ts — /event/<slug> sozinho deu 404 em 40 de 40 mercados multi-resultado medidos em 20260825. mid_price continua NULO quando o livro tem um lado so (123 de 673 mercados em 20260814) — mas a VARIACAO nao depende de mid: ela usa o mesmo lado nas duas pontas da janela, e var_*_base declara qual (mid, ask ou bid). ref_* e o valor da ancora na base escolhida, entao a outra ponta e ref + var. NAO filtra por preco, volume, liquidez nem tamanho de regra: isso e where da tela.';

-- As permissoes saem junto com o `drop view`: recriar a view nao as herda.
revoke all on public.v_radar from anon, authenticated;
grant select on public.v_radar to service_role;

-- Conferencia depois de aplicar (nao roda sozinha):
--
--   select count(*)                                as roster,
--          count(event_group_slug)                 as com_grupo,
--          count(*) filter (where slug <> event_group_slug) as divergentes
--     from public.v_radar;
--
-- Em 25/08/2026 a mesma contagem direto em `events` deu 1024 / 1024 / 956.
