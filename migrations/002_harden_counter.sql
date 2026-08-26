-- 002_harden_counter.sql — Session 1 review fix: the counter guard allowed any
-- increase (a jump of +5 would burn numbers). Tighten to exactly +1 per update.
-- 001_init.sql is already applied and must never be edited; this replaces the
-- function body only — the existing trigger stays bound to it.

CREATE OR REPLACE FUNCTION receipt_counter_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.last_number IS NULL
     OR NEW.last_number IS DISTINCT FROM OLD.last_number + 1 THEN
    RAISE EXCEPTION 'receipt_counter.last_number may only increment by exactly 1';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
