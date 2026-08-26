-- 001_init.sql — receipt counter, receipts table, immutability triggers.
-- These records are financial evidence: sequential numbering must be unbroken,
-- and issued receipts must never be editable or deletable (only voidable).

CREATE TABLE receipt_counter (
  id INT PRIMARY KEY CHECK (id = 1),   -- exactly one row, ever
  last_number INT NOT NULL
);
INSERT INTO receipt_counter (id, last_number) VALUES (1, 0);

CREATE TABLE receipts (
  id SERIAL PRIMARY KEY,
  invoice_number TEXT UNIQUE NOT NULL,          -- format RCPT-000001 (zero-padded, continuous series, never resets)
  issue_date DATE NOT NULL,
  student_name TEXT NOT NULL CHECK (length(trim(student_name)) > 0),
  parent_name TEXT NOT NULL CHECK (length(trim(parent_name)) > 0),
  parent_email TEXT NOT NULL CHECK (position('@' in parent_email) > 1),
  teacher_name TEXT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency IN ('USD','AUD','INR')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('bank_transfer','paypal','upi','other')),
  payment_reference TEXT,                       -- external txn id (bank ref / PayPal id); optional
  fee_description TEXT NOT NULL CHECK (length(trim(fee_description)) > 0),
  gst_treatment TEXT,                           -- intentionally nullable: pending CA confirmation. No default tax claim.
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','voided')),
  void_reason TEXT,
  voided_at TIMESTAMPTZ,
  pdf_bytes BYTEA,                              -- the EXACT PDF emailed to the parent; attached once by Session 2; never regenerated
  email_sent_at TIMESTAMPTZ,                    -- set once by Session 2 after successful send
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT void_state_consistent CHECK (
    (status = 'voided' AND void_reason IS NOT NULL AND length(trim(void_reason)) > 0 AND voided_at IS NOT NULL)
    OR
    (status = 'issued' AND void_reason IS NULL AND voided_at IS NULL)
  )
);

CREATE INDEX idx_receipts_student ON receipts (student_name);
CREATE INDEX idx_receipts_issue_date ON receipts (issue_date);

-- ---------------------------------------------------------------------------
-- Immutability: DELETE is never allowed; UPDATE only for exactly one of three
-- transitions (void, one-time PDF attach, one-time email timestamp), with every
-- other column byte-identical. Anything else fails closed.
-- ---------------------------------------------------------------------------

CREATE FUNCTION receipts_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'receipts are immutable; void instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_receipts_no_delete
  BEFORE DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_block_delete();

CREATE FUNCTION receipts_guard_update() RETURNS trigger AS $$
DECLARE
  frozen_changed BOOLEAN;
  status_changed BOOLEAN;
  reason_changed BOOLEAN;
  voided_at_changed BOOLEAN;
  pdf_changed BOOLEAN;
  email_changed BOOLEAN;
  is_void BOOLEAN;
  is_pdf_attach BOOLEAN;
  is_email_set BOOLEAN;
BEGIN
  -- These columns may never change under any circumstances.
  frozen_changed :=
       NEW.id                IS DISTINCT FROM OLD.id
    OR NEW.invoice_number    IS DISTINCT FROM OLD.invoice_number
    OR NEW.issue_date        IS DISTINCT FROM OLD.issue_date
    OR NEW.student_name      IS DISTINCT FROM OLD.student_name
    OR NEW.parent_name       IS DISTINCT FROM OLD.parent_name
    OR NEW.parent_email      IS DISTINCT FROM OLD.parent_email
    OR NEW.teacher_name      IS DISTINCT FROM OLD.teacher_name
    OR NEW.amount            IS DISTINCT FROM OLD.amount
    OR NEW.currency          IS DISTINCT FROM OLD.currency
    OR NEW.payment_method    IS DISTINCT FROM OLD.payment_method
    OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
    OR NEW.fee_description   IS DISTINCT FROM OLD.fee_description
    OR NEW.gst_treatment     IS DISTINCT FROM OLD.gst_treatment
    OR NEW.created_at        IS DISTINCT FROM OLD.created_at;

  IF frozen_changed THEN
    RAISE EXCEPTION 'receipts are immutable; financial and identity columns can never change (void instead)';
  END IF;

  status_changed    := NEW.status        IS DISTINCT FROM OLD.status;
  reason_changed    := NEW.void_reason   IS DISTINCT FROM OLD.void_reason;
  voided_at_changed := NEW.voided_at     IS DISTINCT FROM OLD.voided_at;
  pdf_changed       := NEW.pdf_bytes     IS DISTINCT FROM OLD.pdf_bytes;
  email_changed     := NEW.email_sent_at IS DISTINCT FROM OLD.email_sent_at;

  -- Transition 1: void an issued receipt (status + reason + timestamp together, nothing else).
  is_void :=
        status_changed AND reason_changed AND voided_at_changed
    AND NOT pdf_changed AND NOT email_changed
    AND OLD.status = 'issued' AND NEW.status = 'voided'
    AND OLD.void_reason IS NULL AND NEW.void_reason IS NOT NULL AND length(trim(NEW.void_reason)) > 0
    AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL;

  -- Transition 2: one-time PDF attach (NULL -> non-null, nothing else).
  is_pdf_attach :=
        pdf_changed
    AND NOT status_changed AND NOT reason_changed AND NOT voided_at_changed AND NOT email_changed
    AND OLD.pdf_bytes IS NULL AND NEW.pdf_bytes IS NOT NULL;

  -- Transition 3: one-time email timestamp (NULL -> timestamp, nothing else).
  is_email_set :=
        email_changed
    AND NOT status_changed AND NOT reason_changed AND NOT voided_at_changed AND NOT pdf_changed
    AND OLD.email_sent_at IS NULL AND NEW.email_sent_at IS NOT NULL;

  IF is_void OR is_pdf_attach OR is_email_set THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'receipts are immutable; only void, one-time pdf attach, or one-time email timestamp are allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_receipts_guard_update
  BEFORE UPDATE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_guard_update();

-- TRUNCATE would silently bypass the row-level DELETE trigger, so block it too.
CREATE FUNCTION receipts_block_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'receipts are immutable; truncate is not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_receipts_no_truncate
  BEFORE TRUNCATE ON receipts
  FOR EACH STATEMENT EXECUTE FUNCTION receipts_block_truncate();

-- ---------------------------------------------------------------------------
-- schema_migrations is append-only: no UPDATE, no DELETE.
-- (The table itself is created by migrate.js before migrations run.)
-- ---------------------------------------------------------------------------

CREATE FUNCTION schema_migrations_block_write() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'schema_migrations is append-only; rows can never be updated or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_schema_migrations_no_update
  BEFORE UPDATE ON schema_migrations
  FOR EACH ROW EXECUTE FUNCTION schema_migrations_block_write();

CREATE TRIGGER trg_schema_migrations_no_delete
  BEFORE DELETE ON schema_migrations
  FOR EACH ROW EXECUTE FUNCTION schema_migrations_block_write();

-- ---------------------------------------------------------------------------
-- receipt_counter: the single row may only move forward (increment path), and
-- may never be deleted (deleting + re-seeding would allow number reuse).
-- ---------------------------------------------------------------------------

CREATE FUNCTION receipt_counter_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.last_number IS NULL OR NEW.last_number <= OLD.last_number THEN
    RAISE EXCEPTION 'receipt_counter.last_number may only increase';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_receipt_counter_guard_update
  BEFORE UPDATE ON receipt_counter
  FOR EACH ROW EXECUTE FUNCTION receipt_counter_guard_update();

CREATE FUNCTION receipt_counter_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'receipt_counter row can never be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_receipt_counter_no_delete
  BEFORE DELETE ON receipt_counter
  FOR EACH ROW EXECUTE FUNCTION receipt_counter_block_delete();
