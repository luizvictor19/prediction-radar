-- 1. Drop colunas operacionais de my_bets (tabela está vazia)
ALTER TABLE public.my_bets DROP COLUMN IF EXISTS external_id;
ALTER TABLE public.my_bets DROP COLUMN IF EXISTS outcome;
ALTER TABLE public.my_bets DROP COLUMN IF EXISTS entry_price;
ALTER TABLE public.my_bets DROP COLUMN IF EXISTS closing_price;
ALTER TABLE public.my_bets DROP COLUMN IF EXISTS resolution_price;
ALTER TABLE public.my_bets DROP COLUMN IF EXISTS stake_usd;
ALTER TABLE public.my_bets DROP COLUMN IF EXISTS shares;
ALTER TABLE public.my_bets DROP COLUMN IF EXISTS result;
ALTER TABLE public.my_bets DROP COLUMN IF EXISTS pnl_usd;
ALTER TABLE public.my_bets DROP COLUMN IF EXISTS clv;

-- 2. Tornar event_id nullable em my_bets (basket pode ter event_id null)
ALTER TABLE public.my_bets ALTER COLUMN event_id DROP NOT NULL;

-- 3. Criar tabela my_bet_legs
CREATE TABLE public.my_bet_legs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  bet_id uuid NOT NULL,
  event_id uuid NULL,
  outcome text NOT NULL,
  entry_price numeric(5, 4) NOT NULL,
  stake_usd numeric(10, 2) NOT NULL,
  shares numeric(10, 4) NULL,
  closing_price numeric(5, 4) NULL,
  resolution_price numeric(5, 4) NULL,
  result text NULL,
  pnl_usd numeric(10, 2) NULL,
  clv numeric(5, 4) NULL,
  notes text NULL,
  closed_at timestamp with time zone NULL,
  created_at timestamp with time zone NULL DEFAULT NOW(),
  CONSTRAINT my_bet_legs_pkey PRIMARY KEY (id),
  CONSTRAINT my_bet_legs_bet_id_fkey
    FOREIGN KEY (bet_id) REFERENCES my_bets(id) ON DELETE CASCADE,
  CONSTRAINT my_bet_legs_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE INDEX idx_bet_legs_bet ON public.my_bet_legs(bet_id);
CREATE INDEX idx_bet_legs_open ON public.my_bet_legs(bet_id) WHERE closed_at IS NULL;
