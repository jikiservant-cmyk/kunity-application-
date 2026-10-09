-- ============================================================================
-- 25: The activation fee IS the membership gate. Manual join approval removed.
--
-- A new member used to stay 'pending' until an SACCO admin pressed Approve,
-- even after paying. From now on, a SUCCESSFUL activation payment moves the
-- member from 'pending' to 'active' automatically (in the same transaction as
-- the payment update, via trigger). Admin approval is still required for
-- withdrawals and loans (those checks live in the money functions and are
-- unchanged).
-- Suspended / rejected members are never re-activated by a payment.
-- ============================================================================

CREATE OR REPLACE FUNCTION kunity.activate_member_on_activation_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kunity, public
AS $$
BEGIN
  IF NEW.status = 'success'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'success')
     AND (NEW.payment_type = 'account_activation' OR NEW.internal_reference LIKE 'PAY-ACT-%')
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

-- Backfill: members who already paid their activation fee while still pending.
UPDATE kunity.members m
SET status = 'active', updated_at = NOW()
WHERE m.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM kunity.payment_requests p
    WHERE p.member_id = m.id
      AND p.organization_id = m.organization_id
      AND p.status = 'success'
      AND (p.payment_type = 'account_activation' OR p.internal_reference LIKE 'PAY-ACT-%')
  );
