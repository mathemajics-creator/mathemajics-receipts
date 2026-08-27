-- 007_free_classes.sql — record the free classes an invoice earns.
--
-- Carried over from the old browser-based generator, which logged Referral /
-- Sibling / Group bonuses on the invoice that earned them. It is a statement of
-- what the family is owed in teaching time, printed on the document; it is NOT
-- money and touches no total. Subtotal, discount and total are unchanged by it,
-- and nothing here is tax-related.
--
-- Both columns are frozen at issue like every other field on an invoice, so the
-- guard function from 004_invoices.sql is replaced here to include them.
-- 004 itself is already applied and must never be edited.

ALTER TABLE invoices ADD COLUMN free_class_count INTEGER;
ALTER TABLE invoices ADD COLUMN free_class_reasons TEXT;

-- Either the block is wholly absent, or it carries a real number of classes.
-- A bonus note with no number would print as a promise with no content, so the
-- count is what makes the block present; the reasons are optional detail.
ALTER TABLE invoices ADD CONSTRAINT invoice_free_classes_consistent CHECK (
  (free_class_count IS NULL AND free_class_reasons IS NULL)
  OR (
    free_class_count IS NOT NULL
    AND free_class_count >= 1
    AND free_class_count <= 100
    AND (free_class_reasons IS NULL OR length(trim(free_class_reasons)) BETWEEN 1 AND 100)
  )
);

CREATE OR REPLACE FUNCTION invoices_guard_update() RETURNS trigger AS $$
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
       NEW.id                 IS DISTINCT FROM OLD.id
    OR NEW.invoice_number     IS DISTINCT FROM OLD.invoice_number
    OR NEW.issue_date         IS DISTINCT FROM OLD.issue_date
    OR NEW.due_date           IS DISTINCT FROM OLD.due_date
    OR NEW.student_name       IS DISTINCT FROM OLD.student_name
    OR NEW.parent_name        IS DISTINCT FROM OLD.parent_name
    OR NEW.parent_email       IS DISTINCT FROM OLD.parent_email
    OR NEW.teacher_name       IS DISTINCT FROM OLD.teacher_name
    OR NEW.line_items         IS DISTINCT FROM OLD.line_items
    OR NEW.subtotal           IS DISTINCT FROM OLD.subtotal
    OR NEW.discount_label     IS DISTINCT FROM OLD.discount_label
    OR NEW.discount_amount    IS DISTINCT FROM OLD.discount_amount
    OR NEW.total              IS DISTINCT FROM OLD.total
    OR NEW.currency           IS DISTINCT FROM OLD.currency
    OR NEW.fx_rate            IS DISTINCT FROM OLD.fx_rate
    OR NEW.fx_source          IS DISTINCT FROM OLD.fx_source
    OR NEW.fx_date            IS DISTINCT FROM OLD.fx_date
    OR NEW.fx_mode            IS DISTINCT FROM OLD.fx_mode
    OR NEW.inr_amount         IS DISTINCT FROM OLD.inr_amount
    OR NEW.free_class_count   IS DISTINCT FROM OLD.free_class_count
    OR NEW.free_class_reasons IS DISTINCT FROM OLD.free_class_reasons
    OR NEW.notes              IS DISTINCT FROM OLD.notes
    OR NEW.created_at         IS DISTINCT FROM OLD.created_at;

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
