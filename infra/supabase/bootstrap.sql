-- One-time hardening for the Supabase project (Path B, D-03). Idempotent.
-- Not a Drizzle migration: rls_auto_enable() exists only on Supabase, and the
-- same migration set must also run on PGlite.
--
-- rls_auto_enable() is a Supabase-provided SECURITY DEFINER event-trigger
-- function (event trigger `ensure_rls`) that turns on RLS for every new table
-- in `public`, so PostgREST cannot read our tables through the publishable key.
-- Keep the function and the trigger; only stop API roles from calling it
-- (security advisor lints 0028/0029).
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
