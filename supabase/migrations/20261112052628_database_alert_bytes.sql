-- Issue 60: the database size above which the bot warns on Telegram.
--
-- The Free plan quota is 500 MB of database per project, summed across the
-- organization (two projects, so ~1 GB), averaged over the billing cycle.
-- With one closed radar month archived on day 9 of the next, the database
-- swings between ~460 MB and ~770 MB (measured 2026-11-12: 469 MB right
-- after issue 59, growth ~10 MB/day). 850 MB stays quiet in a normal month,
-- fires about eight days after a skipped archive, and still leaves ~135 MB
-- under the quota, about two weeks at the current rate.
--
-- The number lives in config, not in code, so it can move without a deploy
-- (a raised roster, a plan change). 0 turns the check off.

alter table public.system_config
  add column if not exists database_alert_bytes bigint not null default 850000000;

comment on column public.system_config.database_alert_bytes is
  'Tamanho do banco (pg_database_size, em bytes) acima do qual o bot avisa no Telegram, uma vez por hora no maximo e com o cooldown de health_alert_cooldown_minutes. Medido contra a cota do plano Free (500 MB por projeto, somados na organizacao). 0 desliga. Issue 60.';
