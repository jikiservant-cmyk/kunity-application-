-- ============================================================================
-- 37_sms_topup_payment_request_member_nullable.sql
--
-- SMS top-ups are organization purchases: an administrator buys credits for
-- the SACCO, not for a member. app/api/admin/sms/topup/route.ts therefore
-- records the purchase in kunity.payment_requests with member_id = NULL.
--
-- The pre-existing table declares member_id NOT NULL, so that insert failed.
-- The failure is non-fatal to the wallet credit (wallet_transactions is the
-- authoritative record and the webhook tolerates "Unknown payment reference"),
-- but the top-up never appears in payment history and the operator cannot
-- reconcile it against NaJiki. Relax the constraint so org-level purchases can
-- be recorded.
--
-- DROP NOT NULL is idempotent: it is a no-op on a database where the column is
-- already nullable.
-- ============================================================================
BEGIN;

ALTER TABLE kunity.payment_requests
  ALTER COLUMN member_id DROP NOT NULL;

COMMIT;
