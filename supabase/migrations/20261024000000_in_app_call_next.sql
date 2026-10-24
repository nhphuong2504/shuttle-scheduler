-- Durable in-app calls. No contact data or client-selected recipients.
CREATE TABLE public.match_calls (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  match_kind text NOT NULL CHECK (match_kind IN ('pool', 'draw', 'placement', 'tier')),
  match_id uuid NOT NULL,
  court_id uuid NOT NULL REFERENCES public.courts(id) ON DELETE CASCADE,
  scheduled_time timestamptz,
  player_ids uuid[] NOT NULL,
  actor_profile_id uuid NOT NULL REFERENCES public.profiles(id),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_calls_match ON public.match_calls(tournament_id, match_id, created_at DESC);
CREATE TABLE public.player_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES public.match_calls(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  read_at timestamptz,
  UNIQUE (call_id, profile_id)
);
CREATE INDEX player_notifications_recipient ON public.player_notifications(profile_id, call_id);
ALTER TABLE public.match_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.match_calls, public.player_notifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.match_calls, public.player_notifications TO service_role;

-- Private adapter keeps the four match engines behind the same checks.
CREATE FUNCTION public.call_next_matches(p_tournament_id uuid)
RETURNS TABLE(kind text, id uuid, court_id uuid, scheduled_time timestamptz, status text, sides uuid[], player_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
SELECT 'pool'::text, m.id, m.court_id, m.scheduled_time, m.status,
  ARRAY[m.team_a_id, m.team_b_id], ARRAY(SELECT DISTINCT v.player_id FROM public.pool_matches x
    JOIN public.teams t ON t.id IN (x.team_a_id, x.team_b_id)
    CROSS JOIN LATERAL (VALUES (t.player_1_id), (t.player_2_id)) v(player_id)
    WHERE x.id = m.id AND v.player_id IS NOT NULL ORDER BY v.player_id)
FROM public.pool_matches m WHERE m.tournament_id = p_tournament_id
UNION ALL
SELECT 'draw'::text, m.id, m.court_id, m.scheduled_time, m.status,
  ARRAY[m.team_a_id, m.team_b_id], ARRAY(SELECT DISTINCT v.player_id FROM public.draw_matches x
    JOIN public.teams t ON t.id IN (x.team_a_id, x.team_b_id)
    CROSS JOIN LATERAL (VALUES (t.player_1_id), (t.player_2_id)) v(player_id)
    WHERE x.id = m.id AND v.player_id IS NOT NULL ORDER BY v.player_id)
FROM public.draw_matches m WHERE m.tournament_id = p_tournament_id
UNION ALL
SELECT 'placement'::text, m.id, m.court_id, m.scheduled_time, m.status,
  ARRAY[m.entrant_a_id, m.entrant_b_id], ARRAY(SELECT DISTINCT v.player_id FROM public.placement_matches x
    JOIN public.placement_entrants e ON e.id IN (x.entrant_a_id, x.entrant_b_id) JOIN public.teams t ON t.id = e.team_id
    CROSS JOIN LATERAL (VALUES (t.player_1_id), (t.player_2_id)) v(player_id)
    WHERE x.id = m.id AND v.player_id IS NOT NULL ORDER BY v.player_id)
FROM public.placement_matches m WHERE m.tournament_id = p_tournament_id
UNION ALL
SELECT 'tier'::text, m.id, m.court_id, m.scheduled_time, m.status,
  ARRAY[m.entrant_a_id, m.entrant_b_id], ARRAY(SELECT DISTINCT v.player_id FROM public.tier_draw_matches x
    JOIN public.placement_entrants e ON e.id IN (x.entrant_a_id, x.entrant_b_id) JOIN public.teams t ON t.id = e.team_id
    CROSS JOIN LATERAL (VALUES (t.player_1_id), (t.player_2_id)) v(player_id)
    WHERE x.id = m.id AND v.player_id IS NOT NULL ORDER BY v.player_id)
FROM public.tier_draw_matches m WHERE m.tournament_id = p_tournament_id;
$$;
REVOKE ALL ON FUNCTION public.call_next_matches(uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.desk_call_state(p_tournament_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN jsonb_build_object(
    'players', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'inApp', p.profile_id IS NOT NULL))
      FROM public.players p WHERE EXISTS (SELECT 1 FROM public.teams t
      WHERE t.tournament_id = p_tournament_id AND p.id IN (t.player_1_id, t.player_2_id))), '[]'::jsonb),
    'records', COALESCE((SELECT jsonb_agg(jsonb_build_object('matchId', q.match_id, 'sentAt', q.sent_at))
      FROM (SELECT match_id, max(created_at) sent_at FROM public.match_calls
      WHERE tournament_id = p_tournament_id GROUP BY match_id) q), '[]'::jsonb));
END;
$$;

CREATE FUNCTION public.send_match_call(p_request_id uuid, p_tournament_id uuid, p_kind text,
  p_match_id uuid, p_court_id uuid, p_scheduled_time timestamptz, p_player_ids uuid[], p_message text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_match record;
  v_previous public.match_calls;
  v_count integer;
  v_table text;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  PERFORM public.lock_tournament_lifecycle_shared(p_tournament_id);
  PERFORM public.assert_tournament_live(p_tournament_id);
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  -- Same request after a lost response returns the committed outcome.
  SELECT * INTO v_previous FROM public.match_calls WHERE id = p_request_id;
  IF FOUND THEN
    IF v_previous.tournament_id <> p_tournament_id OR v_previous.match_kind <> p_kind
       OR v_previous.match_id <> p_match_id OR v_previous.court_id <> p_court_id
       OR v_previous.message <> trim(p_message) OR v_previous.actor_profile_id <> public.current_profile_id() THEN
      RAISE EXCEPTION 'Request already used';
    END IF;
    RETURN jsonb_build_object('count', (SELECT count(*) FROM public.player_notifications WHERE call_id = p_request_id),
      'sentAt', v_previous.created_at);
  END IF;
  IF p_message IS NULL OR length(trim(p_message)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Message must contain 1 to 500 characters';
  END IF;
  v_table := CASE p_kind WHEN 'pool' THEN 'pool_matches' WHEN 'draw' THEN 'draw_matches'
    WHEN 'placement' THEN 'placement_matches' WHEN 'tier' THEN 'tier_draw_matches' END;
  IF v_table IS NULL THEN RAISE EXCEPTION 'Unknown match kind'; END IF;
  EXECUTE format('SELECT id FROM public.%I WHERE id = $1 FOR UPDATE', v_table) USING p_match_id;
  SELECT * INTO v_match FROM public.call_next_matches(p_tournament_id) WHERE kind = p_kind AND id = p_match_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Match no longer available'; END IF;
  IF v_match.status <> 'scheduled' OR v_match.court_id IS NULL
     OR v_match.court_id IS DISTINCT FROM p_court_id
     OR v_match.scheduled_time IS DISTINCT FROM p_scheduled_time
     OR array_position(v_match.sides, NULL) IS NOT NULL
     OR v_match.player_ids IS DISTINCT FROM (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_player_ids) x)
     OR cardinality(v_match.player_ids) = 0 THEN
    RAISE EXCEPTION 'Match changed. Reopen Call next before sending';
  END IF;
  IF EXISTS (SELECT 1 FROM public.call_next_matches(p_tournament_id) n
    WHERE n.court_id = v_match.court_id AND n.status = 'scheduled'
      AND n.scheduled_time < v_match.scheduled_time
      AND (n.scheduled_time AT TIME ZONE (SELECT venue_timezone FROM public.tournaments WHERE id = p_tournament_id))::date
        = (v_match.scheduled_time AT TIME ZONE (SELECT venue_timezone FROM public.tournaments WHERE id = p_tournament_id))::date) THEN
    RAISE EXCEPTION 'The next match changed. Reopen Call next before sending';
  END IF;
  IF EXISTS (SELECT 1 FROM public.match_calls WHERE tournament_id = p_tournament_id
    AND match_id = p_match_id AND created_at > now() - interval '30 seconds') THEN
    RAISE EXCEPTION 'This match was just called. Wait 30 seconds before calling again';
  END IF;
  INSERT INTO public.match_calls(id, tournament_id, match_kind, match_id, court_id, scheduled_time, player_ids, actor_profile_id, message)
    VALUES(p_request_id, p_tournament_id, p_kind, p_match_id, p_court_id, v_match.scheduled_time, v_match.player_ids, public.current_profile_id(), trim(p_message));
  INSERT INTO public.player_notifications(call_id, profile_id)
    SELECT DISTINCT p_request_id, profile_id FROM public.players
    WHERE id = ANY(v_match.player_ids) AND profile_id IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN RAISE EXCEPTION 'No players have a linked Tournova account'; END IF;
  RETURN jsonb_build_object('count', v_count, 'sentAt', now());
END;
$$;

CREATE FUNCTION public.my_match_notifications() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC), '[]'::jsonb) FROM (
    SELECT r.id, r.read_at, c.message, c.created_at, c.tournament_id, t.name tournament_name,
      c.court_id, court.number court_number, c.match_id, c.match_kind,
      NOT EXISTS (SELECT 1 FROM public.call_next_matches(c.tournament_id) m
        WHERE m.kind = c.match_kind AND m.id = c.match_id AND m.status = 'scheduled'
          AND m.court_id = c.court_id AND m.scheduled_time IS NOT DISTINCT FROM c.scheduled_time
          AND m.player_ids = c.player_ids AND t.status = 'in_progress') AS outdated
    FROM public.player_notifications r JOIN public.match_calls c ON c.id = r.call_id
    JOIN public.tournaments t ON t.id = c.tournament_id JOIN public.courts court ON court.id = c.court_id
    WHERE r.profile_id = public.current_profile_id()
    ORDER BY c.created_at DESC LIMIT 100
  ) n;
$$;
CREATE FUNCTION public.read_match_notification(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.player_notifications SET read_at = COALESCE(read_at, now())
    WHERE id = p_id AND profile_id = public.current_profile_id();
$$;
REVOKE ALL ON FUNCTION public.desk_call_state(uuid),
  public.send_match_call(uuid, uuid, text, uuid, uuid, timestamptz, uuid[], text),
  public.my_match_notifications(), public.read_match_notification(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.desk_call_state(uuid),
  public.send_match_call(uuid, uuid, text, uuid, uuid, timestamptz, uuid[], text),
  public.my_match_notifications(), public.read_match_notification(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';

DO $verify$
DECLARE v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['match_calls', 'player_notifications'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_name)::regclass) THEN
      RAISE EXCEPTION 'Call notifications must have RLS enabled';
    END IF;
    IF has_table_privilege('authenticated', 'public.' || v_name, 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('anon', 'public.' || v_name, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'Call notification tables are RPC-only';
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.call_next_matches(uuid)', 'execute') THEN
    RAISE EXCEPTION 'Private match adapter must not be callable';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['desk_call_state(uuid)',
    'send_match_call(uuid,uuid,text,uuid,uuid,timestamptz,uuid[],text)',
    'my_match_notifications()', 'read_match_notification(uuid)'] LOOP
    IF has_function_privilege('anon', 'public.' || v_name, 'execute')
       OR NOT has_function_privilege('authenticated', 'public.' || v_name, 'execute') THEN
      RAISE EXCEPTION 'Call notification RPC privileges are incorrect';
    END IF;
  END LOOP;
END;
$verify$;
