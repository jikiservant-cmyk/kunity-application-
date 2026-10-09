-- ============================================================================
-- 22_repayment_paid_to_date_fix.sql
-- Kunity SACCO — loan repayment totals fix (money bug found in the
-- pre-launch financial cross-check).
--
-- BUG: member_repay_loan_atomic compared the cash repaid so far against the
-- loan total using ONLY principal_paid (SUM(principal_paid)). Interest paid
-- was ignored, so:
--   * a loan that was fully repaid (principal + interest) stayed 'approved'
--     whenever the last payment was interest-only (the completion test
--     compared principal-only paid to the principal+interest total), and
--   * the over-payment guard allowed extra money beyond what was owed; the
--     excess was booked as interest income (member overcharged).
--
-- FIX: paid-to-date = SUM(principal_paid + interest_paid), i.e. total cash
-- already applied to the loan. The remaining-balance and completion checks
-- now use that figure. Signature is unchanged (CREATE OR REPLACE).
--
-- The body is otherwise identical to 21_financial_integrity.sql.
-- Verified by test/financial-tests.mjs (phase 3, checks R1-R4).
-- ============================================================================

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
  v_receivable_account_id UUID;
  v_interest_account_id UUID;
  v_receivable_outstanding NUMERIC;
  v_to_receivable NUMERIC;
  v_to_interest NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Repayment amount must be greater than zero';
  END IF;

  -- FIN-08: active membership required
  SELECT status INTO v_member_status
  FROM kunity.members
  WHERE id = p_member_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found in this organization';
  END IF;

  IF v_member_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Membership is not active (status: %)', v_member_status;
  END IF;

  -- Lock account (must be active with sufficient funds)
  SELECT * INTO v_account
  FROM kunity.accounts
  WHERE id = p_account_id AND member_id = p_member_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  IF v_account.is_active = false THEN
    RAISE EXCEPTION 'Account is not active';
  END IF;

  IF COALESCE(v_account.cached_balance, 0) < p_amount THEN
    RAISE EXCEPTION 'Insufficient funds';
  END IF;

  -- FIN-01: lock the loan row DIRECTLY. The previous implementation used
  -- SELECT ... LEFT JOIN ... GROUP BY ... FOR UPDATE, which PostgreSQL
  -- rejects ("FOR UPDATE is not allowed with GROUP BY clause") — every loan
  -- repayment failed at runtime.
  SELECT * INTO v_loan
  FROM kunity.loans
  WHERE id = p_loan_id AND member_id = p_member_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan not found';
  END IF;

  -- FIN-26: only a DISBURSED loan can be repaid. Repaying a pending
  -- (never-disbursed) or already-completed loan corrupts the receivable.
  IF v_loan.status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Loan is not in a repayable state (status: %)', v_loan.status;
  END IF;

  -- Aggregate repayments in a separate (lock-free) query; concurrency for the
  -- same loan is serialized by the loan row lock taken above.
  -- FIN-27b: total cash already applied to this loan (principal AND interest).
  SELECT COALESCE(SUM(principal_paid + interest_paid), 0) INTO v_paid
  FROM kunity.loan_repayments
  WHERE loan_id = p_loan_id;

  v_total := v_loan.principal + (v_loan.principal * COALESCE(v_loan.interest_rate, 0) / 100);

  IF p_amount > (v_total - v_paid) + 0.000001 THEN
    RAISE EXCEPTION 'Amount exceeds remaining loan balance';
  END IF;

  -- Update balance
  UPDATE kunity.accounts
  SET cached_balance = cached_balance - p_amount, updated_at = NOW()
  WHERE id = p_account_id;

  -- FIN-21: a wallet repayment moves NO cash — the money was already inside
  -- the SACCO. The journal settles the loan receivable and recognizes
  -- interest income instead of (wrongly) crediting the cash account.
  v_receivable_account_id := kunity._org_system_account(
    p_organization_id, 'SYS-LOANS', 'Loan Receivable', 'asset', '%LOAN%'
  );

  IF v_receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Missing loan receivable account for org %', p_organization_id;
  END IF;

  -- Outstanding receivable for THIS loan = debits - credits posted against
  -- the receivable account with this loan_id (disbursement debits it,
  -- repayments credit it).
  SELECT COALESCE(SUM(debit - credit), 0) INTO v_receivable_outstanding
  FROM kunity.journal_lines
  WHERE account_id = v_receivable_account_id
    AND loan_id = p_loan_id;

  v_to_receivable := LEAST(p_amount, GREATEST(v_receivable_outstanding, 0));
  v_to_interest := p_amount - v_to_receivable;

  IF v_to_interest > 0 THEN
    v_interest_account_id := kunity._org_system_account(
      p_organization_id, 'SYS-INTEREST', 'Interest Income', 'income', '%INTEREST%'
    );

    IF v_interest_account_id IS NULL THEN
      RAISE EXCEPTION 'Missing interest income account for org %', p_organization_id;
    END IF;
  END IF;

  -- Journal (balanced: debit member savings, credit loan receivable
  -- settlement + interest income). Institutional float is UNTOUCHED — no
  -- external cash moves during a wallet repayment.
  INSERT INTO kunity.journal_entries (organization_id, description, created_by, created_at, updated_at)
  VALUES (p_organization_id, 'Loan Repayment', p_member_id, NOW(), NOW())
  RETURNING id INTO v_entry_id;

  INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, loan_id, description, created_at, updated_at)
  VALUES (v_entry_id, p_account_id, p_member_id, 'repayment_principal', p_amount, 0, p_loan_id, 'Member loan repayment', NOW(), NOW());

  INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, loan_id, description, created_at, updated_at)
  VALUES (v_entry_id, v_receivable_account_id, NULL, 'repayment', 0, v_to_receivable, p_loan_id, 'Loan receivable settled', NOW(), NOW());

  IF v_to_interest > 0 THEN
    INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, loan_id, description, created_at, updated_at)
    VALUES (v_entry_id, v_interest_account_id, NULL, 'interest', 0, v_to_interest, p_loan_id, 'Loan interest earned', NOW(), NOW());
  END IF;

  INSERT INTO kunity.loan_repayments (organization_id, loan_id, journal_entry_id, member_id, principal_paid, interest_paid, created_by, created_at)
  VALUES (p_organization_id, p_loan_id, v_entry_id, p_member_id, v_to_receivable, v_to_interest, p_member_id, NOW());

  IF (v_paid + p_amount) >= v_total - 0.000001 THEN
    UPDATE kunity.loans SET status = 'completed', updated_at = NOW() WHERE id = p_loan_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'new_balance', v_account.cached_balance - p_amount);
END;
$$;

REVOKE ALL ON FUNCTION kunity.member_repay_loan_atomic(UUID, UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.member_repay_loan_atomic(UUID, UUID, UUID, UUID, NUMERIC) TO service_role;
