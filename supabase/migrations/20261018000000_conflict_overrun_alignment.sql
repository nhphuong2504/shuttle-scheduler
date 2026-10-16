-- ---------------------------------------------------------------------------
-- `schedule_conflicts`: flip the court-overlap chip when the court is Overrun,
-- not one whole minute earlier.
--
-- Written as a new migration rather than an edit because `20261009020000` is
-- already applied to staging and production.
--
-- THE MISMATCH
--
-- Two matches back to back on one court - m1 at 12:00, m2 at 12:10, a ten-minute
-- slot - must not be a conflict while m1 is still inside its slot. They are
-- back-to-back, not double-booked.
--
-- `20261009020000` read a still-running match as occupying its court until
-- `GREATEST(planned_end, now)`, so the pair overlapped from the first instant
-- `now` passed `12:10`, and the chip appeared at 12:10.
--
-- The desk calls the same match "Overrun" only once the whole minutes it has been
-- on court pass its slot (`desk.ts`, `deriveCourtState`):
--
--     elapsedMinutes = floor((now - started_at) / 60s)
--     overrun when elapsedMinutes > slot        ->   started_at + slot + 1 minute
--
-- so the badge flipped at 12:11. Same event, two clocks, one minute apart.
--
-- THE FIX
--
-- The court is not treated as carrying into the next match's time until the desk
-- would call the running match Overrun. `eff_court_end` is the new column, used
-- by the overlap pairing alone; it is `planned_end` until
-- `started_at + slot + 1 minute`, and `GREATEST(planned_end, now)` after it, which
-- is the old day-of value.
--
-- Only the overlap pairing reads it. `eff_end` is untouched, so `rest_shortfall`,
-- `past_closing` and `before_prerequisite` are unchanged: for those, "the match is
-- still on court" is the honest answer, and it is a different question from whether
-- the court has been held past its slot. A player cannot be rested before they have
-- actually come off, whatever the badge says.
--
-- What this does not change: two *published* matches that overlap remain a conflict
-- from the moment they are published, and an overlap against a `reported` match is
-- still measured from its `ended_at`. Only the still-running side moves, and only by
-- the minute between the slot end and Overrun.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.schedule_conflicts(p_tournament_id uuid)
RETURNS TABLE (
  match_table text,
  match_id uuid,
  court_id uuid,
  scheduled_time timestamptz,
  ended_at timestamptz,
  conflict_kind text,
  detail text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  RETURN QUERY
  WITH settings AS (
    SELECT t.venue_timezone AS tz
    FROM public.tournaments t
    WHERE t.id = p_tournament_id
  ),
  m AS (
    SELECT
      'pool_matches'::text AS mt,
      pm.id AS mid,
      pm.court_id AS cid,
      pm.scheduled_time AS sched,
      pm.started_at AS started,
      pm.ended_at AS ended,
      pm.status AS st,
      (pm.scheduled_time + make_interval(mins => t.group_slot_minutes)) AS planned_end,
      make_interval(mins => t.group_rest_gap_minutes) AS rest_gap,
      ARRAY[]::uuid[] AS prereqs
    FROM public.pool_matches pm
    JOIN public.tournaments t ON t.id = pm.tournament_id
    WHERE pm.tournament_id = p_tournament_id
      AND pm.status <> 'void'
      AND pm.court_id IS NOT NULL
      AND pm.scheduled_time IS NOT NULL
    UNION ALL
    SELECT
      'draw_matches',
      dm.id,
      dm.court_id,
      dm.scheduled_time,
      dm.started_at,
      dm.ended_at,
      dm.status,
      (dm.scheduled_time + make_interval(mins => t.knockout_slot_minutes)),
      make_interval(mins => t.knockout_rest_gap_minutes),
      ARRAY_REMOVE(ARRAY[dm.parent_a_id, dm.parent_b_id], NULL)
    FROM public.draw_matches dm
    JOIN public.tournaments t ON t.id = dm.tournament_id
    WHERE dm.tournament_id = p_tournament_id
      AND dm.status <> 'void'
      AND COALESCE(dm.is_bye, false) = false
      AND dm.court_id IS NOT NULL
      AND dm.scheduled_time IS NOT NULL
    UNION ALL
    SELECT
      'placement_matches',
      pmet.id,
      pmet.court_id,
      pmet.scheduled_time,
      pmet.started_at,
      pmet.ended_at,
      pmet.status,
      (pmet.scheduled_time + make_interval(mins => t.group_slot_minutes)),
      make_interval(mins => t.group_rest_gap_minutes),
      pmet.prerequisite_ids
    FROM public.placement_matches pmet
    JOIN public.tournaments t ON t.id = pmet.tournament_id
    WHERE pmet.tournament_id = p_tournament_id
      AND pmet.status <> 'void'
      AND pmet.court_id IS NOT NULL
      AND pmet.scheduled_time IS NOT NULL
    UNION ALL
    SELECT
      'tier_draw_matches',
      tdm.id,
      tdm.court_id,
      tdm.scheduled_time,
      tdm.started_at,
      tdm.ended_at,
      tdm.status,
      (tdm.scheduled_time + make_interval(mins => t.knockout_slot_minutes)),
      make_interval(mins => t.knockout_rest_gap_minutes),
      ARRAY_REMOVE(ARRAY[tdm.parent_a_id, tdm.parent_b_id], NULL)
    FROM public.tier_draw_matches tdm
    JOIN public.tournaments t ON t.id = tdm.tournament_id
    WHERE tdm.tournament_id = p_tournament_id
      AND tdm.status <> 'void'
      AND NOT tdm.is_bye
      AND tdm.court_id IS NOT NULL
      AND tdm.scheduled_time IS NOT NULL
  ),
  eff AS (
    SELECT
      m.*,
      COALESCE(m.started, m.sched) AS eff_start,
      CASE
        WHEN m.ended IS NOT NULL THEN m.ended
        WHEN m.st = 'in-progress' THEN GREATEST(m.planned_end, statement_timestamp())
        ELSE m.planned_end
      END AS eff_end,
      -- When the match gives the court up, which is what the overlap pairing reads.
      -- Deliberately not `eff_end` for a running match: the desk only calls a match
      -- Overrun once `floor((now - started_at) / minute) > slot`, i.e. at
      -- `started_at + slot + 1 minute`, and the chip has to flip with the badge.
      -- Until then the court is treated as free at its planned end, so a back-to-back
      -- successor is not reported while the match is still inside its slot.
      --
      -- `slot` is the planned span. Every branch above sets
      -- `planned_end = scheduled_time + <the slot the desk resolves for that kind>`
      -- (`group_slot_minutes` for pool and placement, `knockout_slot_minutes` for the
      -- two bracket tables), so `planned_end - sched` is that same slot and this cannot
      -- drift from what the desk measured.
      CASE
        WHEN m.ended IS NOT NULL THEN m.ended
        WHEN m.st = 'in-progress'
          AND statement_timestamp()
              >= COALESCE(m.started, m.sched) + (m.planned_end - m.sched) + interval '1 minute'
          THEN GREATEST(m.planned_end, statement_timestamp())
        ELSE m.planned_end
      END AS eff_court_end,
      public.tournament_day_at(p_tournament_id, m.sched) AS day_id,
      -- The one predicate every actionable conflict shares: only a match the desk
      -- can still move is worth reporting. Named so the intent is checkable.
      (m.st = 'scheduled') AS is_scheduled
    FROM m
  ),
  players AS (
    SELECT 'pool_matches'::text AS mt, pm.id AS mid, player.player_id AS pid
    FROM public.pool_matches pm
    JOIN public.teams team ON team.id IN (pm.team_a_id, pm.team_b_id)
    CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
    WHERE pm.tournament_id = p_tournament_id AND player.player_id IS NOT NULL
    UNION ALL
    SELECT 'draw_matches', dm.id, player.player_id
    FROM public.draw_matches dm
    JOIN public.teams team ON team.id IN (dm.team_a_id, dm.team_b_id)
    CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
    WHERE dm.tournament_id = p_tournament_id AND player.player_id IS NOT NULL
    UNION ALL
    SELECT 'placement_matches', pmet.id, player.player_id
    FROM public.placement_matches pmet
    JOIN public.placement_entrants entrant ON entrant.id IN (pmet.entrant_a_id, pmet.entrant_b_id)
    JOIN public.teams team ON team.id = entrant.team_id
    CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
    WHERE pmet.tournament_id = p_tournament_id AND player.player_id IS NOT NULL
    UNION ALL
    SELECT 'tier_draw_matches', tdm.id, player.player_id
    FROM public.tier_draw_matches tdm
    JOIN public.placement_entrants entrant ON entrant.id IN (tdm.entrant_a_id, tdm.entrant_b_id)
    JOIN public.teams team ON team.id = entrant.team_id
    CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
    WHERE tdm.tournament_id = p_tournament_id AND player.player_id IS NOT NULL
  ),
  rest_seq AS (
    SELECT
      p.pid,
      e.mt,
      e.mid,
      e.cid,
      e.sched,
      e.ended,
      e.eff_start,
      e.rest_gap,
      e.is_scheduled,
      lag(e.eff_end) OVER (PARTITION BY p.pid ORDER BY e.eff_start, e.mid) AS prev_end
    FROM players p
    JOIN eff e ON e.mt = p.mt AND e.mid = p.mid
  ),
  -- Each overlapping court pair once, both sides carried, so a conflict can be
  -- reported against whichever side (or sides) is still scheduled. The ordering
  -- tuple means no pair is produced twice.
  --
  -- `eff_court_end` rather than `eff_end`: the running match's span only reaches its
  -- successor once Overrun. See the column's comment in `eff`.
  overlap_pairs AS (
    SELECT
      a.mt AS a_mt, a.mid AS a_mid, a.cid AS a_cid, a.sched AS a_sched, a.ended AS a_ended,
      a.is_scheduled AS a_scheduled,
      b.mt AS b_mt, b.mid AS b_mid, b.cid AS b_cid, b.sched AS b_sched, b.ended AS b_ended,
      b.is_scheduled AS b_scheduled
    FROM eff a
    JOIN eff b
      ON a.cid = b.cid
     AND (a.mt, a.mid::text) < (b.mt, b.mid::text)
     AND a.eff_start < b.eff_court_end
     AND b.eff_start < a.eff_court_end
  ),
  conflicts AS (
    SELECT
      p.a_mt AS mt, p.a_mid AS mid, p.a_cid AS cid, p.a_sched AS sched, p.a_ended AS ended,
      'court_overlap'::text AS kind,
      format('Overlaps another match on the same court (%s)', left(p.b_mid::text, 8)) AS detail
    FROM overlap_pairs p
    WHERE p.a_scheduled

    UNION ALL

    SELECT
      p.b_mt, p.b_mid, p.b_cid, p.b_sched, p.b_ended,
      'court_overlap'::text,
      format('Overlaps another match on the same court (%s)', left(p.a_mid::text, 8))
    FROM overlap_pairs p
    WHERE p.b_scheduled

    UNION ALL

    SELECT
      r.mt, r.mid, r.cid, r.sched, r.ended,
      'rest_shortfall'::text,
      format('Only %s of the required rest', to_char(r.eff_start - r.prev_end, 'FMHH24:MI'))
    FROM rest_seq r
    WHERE r.is_scheduled
      AND r.prev_end IS NOT NULL
      AND r.eff_start < r.prev_end + r.rest_gap

    UNION ALL

    SELECT
      e.mt, e.mid, e.cid, e.sched, e.ended,
      'break'::text,
      format('Overlaps the %s break on %s', COALESCE(br.label, 'scheduled'), d.date)
    FROM eff e
    JOIN settings s ON true
    JOIN public.tournament_days d ON d.id = e.day_id
    JOIN public.tournament_day_breaks br ON br.day_id = d.id
    WHERE e.is_scheduled
      AND e.sched < ((d.date + br.end_time) AT TIME ZONE s.tz)
      AND e.planned_end > ((d.date + br.start_time) AT TIME ZONE s.tz)

    UNION ALL

    SELECT
      e.mt, e.mid, e.cid, e.sched, e.ended,
      'past_closing'::text,
      format('Finishes after the %s close on %s', to_char(d.end_time, 'HH24:MI'), d.date)
    FROM eff e
    JOIN settings s ON true
    JOIN public.tournament_days d ON d.id = e.day_id
    WHERE e.st IN ('scheduled', 'in-progress')
      AND e.eff_end > ((d.date + d.end_time) AT TIME ZONE s.tz)

    UNION ALL

    SELECT
      e.mt, e.mid, e.cid, e.sched, e.ended,
      'before_prerequisite'::text,
      format('Starts before the match it waits on (%s) has finished', left(pre.mid::text, 8))
    FROM eff e
    JOIN eff pre ON pre.mid = ANY(e.prereqs)
    WHERE e.is_scheduled
      AND e.eff_start < pre.eff_end
  )
  SELECT
    c.mt AS match_table,
    c.mid AS match_id,
    (array_agg(c.cid))[1] AS court_id,
    (array_agg(c.sched))[1] AS scheduled_time,
    (array_agg(c.ended))[1] AS ended_at,
    c.kind AS conflict_kind,
    min(c.detail) AS detail
  FROM conflicts c
  GROUP BY c.mt, c.mid, c.kind
  ORDER BY c.mt, c.mid, c.kind;
END;
$$;

-- CREATE OR REPLACE keeps the OID and therefore the existing ACL, but the revoke is
-- re-asserted rather than assumed, so a fresh database that ran this without the
-- hardening migration still ends up with the same grant.
REVOKE ALL ON FUNCTION public.schedule_conflicts(uuid)
  FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.schedule_conflicts(uuid) TO authenticated;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'schedule_conflicts'
      AND p.prosrc LIKE '%can_edit_tournament%'
  ) THEN
    RAISE EXCEPTION 'M4: schedule_conflicts must be guarded on can_edit_tournament';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'schedule_conflicts'
      AND p.prosrc LIKE '%court_overlap%'
      AND p.prosrc LIKE '%rest_shortfall%'
      AND p.prosrc LIKE '%past_closing%'
      AND p.prosrc LIKE '%before_prerequisite%'
  ) THEN
    RAISE EXCEPTION 'M4: schedule_conflicts is missing a conflict kind';
  END IF;

  -- The retired kind. It reported a merely-late match, which is the desk's own
  -- overdue alert rather than a contradiction between two rows, and it must not
  -- come back through a later edit.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'schedule_conflicts'
      AND p.prosrc LIKE '%overdue%'
  ) THEN
    RAISE EXCEPTION 'M4: schedule_conflicts still reports the retired lateness kind';
  END IF;

  -- Every actionable kind keys on a still-scheduled match, including the per-side
  -- court overlap. Without this the function flags history the desk cannot fix.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'schedule_conflicts'
      AND p.prosrc LIKE '%is_scheduled%'
      AND p.prosrc LIKE '%a_scheduled%'
      AND p.prosrc LIKE '%b_scheduled%'
  ) THEN
    RAISE EXCEPTION 'M4: schedule_conflicts does not restrict itself to still-scheduled matches';
  END IF;

  -- The Overrun alignment, and the proof that the pairing reads the gated column
  -- rather than the day-of `eff_end`. Without both, a later edit could reinstate the
  -- one-minute-early chip and every other assertion here would still pass.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'schedule_conflicts'
      AND p.prosrc LIKE '%eff_court_end%'
      AND p.prosrc LIKE '%interval ''1 minute''%'
      AND p.prosrc LIKE '%a.eff_start < b.eff_court_end%'
      AND p.prosrc LIKE '%b.eff_start < a.eff_court_end%'
  ) THEN
    RAISE EXCEPTION
      'M4: schedule_conflicts does not gate the court overlap on the Overrun boundary';
  END IF;

  IF has_function_privilege('anon', 'public.schedule_conflicts(uuid)', 'execute') THEN
    RAISE EXCEPTION 'M4: schedule_conflicts must not be callable by anon';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
