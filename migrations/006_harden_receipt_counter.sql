-- 006_harden_receipt_counter.sql — gap-fill: invoice_counter has a TRUNCATE
-- guard (004), receipt_counter does not (001). TRUNCATE bypasses the row-level
-- DELETE trigger, so without this the counter could be emptied and re-seeded —
-- which would let an already-issued receipt number be handed out a second time.
-- 001_init.sql is already applied and must never be edited; this only adds the
-- missing statement-level trigger, reusing the existing guard function.

CREATE TRIGGER trg_receipt_counter_no_truncate
  BEFORE TRUNCATE ON receipt_counter
  FOR EACH STATEMENT EXECUTE FUNCTION receipt_counter_block_delete();
