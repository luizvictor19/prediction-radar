-- Issue 63: the size alert threshold, corrected to the real quota.
--
-- 20261112052628_database_alert_bytes assumed the Free quota was 500 MB per
-- project summed across the organization (~1 GB) and set 850 MB. The
-- dashboard (2026-11-12) shows 0.5 GB for the whole organization, which also
-- holds chelsea-st (~15 MB). 450 MB for this database leaves ~35 MB of margin,
-- about two weeks at ~2.5 MB/day once the radar takes one photo an hour.
--
-- The default only matters for a fresh row; the owner sets the live value
-- with an UPDATE (issue 63).

alter table public.system_config
  alter column database_alert_bytes set default 450000000;

comment on column public.system_config.database_alert_bytes is
  'Tamanho do banco (pg_database_size, em bytes) acima do qual o bot avisa no Telegram, uma vez por hora no maximo e com o cooldown de health_alert_cooldown_minutes. A cota do plano Free e de 0,5 GB para a organizacao inteira, que tambem tem o chelsea-st (~15 MB). 0 desliga. Issues 60 e 63.';
