-- ============================================================
-- Prediction Radar — verificação de saúde
-- Atualizado após a Spec 000 (2026-08-06)
--
-- Ordem sugerida: 1 → 2 → 3 antes de qualquer diagnóstico.
-- As demais são por sintoma.
-- ============================================================


-- ------------------------------------------------------------
-- 1. A coleta está viva?
--    A PRIMEIRA a rodar. Um componente sumido daqui não gera
--    erro em lugar nenhum — foi assim que o collector ficou
--    48h parado sem ninguém notar.
-- ------------------------------------------------------------
select component,
       count(*) as execs,
       to_char(max(created_at) at time zone 'America/Sao_Paulo', 'HH24:MI:SS') as ultima,
       round(extract(epoch from (now() - max(created_at))) / 60) as min_atras
from system_logs
where created_at > now() - interval '1 hour'
group by 1
order by max(created_at) desc;

-- Esperado rodando: discovery_collector (3min), watchlist_collector (5min
-- de janela de log), resolved_detector (5min), open_legs_collector (10s),
-- esports_partitions (diário), retention_job.
-- Desligados por flag, aparecem no máximo 1x a cada 6h:
-- collector, early_markets_collector, detectores genéricos.
--
-- ALERTA: qualquer coletor com min_atras > 15 merece investigação.


-- ------------------------------------------------------------
-- 2. A cadência está classificando?
--    Se todos os mercados caírem num bucket só, a âncora
--    game_start_time está nula ou a sonda de coluna falhou.
-- ------------------------------------------------------------
select to_char(created_at at time zone 'America/Sao_Paulo', 'HH24:MI') as hora,
       metadata->>'anchor_column' as tem_ancora,
       metadata->>'null_game_start_time' as sem_ancora,
       metadata->'occupancy_by_bucket' as ocupacao,
       metadata->>'roster_size' as roster
from system_logs
where component = 'watchlist_collector' and metadata ? 'occupancy_by_bucket'
order by created_at desc
limit 5;

-- Esperado: anchor_column = true, null_game_start_time = 0, e os buckets
-- distribuídos entre live/soon/far. Tudo em far durante a madrugada
-- é normal (sem partidas); tudo em far ao meio-dia não é.


-- ------------------------------------------------------------
-- 3. Erros na última hora
-- ------------------------------------------------------------
select component, status,
       left(message, 100) as msg,
       count(*) as n,
       to_char(max(created_at) at time zone 'America/Sao_Paulo', 'HH24:MI') as ultima
from system_logs
where status in ('error', 'partial')
  and created_at > now() - interval '1 hour'
group by 1, 2, 3
order by 4 desc
limit 15;

-- ATENÇÃO ao padrão, não só ao volume: a mesma mensagem repetindo
-- centenas de vezes é log dentro de loop. Foi o que inflou
-- system_logs para 2,7M linhas.


-- ------------------------------------------------------------
-- 4. Integridade da watchlist
--    unaccounted != 0 é bug de contagem, não mercado fechando.
-- ------------------------------------------------------------
select to_char(created_at at time zone 'America/Sao_Paulo', 'HH24:MI') as hora,
       metadata->>'unaccounted' as unaccounted,
       metadata->>'batch_divergences' as divergencias,
       metadata->>'lookup_failed_ids' as lookup_falhou,
       metadata->>'failed_snapshot_rows' as escrita_falhou,
       metadata->>'roster_truncated' as roster_truncado
from system_logs
where component = 'watchlist_collector' and metadata ? 'unaccounted'
order by created_at desc
limit 5;

-- Todos devem ser 0 / null / false. roster_truncated = true significa
-- que a watchlist bateu no teto e mercados ficaram sem refresh.


-- ------------------------------------------------------------
-- 5. Tamanho e crescimento
-- ------------------------------------------------------------
select relname as tabela,
       to_char(n_live_tup, 'FM999,999,999') as linhas,
       pg_size_pretty(pg_total_relation_size(relid)) as total,
       pg_size_pretty(pg_relation_size(relid)) as heap,
       pg_size_pretty(pg_indexes_size(relid)) as indices,
       n_dead_tup as mortas
from pg_stat_user_tables
where n_live_tup > 0
order by pg_total_relation_size(relid) desc
limit 12;

-- Se `indices` ficar muito maior que `heap`, é bloat de índice —
-- foi o caso de polymarket_snapshots (1492 MB de índice sobre
-- 80 MB de dados). Correção:
--   supabase db query "reindex table concurrently NOME;" --linked


-- ------------------------------------------------------------
-- 6. Volume diário de snapshots de esports
--    Projeção da Spec 000: ~231k linhas/dia.
-- ------------------------------------------------------------
select date_trunc('day', captured_at)::date as dia,
       to_char(count(*), 'FM999,999,999') as snapshots,
       count(distinct event_id) as markets,
       pg_size_pretty(sum(pg_column_size(t.*))) as bytes_aprox
from esports_snapshots t
where captured_at > now() - interval '7 days'
group by 1
order by 1 desc;

-- Muito acima de 300k/dia: revisar watchlist_interval_far_seconds,
-- que responde por ~2/3 do volume total.


-- ------------------------------------------------------------
-- 7. Partições
--    A default deve ficar SEMPRE em 0 linhas. Linha nela impede
--    a criação da partição daquele dia depois.
-- ------------------------------------------------------------
select tablename,
       pg_size_pretty(pg_total_relation_size(('public.'||tablename)::regclass)) as tamanho
from pg_tables
where tablename like 'esports_snapshots%'
order by tablename;

select count(*) as linhas_na_default from esports_snapshots_default;

-- Deve haver a partição do dia + pelo menos 2 futuras (lookahead).
-- Sem partição futura, a coleta para.


-- ------------------------------------------------------------
-- 8. Cadência real observada
--    Confirma que o intervalo configurado está sendo aplicado
--    de fato, não só classificado.
-- ------------------------------------------------------------
select e.sports_market_type,
       case
         when e.game_start_time is null then 'sem ancora'
         when e.game_start_time <= now() then 'live'
         when e.game_start_time <= now() + interval '6 hours' then 'soon'
         else 'far'
       end as faixa,
       count(distinct e.id) as markets,
       round(avg(gaps.gap)) as gap_medio_seg
from events e
join lateral (
  select extract(epoch from (captured_at - lag(captured_at) over (order by captured_at))) as gap
  from esports_snapshots
  where event_id = e.id and captured_at > now() - interval '20 minutes'
) gaps on gaps.gap is not null
where e.slug ~ '^(cs2|lol|dota2)-'
group by 1, 2
order by gap_medio_seg;

-- Referência: live+moneyline ~12s, soon+moneyline ~60s,
-- far ~300s, derivados 5x o valor da faixa.


-- ------------------------------------------------------------
-- 9. Queries lentas
--    calls > 10 filtra as consultas manuais de diagnóstico.
-- ------------------------------------------------------------
select round(mean_exec_time)::int as media_ms,
       calls,
       round(total_exec_time / 1000)::int as total_seg,
       left(query, 120) as query
from pg_stat_statements
where calls > 10
order by total_exec_time desc
limit 10;

-- Zerar a janela de medição:  select pg_stat_statements_reset();
-- Média perto de 8000ms é a fronteira do timeout do PostgREST.
-- Milhões de calls com média baixa é escrita linha-a-linha, não
-- query lenta — a correção é batch, não índice.


-- ------------------------------------------------------------
-- 10. Zumbis
--     Mercados marcados active cujo end_date já passou.
--     Chegou a 430k antes da poda; deve ficar baixo.
-- ------------------------------------------------------------
select case when slug ~ '^(cs2|lol|dota2)-' then 'esports' else 'outros' end as tipo,
       count(*) as zumbis
from events
where end_date < now() - interval '7 days' and status = 'active'
group by 1;

-- Crescendo em esports: o resolved_detector não está dando conta.
-- Conferir skipped_due_to_limit no log dele.


-- ------------------------------------------------------------
-- 11. Retenção
-- ------------------------------------------------------------
select to_char(created_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as quando,
       message,
       metadata->>'legacy_esports_events' as esports_no_lugar_errado
from system_logs
where component = 'retention_job'
order by created_at desc
limit 5;

-- legacy_esports_events = eventos de esports com série ainda em
-- polymarket_snapshots (open-legs grava lá por necessidade dos
-- leitores de posição). Estão protegidos da retenção, mas fora
-- da tabela particionada.
