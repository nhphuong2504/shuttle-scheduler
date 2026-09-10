UPDATE public.pool_matches AS pm
SET
  score_a = CASE
    WHEN abs(hashtext(pm.id::text)) % 2 = 0 THEN 21
    ELSE 10 + (abs(hashtext(pm.id::text)) % 8)
  END,
  score_b = CASE
    WHEN abs(hashtext(pm.id::text)) % 2 = 0 THEN 10 + (abs(hashtext(pm.id::text)) % 8)
    ELSE 21
  END,
  winner_id = CASE
    WHEN abs(hashtext(pm.id::text)) % 2 = 0 THEN pm.team_a_id
    ELSE pm.team_b_id
  END,
  status = 'reported',
  started_at = COALESCE(pm.started_at, pm.scheduled_time),
  ended_at = COALESCE(
    pm.ended_at,
    pm.scheduled_time + make_interval(mins => COALESCE(
      (SELECT group_slot_minutes FROM public.tournament_settings LIMIT 1),
      20
    ))
  ),
  reported_time = COALESCE(
    pm.reported_time,
    pm.scheduled_time + make_interval(mins => COALESCE(
      (SELECT group_slot_minutes FROM public.tournament_settings LIMIT 1),
      20
    ))
  )
WHERE pm.status NOT IN ('reported', 'walkover', 'void')
  AND pm.team_a_id IS NOT NULL
  AND pm.team_b_id IS NOT NULL;

UPDATE public.pools AS p
SET scheduled_end = latest.pool_end
FROM (
  SELECT pm.pool_id, max(COALESCE(pm.ended_at, pm.scheduled_time)) AS pool_end
  FROM public.pool_matches pm
  GROUP BY pm.pool_id
) AS latest
WHERE p.id = latest.pool_id;

UPDATE public.courts
SET status = 'free';
