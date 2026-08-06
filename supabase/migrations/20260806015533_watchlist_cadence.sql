-- Spec 000, itens 3b e 7 — cadência da watchlist por estado da partida.
--
-- Duas coisas aqui: a coluna que guarda o horário real do jogo e os números da
-- cadência. Os números ficam em config, e não no código, porque cada um é uma
-- aposta sobre dado que ainda não foi medido — quanto tempo a partida dura,
-- quanto o derivado se move comparado ao mercado da série. O primeiro dia em
-- produção vai desmentir alguma delas, e a correção tem que ser um UPDATE, não
-- um deploy.
--
-- ---------------------------------------------------------------------------
-- events.game_start_time — a âncora
-- ---------------------------------------------------------------------------
--
-- Nem `start_date` nem `end_date` dizem quando a partida começa:
--
--   start_date = abertura do mercado. Medido no item 2a: `cs2-gamers-jam1-...`
--                abriu 17:39 do dia ANTERIOR ao jogo. É por isso que a
--                descoberta por `order=startDate` funciona — e é por isso que
--                classificar cadência por ele poria toda a watchlist na faixa
--                ao vivo desde o nascimento.
--
--   end_date   = fim da janela de resolução, não fim do jogo. Medido na Gamma
--                em 2026-08-06 sobre 171 mercados de esports:
--                `end_date - gameStartTime` = p10 4h, p50 6h, p90 6h.
--
-- Esse p50 de 6h é o que descarta a classificação por distância até `end_date`:
-- uma janela ao vivo de 180 min antes do `end_date` só abriria em
-- `gameStartTime + 3h` — com o jogo já encerrado. A faixa de 10-15s cairia
-- inteira depois da partida, que é o oposto do item.
--
-- A Gamma expõe o horário real em três lugares, medidos na mesma amostra:
--
--   gameStartTime        171/171 mercados. Formato '2026-08-06 18:30:00+00'
--                        (sem T, sem Z) — não é ISO-8601.
--   eventStartTime       111/171. Só o mercado da série costuma trazer.
--   events[0].startTime  171/171, em ISO.
--
-- O coletor lê nessa ordem e normaliza para ISO antes de gravar. A coluna é
-- `timestamptz` — o Postgres aceita os dois formatos, quem não aceita é o
-- `Date.parse` de forma garantida.
--
-- Preenchimento: os collectors carimbam no upsert (descoberta e varredura). As
-- linhas que já estão em `events` não são reescritas por eles, e ficam com NULL
-- — mercado com NULL cai na faixa lenta, que é degradação segura mas silenciosa
-- na cadência. Quem fecha essa lacuna é `npm run backfill:game-start-time`,
-- rodado uma vez depois deste apply (ver Parte E: quem roda é o dono).
--
-- Sem índice de propósito. A query do roster já varre `events` por
-- `status='active'` sem índice hoje, e `events` tem 711 MB à espera da poda do
-- item 5. Criar índice antes da poda é pagar por bloat que o item 5 vai apagar.
-- Reavaliar depois dela, com `(game_start_time) where status = 'active'`.

alter table public.events
  add column if not exists game_start_time timestamptz;

comment on column public.events.game_start_time is
  'Horario real da partida (Gamma: gameStartTime / eventStartTime / events[0].startTime). Distinto de start_date (abertura do mercado) e de end_date (fim da janela de resolucao, ~6h depois do jogo).';

-- ---------------------------------------------------------------------------
-- Como a faixa é decidida
-- ---------------------------------------------------------------------------
--
--   falta mais que soon_window_minutes para o jogo  -> faixa lenta (5 min)
--   falta menos que isso, jogo ainda não começou    -> faixa "falta pouco" (1 min)
--   passou de game_start_time, dentro do teto       -> ao vivo (10-15s)
--   passou do teto sem resolver, ou sem âncora      -> faixa lenta
--
-- Não há faixa "encerrada": quem tira da watchlist é a resolução (o
-- `resolved-detector` muda `status`) e a janela de 24h após o `end_date` no
-- roster. Enquanto o mercado está `active`, o preço ainda se move.

alter table public.system_config
  add column if not exists watchlist_interval_live_seconds integer default 12,
  add column if not exists watchlist_interval_soon_seconds integer default 60,
  add column if not exists watchlist_interval_far_seconds integer default 300,
  add column if not exists watchlist_derived_interval_multiplier integer default 5,
  add column if not exists watchlist_soon_window_minutes integer default 360,
  add column if not exists watchlist_live_max_minutes integer default 360,
  add column if not exists watchlist_primary_market_types text[] default '{moneyline}';

comment on column public.system_config.watchlist_interval_live_seconds is
  'Intervalo de refresh do mercado da serie depois de game_start_time. Spec 000 item 3b pede 10-15s; um round de CS2 dura ~2 min.';

comment on column public.system_config.watchlist_interval_soon_seconds is
  'Intervalo quando game_start_time esta dentro de watchlist_soon_window_minutes.';

comment on column public.system_config.watchlist_interval_far_seconds is
  'Intervalo da faixa lenta: longe da partida, sem game_start_time, ou passado o teto de watchlist_live_max_minutes.';

comment on column public.system_config.watchlist_soon_window_minutes is
  'Quanto antes de game_start_time a faixa de 1 min comeca. 360 = as 6h que a spec pede.';

-- O teto do ao vivo.
--
-- A faixa ao vivo termina na resolução, não num relógio. O teto existe só para
-- o caso em que a resolução não vem: partida adiada com o `game_start_time`
-- velho, ou resolução travada na UMA. Sem ele, um mercado desses ficaria a cada
-- 12s pelas 30h que o roster ainda o segura (24h de folga depois de um
-- `end_date` que já é ~6h depois do jogo) — ~9k refreshes por mercado zumbi.
--
-- 360 min cobre um bo5 de LoL com folga larga. Se o log mostrar mercado saindo
-- do ao vivo antes de resolver, é este número que sobe.
comment on column public.system_config.watchlist_live_max_minutes is
  'Por quanto tempo depois de game_start_time o mercado continua na faixa ao vivo sem ter resolvido. Passado o teto, cai para a faixa lenta.';

-- ---------------------------------------------------------------------------
-- O multiplicador — é ele que segura o volume
-- ---------------------------------------------------------------------------
--
-- Uma partida gera vários mercados e só um é a série. Medido na Gamma em
-- 2026-08-06: 171 mercados de esports para 25 partidas — média 6,8, p50 6,
-- máximo 39 (um LoL com `lol_penta_kill`, `lol_both_teams_baron` e afins).
-- Sem distinguir, a faixa rápida se aplicaria aos ~6 derivados de cada partida.
--
-- O multiplicador vale nas TRÊS faixas, não só ao vivo: com a âncora no
-- `game_start_time`, a maior parte do volume não está no ao vivo — está na faixa
-- lenta, multiplicada pelo tamanho do roster.
--
-- Projeção com a âncora nova (883 mercados no roster, ~14 partidas/dia, 7
-- mercados por partida, ~3h de ao vivo por partida — ocupação média de 12
-- mercados ao vivo, 25 em "falta pouco", 846 na faixa lenta):
--
--   multiplicador 1  -> ~734k linhas/dia
--   multiplicador 5  -> ~231k linhas/dia   (~23 MB/dia, ~8 GB/ano)
--   multiplicador 10 -> ~168k linhas/dia
--
-- A projeção anterior (~693k linhas/dia com multiplicador 5) era da âncora por
-- `end_date`, que jogava TODO mercado do roster pelas faixas rápidas nas 9h
-- antes do seu `end_date`. Com a âncora no jogo, só os ~98 mercados das partidas
-- do dia passam por elas; o resto fica na faixa lenta.
--
-- Onde o custo está agora, no multiplicador 5: a faixa lenta é 66% dos refreshes
-- (76,6k de 115,4k por dia). Se for preciso cortar mais, o número que importa é
-- `watchlist_interval_far_seconds`, não a faixa ao vivo — dobrar para 600s tira
-- um terço do total.
comment on column public.system_config.watchlist_derived_interval_multiplier is
  'Quantas vezes mais lento o mercado derivado e refrescado em relacao ao da serie, em qualquer faixa. 1 desliga a distincao.';

-- Qual `sports_market_type` é o mercado da série.
--
-- Confirmado na Gamma em 2026-08-06: o mercado da série vem como 'moneyline'.
-- Cuidado com o vizinho: 'child_moneyline' é o moneyline POR GAME (derivado), e
-- a comparação aqui é por igualdade exata — 'child_moneyline' não entra.
--
-- Continua em lista e em config porque a Gamma muda esses rótulos sem aviso. Se
-- o valor deixar de bater, a distinção silenciosamente trata TODO mercado como
-- derivado e a coleta ao vivo não acontece. O log do coletor traz a ocupação por
-- bucket; `live:primary = 0` com partida rolando é o sintoma exato, e a correção
-- é um UPDATE nesta coluna.
comment on column public.system_config.watchlist_primary_market_types is
  'Valores de events.sports_market_type que identificam o mercado da serie (nao derivado). Lista vazia trata todos como derivados.';
