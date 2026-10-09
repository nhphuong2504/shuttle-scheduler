-- ---------------------------------------------------------------------------
-- `schedule_conflicts`: the conflicts in a tournament's schedule, computed rather
-- than stored.
--
-- The desk needs to know when a live schedule has become impossible to honour:
-- two matches on one court, a player back on court too soon, a match asleep inside
-- a break, a day running past its closing time, a match ordered before the match it
-- waits on, or a still-scheduled match whose time has already passed. None of these
-- is a flag that gets written and then has to be un-written when the desk fixes it.
-- They are all derivable from the rows themselves, in one place, so the answer the
-- organiser sees and the answer the moderator sees are the same answer.
--
-- This is deliberately a *read*. `20261009010000` makes the live reflow refuse to
-- write a schedule it cannot make safe; this is how the resulting conflict is then
-- shown instead of being silently swallowed. The two share the same definition of
-- "safe" - same day, outside breaks, before closing time, enough rest, after every
-- prerequisite - but they compute it over different schedules: the reflow over the
-- cascade it is about to write, this over the rows that exist.
--
-- Authorization: an editor-only read, guarded like `tournament_readiness` rather
-- than granted to every signed-in caller. A viewer has no business reconstructing
-- the running order from its conflicts.
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
      public.tournament_day_at(p_tournament_id, m.sched) AS day_id
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
      lag(e.eff_end) OVER (PARTITION BY p.pid ORDER BY e.eff_start, e.mid) AS prev_end
    FROM players p
    JOIN eff e ON e.mt = p.mt AND e.mid = p.mid
  ),
  conflicts AS (
    SELECT
      e.mt, e.mid, e.cid, e.sched, e.ended,
      'overdue'::text AS kind,
      'Scheduled time has already passed'::text AS detail
    FROM eff e
    WHERE e.st = 'scheduled' AND e.sched < statement_timestamp()

    UNION ALL

    SELECT
      a.mt, a.mid, a.cid, a.sched, a.ended,
      'court_overlap'::text,
      format('Overlaps another match on the same court (%s)', left(b.mid::text, 8))
    FROM eff a
    JOIN eff b
      ON a.cid = b.cid
     AND (a.mt, a.mid::text) < (b.mt, b.mid::text)
     AND a.eff_start < b.eff_end
     AND b.eff_start < a.eff_end

    UNION ALL

    SELECT
      r.mt, r.mid, r.cid, r.sched, r.ended,
      'rest_shortfall'::text,
      format('Only %s of the required rest', to_char(r.eff_start - r.prev_end, 'FMHH24:MI'))
    FROM rest_seq r
    WHERE r.prev_end IS NOT NULL
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
    WHERE e.st = 'scheduled'
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
    WHERE e.eff_start < pre.eff_end
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

  IF has_function_privilege('anon', 'public.schedule_conflicts(uuid)', 'execute') THEN
    RAISE EXCEPTION 'M4: schedule_conflicts must not be callable by anon';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
