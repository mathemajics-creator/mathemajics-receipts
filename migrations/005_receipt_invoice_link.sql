-- 005_receipt_invoice_link.sql — link a receipt back to the invoice it pays.
-- Paid status is DERIVED (a non-voided receipt referencing the invoice), never
-- stored on the invoice: that is what keeps invoices write-once.
-- invoice_id is set at insert and is frozen from then on, so the guard function
-- from 001_init.sql is replaced here (001 itself is never edited).

ALTER TABLE receipts ADD COLUMN invoice_id INTEGER REFERENCES invoices(id);
CREATE INDEX idx_receipts_invoice ON receipts (invoice_id);

CREATE OR REPLACE FUNCTION receipts_guard_update() RETURNS trigger AS $$
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
    OR NEW.invoice_id        IS DISTINCT FROM OLD.invoice_id
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
