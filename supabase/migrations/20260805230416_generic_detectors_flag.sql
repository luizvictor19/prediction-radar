-- Spec 000 — desligar os detectores genéricos, mesmo padrão do item 4.
--
-- Os cinco (`cross_market_intra`, `cross_market_inter`, `calendar_driven`,
-- `hype_reality_gap`, `early_market`) leem `events` + `polymarket_snapshots`.
-- Com a varredura por volume desligada, o lado não-esports dessas duas tabelas
-- parou de receber dado novo: eles rodam a cada 15 min sobre uma foto congelada,
-- gastando query para não encontrar nada. A série de esports, que é o que existe
-- de novo, mora em `esports_snapshots` e nenhum deles lê de lá.
--
-- Uma flag só para o grupo, e não uma por detector: a direção da spec é que os
-- genéricos saiam juntos ("serão desligados, não expandidos"), não que sejam
-- ajustados um a um. Religar é `update system_config set
-- generic_detectors_enabled = true` — o código dos cinco continua intacto.
--
-- Fora do grupo, e continuam rodando: `cleanup_stale_signals` e
-- `dismissStaleSignals`. São a limpeza dos sinais que já existem, e é justamente
-- com os detectores parados que ela importa — sem eles renovando `last_seen_at`,
-- todo sinal genérico ainda ativo vence e é dismissado dentro de
-- `dismiss_stale_cutoff_minutes`. Desligar a limpeza junto deixaria a fila do
-- bot com sinal morto para sempre.

alter table public.system_config
  add column if not exists generic_detectors_enabled boolean default false;

comment on column public.system_config.generic_detectors_enabled is
  'Liga os detectores genericos (cross_market_intra, cross_market_inter, calendar_driven, hype_reality_gap, early_market). false desde a spec 000: sem a varredura por volume eles ficaram sem entrada nova. Nao afeta cleanup_stale_signals.';
