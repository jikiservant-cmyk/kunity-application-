-- ============================================================================
-- 15_loan_disbursement_rpc.sql
-- Atomic loan disbursement using PostgreSQL RPC
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION kunity.disburse_loan_atomic(
  p_loan_id UUID,
  p_organization_id UUID,
  p_member_id UUID,
  p_disbursement_amount NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, kunity, pg_temp
AS $$
DECLARE
  v_loan RECORD;
  v_account RECORD;
  v_entry_id UUID;
BEGIN
  -- 1. Lock and fetch loan
  SELECT * INTO v_loan
  FROM kunity.loans
  WHERE id = p_loan_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan not found';
  END IF;

  IF v_loan.status = 'approved' THEN
    RAISE EXCEPTION 'Loan is already approved and disbursed';
  END IF;

  IF v_loan.status <> 'pending' THEN
    RAISE EXCEPTION 'Cannot approve loan currently in status: %', v_loan.status;
  END IF;

  IF v_loan.principal <> p_disbursement_amount THEN
    RAISE EXCEPTION 'Disbursement amount mismatch';
  END IF;

  -- 2. Update loan status
  UPDATE kunity.loans
  SET status = 'approved', updated_at = NOW()
  WHERE id = p_loan_id;

  -- 3. Lock and fetch account
  SELECT * INTO v_account
  FROM kunity.accounts
  WHERE member_id = p_member_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member wallet account not found in this organization';
  END IF;

  -- 4. Update account balance
  UPDATE kunity.accounts
  SET cached_balance = cached_balance + p_disbursement_amount, updated_at = NOW()
  WHERE id = v_account.id;

  -- 5. Create journal entry
  INSERT INTO kunity.journal_entries (organization_id, description, created_at, updated_at)
  VALUES (p_organization_id, 'Loan Disbursement (Loan ID: ' || left(p_loan_id::text, 8) || ')', NOW(), NOW())
  RETURNING id INTO v_entry_id;

  -- 6. Create journal line
  INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, created_at, updated_at)
  VALUES (v_entry_id, v_account.id, p_member_id, 'loan_disbursement', p_disbursement_amount, 0, NOW(), NOW());

  RETURN jsonb_build_object('success', true, 'message', 'Loan successfully approved and funds disbursed');
END;
$$;

-- Revoke public access
REVOKE ALL ON FUNCTION kunity.disburse_loan_atomic(UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.disburse_loan_atomic(UUID, UUID, UUID, NUMERIC) TO service_role;

COMMIT;
