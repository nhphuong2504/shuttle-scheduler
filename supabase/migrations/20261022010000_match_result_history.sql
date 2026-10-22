-- Keeps the result a correction replaced.
--
-- WHAT WAS MISSING
--
-- Clearing a result is deliberate and loud: `reset_tier_draw_result` puts the match back to
-- `scheduled`, the bracket follows, and the desk sees it. Correcting a result - entering a
-- different score for a match already reported - was silent. The row was overwritten, the
-- old games were gone, and the only trace was that the schedule had reflowed again. If two
-- people typed a score that night, nobody could say which one was sent first or what it was.
--
-- WHY A TRIGGER RATHER THAN THE RPCs
--
-- The four report RPCs are long, and rewriting each body to add an insert would have added
-- four more places for the reset and reflow logic to drift from. A row-level trigger sees
-- every writer on the table - the RPCs, a service-role script, a hand-run SQL fix - and
-- records the same shape for all of them. It fires only when a *reported* result changes, so
-- the ordinary first report (scheduled -> reported) writes nothing: that is an entry, not a
-- correction.
--
-- READ IT
--
--           select * from public.match_result_history
--           where table_name = 'tier_draw_matches' and match_id = '<id>'
--           order by changed_at;
--
-- Editors of that tournament can read it; nobody can write it through the API, because the
-- trigger is the only writer. No screen reads it yet - recording the history was the gap, and
-- a correction-history surface is a separate design decision (see docs/cleanup-deferred.md).

create table public.match_result_history (
  id uuid primary key default gen_random_uuid(),
  table_name text not null
    check (table_name in ('pool_matches', 'draw_matches', 'placement_matches', 'tier_draw_matches')),
  match_id uuid not null,
  -- The result that was replaced.
  from_status text,
  from_games jsonb,
  from_score_a integer,
  from_score_b integer,
  from_winner_id uuid,
  from_ended_at timestamptz,
  -- The result that replaced it.
  to_games jsonb,
  to_score_a integer,
  to_score_b integer,
  to_winner_id uuid,
  to_ended_at timestamptz,
  -- No foreign key to profiles: a service-role fix has no profile, and losing the history
  -- because a person was deleted would be the wrong trade.
  changed_by uuid,
  changed_at timestamptz not null default statement_timestamp()
);

comment on table public.match_result_history is
  'One row per correction of an already-reported result. Written only by record_result_correction(); readable by that tournament''s editors.';

create index match_result_history_match_idx
  on public.match_result_history (table_name, match_id, changed_at desc);

/**
 * Records a reported result being replaced by another one.
 *
 * Generic across the four match tables: `to_jsonb(OLD)` means this can name only the columns
 * every table has, and the ones a table does not have read as NULL. That is the whole reason
 * it is one function rather than four.
 *
 * SECURITY DEFINER so the insert succeeds whatever the writer's privileges are; the trigger is
 * the only writer and no role is granted INSERT on the table.
 */
create or replace function public.record_result_correction()
returns trigger
language plpgsql
security definer
set search_path TO 'public'
as $$
DECLARE
  before_row jsonb := to_jsonb(OLD);
  after_row jsonb := to_jsonb(NEW);
BEGIN
  -- A first report, a clear, a start: not a correction of a result.
  IF before_row ->> 'status' IS DISTINCT FROM 'reported'
     OR after_row ->> 'status' IS DISTINCT FROM 'reported' THEN
    RETURN NEW;
  END IF;

  -- A touch that left the result alone (a note, a court move) is not a correction either.
  IF before_row -> 'games' IS NOT DISTINCT FROM after_row -> 'games'
     AND before_row -> 'score_a' IS NOT DISTINCT FROM after_row -> 'score_a'
     AND before_row -> 'score_b' IS NOT DISTINCT FROM after_row -> 'score_b'
     AND before_row -> 'winner_id' IS NOT DISTINCT FROM after_row -> 'winner_id'
     AND before_row -> 'ended_at' IS NOT DISTINCT FROM after_row -> 'ended_at' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.match_result_history (
    table_name, match_id,
    from_status, from_games, from_score_a, from_score_b, from_winner_id, from_ended_at,
    to_games, to_score_a, to_score_b, to_winner_id, to_ended_at,
    changed_by
  ) VALUES (
    TG_TABLE_NAME, NEW.id,
    before_row ->> 'status',
    before_row -> 'games',
    (before_row ->> 'score_a')::int,
    (before_row ->> 'score_b')::int,
    (before_row ->> 'winner_id')::uuid,
    (before_row ->> 'ended_at')::timestamptz,
    after_row -> 'games',
    (after_row ->> 'score_a')::int,
    (after_row ->> 'score_b')::int,
    (after_row ->> 'winner_id')::uuid,
    (after_row ->> 'ended_at')::timestamptz,
    public.current_profile_id()
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.record_result_correction() IS
  'AFTER UPDATE trigger: keeps the reported result a later report replaced, across all four match tables.';

REVOKE ALL ON FUNCTION public.record_result_correction() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS record_pool_matches_result_correction ON public.pool_matches;
CREATE TRIGGER record_pool_matches_result_correction
  AFTER UPDATE ON public.pool_matches
  FOR EACH ROW EXECUTE FUNCTION public.record_result_correction();

DROP TRIGGER IF EXISTS record_draw_matches_result_correction ON public.draw_matches;
CREATE TRIGGER record_draw_matches_result_correction
  AFTER UPDATE ON public.draw_matches
  FOR EACH ROW EXECUTE FUNCTION public.record_result_correction();

DROP TRIGGER IF EXISTS record_placement_matches_result_correction ON public.placement_matches;
CREATE TRIGGER record_placement_matches_result_correction
  AFTER UPDATE ON public.placement_matches
  FOR EACH ROW EXECUTE FUNCTION public.record_result_correction();

DROP TRIGGER IF EXISTS record_tier_draw_matches_result_correction ON public.tier_draw_matches;
CREATE TRIGGER record_tier_draw_matches_result_correction
  AFTER UPDATE ON public.tier_draw_matches
  FOR EACH ROW EXECUTE FUNCTION public.record_result_correction();

/**
 * The tournament a history row belongs to, for the policy below.
 *
 * A policy on the history table cannot join to the match table generically, so this resolves
 * the scope from `(table_name, match_id)`. SECURITY DEFINER because the caller may not be able
 * to read the match table itself; it returns nothing but the tournament id.
 */
create or replace function public.result_history_tournament(p_table text, p_match_id uuid)
returns uuid
language sql
stable
security definer
set search_path TO 'public'
as $$
  SELECT CASE p_table
    WHEN 'pool_matches' THEN (SELECT tournament_id FROM public.pool_matches WHERE id = p_match_id)
    WHEN 'draw_matches' THEN (SELECT tournament_id FROM public.draw_matches WHERE id = p_match_id)
    WHEN 'placement_matches' THEN (SELECT tournament_id FROM public.placement_matches WHERE id = p_match_id)
    WHEN 'tier_draw_matches' THEN (SELECT tournament_id FROM public.tier_draw_matches WHERE id = p_match_id)
  END;
$$;

REVOKE ALL ON FUNCTION public.result_history_tournament(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.result_history_tournament(text, uuid) TO authenticated;

ALTER TABLE public.match_result_history ENABLE ROW LEVEL SECURITY;

-- Read, if you may edit the tournament the match belongs to. No insert, update or delete
-- policy: the trigger is the only writer, and it does not go through RLS.
CREATE POLICY "match_result_history read by editors"
  ON public.match_result_history
  FOR SELECT
  TO authenticated
  USING (public.can_edit_tournament(public.result_history_tournament(table_name, match_id)));

-- Nothing but a read, and only for a signed-in editor. The default privileges Supabase
-- applies to a new public table hand anon SELECT as well, so `anon` is closed with ALL
-- rather than with the write verbs alone.
REVOKE ALL ON public.match_result_history FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.match_result_history FROM authenticated;
GRANT SELECT ON public.match_result_history TO authenticated;

DO $verify$
DECLARE
  missing text;
BEGIN
  -- Every table the four report RPCs write must be watched, or a correction on one of them
  -- disappears again and the table looks complete.
  FOR missing IN
    SELECT t.table_name
    FROM unnest(ARRAY['pool_matches', 'draw_matches', 'placement_matches', 'tier_draw_matches']) AS t(table_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_trigger g
      WHERE g.tgname = 'record_' || t.table_name || '_result_correction'
        AND NOT g.tgisinternal
    )
  LOOP
    RAISE EXCEPTION 'No correction trigger on %', missing;
  END LOOP;

  IF has_table_privilege('anon', 'public.match_result_history', 'select')
     OR has_table_privilege('authenticated', 'public.match_result_history', 'insert') THEN
    RAISE EXCEPTION 'The result history must be read-only through the API';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
