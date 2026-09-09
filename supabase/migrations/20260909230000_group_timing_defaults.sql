-- Group stage: 20-minute court slots, 10-minute player rest gap
ALTER TABLE public.tournament_settings
  ALTER COLUMN rest_gap_minutes SET DEFAULT 10,
  ALTER COLUMN group_slot_minutes SET DEFAULT 20;

UPDATE public.tournament_settings
SET rest_gap_minutes = 10,
    group_slot_minutes = 20;
