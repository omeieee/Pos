-- Pin search_path on our functions (Supabase lint 0011 "function_search_path_mutable", P1 QA F9).
-- pg_catalog is always searched first; pg_temp goes last so temp objects cannot shadow ours.
ALTER FUNCTION uuid_generate_v7() SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION set_sync_columns() SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION forbid_change() SET search_path = public, pg_temp;
