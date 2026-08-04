-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

SET check_function_bodies = false;

DROP EXTENSION pg_net;

ALTER TABLE public.my_bets
  DROP COLUMN closing_price;

ALTER TABLE public.my_bets
  DROP COLUMN clv;

ALTER TABLE public.my_bets
  DROP COLUMN entry_price;

ALTER TABLE public.my_bets
  DROP COLUMN external_id;

ALTER TABLE public.my_bets
  DROP COLUMN outcome;

ALTER TABLE public.my_bets
  DROP COLUMN pnl_usd;

ALTER TABLE public.my_bets
  DROP COLUMN resolution_price;

ALTER TABLE public.my_bets
  DROP COLUMN result;

ALTER TABLE public.my_bets
  DROP COLUMN shares;

ALTER TABLE public.my_bets
  DROP COLUMN stake_usd;

ALTER TABLE public.system_config
  DROP COLUMN bankroll_usd;

ALTER TABLE public.system_logs
  DROP CONSTRAINT system_logs_pkey;

CREATE EXTENSION hypopg WITH SCHEMA extensions;

CREATE EXTENSION index_advisor WITH SCHEMA extensions;

CREATE EXTENSION pg_trgm WITH SCHEMA public;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT DELETE, INSERT, SELECT, UPDATE ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ROUTINES TO service_role;

GRANT SELECT, USAGE ON SEQUENCE public.polymarket_snapshots_id_seq TO anon;

GRANT SELECT, USAGE ON SEQUENCE public.polymarket_snapshots_id_seq TO authenticated;

GRANT SELECT, USAGE ON SEQUENCE public.polymarket_snapshots_id_seq TO service_role;

GRANT SELECT, USAGE ON SEQUENCE public.system_logs_id_seq TO anon;

GRANT SELECT, USAGE ON SEQUENCE public.system_logs_id_seq TO authenticated;

GRANT SELECT, USAGE ON SEQUENCE public.system_logs_id_seq TO service_role;

CREATE FUNCTION public.run_snapshot_retention_batch (
  delete_type     text,
  retention_hours integer DEFAULT 24,
  batch_size      integer DEFAULT 5000
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  AS $function$                                                                 
  DECLARE
    deleted_count int := 0;
  BEGIN                                                                         
    IF delete_type = 'old' THEN
      WITH to_delete AS (                                                       
        SELECT id FROM public.polymarket_snapshots            
        WHERE captured_at < NOW() - (retention_hours || ' hours')::interval     
        LIMIT batch_size                                                        
      ),                                                                        
      deleted AS (                                                              
        DELETE FROM public.polymarket_snapshots                               
        WHERE id IN (SELECT id FROM to_delete)                                  
        RETURNING 1
      )                                                                         
      SELECT count(*) INTO deleted_count FROM deleted;        
                                                                                
    ELSIF delete_type = 'finalized' THEN
      WITH to_delete AS (                                                       
        SELECT s.id                                           
        FROM public.polymarket_snapshots s                                      
        INNER JOIN public.events e ON e.id = s.event_id                         
        WHERE e.status IN ('resolved', 'closed_manual', 'inactive')
        LIMIT batch_size                                                        
      ),                                                                        
      deleted AS (                                                              
        DELETE FROM public.polymarket_snapshots                                 
        WHERE id IN (SELECT id FROM to_delete)                
        RETURNING 1
      )
      SELECT count(*) INTO deleted_count FROM deleted;
                                                                                
    ELSE
      RAISE EXCEPTION 'Invalid delete_type: %', delete_type;                    
    END IF;                                                   

    RETURN deleted_count;
  END;
  $function$;

GRANT ALL ON FUNCTION public.run_snapshot_retention_batch(text, integer, integer) TO anon;

GRANT ALL ON FUNCTION public.run_snapshot_retention_batch(text, integer, integer) TO authenticated;

GRANT ALL ON FUNCTION public.run_snapshot_retention_batch(text, integer, integer) TO service_role;

CREATE FUNCTION public.run_snapshot_retention (
  retention_hours integer DEFAULT 24
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  AS $function$
DECLARE
  old_deleted int := 0;
  finalized_deleted int := 0;
BEGIN
  -- Deleta snapshots antigos
  WITH deleted AS (
    DELETE FROM public.polymarket_snapshots
    WHERE captured_at < NOW() - (retention_hours || ' hours')::interval
    RETURNING 1
  )
  SELECT count(*) INTO old_deleted FROM deleted;
  
  -- Deleta snapshots de events finalizados
  WITH deleted AS (
    DELETE FROM public.polymarket_snapshots
    WHERE event_id IN (
      SELECT id FROM public.events 
      WHERE status IN ('resolved', 'closed_manual', 'inactive')
    )
    RETURNING 1
  )
  SELECT count(*) INTO finalized_deleted FROM deleted;
  
  RETURN jsonb_build_object(
    'old_deleted', old_deleted,
    'finalized_deleted', finalized_deleted,
    'retention_hours', retention_hours
  );
END;
$function$;

GRANT ALL ON FUNCTION public.run_snapshot_retention(integer) TO anon;

GRANT ALL ON FUNCTION public.run_snapshot_retention(integer) TO authenticated;

GRANT ALL ON FUNCTION public.run_snapshot_retention(integer) TO service_role;

CREATE FUNCTION public.search_events_by_title (
  query_text           text,
  similarity_threshold double precision DEFAULT 0.15
)
  RETURNS TABLE (
    id                  uuid,
    title               text,
    polymarket_category text,
    end_date            timestamp with time zone,
    similarity_score    double precision
  )
  LANGUAGE sql
  STABLE
  AS $function$
  SELECT 
    e.id,
    e.title,
    e.polymarket_category,
    e.end_date,
    similarity(e.title, query_text) AS similarity_score
  FROM events e
  WHERE e.status = 'active'
    AND similarity(e.title, query_text) >= similarity_threshold
  ORDER BY similarity_score DESC, e.end_date ASC
  LIMIT 10;
$function$;

GRANT ALL ON FUNCTION public.search_events_by_title(text, double precision) TO anon;

GRANT ALL ON FUNCTION public.search_events_by_title(text, double precision) TO authenticated;

GRANT ALL ON FUNCTION public.search_events_by_title(text, double precision) TO service_role;

CREATE OR REPLACE FUNCTION public.update_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $function$                                                         
  BEGIN                                                                         
    NEW.updated_at = NOW();                                                     
    RETURN NEW;
  END;
  $function$;

ALTER TABLE public.system_config
  ALTER COLUMN cross_market_dedup_window_minutes SET DEFAULT 60;

CREATE TABLE public.ai_analyses (
  id                   uuid                     DEFAULT gen_random_uuid() NOT NULL,
  signal_id            uuid,
  event_id             uuid,
  context_data         jsonb,
  external_sources     jsonb,
  recommendation       text,
  recommended_outcome  text,
  confidence           numeric,
  thesis               text,
  estimated_fair_price numeric,
  model_used           text,
  tokens_input         integer,
  tokens_output        integer,
  cost_usd             numeric,
  user_acted           boolean,
  outcome_correct      boolean,
  pnl_actual           numeric,
  created_at           timestamp with time zone DEFAULT now()
);

ALTER TABLE public.ai_analyses
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.ai_analyses
  ADD CONSTRAINT ai_analyses_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id);

ALTER TABLE public.ai_analyses
  ADD CONSTRAINT ai_analyses_pkey PRIMARY KEY (id);

ALTER TABLE public.ai_analyses
  ADD CONSTRAINT ai_analyses_signal_id_fkey FOREIGN KEY (signal_id) REFERENCES public.detected_signals(id);

GRANT ALL ON public.ai_analyses TO anon;

GRANT ALL ON public.ai_analyses TO authenticated;

GRANT ALL ON public.ai_analyses TO service_role;

CREATE INDEX idx_ai_analyses_signal ON public.ai_analyses (signal_id);

CREATE INDEX idx_ai_analyses_event ON public.ai_analyses (event_id);

ALTER TABLE public.detected_signals
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.detected_signals
  ADD COLUMN user_dismissed_at timestamp with time zone;

ALTER TABLE public.detected_signals
  ADD COLUMN user_acted_at timestamp with time zone;

ALTER TABLE public.detected_signals
  ADD COLUMN user_action_type text;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.detected_signals TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.detected_signals TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.detected_signals TO service_role;

ALTER TABLE public.events
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.events
  ADD COLUMN event_group_slug text;

ALTER TABLE public.events
  ADD COLUMN sports_market_type text;

ALTER TABLE public.events
  ADD COLUMN line numeric;

ALTER TABLE public.events
  ADD COLUMN resolved_at timestamp with time zone;

ALTER TABLE public.events
  ADD COLUMN start_date timestamp with time zone;

ALTER TABLE public.events
  ADD COLUMN is_new_market boolean DEFAULT false;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.events TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.events TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.events TO service_role;

CREATE INDEX events_title_trgm_idx ON public.events USING gin (title public.gin_trgm_ops);

CREATE INDEX idx_events_new_market ON public.events (is_new_market, start_date)
  WHERE is_new_market = true;

CREATE TRIGGER events_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE public.my_bet_legs (
  id               uuid                     DEFAULT gen_random_uuid() NOT NULL,
  bet_id           uuid                     NOT NULL,
  event_id         uuid,
  outcome          text                     NOT NULL,
  entry_price      numeric(5,4)             NOT NULL,
  stake_usd        numeric(10,2)            NOT NULL,
  shares           numeric(10,4),
  closing_price    numeric(5,4),
  resolution_price numeric(5,4),
  result           text,
  pnl_usd          numeric(10,2),
  clv              numeric(5,4),
  notes            text,
  closed_at        timestamp with time zone,
  created_at       timestamp with time zone DEFAULT now()
);

ALTER TABLE public.my_bet_legs
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.my_bet_legs
  ADD CONSTRAINT my_bet_legs_bet_id_fkey FOREIGN KEY (bet_id) REFERENCES public.my_bets(id) ON DELETE CASCADE;

ALTER TABLE public.my_bet_legs
  ADD CONSTRAINT my_bet_legs_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id);

ALTER TABLE public.my_bet_legs
  ADD CONSTRAINT my_bet_legs_pkey PRIMARY KEY (id);

GRANT ALL ON public.my_bet_legs TO anon;

GRANT ALL ON public.my_bet_legs TO authenticated;

GRANT ALL ON public.my_bet_legs TO service_role;

CREATE INDEX idx_bet_legs_bet ON public.my_bet_legs (bet_id);

CREATE INDEX idx_bet_legs_open ON public.my_bet_legs (bet_id)
  WHERE closed_at IS NULL;

ALTER TABLE public.my_bets
  ENABLE ROW LEVEL SECURITY;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.my_bets TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.my_bets TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.my_bets TO service_role;

ALTER TABLE public.polymarket_snapshots
  ENABLE ROW LEVEL SECURITY;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.polymarket_snapshots TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.polymarket_snapshots TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.polymarket_snapshots TO service_role;

ALTER TABLE public.system_config
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.system_config
  ADD COLUMN notify_min_edge_pct numeric DEFAULT 2.0;

ALTER TABLE public.system_config
  ADD COLUMN cross_market_max_stake_pct numeric DEFAULT 0.10 NOT NULL;

ALTER TABLE public.system_config
  ADD COLUMN cash_usd numeric DEFAULT 0 NOT NULL;

ALTER TABLE public.system_config
  ADD COLUMN signal_ttl_minutes integer DEFAULT 30;

ALTER TABLE public.system_config
  ADD COLUMN signal_cooldown_minutes integer DEFAULT 60;

ALTER TABLE public.system_config
  ADD COLUMN stale_cleanup_threshold_hours integer DEFAULT 1;

ALTER TABLE public.system_config
  ADD COLUMN dismiss_stale_cutoff_minutes integer DEFAULT 15;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.system_config TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.system_config TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.system_config TO service_role;

ALTER TABLE public.system_logs
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.system_logs
  ADD CONSTRAINT system_logs_new_pkey PRIMARY KEY (id);

GRANT DELETE, INSERT, SELECT, UPDATE ON public.system_logs TO anon;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.system_logs TO authenticated;

GRANT DELETE, INSERT, SELECT, UPDATE ON public.system_logs TO service_role;
