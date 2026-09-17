# Generates 20260917030000_placement_live_schedule_shift.sql.
#
# The live-shift function is a working 350-line reflow algorithm, and the change
# needed here is purely additive: two more tables in the union, two more player
# inserts, two more write-backs, one wider guard. Re-typing that body by hand to
# add four branches would put the legacy round-robin path at risk for no reason,
# and there is no local database to test against. So the original function is
# copied byte-for-byte out of its migration and the new branches are spliced in
# at exact anchors. Every anchor is asserted to occur exactly once, so a future
# edit to the source migration fails this script loudly instead of silently
# splicing into the wrong place.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'supabase/migrations/20260915000000_tournament_scoping.sql'
$target = Join-Path $root 'supabase/migrations/20260917030000_placement_live_schedule_shift.sql'

$src = [System.IO.File]::ReadAllText($source)
$nl = if ($src.Contains("`r`n")) { "`r`n" } else { "`n" }
Write-Host "source line ending: $(if ($nl -eq "`r`n") { 'CRLF' } else { 'LF' })"

# --- Extract the function verbatim -----------------------------------------
$fnStart = $src.IndexOf('CREATE OR REPLACE FUNCTION public.shift_live_schedule_after_match(')
$fnEnd = $src.IndexOf('REVOKE ALL ON FUNCTION public.shift_live_schedule_after_match')
if ($fnStart -lt 0 -or $fnEnd -lt 0 -or $fnEnd -le $fnStart) { throw 'could not locate the shift function' }
$fn = $src.Substring($fnStart, $fnEnd - $fnStart).TrimEnd("`r", "`n") + $nl

function Splice {
  param([string]$Text, [string]$Old, [string]$New, [string]$Name)
  $first = $Text.IndexOf($Old)
  if ($first -lt 0) { throw "anchor not found: $Name" }
  if ($Text.IndexOf($Old, $first + 1) -ge 0) { throw "anchor not unique: $Name" }
  Write-Host "spliced: $Name"
  return $Text.Substring(0, $first) + $New + $Text.Substring($first + $Old.Length)
}

function Lines {
  param([string[]]$Block)
  return ($Block -join $nl)
}

# --- 1. The guard -----------------------------------------------------------
$fn = Splice $fn `
  "IF p_table NOT IN ('pool_matches', 'draw_matches') THEN" `
  "IF p_table NOT IN ('pool_matches', 'draw_matches', 'placement_matches', 'tier_draw_matches') THEN" `
  'table guard'

# --- 2. The source row ------------------------------------------------------
# The original had a two-way `IF ... ELSE`. Without this the ELSE branch would
# look a placement match up in `draw_matches`, find nothing, and return early
# with `source_court IS NULL` -- the reflow would silently do nothing at all,
# which is the worst possible failure mode for this function.
$sourceAnchor = Lines @(
  '  ELSE',
  '    SELECT court_id, scheduled_time, ended_at, tournament_id',
  '    INTO source_court, source_time, source_end, source_tournament',
  '    FROM public.draw_matches',
  '    WHERE id = p_match_id',
  "      AND status IN ('reported', 'walkover');",
  '  END IF;'
)
$sourceBlock = Lines @(
  "  ELSIF p_table = 'draw_matches' THEN",
  '    SELECT court_id, scheduled_time, ended_at, tournament_id',
  '    INTO source_court, source_time, source_end, source_tournament',
  '    FROM public.draw_matches',
  '    WHERE id = p_match_id',
  "      AND status IN ('reported', 'walkover');",
  "  ELSIF p_table = 'placement_matches' THEN",
  '    SELECT court_id, scheduled_time, ended_at, tournament_id',
  '    INTO source_court, source_time, source_end, source_tournament',
  '    FROM public.placement_matches',
  '    WHERE id = p_match_id',
  "      AND status IN ('reported', 'walkover');",
  '  ELSE',
  '    SELECT court_id, scheduled_time, ended_at, tournament_id',
  '    INTO source_court, source_time, source_end, source_tournament',
  '    FROM public.tier_draw_matches',
  '    WHERE id = p_match_id',
  "      AND status IN ('reported', 'walkover');",
  '  END IF;'
)
$fn = Splice $fn $sourceAnchor $sourceBlock 'source row lookup'

# --- 3. The work insert ----------------------------------------------------
$workBranch = Lines @(
  '',
  '  -- The two-round placement format''s tables. For the columns this function',
  '  -- reads they are structurally identical to the legacy pair: court, time,',
  '  -- actual start and end, status. Only the entrant columns differ, and this',
  '  -- function never touches those. A tournament has exactly one format, so on any',
  '  -- given call exactly one pair of branches contributes rows and the other pair',
  '  -- matches nothing -- which is what keeps this change additive rather than a',
  '  -- behaviour change for the round-robin path.',
  '  UNION ALL',
  '  SELECT',
  "    'placement_matches',",
  '    pmet.id,',
  '    pmet.court_id,',
  '    pmet.scheduled_time,',
  '    pmet.scheduled_time,',
  '    pmet.started_at,',
  '    pmet.ended_at,',
  '    make_interval(mins => settings.group_slot_minutes),',
  '    make_interval(mins => settings.group_rest_gap_minutes),',
  '    pmet.status,',
  "    pmet.status = 'scheduled'",
  '  FROM public.placement_matches pmet',
  '  JOIN public.tournaments settings ON settings.id = pmet.tournament_id',
  '  WHERE pmet.tournament_id = source_tournament',
  '    AND pmet.court_id IS NOT NULL',
  '    AND pmet.scheduled_time IS NOT NULL',
  "    AND pmet.status <> 'void'",
  '  UNION ALL',
  '  SELECT',
  "    'tier_draw_matches',",
  '    tdm.id,',
  '    tdm.court_id,',
  '    tdm.scheduled_time,',
  '    tdm.scheduled_time,',
  '    tdm.started_at,',
  '    tdm.ended_at,',
  '    make_interval(mins => settings.knockout_slot_minutes),',
  '    make_interval(mins => settings.knockout_rest_gap_minutes),',
  '    tdm.status,',
  "    tdm.status = 'scheduled'",
  '  FROM public.tier_draw_matches tdm',
  '  JOIN public.tournaments settings ON settings.id = tdm.tournament_id',
  '  WHERE tdm.tournament_id = source_tournament',
  '    AND tdm.court_id IS NOT NULL',
  '    AND tdm.scheduled_time IS NOT NULL',
  "    AND tdm.status <> 'void'",
  '    AND NOT tdm.is_bye;'
)
$fn = Splice $fn `
  'AND COALESCE(dm.is_bye, false) = false;' `
  ('AND COALESCE(dm.is_bye, false) = false' + $nl + $workBranch) `
  'work insert branches'

# --- 4. The player lookup --------------------------------------------------
$playerAnchor = Lines @(
  'ON team.id IN (dm.team_a_id, dm.team_b_id)',
  '  CROSS JOIN LATERAL (',
  '    VALUES (team.player_1_id), (team.player_2_id)',
  '  ) player(player_id)',
  '  WHERE player.player_id IS NOT NULL',
  '  ON CONFLICT DO NOTHING;'
)
$playerBlock = Lines @(
  '',
  '',
  '  -- This is the one place the new tables are not structurally identical to the',
  '  -- legacy ones. A placement match carries entrant ids, and an entrant is what',
  '  -- points at a team, so resolving players needs one more hop. The rest-gap',
  '  -- reflow is driven entirely by this table: get it wrong and the function would',
  '  -- happily move a player''s next match into their rest window.',
  '  INSERT INTO live_match_players',
  "  SELECT 'placement_matches', pmet.id, player.player_id",
  '  FROM public.placement_matches pmet',
  '  JOIN live_schedule_work work',
  "    ON work.match_table = 'placement_matches' AND work.match_id = pmet.id",
  '  JOIN public.placement_entrants entrant',
  '    ON entrant.id IN (pmet.entrant_a_id, pmet.entrant_b_id)',
  '  JOIN public.teams team',
  '    ON team.id = entrant.team_id',
  '  CROSS JOIN LATERAL (',
  '    VALUES (team.player_1_id), (team.player_2_id)',
  '  ) player(player_id)',
  '  WHERE player.player_id IS NOT NULL',
  '  ON CONFLICT DO NOTHING;',
  '',
  '  INSERT INTO live_match_players',
  "  SELECT 'tier_draw_matches', tdm.id, player.player_id",
  '  FROM public.tier_draw_matches tdm',
  '  JOIN live_schedule_work work',
  "    ON work.match_table = 'tier_draw_matches' AND work.match_id = tdm.id",
  '  JOIN public.placement_entrants entrant',
  '    ON entrant.id IN (tdm.entrant_a_id, tdm.entrant_b_id)',
  '  JOIN public.teams team',
  '    ON team.id = entrant.team_id',
  '  CROSS JOIN LATERAL (',
  '    VALUES (team.player_1_id), (team.player_2_id)',
  '  ) player(player_id)',
  '  WHERE player.player_id IS NOT NULL',
  '  ON CONFLICT DO NOTHING;'
)
$fn = Splice $fn $playerAnchor ($playerAnchor + $playerBlock) 'player lookup inserts'

# --- 5. The write-back -----------------------------------------------------
$writeAnchor = "AND dm.status = 'scheduled';"
$writeBlock = Lines @(
  '',
  '',
  '  UPDATE public.placement_matches pmet',
  '  SET scheduled_time = work.shifted_time',
  '  FROM live_schedule_work work',
  "  WHERE work.match_table = 'placement_matches'",
  '    AND work.match_id = pmet.id',
  '    AND work.dirty',
  "    AND pmet.status = 'scheduled';",
  '',
  '  UPDATE public.tier_draw_matches tdm',
  '  SET scheduled_time = work.shifted_time',
  '  FROM live_schedule_work work',
  "  WHERE work.match_table = 'tier_draw_matches'",
  '    AND work.match_id = tdm.id',
  '    AND work.dirty',
  "    AND tdm.status = 'scheduled';"
)
$fn = Splice $fn $writeAnchor ($writeAnchor + $writeBlock) 'write-back updates'

# --- 6. The report RPCs now trigger the shift ------------------------------
$reports = @'
-------------------------------------------------------------------------------
-- 2. Reporting a result now reflows the rest of the day
-------------------------------------------------------------------------------

-- Both report functions are redefined for one reason: to call the shift that
-- section 1 taught about the placement tables. Everything else about them is
-- unchanged, including their signatures, so this is a replace and not a new
-- overload.
--
-- Only the reporting path reflows, not `start_placement_match`. Live reflow is
-- about recovery: a match that finishes late pushes the rest of its court, and
-- that is a consequence of a *result*. Marking a match in progress is a statement
-- about what is happening, not an event that reschedules anything.

CREATE OR REPLACE FUNCTION public.report_placement_result(
  p_match_id uuid,
  p_games jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_side text;
  v_winner uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT tournament_id INTO v_tournament
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT public.placement_check_games(
    p_games, t.placement_games_to, t.placement_win_by, t.placement_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  SELECT CASE WHEN v_side = 'a' THEN entrant_a_id ELSE entrant_b_id END INTO v_winner
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_winner IS NULL THEN
    RAISE EXCEPTION 'That side has no entrant assigned yet';
  END IF;

  UPDATE public.placement_matches
  SET games = p_games,
      winner_id = v_winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;

  PERFORM public.shift_live_schedule_after_match('placement_matches', p_match_id);
END;
$$;

REVOKE ALL ON FUNCTION public.report_placement_result(uuid, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_placement_result(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.report_tier_draw_result(
  p_match_id uuid,
  p_games jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_draw uuid;
  v_side text;
  v_winner uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT tournament_id, draw_id INTO v_tournament, v_draw
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT public.placement_check_games(
    p_games, t.knockout_games_to, t.knockout_win_by, t.knockout_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  SELECT CASE WHEN v_side = 'a' THEN entrant_a_id ELSE entrant_b_id END INTO v_winner
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_winner IS NULL THEN
    RAISE EXCEPTION 'That side has no entrant assigned yet';
  END IF;

  UPDATE public.tier_draw_matches
  SET games = p_games,
      winner_id = v_winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;

  -- Advance first, then reflow. Advancing may create a match that is now ready to
  -- play, and reflowing before it existed would leave that match out of the
  -- ordering it just joined.
  PERFORM public.advance_tier_draw_locked(v_draw);
  PERFORM public.shift_live_schedule_after_match('tier_draw_matches', p_match_id);
END;
$$;

REVOKE ALL ON FUNCTION public.report_tier_draw_result(uuid, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_tier_draw_result(uuid, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
'@
$reports = $reports.Replace("`r`n", "`n").Replace("`n", $nl)

$header = @'
-- ---------------------------------------------------------------------------
-- Live schedule reflow for the two-round placement format.
--
-- Two things happen here, and the first is the reason the second exists.
--
-- 1. `shift_live_schedule_after_match` learns about `placement_matches` and
--    `tier_draw_matches`.
--
--    Until now, reporting a placement result moved nothing. Every other match on
--    that court stayed at its planned time, so a placement round that ran 20
--    minutes long silently ate the gap before the next match, and the desk only
--    found out when the day ended late. The round-robin path has reflowed since
--    `20260910120000_live_schedule_time_shift.sql`; this closes the same gap for
--    the format that replaced it.
--
--    The change is deliberately additive. The function is ~350 lines of reflow
--    algorithm -- court sequencing, player rest windows, immutable windows,
--    cross-court propagation -- and none of it is format-specific. Rewriting it
--    would have put a working, load-bearing path at risk to add two tables to a
--    `UNION ALL`. So the body is unchanged: five additions at five anchors (a
--    wider table guard, a fourth arm on the source-row lookup, two union branches,
--    two player-lookup inserts, two write-backs) and not one edit to the logic
--    between them. `scripts/verify-placement-shift-migration.ps1` proves that, by
--    requiring every line of the original function to appear in this one, in
--    order, with only the three deliberate one-line rewrites standing in for it.
--
--    The source-row lookup is the addition worth not missing. It was a two-way
--    `IF ... ELSE`, so without a fourth arm a placement match would have been
--    looked up in `draw_matches`, found nothing, and returned early on
--    `source_court IS NULL` -- the reflow would have silently done nothing at all,
--    which is the worst available failure mode.
--
--    Why that is safe rather than merely cautious: every branch is scoped to
--    `source_tournament`, and a tournament has exactly one format. For a
--    round-robin tournament the two new branches match zero rows, and for a
--    placement tournament the two legacy branches do. The two sets of tables can
--    never both contribute to one reflow, so neither format can perturb the other.
--
-- 2. `report_placement_result` and `report_tier_draw_result` call it.
--
--    Without this the first change would be dead code. Note the ordering in the
--    knockout case: advance the bracket first, then reflow, because advancing can
--    create a match that is now ready to play and a reflow that ran first would
--    not know about it.
--
-- Not covered: `start_placement_match`. Marking a match in progress is a
-- statement about the present, not an event that reschedules the day; the legacy
-- path draws the same line.
-- ---------------------------------------------------------------------------

'@
$header = $header.Replace("`r`n", "`n").Replace("`n", $nl)

$output = $header + $fn + $nl + $reports
[System.IO.File]::WriteAllText($target, $output)
Write-Host "wrote $target ($((Get-Item $target).Length) bytes)"
