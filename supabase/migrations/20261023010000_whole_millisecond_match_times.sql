-- Match times are stored in whole milliseconds, because the application can only read them that way.
--
-- Postgres keeps a `timestamptz` to the microsecond; JavaScript's `Date` keeps milliseconds and
-- drops the rest. Anything the database stamps with the clock - `ended_at` and `started_at` from
-- `statement_timestamp()`, a reflow's `shifted_time` behind a match still on court - therefore reads
-- back in the app a fraction of a millisecond early. The planner places the next match at the
-- previous one's end *as it read it*: 11:15:06.310 for a match that ends at 11:15:06.310499. The
-- writers compare strictly in microseconds, so `place_ready_matches` answered `court_busy` (or
-- `player_busy`, which adds the rest gap) for a start half a millisecond before the court was free.
-- It is not a rounding slip in the solver: both sides were right in their own units. Any match
-- placed straight after one the reflow or a report had touched could be refused this way, and a
-- batch refused slot by slot is what let a make-up match be written without its prerequisites (Viet
-- Nam Open 2026, Men's Doubles; see docs/scheduling-decisions.md section 31).
--
-- The repo has met this once before and fixed it at the model's edge (`inProgressEnd` rounds to whole
-- milliseconds). This does the same at the database's edge, so every writer and every reader - the
-- placement RPCs, a hand-move, the reflow, `schedule_conflicts`, the Desk - sees one resolution:
--
--   * a BEFORE trigger on the four match tables truncates `scheduled_time`, `started_at` and
--     `ended_at` to whole milliseconds on insert and whenever one of them is written;
--   * truncation, not rounding, so a stored time is never later than the instant it was taken and a
--     result is never dated in the future;
--   * a one-off backfill makes the rows already stored agree. The desk-activity and result-history
--     triggers are switched off around it and back on after, in the same transaction: the backfill
--     changes no schedule and no result, and must not leave "time-shifted" or "result corrected"
--     rows in the log to say it did.
--
-- Nothing applied is edited.

CREATE OR REPLACE FUNCTION public.truncate_match_times_to_ms()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.scheduled_time := date_trunc('milliseconds', NEW.scheduled_time);
  NEW.started_at := date_trunc('milliseconds', NEW.started_at);
  NEW.ended_at := date_trunc('milliseconds', NEW.ended_at);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.truncate_match_times_to_ms() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pool_matches_whole_ms ON public.pool_matches;
CREATE TRIGGER pool_matches_whole_ms
BEFORE INSERT OR UPDATE OF scheduled_time, started_at, ended_at ON public.pool_matches
FOR EACH ROW EXECUTE FUNCTION public.truncate_match_times_to_ms();

DROP TRIGGER IF EXISTS draw_matches_whole_ms ON public.draw_matches;
CREATE TRIGGER draw_matches_whole_ms
BEFORE INSERT OR UPDATE OF scheduled_time, started_at, ended_at ON public.draw_matches
FOR EACH ROW EXECUTE FUNCTION public.truncate_match_times_to_ms();

DROP TRIGGER IF EXISTS placement_matches_whole_ms ON public.placement_matches;
CREATE TRIGGER placement_matches_whole_ms
BEFORE INSERT OR UPDATE OF scheduled_time, started_at, ended_at ON public.placement_matches
FOR EACH ROW EXECUTE FUNCTION public.truncate_match_times_to_ms();

DROP TRIGGER IF EXISTS tier_draw_matches_whole_ms ON public.tier_draw_matches;
CREATE TRIGGER tier_draw_matches_whole_ms
BEFORE INSERT OR UPDATE OF scheduled_time, started_at, ended_at ON public.tier_draw_matches
FOR EACH ROW EXECUTE FUNCTION public.truncate_match_times_to_ms();

-- Backfill. The logging triggers are disabled per table for the duration of its update only.
ALTER TABLE public.pool_matches DISABLE TRIGGER pool_matches_desk_activity;
ALTER TABLE public.pool_matches DISABLE TRIGGER record_pool_matches_result_correction;
UPDATE public.pool_matches
SET scheduled_time = date_trunc('milliseconds', scheduled_time),
    started_at = date_trunc('milliseconds', started_at),
    ended_at = date_trunc('milliseconds', ended_at)
WHERE scheduled_time <> date_trunc('milliseconds', scheduled_time)
   OR started_at <> date_trunc('milliseconds', started_at)
   OR ended_at <> date_trunc('milliseconds', ended_at);
ALTER TABLE public.pool_matches ENABLE TRIGGER pool_matches_desk_activity;
ALTER TABLE public.pool_matches ENABLE TRIGGER record_pool_matches_result_correction;

ALTER TABLE public.draw_matches DISABLE TRIGGER draw_matches_desk_activity;
ALTER TABLE public.draw_matches DISABLE TRIGGER record_draw_matches_result_correction;
UPDATE public.draw_matches
SET scheduled_time = date_trunc('milliseconds', scheduled_time),
    started_at = date_trunc('milliseconds', started_at),
    ended_at = date_trunc('milliseconds', ended_at)
WHERE scheduled_time <> date_trunc('milliseconds', scheduled_time)
   OR started_at <> date_trunc('milliseconds', started_at)
   OR ended_at <> date_trunc('milliseconds', ended_at);
ALTER TABLE public.draw_matches ENABLE TRIGGER draw_matches_desk_activity;
ALTER TABLE public.draw_matches ENABLE TRIGGER record_draw_matches_result_correction;

ALTER TABLE public.placement_matches DISABLE TRIGGER placement_matches_desk_activity;
ALTER TABLE public.placement_matches DISABLE TRIGGER record_placement_matches_result_correction;
UPDATE public.placement_matches
SET scheduled_time = date_trunc('milliseconds', scheduled_time),
    started_at = date_trunc('milliseconds', started_at),
    ended_at = date_trunc('milliseconds', ended_at)
WHERE scheduled_time <> date_trunc('milliseconds', scheduled_time)
   OR started_at <> date_trunc('milliseconds', started_at)
   OR ended_at <> date_trunc('milliseconds', ended_at);
ALTER TABLE public.placement_matches ENABLE TRIGGER placement_matches_desk_activity;
ALTER TABLE public.placement_matches ENABLE TRIGGER record_placement_matches_result_correction;

ALTER TABLE public.tier_draw_matches DISABLE TRIGGER tier_draw_matches_desk_activity;
ALTER TABLE public.tier_draw_matches DISABLE TRIGGER record_tier_draw_matches_result_correction;
UPDATE public.tier_draw_matches
SET scheduled_time = date_trunc('milliseconds', scheduled_time),
    started_at = date_trunc('milliseconds', started_at),
    ended_at = date_trunc('milliseconds', ended_at)
WHERE scheduled_time <> date_trunc('milliseconds', scheduled_time)
   OR started_at <> date_trunc('milliseconds', started_at)
   OR ended_at <> date_trunc('milliseconds', ended_at);
ALTER TABLE public.tier_draw_matches ENABLE TRIGGER tier_draw_matches_desk_activity;
ALTER TABLE public.tier_draw_matches ENABLE TRIGGER record_tier_draw_matches_result_correction;

DO $verify$
DECLARE
  v_table text;
  v_left bigint;
BEGIN
  IF to_regprocedure('public.truncate_match_times_to_ms()') IS NULL THEN
    RAISE EXCEPTION 'truncate_match_times_to_ms is missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.truncate_match_times_to_ms()', 'execute')
     OR has_function_privilege('anon', 'public.truncate_match_times_to_ms()', 'execute') THEN
    RAISE EXCEPTION 'truncate_match_times_to_ms is internal and must not be a client RPC';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['pool_matches', 'draw_matches', 'placement_matches', 'tier_draw_matches']
  LOOP
    -- The whole-millisecond trigger is present and on.
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = ('public.' || v_table)::regclass
        AND t.tgname = v_table || '_whole_ms'
        AND t.tgenabled = 'O'
    ) THEN
      RAISE EXCEPTION '% has no enabled whole-millisecond trigger', v_table;
    END IF;
    -- The two logging triggers switched off for the backfill are back on.
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = ('public.' || v_table)::regclass
        AND t.tgname = v_table || '_desk_activity' AND t.tgenabled = 'O'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = ('public.' || v_table)::regclass
        AND t.tgname = 'record_' || v_table || '_result_correction' AND t.tgenabled = 'O'
    ) THEN
      RAISE EXCEPTION '% lost a logging trigger across the backfill', v_table;
    END IF;
    -- And nothing is left finer than a millisecond.
    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE scheduled_time <> date_trunc(''milliseconds'', scheduled_time) '
      'OR started_at <> date_trunc(''milliseconds'', started_at) '
      'OR ended_at <> date_trunc(''milliseconds'', ended_at)', v_table)
    INTO v_left;
    IF v_left <> 0 THEN
      RAISE EXCEPTION '% still has % rows with a sub-millisecond time', v_table, v_left;
    END IF;
  END LOOP;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
