-- Variação sem mid, e o lado oposto derivado.
--
-- Dois ajustes na camada de leitura, e uma coisa que NÃO muda:
-- `mid_price` continua nulo quando falta um lado do livro. Essa regra impediu
-- um gap falso de +0,13 na frente do XTracker e não está em discussão aqui.
--
-- ---------------------------------------------------------------------------
-- 1. Variação não precisa de mid — precisa do MESMO LADO nas duas pontas
-- ---------------------------------------------------------------------------
--
-- Medido em 20260814: 123 de 673 mercados do roster têm livro de um lado só.
-- Com a regra anterior eles saíam sem preço E sem variação — um quinto da tela
-- em branco na coluna que mais importa.
--
-- Mas o que falta é o MEIO, não o movimento. Azarão com só venda que foi de
-- 0,03 para 0,05 andou 2 centavos, e isso é observação real. Basta comparar o
-- mesmo lado do livro nas duas pontas da janela.
--
-- A cascata, em ordem:
--
--   mid nas duas pontas   -> base 'mid'
--   senão ask nas duas    -> base 'ask'
--   senão bid nas duas    -> base 'bid'
--   senão                 -> nulo, como antes
--
-- `ask` antes de `bid` porque o caso que motivou isto é o azarão com só venda:
-- `ladosDoLivro` (src/collectors/radar-selection.ts) trata `bid <= 0` como
-- "ninguém comprando", então livro de um lado só costuma ser o lado do ask.
-- A ordem não é neutra e por isso está escrita, não implícita.
--
-- ### A coluna que declara a base é obrigatória, não enfeite
--
-- Variação de ask e variação de mid NÃO são a mesma medida. Um ask que cai de
-- 0,05 para 0,03 pode ser o spread fechando, não a probabilidade caindo.
-- Entregar os dois na mesma coluna sem rótulo produziria um número que PARECE
-- comparável entre linhas e não é — que é exatamente o mecanismo pelo qual este
-- projeto já fabricou achado. Daí `var_1h_base` e irmãs.
--
-- ### Nunca misturar bases entre as pontas
--
-- Ask de agora contra mid de uma hora atrás é ruído com cara de sinal. A
-- garantia é estrutural: a escolha da base e o cálculo da variação saem da
-- MESMA função, `var_com_base`, que só olha para um par de valores por vez. Não
-- existe caminho de código em que a ponta de agora e a âncora usem bases
-- diferentes.
--
-- ### O que muda no contrato da view
--
-- `mid_1h` / `mid_24h` / `mid_7d` SAEM e viram `ref_1h` / `ref_24h` / `ref_7d`:
-- o valor da âncora NA BASE ESCOLHIDA. Com `ref` e `var` a outra ponta é
-- `ref + var`, então a linha fica auto-contida. Renomear é possível agora
-- porque a tela ainda não existe; depois seria quebra.
--
-- Por isso as views são DROPADAS e recriadas: `create or replace view` não
-- renomeia coluna nem insere no meio.
--
-- ---------------------------------------------------------------------------
-- 2. O lado "No", derivado em vez de coletado
-- ---------------------------------------------------------------------------
--
-- O coletor grava só o rótulo do outcome 0 — medido: 27.204 linhas em 24h, um
-- rótulo só ('Yes'). Leg comprada no outro lado nunca casa por rótulo, e por
-- isso 61 de 61 legs históricas não achavam preço.
--
-- Dobrar a coleta seria dobrar a linha/dia de uma série que a retenção não
-- apaga, para gravar um número que já é conhecido: em mercado de dois
-- resultados o outro lado é exato por aritmética.
--
--   mid_no = 1 - mid_yes
--   bid_no = 1 - ask_yes      (o melhor preço de compra do No é o espelho do
--   ask_no = 1 - bid_yes       melhor preço de venda do Yes, e vice-versa)
--
-- ### O que NÃO dá para derivar: profundidade
--
-- `bid_depth` e `ask_depth` são o TAMANHO das ordens no topo do livro do token
-- Yes. O livro do token No é outro livro, com outras ordens: não há identidade
-- aritmética que leve um no outro. Um número derivado ali pareceria
-- profundidade do No e não seria.
--
-- Então: quando o preço é derivado, `bid_depth` e `ask_depth` saem NULOS, e
-- `preco_origem` diz `'derivado (1 - lado coletado)'`. A ausência é declarada,
-- não silenciosa.
--
-- ### Quando a derivação é permitida
--
-- Só quando o mercado tem exatamente dois resultados E os dois rótulos (o da
-- leg e o da foto) estão entre eles. Sem essa checagem, uma leg com rótulo de
-- time num mercado Yes/No receberia `1 - mid`, que seria invenção. Medido em
-- 20260814: `outcomes->'values'` tem 2 elementos em 138.497 de 138.497 events,
-- mas a checagem fica porque o dia em que isso mudar não vem avisando.
--
-- Hoje isto não tem consumidor: zero legs abertas. É preparação.

-- ---------------------------------------------------------------------------
-- A função que escolhe a base
-- ---------------------------------------------------------------------------
--
-- Função e não `case` repetido na view: a regra vale para as três janelas, e
-- três cópias são três oportunidades de divergirem numa edição futura. Aqui a
-- ordem da cascata existe UMA vez.
--
-- `immutable` porque é função pura dos argumentos — isso deixa o planejador
-- dobrá-la e a mantém elegível para índice se algum dia precisar.
--
-- Devolve as três coisas juntas de propósito: base, variação e o valor da
-- âncora na base escolhida. Separar em três funções abriria a porta para
-- alguém chamar duas delas com argumentos diferentes.

create or replace function public.var_com_base (
  mid_agora  numeric, ask_agora  numeric, bid_agora  numeric,
  mid_ancora numeric, ask_ancora numeric, bid_ancora numeric
)
  returns table (base text, variacao numeric, ref numeric)
  language sql
  immutable
  parallel safe
as $$
  select
    case
      when mid_agora is not null and mid_ancora is not null then 'mid'
      when ask_agora is not null and ask_ancora is not null then 'ask'
      when bid_agora is not null and bid_ancora is not null then 'bid'
    end,
    case
      when mid_agora is not null and mid_ancora is not null then mid_agora - mid_ancora
      when ask_agora is not null and ask_ancora is not null then ask_agora - ask_ancora
      when bid_agora is not null and bid_ancora is not null then bid_agora - bid_ancora
    end,
    case
      when mid_agora is not null and mid_ancora is not null then mid_ancora
      when ask_agora is not null and ask_ancora is not null then ask_ancora
      when bid_agora is not null and bid_ancora is not null then bid_ancora
    end;
$$;

comment on function public.var_com_base (numeric, numeric, numeric, numeric, numeric, numeric) is
  'Escolhe a base da variacao (mid > ask > bid, nessa ordem) e devolve base, variacao e o valor da ancora na base escolhida. As tres saem juntas para que ponta e ancora nunca usem bases diferentes: ask de agora contra mid de uma hora atras e ruido com cara de sinal.';

revoke all on function public.var_com_base (numeric, numeric, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.var_com_base (numeric, numeric, numeric, numeric, numeric, numeric)
  to service_role;

-- ---------------------------------------------------------------------------
-- `v_radar`
-- ---------------------------------------------------------------------------
--
-- Tudo que a 20260814142958 estabeleceu continua valendo e não se repete aqui:
-- nenhum filtro de opinião, janela por TEMPO com âncora na foto mais próxima do
-- alvo (tolerâncias 1h ±15 min, 24h ±1 h, 7d ±6 h), `span_*` publicando o
-- tamanho real da janela, `security_invoker` reproduzindo o RLS das tabelas.

drop view if exists public.v_radar;

create view public.v_radar
with (security_invoker = true) as
with roster as (
  select e.id, e.polymarket_id, e.slug, e.title, e.polymarket_category,
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
  'Uma linha por mercado do roster (radar_tracked e status active). mid_price continua NULO quando o livro tem um lado so (123 de 673 mercados em 20260814) — mas a VARIACAO nao depende de mid: ela usa o mesmo lado nas duas pontas da janela, e var_*_base declara qual (mid, ask ou bid). ref_* e o valor da ancora na base escolhida, entao a outra ponta e ref + var. NAO filtra por preco, volume, liquidez nem tamanho de regra: isso e where da tela.';

-- ---------------------------------------------------------------------------
-- `v_minhas_posicoes`
-- ---------------------------------------------------------------------------

drop view if exists public.v_minhas_posicoes;

create view public.v_minhas_posicoes
with (security_invoker = true) as
select
  l.id                                      as leg_id,
  b.id                                      as bet_id,
  l.event_id,
  e.title                                   as pergunta,
  e.polymarket_category                     as categoria,
  e.radar_tema                              as tema,
  e.radar_tracked                           as no_radar,
  e.end_date                                as fecha_em,

  l.outcome,
  l.stake_usd,
  l.shares,
  l.entry_price,
  l.preco_mercado                           as preco_mercado_na_entrada,
  l.preco_mercado_em                        as preco_mercado_na_entrada_em,
  l.entry_price - l.preco_mercado           as custo_de_execucao,

  -- O preço do LADO DA LEG. Coletado quando o rótulo bate; derivado por
  -- aritmética quando a leg está no outro lado de um mercado de dois
  -- resultados; nulo quando nenhum dos dois.
  lado.mid_price                            as preco_agora,
  lado.best_bid                             as bid_agora,
  lado.best_ask                             as ask_agora,

  -- Profundidade NÃO é derivável: o livro do outro token é outro livro. Sai
  -- nula na linha derivada, e `preco_origem` diz por quê.
  lado.bid_depth,
  lado.ask_depth,
  lado.origem                               as preco_origem,

  agora.captured_at                         as preco_em,
  round((extract(epoch from (now() - agora.captured_at)) / 60)::numeric, 1)
                                            as preco_idade_min,

  l.shares * lado.mid_price                 as valor_marcado,
  l.shares * lado.mid_price - l.stake_usd   as pnl_nao_realizado,

  -- A ordem importa: cada ramo só é alcançado quando os anteriores falharam, e
  -- os quatro motivos são causas diferentes com conserto diferente.
  case
    when l.event_id is null              then 'leg sem mercado (basket)'
    when agora.captured_at is null       then 'mercado sem foto (fora do radar)'
    when lado.origem is null             then 'rotulo fora dos outcomes do mercado'
    when lado.mid_price is null          then 'livro de um lado so'
  end                                       as motivo_sem_preco,

  b.thesis                                  as tese,
  b.prob_self,
  b.confidence_self,
  b.estrategia,
  b.placed_at,
  l.created_at

from public.my_bet_legs l
join public.my_bets b   on b.id = l.bet_id
left join public.events e on e.id = l.event_id

-- A última foto do mercado, seja qual for o rótulo coletado. Não filtra por
-- `l.outcome`: é justamente o descasamento de rótulo que precisa ser resolvido
-- em vez de virar ausência.
left join lateral (
  select s.outcome, s.mid_price, s.best_bid, s.best_ask,
         s.bid_depth, s.ask_depth, s.captured_at
    from public.polymarket_snapshots s
   where s.event_id = l.event_id
   order by s.captured_at desc
   limit 1
) agora on true

-- A tradução para o lado da leg.
--
-- `bid_no = 1 - ask_yes` e `ask_no = 1 - bid_yes` estão CRUZADOS de propósito:
-- o melhor preço de compra de um lado é o espelho do melhor preço de venda do
-- outro. Copiar sem cruzar inverteria o spread.
left join lateral (
  select
    case
      when agora.outcome = l.outcome then agora.mid_price
      when oposto.ok                 then 1 - agora.mid_price
    end as mid_price,
    case
      when agora.outcome = l.outcome then agora.best_bid
      when oposto.ok                 then 1 - agora.best_ask
    end as best_bid,
    case
      when agora.outcome = l.outcome then agora.best_ask
      when oposto.ok                 then 1 - agora.best_bid
    end as best_ask,
    case when agora.outcome = l.outcome then agora.bid_depth end as bid_depth,
    case when agora.outcome = l.outcome then agora.ask_depth end as ask_depth,
    case
      when agora.outcome = l.outcome then 'coletado'
      when oposto.ok                 then 'derivado (1 - lado coletado); profundidade nao derivavel'
    end as origem
  from (
    select
      -- Dois resultados, e os dois rótulos entre eles. Sem isso, uma leg com
      -- rótulo de time num mercado Yes/No receberia `1 - mid`, que é invenção.
      jsonb_array_length(e.outcomes -> 'values') = 2
      and e.outcomes -> 'values' ? l.outcome
      and e.outcomes -> 'values' ? agora.outcome
      and agora.outcome <> l.outcome
        as ok
  ) oposto
) lado on true

-- A versão anterior tinha aqui uma lateral `exists` para separar "mercado nunca
-- coletado" de "coletado noutro rótulo". Ela existia porque a lateral `agora`
-- filtrava por `outcome`. Agora não filtra mais — `agora.captured_at is null`
-- já significa "nenhuma foto deste mercado" — e a lateral saiu.

where l.closed_at is null;

comment on view public.v_minhas_posicoes is
  'Legs abertas com preco do LADO DA LEG. Quando o radar coletou o outro lado (ele grava so o outcome 0), o preco e DERIVADO por aritmetica de mercado de dois resultados: mid = 1 - mid, bid = 1 - ask, ask = 1 - bid. preco_origem declara coletado ou derivado. Profundidade NAO e derivavel — o livro do outro token e outro livro — e sai nula na linha derivada. Sem preco, valor_marcado e pnl_nao_realizado ficam NULOS em vez de virarem o custo, e motivo_sem_preco diz por que faltou.';

revoke all on public.v_radar           from anon, authenticated;
revoke all on public.v_minhas_posicoes from anon, authenticated;

grant select on public.v_radar           to service_role;
grant select on public.v_minhas_posicoes to service_role;

-- ---------------------------------------------------------------------------
-- Para conferir depois do apply
-- ---------------------------------------------------------------------------
--
--   select var_1h_base, count(*) from public.v_radar group by 1 order by 2 desc;
--   select preco_origem, motivo_sem_preco, count(*)
--     from public.v_minhas_posicoes group by 1, 2;
--   npm run radar:conferir
--
-- `radar:conferir` refaz a janela E a base em TypeScript
-- (`scripts/lib/janela-radar.ts`, com teste sem rede) e compara com o que a
-- view devolveu — a base antes da variacao, porque variacao certa sobre a base
-- errada e o defeito que o script existe para pegar. Tambem confere que linha
-- com preco derivado vem com profundidade NULA.
--
-- Dependencia nova em codigo: `src/lib/bankroll.ts` passou a ler
-- `v_minhas_posicoes` em vez de refazer a marcacao a mao. Se esta migration for
-- revertida sem reverter aquele arquivo, o bankroll para de marcar — e ele foi
-- escrito para responder NULO nesse caso, nao zero.
--
-- Medido em 20260814 15:20 UTC, antes do apply (rodando o corpo da view a mao),
-- sobre 673 mercados do roster. `var_*_base` nulo NUNCA aconteceu com ancora
-- presente: 0 linhas sem base por incompatibilidade entre as pontas.
--
--   var_1h por base   mid 518 · ask 114 · bid 2 · nula 39
--   total com var_1h  634 (94,2% do roster), contra 518 (77,0%) antes
--
-- Os 116 mercados recuperados sao exatamente os que nao tem `mid` agora e
-- passaram a ter variacao pelo lado que existe. Dos 123 sem `mid`, 7 continuam
-- sem variacao.
--
-- As 39 linhas sem variacao de 1h NAO sao por base incompativel — sao 39 por
-- falta de ancora e 0 por base (medido separadamente). Entraram no roster ha
-- menos de uma hora, entao nao existe foto a 1h de distancia. Nulo e a resposta
-- certa, e o numero cai sozinho conforme a serie envelhece.
--
-- Custo: `explain (analyze, buffers)` do corpo novo deu 38-42 ms em tres
-- execucoes (o anterior, so com mid, dava 55,0 ms na mesma maquina). As ancoras
-- passaram a trazer best_bid e best_ask alem do mid; nao mudou o plano —
-- continua Index Scan por (event_id, captured_at desc), sem seq scan sobre a
-- serie. `var_com_base` e immutable e nao toca tabela nenhuma.
