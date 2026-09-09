ALTER TABLE public.pools DROP CONSTRAINT pools_size_check;
ALTER TABLE public.pools ADD CONSTRAINT pools_size_check CHECK (size >= 4 AND size <= 8);