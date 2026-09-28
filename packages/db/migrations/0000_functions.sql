-- Portable helpers (plain SQL/plpgsql only: this set must run on PGlite and Supabase).

-- UUIDv7 (RFC 9562): 48-bit Unix ms timestamp + version 7 + variant + random.
-- Native uuidv7() only exists from PostgreSQL 18, so it is not used.
CREATE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE sql VOLATILE AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$;
--> statement-breakpoint

-- Sync columns (03 §1, D-04): every insert/update takes the next global rev,
-- every update bumps version by one, and updated_at follows the change.
CREATE FUNCTION set_sync_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.rev := nextval('rev_seq');
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Financial and audit rows are never deleted (03 §1); the audit log is append-only.
CREATE FUNCTION forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
