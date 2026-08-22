-- ---------------------------------------------------------------------------
-- Probabilidade registrada SEM operação
-- ---------------------------------------------------------------------------
--
-- A tela do radar (`web/`) registra a probabilidade do dono ANTES de ele ir
-- para a Polymarket — essa ordem é o requisito inteiro: número escrito depois
-- de ver o resultado da entrada não vale como previsão.
--
-- No instante do registro não existe lado, preço de entrada nem stake. Ou seja:
-- não existe `my_bet_legs`, cujas colunas `outcome`, `entry_price` e
-- `stake_usd` são NOT NULL. A previsão nasce como uma linha de `my_bets` sem
-- nenhuma leg.
--
-- Isso é deliberado e não precisa de flag: **bet sem leg É previsão sem
-- operação**, derivável por `not exists (select 1 from my_bet_legs ...)`. Uma
-- coluna `eh_opiniao boolean` seria um segundo lugar para a mesma verdade, e
-- dois lugares discordam.
--
-- Auditoria feita antes desta migration (19/08/2026): todo consumidor de
-- posição/P&L é dirigido pela LEG, não pelo bet — `v_minhas_posicoes` tem a leg
-- no `from` e join inner, `bankroll.ts` lê a view, `/positions`, `/status`,
-- `/edit` e o `resolved-detector` idem. `v_radar` já separa `prob_self`
-- (lateral sobre `my_bets`) de `tenho_posicao`/`legs_abertas` (lateral sobre
-- `my_bet_legs`). Os dois pontos que contavam bet sem leg como posição
-- (`calendar-driven.ts`, `signal-context.ts`) foram corrigidos no mesmo commit.
--
-- ---------------------------------------------------------------------------
-- O preço de mercado, de novo — agora do lado do bet
-- ---------------------------------------------------------------------------
--
-- `20260814142957_registro_prob_self.sql` colocou `preco_mercado` /
-- `preco_mercado_em` em `my_bet_legs`, com a justificativa de que preço é por
-- MERCADO e uma basket tem N mercados. Isso continua certo para aposta.
--
-- Mas a previsão sem operação não tem leg onde pendurar a linha de base — e
-- sem linha de base a medição não existe: o que se quer saber em dois meses é
-- `prob_self` contra o preço que o mercado dava NAQUELE instante. Reconstruir
-- depois seria escolher a foto que favorece o resultado.
--
-- Uma linha de `my_bets` de previsão tem `event_id` não nulo e um mercado só,
-- então o argumento da basket não se aplica a ela.
--
-- ---------------------------------------------------------------------------
-- Por que TRÊS colunas e não duas
-- ---------------------------------------------------------------------------
--
-- Em `my_bet_legs` o preço fica ao lado de `outcome`, então o lado é conhecido
-- por vizinhança. `my_bets` não tem `outcome` (foi dropada em
-- `002_my_bet_legs.sql`), e preço sem lado é linha de base inutilizável:
-- `v_radar.outcome` é o lado do último snapshot e nem sempre é o "Yes" da
-- pergunta. Gravar 0,37 sem dizer de que lado é o mesmo erro de significado de
-- campo que este projeto já pagou três vezes (`startDate` que era data de
-- criação, `endDate` exclusivo, `endDate` da Gamma que não é resolução).
--
--   `preco_mercado`          o mid do livro.
--   `preco_mercado_em`       o `captured_at` da foto — NÃO o instante do
--                            registro.
--   `preco_mercado_outcome`  de que lado é esse preço.
--
-- `preco_mercado` é NULO quando `mid_price` é nulo, o que acontece em livro de
-- um lado só (123 de 673 mercados em 14/08). Nunca 0,50 por aritmética.

alter table public.my_bets
  add column if not exists preco_mercado         numeric(5,4),
  add column if not exists preco_mercado_em      timestamptz,
  add column if not exists preco_mercado_outcome text;

comment on column public.my_bets.preco_mercado is
  'Mid do livro (v_radar.mid_price) no instante do registro da probabilidade, a linha de base contra a qual prob_self e medida. NULO quando o livro tinha um lado so ou nao ha foto. Nunca 0.50, nunca entry_price. Para aposta com leg, o equivalente e my_bet_legs.preco_mercado.';

comment on column public.my_bets.preco_mercado_em is
  'captured_at da foto usada em preco_mercado, NAO o instante do registro (esse e placed_at). Existe para a idade da base ser mensuravel: a cadencia do radar e de 15 min.';

comment on column public.my_bets.preco_mercado_outcome is
  'De que lado e preco_mercado (v_radar.outcome). Sem ele o preco nao e comparavel com prob_self: o lado do ultimo snapshot nem sempre e o Yes da pergunta.';

-- Preço fora de [0,1] é erro de unidade, não valor de cauda: `numeric(5,4)`
-- aceitaria 9,9999 calado.
alter table public.my_bets
  add constraint my_bets_preco_mercado_intervalo
  check (preco_mercado is null or (preco_mercado >= 0 and preco_mercado <= 1));

-- Preço sem lado não é dado incompleto, é dado enganoso — ele parece
-- comparável e não é. O banco recusa em vez de deixar passar.
alter table public.my_bets
  add constraint my_bets_preco_mercado_tem_lado
  check (preco_mercado is null or preco_mercado_outcome is not null);
