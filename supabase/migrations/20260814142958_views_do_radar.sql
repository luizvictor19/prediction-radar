-- As views do radar: `v_radar` e `v_minhas_posicoes`.
--
-- O contrato entre banco e tela. O PostgREST expõe view automaticamente, com
-- ordenação, filtro e paginação de graça, então isto substitui o backend que
-- não vai existir.
--
-- ---------------------------------------------------------------------------
-- A regra que decide tudo: a view EXPÕE, quem filtra é a query da tela
-- ---------------------------------------------------------------------------
--
-- Nenhum `where` de opinião aqui dentro. Nada de faixa de preço, volume mínimo,
-- tamanho de regra, teto por assunto. Tudo isso é coluna, e trocar de tese tem
-- que custar um `where` na tela — não uma migration.
--
-- É o mesmo princípio que já governa o coletor ("filtra na coleta o que NÃO
-- muda, filtra na view o que muda"), levado um passo adiante: a view também não
-- filtra o que muda. Ela só junta e nomeia.
--
-- O único `where` de `v_radar` é `radar_tracked and status = 'active'`, e ele
-- não é opinião: é a definição de "o roster agora". Mercado resolvido sai
-- porque não há mais preço para vigiar, não porque deixou de interessar — e a
-- série dele continua intacta na tabela, protegida por `radar_tracked`.
--
-- ---------------------------------------------------------------------------
-- `mid_price` nulo continua nulo, e a variação contra ele também
-- ---------------------------------------------------------------------------
--
-- Livro de um lado só é resposta legítima e NÃO é canto raro: medido em
-- 20260814, `mid_price` é nulo em 18,3% das linhas (4.857 de 26.589), atingindo
-- 119 dos 645 mercados do roster. Um quinto do dado.
--
-- Nada aqui preenche isso. Nem 0,50, nem o lado existente repetido, nem o
-- último mid conhecido. Livro vazio com mid 0,50 por aritmética já fabricou um
-- gap falso de +0,13 na frente do XTracker, e o número saiu bonito o bastante
-- para ninguém desconfiar.
--
-- A variação sai de subtração pura (`agora - âncora`), e subtração com nulo dá
-- nulo no Postgres. Isso é de propósito: `coalesce(..., 0)` em cima de qualquer
-- uma das duas pontas transformaria "não sei" em "não mudou", que é a mentira
-- mais cara que uma tela de preço pode contar.
--
-- ---------------------------------------------------------------------------
-- A janela é por TEMPO, e a âncora é o snapshot mais próximo do alvo
-- ---------------------------------------------------------------------------
--
-- "1h atrás" NÃO é "4 fotos atrás". Contar linhas dá salto errado no primeiro
-- buraco da série, e buraco existe: a cobertura por ciclo medida é 95,9%
-- (618 de 645), não 100%.
--
-- O alvo de cada janela é `agora.captured_at - janela`, e não `now() - janela`.
-- A diferença importa: a última foto pode ter até 15 min de idade (a cadência),
-- e ancorar em `now()` faria a janela "1h" medir 45 min de verdade. Ancorada na
-- própria foto, ela mede 1h de dado observado, sempre.
--
-- Dentro da tolerância, a âncora é a foto MAIS PRÓXIMA do alvo — não a anterior
-- nem a seguinte. Fora da tolerância, não há âncora, e a variação é nula.
--
-- ### As tolerâncias, e de onde saem
--
--   1h    ±15 min    24h   ±1 h    7d   ±6 h
--
-- O piso é a cadência: com foto a cada 15 min, um alvo que caia no meio de um
-- intervalo está a no máximo 7,5 min da foto mais próxima. ±15 min cobre um
-- ciclo INTEIRO perdido (buraco de 30 min) sem perder a âncora.
--
-- Medido em 20260814 sobre os 645 mercados: o pior desvio de âncora de 1h foi
-- de 0,04 min — 2,4 segundos. Nenhum mercado ficou sem âncora por tolerância.
-- A folga nunca foi usada; ela existe para o dia em que o coletor cair.
--
-- ±1h em 24h é 4% da janela, ±6h em 7d é 3,6%. As duas crescem menos que
-- proporcionalmente de propósito: quanto mais longa a janela, menos um desvio
-- absoluto distorce a variação.
--
-- `span_1h_min`, `span_24h_h` e `span_7d_d` publicam o tamanho REAL da janela
-- medida em cada linha. Quem quiser rigor filtra por eles; a tolerância nunca
-- é aplicada em silêncio.
--
-- ---------------------------------------------------------------------------
-- O plano, medido em 20260814 (`explain (analyze, buffers)`)
-- ---------------------------------------------------------------------------
--
--   645 mercados no roster, 26.589 linhas de série (10,6 h de coleta)
--   Planning 4,9 ms · Execution 55,0 ms · 17.661 buffers, 2 reads
--
-- NÃO há seq scan sobre `polymarket_snapshots`. Todo acesso é Index Scan por
-- `(event_id, captured_at desc)`, o índice que a partição herda do pai.
--
-- A poda de partição FUNCIONA, e em tempo de execução: as âncoras têm limite
-- superior e inferior derivados de `agora.captured_at` (um parâmetro do laço),
-- e o plano mostra 4 das 5 partições como `never executed`.
--
-- O ramo do "preço agora" é a exceção, e é estrutural: `order by captured_at
-- desc limit 1` sem limite de tempo obriga um `Merge Append` que abre uma
-- varredura em TODA partição. Custo medido: 2 buffers por mercado por partição
-- vazia, 12,1 ms no total hoje.
--
-- Um piso de tempo não conserta isso, e foi testado: `captured_at >= now() -
-- 30 days` deu buffers idênticos (7.095), porque limite INFERIOR não poda
-- partição futura nem a `historico`, que começa em `minvalue`. Ficou de fora —
-- não compra desempenho e nularia em silêncio o preço de mercado parado.
--
-- ### Escala: 30× de quê
--
-- Medido, multiplicando o roster pelos mesmos 645 mercados reais:
--
--   roster      1× (645)      40 ms
--   roster      5× (3.225)    80 ms
--   roster     10× (6.450)   125 ms
--   roster     30× (19.350)  308 ms
--
-- E com as três âncoras ACHANDO linha (hoje 24h e 7d não acham, a série tem
-- 10,6 h — simulado apontando-as para dentro da janela existente):
--
--   roster      1× (645)      51 ms
--   roster     30× (19.350)  335 ms
--
-- Sublinear porque o custo por mercado é descida de índice, não varredura: 30×
-- mais LINHAS na série não muda quase nada (a árvore ganha um nível).
--
-- **O que cresce é o número de PARTIÇÕES, não o de linhas.** Nada é dropado
-- aqui por desenho, então elas só acumulam: 12 por ano. Em 3 anos são ~35, e o
-- `Merge Append` do "preço agora" passaria de 7.095 para ~46.000 buffers — de
-- 12 ms para ~78 ms com o roster de hoje. Com roster 30× junto, o produto é que
-- machuca (~1,5 s), e aí o caminho é separar por regime, não materializar.
--
-- ### Por que view comum, e não materializada
--
-- Porque 55 ms cabe. Materializada teria que ser refrescada por um job, e job
-- é mais uma coisa que para sem avisar — e o modo de falha é o pior possível:
-- a tela continua respondendo, com preço de ontem, sem nada indicando isso.
-- O gatilho para revisar é medido, não estético: quando `Execution Time` da
-- `v_radar` passar de ~1 s. A query para conferir está no fim deste arquivo.

-- ---------------------------------------------------------------------------
-- O índice que a medição pediu
-- ---------------------------------------------------------------------------
--
-- `my_bets` não tem índice em `event_id`, e a lateral da "última probabilidade"
-- roda uma vez por mercado do roster. Medido no plano: `Seq Scan on my_bets`,
-- 0,011 ms × 645 laços = 7,1 ms, 13% do tempo de execução da view — com 58
-- apostas na tabela. O custo é linear no número de apostas, e essa tabela só
-- cresce.
--
-- `my_bet_legs` não ganha índice novo: a mesma medição deu 0,001 ms por laço
-- usando `idx_bet_legs_open`. Índice sem número que o justifique é inchaço, e
-- este projeto já pagou 1.492 MB por essa lição.

create index if not exists idx_my_bets_event on public.my_bets (event_id)
  where event_id is not null;

comment on index public.idx_my_bets_event is
  'Serve a lateral da ultima probabilidade em v_radar, que roda uma vez por mercado do roster. Sem ele o plano fazia Seq Scan de my_bets 645 vezes (7,1 ms, 13% do tempo da view).';

-- ---------------------------------------------------------------------------
-- `v_radar`
-- ---------------------------------------------------------------------------
--
-- `security_invoker = true` reproduz EXATAMENTE o controle de acesso que as
-- tabelas já têm. `events`, `polymarket_snapshots`, `my_bets` e `my_bet_legs`
-- estão todas com RLS ligado e ZERO policies — ou seja, só `service_role` (que
-- tem BYPASSRLS) enxerga linha. Uma view `security definer` (o padrão do
-- Postgres) entregaria o roster inteiro para `anon`, que é a chave que vai num
-- front-end. A view não pode ser a porta dos fundos do RLS.

create or replace view public.v_radar
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
  a1h.mid_price                             as mid_1h,
  agora.mid_price - a1h.mid_price           as var_1h,
  a1h.captured_at                           as ancora_1h,
  round((extract(epoch from (agora.captured_at - a1h.captured_at)) / 60)::numeric, 1)
                                            as span_1h_min,

  -- variação 24h
  a24h.mid_price                            as mid_24h,
  agora.mid_price - a24h.mid_price          as var_24h,
  a24h.captured_at                          as ancora_24h,
  round((extract(epoch from (agora.captured_at - a24h.captured_at)) / 3600)::numeric, 2)
                                            as span_24h_h,

  -- variação 7d
  a7d.mid_price                             as mid_7d,
  agora.mid_price - a7d.mid_price           as var_7d,
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

-- O "agora": a última foto do mercado, sem piso de tempo. `left join` porque
-- mercado sem foto nenhuma continua na view, com preço nulo — sumir da lista
-- seria descarte silencioso do caso mais interessante (o coletor falhando).
left join lateral (
  select s.outcome, s.best_bid, s.best_ask, s.mid_price, s.spread,
         s.bid_depth, s.ask_depth, s.volume_24h, s.captured_at
    from public.polymarket_snapshots s
   where s.event_id = r.id
   order by s.captured_at desc
   limit 1
) agora on true

-- As três âncoras. `s.outcome = agora.outcome` porque comparar mid de rótulos
-- diferentes seria somar duas séries: hoje o radar só grava 'Yes', mas o rótulo
-- vem do payload da Gamma e não é contrato.
--
-- Quando `agora` é nulo, `agora.captured_at` é nulo, os limites viram nulos,
-- nenhuma linha casa, e a âncora é nula. A cascata cai sozinha, sem `case`.
left join lateral (
  select s.mid_price, s.captured_at
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
  select s.mid_price, s.captured_at
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
  select s.mid_price, s.captured_at
    from public.polymarket_snapshots s
   where s.event_id = r.id
     and s.outcome  = agora.outcome
     and s.captured_at >= agora.captured_at - interval '7 days' - interval '6 hours'
     and s.captured_at <= agora.captured_at - interval '7 days' + interval '6 hours'
   order by abs(extract(epoch from (s.captured_at - (agora.captured_at - interval '7 days')))),
            s.captured_at
   limit 1
) a7d on true

-- Agregado sem `group by` devolve UMA linha sempre, com `count` = 0 quando não
-- há leg. Por isso `tenho_posicao` nunca é nulo — é `false`, que é a resposta
-- certa para "não tenho".
left join lateral (
  select count(*) as legs_abertas, sum(l.stake_usd) as stake_aberto_usd
    from public.my_bet_legs l
   where l.event_id = r.id
     and l.closed_at is null
) pos on true

-- A última probabilidade que EU declarei sobre este mercado. Filtra
-- `prob_self is not null` de propósito: uma aposta nova sem probabilidade
-- (coorte 'legado') não pode apagar da tela uma probabilidade dita antes.
left join lateral (
  select b.prob_self, b.placed_at, b.estrategia
    from public.my_bets b
   where b.event_id = r.id
     and b.prob_self is not null
   order by b.placed_at desc
   limit 1
) minha on true;

comment on view public.v_radar is
  'Uma linha por mercado do roster (radar_tracked e status active). Expoe preco, variacao por janela de TEMPO (1h/24h/7d), tamanho, prazo e o que ja foi apostado. NAO filtra por preco, volume, liquidez nem tamanho de regra: isso e where da tela. mid_price nulo (livro de um lado so, 18,3% das linhas em 20260814) fica nulo, e a variacao contra ele tambem. Ver span_1h_min / span_24h_h / span_7d_d para o tamanho REAL da janela medida em cada linha.';

-- ---------------------------------------------------------------------------
-- `v_minhas_posicoes`
-- ---------------------------------------------------------------------------
--
-- Posição aberta com preço atual, P&L não realizado e a tese registrada.
--
-- ### `bankroll.ts` cai no custo — e continua caindo
--
-- `getBankrollState()` marca a mercado lendo a última foto por
-- `(event_id, outcome)` e, quando não acha `mid_price`, soma `stake_usd` no
-- lugar (`src/lib/bankroll.ts`). Isso faz o P&L não realizado dar zero para a
-- perna sem preço, e o bankroll parecer estável exatamente onde é desconhecido.
--
-- Medido em 20260814, com o radar já alimentando a tabela: das 61 legs
-- registradas, **61 cairiam no custo**. Nenhuma delas está em mercado com
-- `radar_tracked`, e os rótulos são nome de time — `Vitality`, `Gen.G`,
-- `Natus Vincere`. São mercados de PARTIDA de esports, que o coletor do radar
-- descarta por decisão (`ehMercadoDePartida`, `PREFIXOS_ESPORTS`). O radar não
-- conserta a carteira antiga porque não coleta esses mercados.
--
-- (Legs abertas hoje: zero. O número acima é sobre as 61 históricas, que é o
-- que existe para medir.)
--
-- E há um segundo desencontro, estrutural, que vale para o futuro: o radar
-- grava só `outcome = 'Yes'` (medido: 27.204 linhas em 24h, um rótulo só). Uma
-- leg em 'No' nunca casa por rótulo, mesmo com o mercado no roster.
--
-- Esta view NÃO repete o fallback: sem preço, `preco_agora`, `valor_marcado` e
-- `pnl_nao_realizado` ficam NULOS. E `motivo_sem_preco` diz por quê, para o
-- silêncio virar diagnóstico em vez de zero.

create or replace view public.v_minhas_posicoes
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

  agora.mid_price                           as preco_agora,
  agora.captured_at                         as preco_em,
  round((extract(epoch from (now() - agora.captured_at)) / 60)::numeric, 1)
                                            as preco_idade_min,

  l.shares * agora.mid_price                as valor_marcado,
  l.shares * agora.mid_price - l.stake_usd  as pnl_nao_realizado,

  case
    when l.event_id is null            then 'leg sem mercado (basket)'
    when not qualquer.tem              then 'mercado sem foto (fora do radar)'
    when agora.captured_at is null     then 'rotulo nao coletado (o radar so grava Yes)'
    when agora.mid_price is null       then 'livro de um lado so'
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

-- A foto certa: mesmo mercado E mesmo rótulo.
left join lateral (
  select s.mid_price, s.captured_at
    from public.polymarket_snapshots s
   where s.event_id = l.event_id
     and s.outcome  = l.outcome
   order by s.captured_at desc
   limit 1
) agora on true

-- Existe foto do mercado com QUALQUER rótulo? É o que separa "mercado nunca
-- coletado" de "coletado, mas noutro lado do livro".
--
-- `exists` e não `count(*)`: contar percorreria a série inteira do mercado
-- (milhares de linhas por mês) para responder uma pergunta de sim ou não.
left join lateral (
  select exists (
    select 1 from public.polymarket_snapshots s where s.event_id = l.event_id
  ) as tem
) qualquer on true

where l.closed_at is null;

comment on view public.v_minhas_posicoes is
  'Legs abertas com preco atual, P&L nao realizado e a tese. NAO repete o fallback do bankroll.ts: sem preco, valor_marcado e pnl_nao_realizado ficam NULOS em vez de virarem o custo, e motivo_sem_preco diz por que faltou. Medido em 20260814: das 61 legs registradas, 61 nao acham preco (mercados de partida de esports, que o radar nao coleta).';

-- ---------------------------------------------------------------------------
-- Acesso
-- ---------------------------------------------------------------------------
--
-- `security_invoker` já garante que o RLS das tabelas vale para quem consulta.
-- O `revoke` de `anon` é a segunda tranca: as default privileges deste banco
-- dão acesso a `anon` em objeto novo do schema public, e a lição da partição
-- `polymarket_snapshots_default` foi exatamente essa.

revoke all on public.v_radar           from anon, authenticated;
revoke all on public.v_minhas_posicoes from anon, authenticated;

grant select on public.v_radar           to service_role;
grant select on public.v_minhas_posicoes to service_role;

-- ---------------------------------------------------------------------------
-- Para conferir depois do apply
-- ---------------------------------------------------------------------------
--
-- Custo (o gatilho de revisar o desenho é `Execution Time` passar de ~1 s):
--
--   explain (analyze, buffers) select * from public.v_radar;
--
-- Cobertura das janelas, com o motivo separado por causa:
--
--   select count(*)                                            as mercados,
--          count(*) filter (where preco_em is null)            as sem_foto,
--          count(*) filter (where mid_price is null)           as sem_mid_agora,
--          count(*) filter (where ancora_1h is null)           as sem_ancora_1h,
--          count(*) filter (where var_1h  is not null)         as com_var_1h,
--          count(*) filter (where var_24h is not null)         as com_var_24h,
--          count(*) filter (where var_7d  is not null)         as com_var_7d
--     from public.v_radar;
--
-- Medido em 20260814 14:20 UTC, antes do apply (rodando o corpo da view à mão):
--
--   mercados 645 · sem_foto 0 · sem_mid_agora 119 · sem_ancora_1h 0
--   com_var_1h 526 · com_var_24h 0 · com_var_7d 0
--
-- Os dois zeros do fim não são defeito da view: a série começou às 03:45 UTC do
-- mesmo dia e tem 10,6 h. `var_24h` passa a existir em 20260815, `var_7d` em
-- 20260821. E os 119 sem variação de 1h são os mesmos 119 sem `mid` agora —
-- nenhum mercado ficou sem variação por falta de foto na janela.
