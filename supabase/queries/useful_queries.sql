-- System Health & Activity Metrics
select 
  (select count(*) from events) as total_events,
  (select count(*) from polymarket_snapshots) as total_snapshots,
  (select count(*) from system_logs where status = 'success' and created_at > now() - interval '24 hours') as success_24h,
  (select count(*) from system_logs where status = 'error' and created_at > now() - interval '24 hours') as errors_24h,
  (select max(created_at) from system_logs) as last_run;

-- Database Tables Size Overview
select 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) as size,
  pg_total_relation_size(schemaname || '.' || tablename) as bytes
from pg_tables 
where schemaname = 'public'
order by pg_total_relation_size(schemaname || '.' || tablename) desc;

-- Database Size Overview
select pg_size_pretty(pg_database_size(current_database()));