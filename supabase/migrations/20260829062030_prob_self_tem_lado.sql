-- ---------------------------------------------------------------------------
-- Which side `prob_self` is about
-- ---------------------------------------------------------------------------
--
-- `prob_self` stores a probability and does not say WHICH outcome it is about.
-- The price, on the same row, does say: `preco_mercado_outcome` exists for
-- exactly that reason, and `20260819051905_prob_sem_leg.sql` justifies it:
--
--   "preço sem lado é linha de base inutilizável [...] Gravar 0,37 sem dizer
--    de que lado é o mesmo erro de significado de campo que este projeto já
--    pagou três vezes"
--
-- The probability never got the same treatment, and the two writers orient it
-- to different things:
--
--   screen (`estrategia = 'radar'`)      the question's Yes, implied. No leg.
--   bot    (`estrategia = 'saliencia'`)  the leg's outcome, which can be No.
--   basket (`event_id` null)             N markets, no single side.
--
-- One column, two orientations, neither written down. Scoring it as if it were
-- one produces a plausible and wrong Brier on every row coming from the bot.
--
-- ---------------------------------------------------------------------------
-- Why now, with the series at zero
-- ---------------------------------------------------------------------------
--
-- Measured on 29/08/2026 by `npm run medir:serie` and confirmed by a second
-- path independent of that script: `my_bets` holds 58 rows and **0** with
-- `prob_self` not null. All 58 are `estrategia = 'legado'`, the newest from
-- 23/05/2026, all older than the column itself, which was born on 14/08/2026.
--
-- Two consequences, both of which matter here: there is no backfill to do, and
-- no existing row violates the constraint below (all 58 take the first branch,
-- `prob_self is null`). So the check goes in VALID, with no `not valid` and no
-- table scan.
--
-- It is also the only cheap window. At the thirtieth row, in October, the side
-- is information that never existed: it cannot be recovered by asking the
-- database, and whoever recorded it will not remember.
--
-- ---------------------------------------------------------------------------
-- A label, not a boolean
-- ---------------------------------------------------------------------------
--
-- `events.resolved_outcome` is a free-form label: a sample of 1000 resolved
-- events returns `T1`, `Bilibili Gaming`, `No`, `Yes` and a long tail of team
-- names. Storing the LABEL makes scoring a string comparison against that
-- column, with no translation table in between. It is also the comparison the
-- code already performs: `resolved-detector.ts` settles a leg with
-- `leg.outcome === resolution.winnerOutcome`.
--
-- An `is_yes boolean` would need `events.outcomes.values` to get back to the
-- label at scoring time, and would assume a binary shape the roster already
-- contradicts: on 29/08/2026, 1 of the 1074 markets is `Nothing | Something`.
--
-- ---------------------------------------------------------------------------
-- Why NOT derive the side by rule
-- ---------------------------------------------------------------------------
--
-- The rule one could use was measured on 29/08/2026: the last snapshot's side
-- lands at index 0 of the event's list in 1074 of 1074 roster markets. A
-- hundred percent, and it still does not authorise deriving.
--
-- That rate is a property of `radar-collector.ts`, which records only the
-- index-0 label, and which falls back to the literal string 'Yes' when the
-- list will not parse. Nothing in the schema enforces it and nothing measures
-- it if it changes: a change in the collector would surface as a wrong Brier,
-- not as an error. And for the bot there is no rule at all, because the side
-- is whatever outcome was typed, and it can be `No`.

alter table public.my_bets
  add column if not exists prob_self_outcome text;

-- The two `comment on column` payloads below stay in Portuguese, unlike the
-- prose above. They are schema objects read next to the other 15 column
-- comments of this table, all of which are Portuguese, and splitting one
-- column out of that set would make the table's documentation bilingual.

-- `prob_self` already asserted an orientation ("para o desfecho da aposta",
-- 20260814142957), and the screen, which has no leg, reinterpreted that as the
-- question's Yes with nothing recording the swap. It now points at the column
-- that answers, instead of describing a side the row does not hold.
comment on column public.my_bets.prob_self is
  'Minha probabilidade declarada, em 0-1, dita ANTES do resultado. De que desfecho ela e esta em prob_self_outcome, e sem ele a linha nao e pontuavel. E o unico campo com que da para calcular Brier: (prob_self - desfecho)^2. Nao confundir com confidence_self, que e sentimento 1-10 e nao tem unidade.';

comment on column public.my_bets.prob_self_outcome is
  'De que desfecho e prob_self. Rotulo, para pontuar por comparacao direta de string contra events.resolved_outcome, como resolved-detector.ts ja faz com my_bet_legs.outcome. Quando event_id existe o rotulo passou por normalizeOutcome e esta no vocabulario de events.outcomes.values; quando nao existe e texto cru do dono e NAO esta garantido nesse vocabulario. Na tela e o v_radar.outcome do mercado; no bot e o outcome da leg, que pode ser No. NULO quando event_id e nulo, caso em que a linha nao e pontuavel por este caminho.';

-- ---------------------------------------------------------------------------
-- The constraint, and why it is conditioned on `event_id`
-- ---------------------------------------------------------------------------
--
-- The obvious form would be `prob_self is null or prob_self_outcome is not
-- null`. It BREAKS the bot: the basket flow (`src/bot/handlers/register.ts`)
-- writes `prob_self` with a null `event_id` and N legs, and has no single side
-- to declare, because the probability there is about the whole thesis and not
-- about one outcome. With the unconditional check, every basket registration
-- would start failing at insert.
--
-- The cut is "this row is about ONE market": a row with `event_id` is about a
-- single market and resolves one day, and it is the same condition that
-- `medir:serie` and `v_radar` already use to ignore the others.
--
-- So: a probability about ONE market has to say which side it is about. A
-- probability about a basket has no side to give, and the database does not
-- pretend otherwise by storing an arbitrary label.
--
-- CAREFUL, and this is the honest limit of the constraint: a null `event_id`
-- does NOT mean "not scorable". `track.ts` and `track-custom.ts` write bets
-- with a null `event_id` whose LEGS carry real `event_id`s, and the
-- `resolved-detector` resolves per leg and closes the bet when all legs close.
-- Neither of those two writes `prob_self` today (checked: the field is absent
-- from both inserts), and that is the only reason this condition suffices.
--
-- In other words the check is the floor, not the ceiling, and it rests on a
-- fact about TODAY's writers rather than on a property of the table. A new
-- writer that stores `prob_self` on a row with no `event_id` and legs pointing
-- at real markets escapes the requirement entirely. Whoever touches the
-- writers checks this.
--
-- The bot's single bet on an unmatched market also escapes (null `event_id`,
-- leg with a typed outcome). The writer records the side there anyway, because
-- it is known.
--
-- `do` block for the same reason as `20260814142957`: `add constraint if not
-- exists` does not exist in Postgres, and a migration that breaks on reapply
-- is a migration nobody runs twice.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.my_bets'::regclass
       and conname = 'my_bets_prob_self_tem_lado'
  ) then
    alter table public.my_bets
      add constraint my_bets_prob_self_tem_lado
      check (prob_self is null or event_id is null or prob_self_outcome is not null);
  end if;
end $$;

-- Check after applying (does not run on its own):
--
--   select count(*)                                             as linhas,
--          count(prob_self)                                     as com_prob,
--          count(*) filter (where prob_self is not null
--                             and event_id  is not null
--                             and prob_self_outcome is null)    as sem_lado
--     from public.my_bets;
--
-- `sem_lado` has to be 0. If it is not, the check did not go in.
