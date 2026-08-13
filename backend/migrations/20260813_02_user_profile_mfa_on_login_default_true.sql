-- Migration date: 2026-08-13

ALTER TABLE public.user_profiles
  ALTER COLUMN mfa_on_login SET DEFAULT true;
