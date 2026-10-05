-- ============================================================================
-- 21_financial_integrity.sql
-- Kunity SACCO — Financial integrity fixes from the pre-launch pentest
--
-- All function signatures are IDENTICAL to the existing production functions
-- so CREATE OR REPLACE applies cleanly. Run on the live database before launch.
--
-- Fixes (see SECURITY_PENTEST_REPORT.md, FIN-01..FIN-13):
--  1. member_repay_loan_atomic: FOR UPDATE + GROUP BY is invalid in Postgres
--     (every repayment errored). Lock the loan row directly, aggregate
--     repayments separately. Also adds loan_repayments table creation.
--  2. Webhook amount drift: the collected amount must match the created
--     payment intent (±0.01). Mismatches fail closed (stay pending) instead
--     of silently overwriting the stored amount.
--  3. account_activation payments now post the same double-entry ledger as
--     deposits (previously: money collected, nothing recorded).
--  4. Withdrawal / repayment / disbursement journal entries are now BALANCED
--     double-entry (member side + organizational cash side), with the
--     institutional float (sacco_wallets) maintained in both directions.
--  5. LivePay deposits now update the member's cached_balance.
--  6. debit_sms_wallet: sufficient-funds check inside the RPC (no negative
--     balances from check-then-debit races).
--  7. credit_sms_wallet_idempotent: refuses to credit a wallet that does not
--     own the transaction being marked processed.
--  8. New refund_sms_wallet RPC: idempotent refunds for failed SMS dispatches
--     (the previous refund path called credit_sms_wallet with a parameter it
--     does not have, so refunds NEVER executed).
--  9. Withdrawals/repayments/loan applications require an ACTIVE membership
--     and (for withdrawals) an ACTIVE account.
-- 10. All account lookups are deterministic (explicit ORDER BY).
-- 11. Intermediate webhook statuses (pending/processing) no longer poison the
--     payment request to 'failed' (which used to permanently drop the deposit
--     via the idempotency guard).
-- ============================================================================

-- ============================================================================
-- 0. loan_repayments table (FIN-01b: referenced by the repayment RPC but never
--    created by any migration in this repository)
-- ============================================================================
CREATE TABLE IF NOT EXISTS kunity.loan_repayments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    loan_id UUID NOT NULL,
    journal_entry_id UUID,
    member_id UUID NOT NULL,
    principal_paid NUMERIC(20,2) NOT NULL DEFAULT 0,
    interest_paid NUMERIC(20,2) NOT NULL DEFAULT 0,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_repayments_loan_id ON kunity.loan_repayments(loan_id);
CREATE INDEX IF NOT EXISTS idx_loan_repayments_member_id ON kunity.loan_repayments(member_id);

-- ============================================================================
-- 0. kunity._org_system_account — FIN-22 helper: resolve an ORGANIZATIONAL
--    (member_id IS NULL) system account deterministically, self-provisioning
--    one if the org has none. The app creates MEMBER wallet accounts with
--    account_category='asset', so any account picker that only filters on
--    org+asset+active can accidentally select a MEMBER's personal account as
--    the organizational cash/receivable account — posting org-wide movements
--    into a member's transaction feed. Every org-account pick in this
--    migration goes through this helper.
-- ============================================================================
CREATE OR REPLACE FUNCTION kunity._org_system_account(
  p_organization_id UUID,
  p_code TEXT,
  p_name TEXT,
  p_category TEXT,
  p_pattern TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, kunity, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  -- 1. Exact code match (organizational accounts only)
  SELECT id INTO v_id
  FROM kunity.accounts
  WHERE organization_id = p_organization_id
    AND member_id IS NULL
    AND code = p_code
  ORDER BY is_system DESC, created_at ASC
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- 2. Fuzzy match on existing organizational accounts (name/code pattern,
  --    system accounts preferred). Operator-created accounts (is_system=false)
  --    with a matching name still count.
  IF p_pattern IS NOT NULL AND p_pattern <> '' THEN
    SELECT id INTO v_id
    FROM kunity.accounts
    WHERE organization_id = p_organization_id
      AND member_id IS NULL
      AND account_category = p_category
      AND (code ILIKE p_pattern OR name ILIKE p_pattern)
    ORDER BY is_system DESC, created_at ASC
    LIMIT 1;

    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  -- 3. Self-provision a system account so the books never depend on manual
  --    setup (idempotent; re-selects if a concurrent transaction created it)
  BEGIN
    INSERT INTO kunity.accounts (
      organization_id, member_id, name, code, account_category,
      currency, cached_balance, is_active, is_system
    ) VALUES (
      p_organization_id, NULL, p_name, p_code, p_category,
      'UGX', 0, true, true
    )
    RETURNING id INTO v_id;

    RETURN v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_id
    FROM kunity.accounts
    WHERE organization_id = p_organization_id
      AND member_id IS NULL
      AND code = p_code
    ORDER BY created_at ASC
    LIMIT 1;

    RETURN v_id;
  END;
END;
$$;

REVOKE ALL ON FUNCTION kunity._org_system_account(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 1. member_withdraw_atomic — balanced double-entry + eligibility checks
-- ============================================================================
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
  v_member_status TEXT;
  v_cash_account_id UUID;
  v_entry_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Withdrawal amount must be greater than zero';
  END IF;

  -- FIN-08: membership must exist, belong to this org, and be ACTIVE
  -- (suspended/pending/rejected members cannot move money)
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

  -- Lock account; FIN-08: must belong to the member and be ACTIVE
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

  -- Update balance
  UPDATE kunity.accounts
  SET cached_balance = cached_balance - p_amount, updated_at = NOW()
  WHERE id = p_account_id;

  -- FIN-04/09/22: deterministic ORGANIZATIONAL cash account (never a member's
  -- personal wallet; self-provisions a system wallet account if none exists)
  v_cash_account_id := kunity._org_system_account(
    p_organization_id, 'SYS-WALLET-01', 'Organizational Mobile Money Wallet', 'asset',
    '%WALLET%'
  );

  IF v_cash_account_id IS NULL THEN
    RAISE EXCEPTION 'Missing organizational cash/wallet asset account for org %', p_organization_id;
  END IF;

  -- Journal (balanced: debit member savings, credit organizational cash)
  INSERT INTO kunity.journal_entries (organization_id, description, created_by, created_at, updated_at)
  VALUES (p_organization_id, 'Wallet Withdrawal', p_member_id, NOW(), NOW())
  RETURNING id INTO v_entry_id;

  INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, description, created_at, updated_at)
  VALUES (v_entry_id, p_account_id, p_member_id, 'withdrawal', p_amount, 0, 'Member withdrawal', NOW(), NOW());

  INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, description, created_at, updated_at)
  VALUES (v_entry_id, v_cash_account_id, NULL, 'withdrawal', 0, p_amount, 'Cash paid out to member', NOW(), NOW());

  -- FIN-04: institutional float decreases when cash leaves the SACCO
  UPDATE kunity.sacco_wallets
  SET balance = balance - p_amount, last_updated = NOW()
  WHERE organization_id = p_organization_id;

  IF NOT FOUND THEN
    INSERT INTO kunity.sacco_wallets (organization_id, balance, last_updated)
    VALUES (p_organization_id, -p_amount, NOW());
  END IF;

  RETURN jsonb_build_object('success', true, 'new_balance', v_account.cached_balance - p_amount);
END;
$$;

-- ============================================================================
-- 2. member_repay_loan_atomic — FIX: FOR UPDATE + GROUP BY is invalid SQL
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
  SELECT COALESCE(SUM(principal_paid), 0) INTO v_paid
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

-- ============================================================================
-- 3. member_apply_loan — verify the applicant is an ACTIVE member of the org
-- ============================================================================
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
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Loan amount must be greater than zero';
  END IF;

  -- FIN-08: only active members of this organization may apply
  SELECT status INTO v_member_status
  FROM kunity.members
  WHERE id = p_member_id AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found in this organization';
  END IF;

  IF v_member_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Membership is not active (status: %)', v_member_status;
  END IF;

  INSERT INTO kunity.loans (organization_id, member_id, principal, interest_rate, status, created_by, created_at, updated_at)
  VALUES (p_organization_id, p_member_id, p_amount, 10, 'pending', p_member_id, NOW(), NOW())
  RETURNING id INTO v_loan_id;

  RETURN jsonb_build_object('success', true, 'loan_id', v_loan_id);
END;
$$;

-- ============================================================================
-- 4. disburse_loan_atomic — FIN-20: internal transfer (receivable <-> wallet);
--    balanced double-entry; institutional float NOT touched at disbursement
-- ============================================================================
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
  v_receivable_account_id UUID;
  v_entry_id UUID;
BEGIN
  -- 1. Lock and fetch loan (must belong to the borrower)
  SELECT * INTO v_loan
  FROM kunity.loans
  WHERE id = p_loan_id AND organization_id = p_organization_id AND member_id = p_member_id
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

  -- 3. Lock and fetch the member's account. FIN-09/22: prefer the
  --    member_savings-linked account (the app's canonical linkage), then the
  --    member's accounts table entries. The picked account MUST be active —
  --    loan proceeds must not land in a frozen/pending wallet.
  SELECT a.* INTO v_account
  FROM kunity.accounts a
  JOIN kunity.member_savings ms ON ms.account_id = a.id
  WHERE a.member_id = p_member_id
    AND a.organization_id = p_organization_id
    AND ms.organization_id = p_organization_id
    AND ms.deleted_at IS NULL
  ORDER BY (CASE WHEN ms.status = 'active' THEN 0 ELSE 1 END),
           (CASE WHEN a.is_active THEN 0 ELSE 1 END),
           a.created_at ASC
  LIMIT 1
  FOR UPDATE OF a;

  IF v_account.id IS NULL THEN
    SELECT * INTO v_account
    FROM kunity.accounts
    WHERE member_id = p_member_id AND organization_id = p_organization_id
    ORDER BY is_active DESC, created_at ASC
    LIMIT 1
    FOR UPDATE;
  END IF;

  IF v_account.id IS NULL THEN
    RAISE EXCEPTION 'Member wallet account not found in this organization';
  END IF;

  IF v_account.is_active = false THEN
    RAISE EXCEPTION 'Member wallet account is not active';
  END IF;

  -- 4. Update account balance (loan proceeds land in the member's wallet)
  UPDATE kunity.accounts
  SET cached_balance = COALESCE(cached_balance, 0) + p_disbursement_amount, updated_at = NOW()
  WHERE id = v_account.id;

  -- 5. FIN-20: disbursement is an INTERNAL transfer — the loan receivable is
  --    created and the member's wallet is credited. NO cash leaves the SACCO
  --    here (the member withdraws the proceeds later, which is when the
  --    float decrements), so the organizational float is UNTOUCHED and the
  --    journal must NOT debit the cash account.
  v_receivable_account_id := kunity._org_system_account(
    p_organization_id, 'SYS-LOANS', 'Loan Receivable', 'asset', '%LOAN%'
  );

  IF v_receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Missing loan receivable account for org %', p_organization_id;
  END IF;

  -- 6. Journal (balanced: debit loan receivable, credit member account)
  INSERT INTO kunity.journal_entries (organization_id, description, created_at, updated_at)
  VALUES (p_organization_id, 'Loan Disbursement (Loan ID: ' || left(p_loan_id::text, 8) || ')', NOW(), NOW())
  RETURNING id INTO v_entry_id;

  INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, loan_id, description, created_at, updated_at)
  VALUES (v_entry_id, v_receivable_account_id, NULL, 'loan_disbursement', p_disbursement_amount, 0, p_loan_id, 'Loan receivable created', NOW(), NOW());

  INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, loan_id, description, created_at, updated_at)
  VALUES (v_entry_id, v_account.id, p_member_id, 'loan_disbursement', 0, p_disbursement_amount, p_loan_id, 'Loan proceeds credited to member', NOW(), NOW());

  RETURN jsonb_build_object('success', true, 'message', 'Loan successfully approved and funds disbursed');
END;
$$;

-- ============================================================================
-- 5. process_najiki_webhook — amount-drift protection, activation ledger,
--    intermediate statuses, deterministic accounts, balanced entries
-- ============================================================================
CREATE OR REPLACE FUNCTION kunity.process_najiki_webhook(
  p_reference TEXT,
  p_status TEXT,
  p_amount NUMERIC,
  p_external_entity_id TEXT,
  p_payment_type TEXT,
  p_payload JSONB,
  p_fee NUMERIC DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, kunity, pg_temp
AS $$
DECLARE
  v_pr kunity.payment_requests%ROWTYPE;
  v_net_amount NUMERIC;
  v_journal_entry_id UUID;
  v_cash_account_id UUID;
  v_member_account_id UUID;
  v_fee_account_id UUID;
  v_is_success BOOLEAN;
  v_is_failure BOOLEAN;
  v_fee NUMERIC;
  v_effective_type TEXT;
  v_is_activation BOOLEAN := false;
  v_payload_currency TEXT;
  -- FIN-17: %TYPE so the assignment works whether the live column is the
  -- kunity.payment_status enum or plain text (the original CASE-of-literals
  -- pattern crashes with 42804 when the column is the enum type).
  v_new_status kunity.payment_requests.status%TYPE;
BEGIN
  v_is_success := (p_status IN ('success', 'successful'));
  v_is_failure := (p_status IN ('failed', 'failure', 'cancelled', 'canceled', 'expired', 'rejected'));

  --------------------------------------------------------------------------
  -- 1. Validate inputs
  --------------------------------------------------------------------------
  IF p_amount IS NOT NULL AND p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid amount');
  END IF;

  IF p_fee IS NOT NULL AND (p_fee < 0 OR (p_amount IS NOT NULL AND p_fee > p_amount)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid fee');
  END IF;

  --------------------------------------------------------------------------
  -- 2. Find and lock payment request
  --------------------------------------------------------------------------
  SELECT * INTO v_pr
  FROM kunity.payment_requests
  WHERE internal_reference = p_reference
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown payment reference');
  END IF;

  --------------------------------------------------------------------------
  -- 3. Idempotency check
  --------------------------------------------------------------------------
  IF v_pr.status IN ('success', 'failed') OR v_pr.journal_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'message', 'Already processed',
      'payment_request_id', v_pr.id,
      'status', v_pr.status,
      'journal_entry_id', v_pr.journal_entry_id
    );
  END IF;

  --------------------------------------------------------------------------
  -- 4. FIN-02: amount consistency — the collected amount must match the
  --    created payment intent (±0.01). Any drift fails CLOSED (stays pending)
  --    so operations can investigate instead of silently re-rating the
  --    payment to whatever the webhook claims.
  --------------------------------------------------------------------------
  IF p_amount IS NOT NULL AND ABS(COALESCE(v_pr.amount, 0) - p_amount) > 0.01 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Amount mismatch: refusing to process payment whose collected amount differs from the intent',
      'stored_amount', v_pr.amount,
      'webhook_amount', p_amount
    );
  END IF;

  IF p_amount IS NOT NULL THEN
    v_pr.amount := p_amount;
  END IF;
  v_fee := COALESCE(p_fee, 0);

  --------------------------------------------------------------------------
  -- 4b. FIN-24: currency consistency — the collected currency must match the
  --     intent's currency. Amounts matching numerically across DIFFERENT
  --     currencies would credit UGX books with foreign-currency money.
  --     (The webhook payload carries the gateway currency.)
  --------------------------------------------------------------------------
  v_payload_currency := NULLIF(LOWER(TRIM(COALESCE(p_payload->>'currency', ''))), '');
  IF v_payload_currency IS NOT NULL
     AND v_pr.currency IS NOT NULL
     AND NULLIF(LOWER(TRIM(v_pr.currency::text)), '') IS NOT NULL
     AND v_payload_currency <> LOWER(TRIM(v_pr.currency::text)) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Currency mismatch: refusing to process payment in a different currency than the intent',
      'stored_currency', v_pr.currency,
      'webhook_currency', v_payload_currency
    );
  END IF;

  --------------------------------------------------------------------------
  -- 4c. FIN-23: payment-type whitelist. The payment type is client-controllable
  --     at intent creation; previously ANY unrecognized type flipped the
  --     request to 'success' with NO ledger posting ("no specific action
  --     taken") — money collected, nothing recorded, member never credited.
  --     Unknown types now FAIL CLOSED: the request stays 'pending' and is
  --     flagged for review. ('BUY_SMS' topups are credited application-side
  --     from wallet_transactions and never need RPC-side ledger posting.)
  --------------------------------------------------------------------------
  v_effective_type := COALESCE(NULLIF(p_payment_type, ''), v_pr.payment_type, 'deposit');
  IF v_is_success
     AND v_effective_type NOT IN ('deposit', 'account_activation')
     AND v_pr.internal_reference NOT LIKE 'PAY-ACT-%' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Unrecognized payment type — held for review',
      'payment_type', v_effective_type,
      'payment_request_id', v_pr.id
    );
  END IF;

  --------------------------------------------------------------------------
  -- 5. FIN-10: intermediate statuses (pending/processing) must NOT flip the
  --    request to 'failed' — that used to permanently drop the deposit via
  --    the idempotency guard when the final success webhook arrived.
  --------------------------------------------------------------------------
  IF NOT v_is_success AND NOT v_is_failure THEN
    UPDATE kunity.payment_requests
    SET payload = p_payload
    WHERE id = v_pr.id;
    RETURN jsonb_build_object('message', 'Intermediate status recorded; awaiting final status');
  END IF;

  --------------------------------------------------------------------------
  -- 6. Update payment request status and metadata
  --------------------------------------------------------------------------
  v_new_status := CASE WHEN v_is_success THEN 'success' ELSE 'failed' END;
  UPDATE kunity.payment_requests
  SET
    status = v_new_status,
    payload = p_payload,
    amount = v_pr.amount,
    fee = v_fee,
    completed_at = CURRENT_TIMESTAMP
  WHERE id = v_pr.id
  RETURNING * INTO v_pr;

  IF NOT v_is_success THEN
    RETURN jsonb_build_object('message', 'Payment failed, updated status', 'payment_request_id', v_pr.id);
  END IF;

  v_effective_type := COALESCE(NULLIF(p_payment_type, ''), v_pr.payment_type, 'deposit');

  --------------------------------------------------------------------------
  -- 7. Account activation flow: activate memberships/accounts AND record the
  --    money (FIN-03: previously the collected amount vanished from the books)
  --------------------------------------------------------------------------
  IF v_effective_type = 'account_activation' OR v_pr.internal_reference LIKE 'PAY-ACT-%' THEN
    v_is_activation := true;

    UPDATE kunity.member_savings
    SET status = 'active'
    WHERE member_id = v_pr.member_id
      AND organization_id = v_pr.organization_id;

    UPDATE kunity.accounts
    SET is_active = true
    WHERE member_id = v_pr.member_id
      AND organization_id = v_pr.organization_id;
  END IF;

  --------------------------------------------------------------------------
  -- 8. Ledger posting for deposit / account_activation payments.
  --    Unknown payment types keep the original no-action behaviour.
  --------------------------------------------------------------------------
  IF v_effective_type IN ('deposit', 'account_activation') OR v_effective_type IS NULL OR v_effective_type = '' THEN
    -- A. Deterministic member account (FIN-09): prefer member_savings (active
    --    first), then the member's accounts table entries.
    SELECT ms.account_id INTO v_member_account_id
    FROM kunity.member_savings ms
    WHERE ms.organization_id = v_pr.organization_id
      AND ms.member_id = v_pr.member_id
      AND ms.account_id IS NOT NULL
    ORDER BY (CASE WHEN ms.status = 'active' THEN 0 ELSE 1 END), ms.created_at ASC
    LIMIT 1;

    IF v_member_account_id IS NULL THEN
      SELECT id INTO v_member_account_id
      FROM kunity.accounts
      WHERE organization_id = v_pr.organization_id
        AND member_id = v_pr.member_id
      ORDER BY is_active DESC, created_at ASC
      LIMIT 1;
    END IF;

    IF v_member_account_id IS NULL THEN
      RAISE EXCEPTION 'Missing member account for member %', v_pr.member_id;
    END IF;

    -- B. FIN-22: deterministic ORGANIZATIONAL cash account (member_id IS
    --    NULL — the app creates member wallets as account_category='asset',
    --    so an unscoped pick could post org cash to a member's personal
    --    account). Self-provisions a system wallet if none exists.
    v_cash_account_id := kunity._org_system_account(
      v_pr.organization_id, 'SYS-WALLET-01', 'Organizational Mobile Money Wallet', 'asset',
      '%WALLET%'
    );

    IF v_cash_account_id IS NULL THEN
      RAISE EXCEPTION 'Missing cash/wallet asset account for org %', v_pr.organization_id;
    END IF;

    -- C. Fee account (optional). FIN-11: if a fee is charged but no fee
    --    account is configured, do NOT deduct the fee from the member — an
    --    entry must always balance (debit gross = credit net + credit fee).
    IF v_fee > 0 THEN
      SELECT id INTO v_fee_account_id
      FROM kunity.accounts
      WHERE organization_id = v_pr.organization_id
        AND member_id IS NULL
        AND account_category IN ('income', 'expense')
        AND is_active = true
        AND is_system = true
        AND (code ILIKE 'FEE%' OR name ILIKE '%Fee%' OR name ILIKE '%Charge%')
      ORDER BY created_at ASC
      LIMIT 1;

      IF v_fee_account_id IS NULL THEN
        v_fee := 0;
        UPDATE kunity.payment_requests SET fee = 0 WHERE id = v_pr.id;
        v_pr.fee := 0;
      END IF;
    END IF;

    v_net_amount := v_pr.amount - v_fee;

    -- D. Journal entry header
    INSERT INTO kunity.journal_entries (
      organization_id, reference, description, entry_date, source_module
    ) VALUES (
      v_pr.organization_id,
      COALESCE(p_reference, v_pr.internal_reference),
      CASE WHEN v_is_activation THEN 'Najiki Account Activation Deposit' ELSE 'Najiki Webhook Deposit' END,
      CURRENT_DATE,
      'najiki_webhook'
    ) RETURNING id INTO v_journal_entry_id;

    UPDATE kunity.payment_requests
    SET journal_entry_id = v_journal_entry_id
    WHERE id = v_pr.id;

    -- E. Balanced double-entry lines
    INSERT INTO kunity.journal_lines (
      journal_entry_id, account_id, member_id, line_type, debit, credit, description
    ) VALUES (
      v_journal_entry_id, v_cash_account_id, NULL, 'deposit', v_pr.amount, 0, 'Gross gateway deposit'
    );

    INSERT INTO kunity.journal_lines (
      journal_entry_id, account_id, member_id, line_type, debit, credit, description
    ) VALUES (
      v_journal_entry_id, v_member_account_id, v_pr.member_id, 'deposit', 0, v_net_amount, 'Member net deposit'
    );

    IF v_fee > 0 AND v_fee_account_id IS NOT NULL THEN
      INSERT INTO kunity.journal_lines (
        journal_entry_id, account_id, member_id, line_type, debit, credit, description
      ) VALUES (
        v_journal_entry_id, v_fee_account_id, NULL, 'fee', 0, v_fee, 'Gateway processing fee'
      );
    END IF;

    -- F. Member's spendable balance
    UPDATE kunity.accounts
    SET cached_balance = COALESCE(cached_balance, 0) + v_net_amount, updated_at = NOW()
    WHERE id = v_member_account_id;

    -- G. Institutional float (gross cash received)
    UPDATE kunity.sacco_wallets
    SET balance = balance + v_pr.amount, last_updated = CURRENT_TIMESTAMP
    WHERE organization_id = v_pr.organization_id;

    IF NOT FOUND THEN
      INSERT INTO kunity.sacco_wallets (organization_id, balance, last_updated)
      VALUES (v_pr.organization_id, v_pr.amount, CURRENT_TIMESTAMP);
    END IF;

    RETURN jsonb_build_object(
      'message', 'Success recorded. Journal entries created.',
      'payment_request_id', v_pr.id,
      'journal_entry_id', v_journal_entry_id,
      'member_account_id', v_member_account_id,
      'gross_amount', v_pr.amount,
      'fee', v_fee,
      'net_amount', v_net_amount,
      'activation', v_is_activation
    );
  END IF;

  RETURN jsonb_build_object(
    'message', 'Payment successful but no specific action taken',
    'payment_request_id', v_pr.id,
    'payment_type', v_effective_type
  );
END;
$$;

-- ============================================================================
-- 6. process_livepay_webhook — amount-drift protection, member balance credit,
--    intermediate statuses, deterministic accounts
-- ============================================================================
CREATE OR REPLACE FUNCTION kunity.process_livepay_webhook(
  p_internal_reference TEXT,
  p_status TEXT,
  p_amount NUMERIC,
  p_fee NUMERIC,
  p_currency TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, kunity, pg_temp
AS $$
DECLARE
  v_pr kunity.payment_requests%ROWTYPE;
  v_net_amount NUMERIC;
  v_journal_entry_id UUID;
  v_cash_account_id UUID;
  v_member_account_id UUID;
  v_fee_account_id UUID;
  v_is_success BOOLEAN;
  v_is_failure BOOLEAN;
  -- FIN-17: %TYPE so the assignment works whether the live column is the
  -- kunity.payment_status enum or plain text.
  v_new_status kunity.payment_requests.status%TYPE;
BEGIN
  v_is_success := (p_status IN ('success', 'successful'));
  v_is_failure := (p_status IN ('failed', 'failure', 'cancelled', 'canceled', 'expired', 'rejected'));

  -- 1. Validate inputs
  IF p_amount IS NOT NULL AND p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid amount');
  END IF;

  IF p_fee IS NOT NULL AND (p_fee < 0 OR (p_amount IS NOT NULL AND p_fee > p_amount)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid fee');
  END IF;

  -- 2. Fetch the payment request
  SELECT * INTO v_pr
  FROM kunity.payment_requests
  WHERE internal_reference = p_internal_reference
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown payment reference');
  END IF;

  -- 3. Idempotency check
  IF v_pr.status::text IN ('success', 'failed') OR v_pr.journal_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'message', 'Already processed',
      'payment_request_id', v_pr.id,
      'status', v_pr.status,
      'journal_entry_id', v_pr.journal_entry_id
    );
  END IF;

  -- 4. FIN-02: amount consistency (±0.01), fail closed on drift
  IF p_amount IS NOT NULL AND ABS(COALESCE(v_pr.amount, 0) - p_amount) > 0.01 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Amount mismatch: refusing to process payment whose collected amount differs from the intent',
      'stored_amount', v_pr.amount,
      'webhook_amount', p_amount
    );
  END IF;

  IF p_amount IS NOT NULL THEN
    v_pr.amount := p_amount;
  END IF;

  -- 4b. FIN-24: currency consistency (fail closed on mismatch)
  IF p_currency IS NOT NULL
     AND NULLIF(TRIM(p_currency), '') IS NOT NULL
     AND v_pr.currency IS NOT NULL
     AND NULLIF(TRIM(v_pr.currency::text), '') IS NOT NULL
     AND LOWER(TRIM(p_currency)) <> LOWER(TRIM(v_pr.currency::text)) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Currency mismatch: refusing to process payment in a different currency than the intent',
      'stored_currency', v_pr.currency,
      'webhook_currency', p_currency
    );
  END IF;

  -- 4c. FIN-23: payment-type whitelist (fail closed on unknown types).
  --     LivePay intents are member deposits/activations only.
  IF v_is_success
     AND COALESCE(NULLIF(v_pr.payment_type, ''), 'deposit') NOT IN ('deposit', 'account_activation')
     AND v_pr.internal_reference NOT LIKE 'PAY-ACT-%' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Unrecognized payment type — held for review',
      'payment_type', v_pr.payment_type,
      'payment_request_id', v_pr.id
    );
  END IF;

  -- 5. FIN-10: intermediate statuses must not poison the request
  IF NOT v_is_success AND NOT v_is_failure THEN
    UPDATE kunity.payment_requests
    SET payload = p_payload
    WHERE id = v_pr.id;
    RETURN jsonb_build_object('message', 'Intermediate status recorded; awaiting final status');
  END IF;

  -- 6. Update status (FIN-17: %TYPE-typed value works for enum AND text columns)
  v_new_status := CASE WHEN v_is_success THEN 'success' ELSE 'failed' END;
  UPDATE kunity.payment_requests
  SET
    status = v_new_status,
    payload = p_payload,
    fee = COALESCE(p_fee, 0),
    amount = v_pr.amount,
    completed_at = now()
  WHERE id = v_pr.id
  RETURNING * INTO v_pr;

  -- 7. If the payment failed, stop (no ledger entries)
  IF NOT v_is_success THEN
    RETURN jsonb_build_object('message', 'Payment failed, updated status', 'payment_request_id', v_pr.id);
  END IF;

  -- 8. Payment successful -> double-entry ledger
  v_net_amount := v_pr.amount - COALESCE(v_pr.fee, 0);

  -- 8A. FIN-22: deterministic ORGANIZATIONAL cash account (member_id IS
  --     NULL; self-provisions a system wallet if none exists)
  v_cash_account_id := kunity._org_system_account(
    v_pr.organization_id, 'SYS-WALLET-01', 'Organizational Mobile Money Wallet', 'asset',
    '%WALLET%'
  );

  IF v_cash_account_id IS NULL THEN
    RAISE EXCEPTION 'Missing primary cash/wallet asset account for org %', v_pr.organization_id;
  END IF;

  -- 8B. Deterministic member savings account
  SELECT ms.account_id INTO v_member_account_id
  FROM kunity.member_savings ms
  WHERE ms.organization_id = v_pr.organization_id
    AND ms.member_id = v_pr.member_id
    AND ms.account_id IS NOT NULL
  ORDER BY (CASE WHEN ms.status = 'active' THEN 0 ELSE 1 END), ms.created_at ASC
  LIMIT 1;

  IF v_member_account_id IS NULL THEN
    SELECT id INTO v_member_account_id
    FROM kunity.accounts
    WHERE organization_id = v_pr.organization_id
      AND member_id = v_pr.member_id
    ORDER BY is_active DESC, created_at ASC
    LIMIT 1;
  END IF;

  IF v_member_account_id IS NULL THEN
    RAISE EXCEPTION 'Missing member account for member %', v_pr.member_id;
  END IF;

  -- 8C. Fee account (required when a fee is charged, matching original behavior)
  IF COALESCE(v_pr.fee, 0) > 0 THEN
    SELECT id INTO v_fee_account_id
    FROM kunity.accounts
    WHERE organization_id = v_pr.organization_id
      AND member_id IS NULL
      AND account_category IN ('income', 'expense')
      AND is_active = true
      AND is_system = true
      AND (code ILIKE 'FEE%' OR name ILIKE '%Fee%')
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_fee_account_id IS NULL THEN
      RAISE EXCEPTION 'Missing system fee account for org %. Cannot process fee of %.', v_pr.organization_id, v_pr.fee;
    END IF;
  END IF;

  -- 9. Journal entry header
  INSERT INTO kunity.journal_entries (
    organization_id, reference, description, entry_date, source_module
  ) VALUES (
    v_pr.organization_id,
    v_pr.internal_reference,
    'LivePay Webhook Deposit',
    CURRENT_DATE,
    'livepay_webhook'
  ) RETURNING id INTO v_journal_entry_id;

  UPDATE kunity.payment_requests
  SET journal_entry_id = v_journal_entry_id
  WHERE id = v_pr.id;

  -- 10. Balanced journal lines
  INSERT INTO kunity.journal_lines (
    journal_entry_id, account_id, member_id, line_type, debit, credit, description
  ) VALUES (
    v_journal_entry_id, v_cash_account_id, NULL, 'deposit', v_pr.amount, 0, 'LivePay Gross Deposit'
  );

  INSERT INTO kunity.journal_lines (
    journal_entry_id, account_id, member_id, line_type, debit, credit, description
  ) VALUES (
    v_journal_entry_id, v_member_account_id, v_pr.member_id, 'deposit', 0, v_net_amount, 'Member Net Saving'
  );

  IF v_fee_account_id IS NOT NULL AND COALESCE(v_pr.fee, 0) > 0 THEN
    INSERT INTO kunity.journal_lines (
      journal_entry_id, account_id, member_id, line_type, debit, credit, description
    ) VALUES (
      v_journal_entry_id, v_fee_account_id, NULL, 'fee', 0, v_pr.fee, 'LivePay Processing Fee'
    );
  END IF;

  -- 11. FIN-05: the member's spendable balance was NEVER updated by the
  --     original LivePay flow — deposits were invisible for withdrawals.
  UPDATE kunity.accounts
  SET cached_balance = COALESCE(cached_balance, 0) + v_net_amount, updated_at = NOW()
  WHERE id = v_member_account_id;

  -- 12. Institutional float
  UPDATE kunity.sacco_wallets
  SET balance = balance + v_pr.amount, last_updated = now()
  WHERE organization_id = v_pr.organization_id;

  IF NOT FOUND THEN
    INSERT INTO kunity.sacco_wallets (organization_id, balance, last_updated)
    VALUES (v_pr.organization_id, v_pr.amount, now());
  END IF;

  RETURN jsonb_build_object(
    'message', 'Success recorded. Journal entries created.',
    'payment_request_id', v_pr.id,
    'journal_entry_id', v_journal_entry_id
  );
END;
$$;

-- ============================================================================
-- 7. debit_sms_wallet — FIN-07: sufficient-funds check inside the RPC.
--    Previously the balance was only checked in application code (TOCTOU),
--    so concurrent dispatches could drive the wallet negative.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.debit_sms_wallet(
    p_wallet_id text,
    p_amount numeric,
    p_idempotency_key text,
    p_tenant_id text,
    p_description text DEFAULT 'SMS deduction'
)
RETURNS SETOF public.wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wallet public.wallets%ROWTYPE;
BEGIN
  -- 1) Input validation
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be a positive number';
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'Idempotency key is required';
  END IF;

  -- 2) Lock the wallet row (serializes concurrent debits)
  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE id::text = p_wallet_id
  FOR UPDATE;

  IF v_wallet.id IS NULL THEN
    RAISE EXCEPTION 'Wallet not found: %', p_wallet_id;
  END IF;

  -- 3) Idempotent replay: this debit already executed — never debit twice
  IF EXISTS (
    SELECT 1 FROM public.wallet_transactions
    WHERE wallet_id::text = p_wallet_id
      AND reference = p_idempotency_key
      AND direction = 'debit'
  ) THEN
    RETURN NEXT v_wallet;
    RETURN;
  END IF;

  -- 4) FIN-07: atomic sufficient-funds check (fail closed)
  IF v_wallet.balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient funds: balance %, required %', v_wallet.balance, p_amount;
  END IF;

  -- 5) Ledger the debit
  INSERT INTO public.wallet_transactions (
    id, wallet_id, tenant_id, direction, amount, currency, note,
    reference, description, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_wallet.id, v_wallet.tenant_id, 'debit', p_amount, 'UGX',
    'success', p_idempotency_key, p_description, now(), now()
  );

  -- 6) Deduct
  UPDATE public.wallets
  SET balance = balance - p_amount, updated_at = now()
  WHERE id = v_wallet.id
  RETURNING * INTO v_wallet;

  RETURN NEXT v_wallet;
  RETURN;
END;
$$;

-- ============================================================================
-- 8. credit_sms_wallet_idempotent — FIN-13: the credited wallet must own the
--    transaction being marked processed.
--    FIN-18: parameters changed UUID -> TEXT and all id comparisons use
--    ::text, because public.wallets / public.wallet_transactions are created
--    outside the repo migrations and their id types are not guaranteed
--    (the original debit RPC compares uuid = text, which errors — one of the
--    two original wallet RPCs could never run depending on the live type).
--    The app only ever passes string ids via PostgREST, so text parameters
--    accept both uuid and text columns.
-- ============================================================================
DROP FUNCTION IF EXISTS public.credit_sms_wallet_idempotent(UUID, UUID, NUMERIC);
CREATE OR REPLACE FUNCTION public.credit_sms_wallet_idempotent(
    p_wallet_id TEXT,
    p_transaction_id TEXT,
    p_amount NUMERIC
)
RETURNS SETOF public.wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, kunity, pg_temp
AS $$
DECLARE
    v_tx RECORD;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be positive';
    END IF;

    -- Lock transaction row (schema-agnostic: works for uuid and text ids)
    SELECT * INTO v_tx
    FROM public.wallet_transactions
    WHERE id::text = p_transaction_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Transaction not found';
    END IF;

    -- FIN-13: ownership guard — never credit wallet X from wallet Y's transaction
    IF v_tx.wallet_id IS NOT NULL AND v_tx.wallet_id::text <> p_wallet_id THEN
        RAISE EXCEPTION 'Transaction % does not belong to wallet %', p_transaction_id, p_wallet_id;
    END IF;

    IF v_tx.note = 'success' OR v_tx.status = 'success' THEN
        -- Already credited
        RETURN QUERY SELECT * FROM public.wallets WHERE id::text = p_wallet_id;
        RETURN;
    END IF;

    -- Mark as success
    UPDATE public.wallet_transactions
    SET note = 'success', status = 'success', updated_at = NOW()
    WHERE id::text = p_transaction_id;

    -- Credit wallet
    RETURN QUERY
    UPDATE public.wallets
    SET balance = balance + p_amount, updated_at = NOW()
    WHERE id::text = p_wallet_id
    RETURNING *;
END;
$$;

-- ============================================================================
-- 9. refund_sms_wallet — NEW idempotent refund RPC.
--    The application previously refunded failed SMS dispatches by calling
--    credit_sms_wallet with a third parameter that function does not accept,
--    so the refund call ALWAYS failed and tenants were charged for messages
--    that never went out. (FIN-06)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.refund_sms_wallet(
    p_wallet_id text,
    p_amount numeric,
    p_reference text
)
RETURNS SETOF public.wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wallet public.wallets%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be a positive number';
  END IF;

  IF p_reference IS NULL OR length(trim(p_reference)) = 0 THEN
    RAISE EXCEPTION 'Refund reference is required';
  END IF;

  -- Lock the wallet row
  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE id::text = p_wallet_id
  FOR UPDATE;

  IF v_wallet.id IS NULL THEN
    RAISE EXCEPTION 'Wallet not found: %', p_wallet_id;
  END IF;

  -- Idempotent replay: this refund already executed — never refund twice
  IF EXISTS (
    SELECT 1 FROM public.wallet_transactions
    WHERE wallet_id::text = p_wallet_id
      AND reference = p_reference
      AND direction = 'credit'
  ) THEN
    RETURN NEXT v_wallet;
    RETURN;
  END IF;

  -- Ledger the refund
  INSERT INTO public.wallet_transactions (
    id, wallet_id, tenant_id, direction, amount, currency, note,
    reference, description, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_wallet.id, v_wallet.tenant_id, 'credit', p_amount, 'UGX',
    'refund', p_reference, 'SMS refund (failed dispatch)', now(), now()
  );

  -- Credit wallet
  UPDATE public.wallets
  SET balance = balance + p_amount, updated_at = now()
  WHERE id = v_wallet.id
  RETURNING * INTO v_wallet;

  RETURN NEXT v_wallet;
  RETURN;
END;
$$;

-- ============================================================================
-- 10. Permissions (mirror the platform lockdown posture)
-- ============================================================================
REVOKE ALL ON FUNCTION kunity.member_withdraw_atomic(UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.member_withdraw_atomic(UUID, UUID, UUID, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION kunity.member_repay_loan_atomic(UUID, UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.member_repay_loan_atomic(UUID, UUID, UUID, UUID, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION kunity.member_apply_loan(UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.member_apply_loan(UUID, UUID, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION kunity.disburse_loan_atomic(UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.disburse_loan_atomic(UUID, UUID, UUID, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION kunity.process_najiki_webhook(TEXT, TEXT, NUMERIC, TEXT, TEXT, JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.process_najiki_webhook(TEXT, TEXT, NUMERIC, TEXT, TEXT, JSONB, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION kunity.process_livepay_webhook(TEXT, TEXT, NUMERIC, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.process_livepay_webhook(TEXT, TEXT, NUMERIC, NUMERIC, TEXT, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.debit_sms_wallet(TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_sms_wallet(TEXT, NUMERIC, TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.credit_sms_wallet_idempotent(TEXT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_sms_wallet_idempotent(TEXT, TEXT, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION public.refund_sms_wallet(TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_sms_wallet(TEXT, NUMERIC, TEXT) TO service_role;
