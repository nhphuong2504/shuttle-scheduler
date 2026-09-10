ALTER FUNCTION public.normalize_email(text) SET search_path = public;

ALTER VIEW public.player_roster SET (security_invoker = on);

DROP POLICY IF EXISTS "player roster public read" ON public.players;
CREATE POLICY "player roster public read" ON public.players
FOR SELECT TO anon
USING (true);

REVOKE EXECUTE ON FUNCTION public.current_staff_role() FROM anon;
REVOKE EXECUTE ON FUNCTION public.has_staff_role(text[]) FROM anon;
REVOKE ALL ON FUNCTION public.apply_pool_generation(uuid, boolean, jsonb) FROM anon, public;
REVOKE ALL ON FUNCTION public.apply_draw_generation(uuid, boolean, jsonb) FROM anon, public;
REVOKE ALL ON FUNCTION public.apply_day_schedule(int, jsonb, jsonb) FROM anon, public;
REVOKE ALL ON FUNCTION public.report_pool_result(uuid, int, int) FROM anon, public;
REVOKE ALL ON FUNCTION public.report_draw_result(uuid, jsonb) FROM anon, public;
REVOKE ALL ON FUNCTION public.reset_and_repair_match(text, uuid) FROM anon, public;
REVOKE ALL ON FUNCTION public.resolve_match_exception(text, uuid, text, uuid, text) FROM anon, public;
REVOKE ALL ON FUNCTION public.link_staff_role() FROM anon, authenticated, public;

GRANT EXECUTE ON FUNCTION public.apply_pool_generation(uuid, boolean, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_draw_generation(uuid, boolean, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_day_schedule(int, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_pool_result(uuid, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_draw_result(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_and_repair_match(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_match_exception(text, uuid, text, uuid, text) TO authenticated;