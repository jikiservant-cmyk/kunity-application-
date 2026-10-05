-- ============================================================================
-- 21_auth_integrity_hardening.sql
-- Kunity SACCO — Authentication / authorization integrity hardening
--
-- Companion to the application-layer fixes (see SECURITY_AUDIT.md):
--   * Defense-in-depth: the member money-movement RPCs now enforce the
--     member's account standing (status = 'active') and, where relevant,
--     that the target account is active — so the check holds even if an
--     application-layer guard is ever bypassed or a new caller is added.
--   * Withdrawal / repayment require an ACTIVE account (frozen or
--     deactivated accounts are locked out even if they carry a balance).
--   * Loan applications require an ACTIVE, non-suspended member.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. member_withdraw_atomic — require active member + active account
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kunity.member_withdraw_atomic(
  p_member_id UUID,
  p_organization_id UUID,
  p_account_id UUID,
  p_amount NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, kunity, pg_temp
AS $$
DECLARE
  v_account RECORD;
  v_entry_id UUID;
  v_member_status TEXT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Withdrawal amount must be greater than zero';
  END IF;

  -- SECURITY: only fully approved members may withdraw funds.
  SELECT m.status INTO v_member_status
  FROM kunity.members m
  WHERE m.id = p_member_id AND m.organization_id = p_organization_id
  FOR SHARE;

  IF v_member_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Member account is not active';
  END IF;

  -- Lock account (must belong to the member AND be active)
  SELECT * INTO v_account
  FROM kunity.accounts
  WHERE id = p_account_id
    AND member_id = p_member_id
    AND organization_id = p_organization_id
    AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found or not active';
  END IF;

  IF v_account.cached_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient funds';
  END IF;

  -- Update balance
  UPDATE kunity.accounts
  SET cached_balance = cached_balance - p_amount, updated_at = NOW()
  WHERE id = p_account_id;

  -- Journal
  INSERT INTO kunity.journal_entries (organization_id, description, created_by, created_at, updated_at)
  VALUES (p_organization_id, 'Wallet Withdrawal', p_member_id, NOW(), NOW())
  RETURNING id INTO v_entry_id;

  INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, credit, debit, created_at, updated_at)
  VALUES (v_entry_id, p_account_id, p_member_id, 'withdrawal', p_amount, 0, NOW(), NOW());

  RETURN jsonb_build_object('success', true, 'new_balance', v_account.cached_balance - p_amount);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. member_repay_loan_atomic — require active member + active account
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kunity.member_repay_loan_atomic(
  p_member_id UUID,
  p_organization_id UUID,
  p_account_id UUID,
  p_loan_id UUID,
  p_amount NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, kunity, pg_temp
AS $$
DECLARE
  v_account RECORD;
  v_loan RECORD;
  v_entry_id UUID;
  v_paid NUMERIC;
  v_total NUMERIC;
  v_member_status TEXT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Repayment amount must be greater than zero';
  END IF;

  -- SECURITY: only fully approved members may repay from wallet funds.
  SELECT m.status INTO v_member_status
  FROM kunity.members m
  WHERE m.id = p_member_id AND m.organization_id = p_organization_id
  FOR SHARE;

  IF v_member_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Member account is not active';
  END IF;

  -- Lock account (must belong to the member AND be active)
  SELECT * INTO v_account
  FROM kunity.accounts
  WHERE id = p_account_id
    AND member_id = p_member_id
    AND organization_id = p_organization_id
    AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found or not active';
  END IF;

  IF v_account.cached_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient funds';
  END IF;

  -- Lock loan
  SELECT l.*, COALESCE(SUM(lr.principal_paid), 0) as paid_amount INTO v_loan
  FROM kunity.loans l
  LEFT JOIN kunity.loan_repayments lr ON lr.loan_id = l.id
  WHERE l.id = p_loan_id AND l.member_id = p_member_id AND l.organization_id = p_organization_id
  GROUP BY l.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan not found';
  END IF;

  v_total := v_loan.principal + (v_loan.principal * v_loan.interest_rate / 100);
  v_paid := v_loan.paid_amount;

  IF p_amount > (v_total - v_paid) THEN
    RAISE EXCEPTION 'Amount exceeds remaining loan balance';
  END IF;

  -- Update balance
  UPDATE kunity.accounts
  SET cached_balance = cached_balance - p_amount, updated_at = NOW()
  WHERE id = p_account_id;

  -- Journal
  INSERT INTO kunity.journal_entries (organization_id, description, created_by, created_at, updated_at)
  VALUES (p_organization_id, 'Loan Repayment', p_member_id, NOW(), NOW())
  RETURNING id INTO v_entry_id;

  INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, credit, debit, loan_id, created_at, updated_at)
  VALUES (v_entry_id, p_account_id, p_member_id, 'repayment_principal', p_amount, 0, p_loan_id, NOW(), NOW());

  INSERT INTO kunity.loan_repayments (organization_id, loan_id, journal_entry_id, member_id, principal_paid, created_by, created_at)
  VALUES (p_organization_id, p_loan_id, v_entry_id, p_member_id, p_amount, p_member_id, NOW());

  IF (v_paid + p_amount) >= v_total THEN
    UPDATE kunity.loans SET status = 'completed', updated_at = NOW() WHERE id = p_loan_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'new_balance', v_account.cached_balance - p_amount);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. member_apply_loan — require active member
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kunity.member_apply_loan(
  p_member_id UUID,
  p_organization_id UUID,
  p_amount NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, kunity, pg_temp
AS $$
DECLARE
  v_loan_id UUID;
  v_member_status TEXT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Loan amount must be greater than zero';
  END IF;

  -- SECURITY: pending, rejected, or suspended members cannot apply for credit.
  SELECT m.status INTO v_member_status
  FROM kunity.members m
  WHERE m.id = p_member_id AND m.organization_id = p_organization_id
  FOR SHARE;

  IF v_member_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Member account is not active';
  END IF;

  INSERT INTO kunity.loans (organization_id, member_id, principal, interest_rate, status, created_by, created_at, updated_at)
  VALUES (p_organization_id, p_member_id, p_amount, 10, 'pending', p_member_id, NOW(), NOW())
  RETURNING id INTO v_loan_id;

  RETURN jsonb_build_object('success', true, 'loan_id', v_loan_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Execution grants: service_role only (re-assert after replacement)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION kunity.member_withdraw_atomic(UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.member_withdraw_atomic(UUID, UUID, UUID, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION kunity.member_repay_loan_atomic(UUID, UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.member_repay_loan_atomic(UUID, UUID, UUID, UUID, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION kunity.member_apply_loan(UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.member_apply_loan(UUID, UUID, NUMERIC) TO service_role;

COMMIT;
