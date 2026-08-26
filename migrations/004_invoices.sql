-- 004_invoices.sql — invoice counter, invoices table, immutability triggers.
-- Invoices are financial evidence exactly like receipts: an unbroken INV- series,
-- written once, never edited or deleted (only voidable). Line items and the FX
-- block live inside the frozen row so they can never drift from the totals.
-- There is deliberately no tax/GST column here.

CREATE TABLE invoice_counter (
  id INT PRIMARY KEY CHECK (id = 1),   -- exactly one row, ever
  last_number INT NOT NULL
);
INSERT INTO invoice_counter (id, last_number) VALUES (1, 0);

CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  invoice_number TEXT UNIQUE NOT NULL,           -- INV-000001, continuous, never resets
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  student_name TEXT NOT NULL CHECK (length(trim(student_name)) > 0),
  parent_name TEXT NOT NULL CHECK (length(trim(parent_name)) > 0),
  parent_email TEXT NOT NULL CHECK (position('@' in parent_email) > 1),
  teacher_name TEXT,
  line_items JSONB NOT NULL,                     -- frozen at issue; shape validated in application code
  subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal > 0),
  discount_label TEXT,
  discount_amount NUMERIC(12,2) CHECK (discount_amount IS NULL OR discount_amount >= 0),
  total NUMERIC(12,2) NOT NULL CHECK (total > 0),
  currency TEXT NOT NULL CHECK (currency IN ('USD','AUD','INR')),

  -- FX block: all four present together, or all NULL. Frozen at issue.
  fx_rate NUMERIC(18,6) CHECK (fx_rate IS NULL OR fx_rate > 0),
  fx_source TEXT,
  fx_date DATE,
  fx_mode TEXT CHECK (fx_mode IS NULL OR fx_mode IN ('indicative','payable')),
  inr_amount NUMERIC(14,2) CHECK (inr_amount IS NULL OR inr_amount > 0),

  notes TEXT,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','voided')),
  void_reason TEXT,
  voided_at TIMESTAMPTZ,
  pdf_bytes BYTEA,                               -- the EXACT PDF emailed; attached once, never regenerated
  email_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT invoice_void_state_consistent CHECK (
    (status = 'voided' AND void_reason IS NOT NULL AND length(trim(void_reason)) > 0 AND voided_at IS NOT NULL)
    OR (status = 'issued' AND void_reason IS NULL AND voided_at IS NULL)
  ),
  CONSTRAINT invoice_fx_block_complete CHECK (
    (fx_rate IS NULL AND fx_source IS NULL AND fx_date IS NULL AND fx_mode IS NULL AND inr_amount IS NULL)
    OR (fx_rate IS NOT NULL AND fx_source IS NOT NULL AND length(trim(fx_source)) > 0
        AND fx_date IS NOT NULL AND fx_mode IS NOT NULL AND inr_amount IS NOT NULL)
  ),
  CONSTRAINT invoice_due_not_before_issue CHECK (due_date >= issue_date)
);

CREATE INDEX idx_invoices_student ON invoices (student_name);
CREATE INDEX idx_invoices_issue_date ON invoices (issue_date);

-- ---------------------------------------------------------------------------
-- Immutability: DELETE is never allowed; UPDATE only for exactly one of three
-- transitions (void, one-time PDF attach, one-time email timestamp), with every
-- other column byte-identical. Anything else fails closed.
-- ---------------------------------------------------------------------------

CREATE FUNCTION invoices_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'invoices are immutable; void instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoices_no_delete
  BEFORE DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_block_delete();

CREATE FUNCTION invoices_guard_update() RETURNS trigger AS $$
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
       NEW.id              IS DISTINCT FROM OLD.id
    OR NEW.invoice_number  IS DISTINCT FROM OLD.invoice_number
    OR NEW.issue_date      IS DISTINCT FROM OLD.issue_date
    OR NEW.due_date        IS DISTINCT FROM OLD.due_date
    OR NEW.student_name    IS DISTINCT FROM OLD.student_name
    OR NEW.parent_name     IS DISTINCT FROM OLD.parent_name
    OR NEW.parent_email    IS DISTINCT FROM OLD.parent_email
    OR NEW.teacher_name    IS DISTINCT FROM OLD.teacher_name
    OR NEW.line_items      IS DISTINCT FROM OLD.line_items
    OR NEW.subtotal        IS DISTINCT FROM OLD.subtotal
    OR NEW.discount_label  IS DISTINCT FROM OLD.discount_label
    OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
    OR NEW.total           IS DISTINCT FROM OLD.total
    OR NEW.currency        IS DISTINCT FROM OLD.currency
    OR NEW.fx_rate         IS DISTINCT FROM OLD.fx_rate
    OR NEW.fx_source       IS DISTINCT FROM OLD.fx_source
    OR NEW.fx_date         IS DISTINCT FROM OLD.fx_date
    OR NEW.fx_mode         IS DISTINCT FROM OLD.fx_mode
    OR NEW.inr_amount      IS DISTINCT FROM OLD.inr_amount
    OR NEW.notes           IS DISTINCT FROM OLD.notes
    OR NEW.created_at      IS DISTINCT FROM OLD.created_at;

  IF frozen_changed THEN
    RAISE EXCEPTION 'invoices are immutable; financial and identity columns can never change (void instead)';
  END IF;

  status_changed    := NEW.status        IS DISTINCT FROM OLD.status;
  reason_changed    := NEW.void_reason   IS DISTINCT FROM OLD.void_reason;
  voided_at_changed := NEW.voided_at     IS DISTINCT FROM OLD.voided_at;
  pdf_changed       := NEW.pdf_bytes     IS DISTINCT FROM OLD.pdf_bytes;
  email_changed     := NEW.email_sent_at IS DISTINCT FROM OLD.email_sent_at;

  -- Transition 1: void an issued invoice (status + reason + timestamp together, nothing else).
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

  RAISE EXCEPTION 'invoices are immutable; only void, one-time pdf attach, or one-time email timestamp are allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoices_guard_update
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard_update();

-- TRUNCATE would silently bypass the row-level DELETE trigger, so block it too.
CREATE FUNCTION invoices_block_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'invoices are immutable; truncate is not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoices_no_truncate
  BEFORE TRUNCATE ON invoices
  FOR EACH STATEMENT EXECUTE FUNCTION invoices_block_truncate();

-- ---------------------------------------------------------------------------
-- invoice_counter: the single row may only move forward by exactly 1, and may
-- never be removed (deleting + re-seeding would allow number reuse). TRUNCATE
-- is blocked too, since it would bypass the row-level DELETE trigger.
-- ---------------------------------------------------------------------------

CREATE FUNCTION invoice_counter_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.last_number IS NULL
     OR NEW.last_number IS DISTINCT FROM OLD.last_number + 1 THEN
    RAISE EXCEPTION 'invoice_counter.last_number may only increment by exactly 1';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_counter_guard_update
  BEFORE UPDATE ON invoice_counter
  FOR EACH ROW EXECUTE FUNCTION invoice_counter_guard_update();

CREATE FUNCTION invoice_counter_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'invoice_counter row can never be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_counter_no_delete
  BEFORE DELETE ON invoice_counter
  FOR EACH ROW EXECUTE FUNCTION invoice_counter_block_delete();

CREATE TRIGGER trg_invoice_counter_no_truncate
  BEFORE TRUNCATE ON invoice_counter
  FOR EACH STATEMENT EXECUTE FUNCTION invoice_counter_block_delete();
