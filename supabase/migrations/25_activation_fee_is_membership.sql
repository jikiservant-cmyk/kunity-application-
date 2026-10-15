-- ============================================================================
-- 25: The activation fee IS the membership gate. Manual join approval removed.
--
-- Division of responsibility:
--   * process_najiki_webhook (and process_livepay_webhook) VERIFY and PROCESS
--     the payment and record its success (payment_requests.status = 'success').
--     They activate member_savings / accounts for activation payments.
--   * THIS TRIGGER synchronises kunity.members.status from that recorded
--     success. It is payment-path agnostic: any writer that marks an activation
--     payment successful gets the same result.
--
-- The trigger only acts when ALL of these hold for the STORED payment request:
--   - status is now 'success' (and was not already 'success')
--   - it is an activation payment (stored payment_type or PAY-ACT- reference)
--   - direction is inbound
--   - currency is UGX
--   - amount is at least the activation fee (kunity.activation_fee_minimum())
--   - the member is currently 'pending' (suspended / rejected are never changed)
-- It never reads a caller-supplied payment type.
-- Admin approval is still required for withdrawals and loans (unchanged).
-- ============================================================================

-- The activation fee. Keep in step with MEMBER_MIN_AMOUNTS in
-- app/api/payments/intent/route.ts (account_activation: 5000).
CREATE OR REPLACE FUNCTION kunity.activation_fee_minimum()
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT 5000::numeric $$;

CREATE OR REPLACE FUNCTION kunity.is_qualifying_activation_payment(
  p_payment_type text,
  p_internal_reference text,
  p_direction text,
  p_currency text,
  p_amount numeric,
  p_status text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT p_status = 'success'
     AND (p_payment_type = 'account_activation' OR p_internal_reference LIKE 'PAY-ACT-%')
     AND COALESCE(NULLIF(p_direction, ''), 'inbound') = 'inbound'
     AND UPPER(COALESCE(NULLIF(p_currency, ''), 'UGX')) = 'UGX'
     AND p_amount >= kunity.activation_fee_minimum()
$$;

CREATE OR REPLACE FUNCTION kunity.activate_member_on_activation_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, kunity, pg_temp
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
     AND kunity.is_qualifying_activation_payment(
           NEW.payment_type, NEW.internal_reference, NEW.direction,
           NEW.currency, NEW.amount, NEW.status::text)
  THEN
    UPDATE kunity.members
    SET status = 'active', updated_at = NOW()
    WHERE id = NEW.member_id
      AND organization_id = NEW.organization_id
      AND status = 'pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_activate_member_on_activation_payment ON kunity.payment_requests;
CREATE TRIGGER trg_activate_member_on_activation_payment
  AFTER INSERT OR UPDATE OF status ON kunity.payment_requests
  FOR EACH ROW
  EXECUTE FUNCTION kunity.activate_member_on_activation_payment();

-- Backfill: pending members whose activation payment was already recorded
-- successfully under the same rules.
UPDATE kunity.members m
SET status = 'active', updated_at = NOW()
WHERE m.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM kunity.payment_requests p
    WHERE p.member_id = m.id
      AND p.organization_id = m.organization_id
      AND kunity.is_qualifying_activation_payment(
            p.payment_type, p.internal_reference, p.direction,
            p.currency, p.amount, p.status::text)
  );
