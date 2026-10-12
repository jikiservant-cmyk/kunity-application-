-- ============================================================================
-- 27: Atomic payment-success RPC (replaces process_najiki_webhook).
--
-- Division of responsibility (agreed):
--   * THIS function verifies the payment against the STORED request and
--     records the money in one transaction: payment status, the double-entry
--     journal, member balances, and activation of accounts / savings.
--   * trg_activate_member_on_activation_payment (migration 25) then sets
--     members.status = 'active' from the recorded success, in the same
--     transaction.
--
-- Verification (all against the stored payment_requests row, never against
-- caller-supplied values alone):
--   - amount must equal the stored amount (+/- 0.01)
--   - currency in the payload, if given, must equal the stored currency
--   - payment type: a caller-supplied type must equal the stored type
--   - only deposit, account_activation and BUY_SMS are accepted; anything else
--     is held (status stays pending) for review
--   - an activation must be at least kunity.activation_fee_minimum()
--
-- Failures that cannot be posted (missing accounts) RAISE, which rolls back the
-- whole transaction; the request stays pending and the gateway can retry.
--
-- Enum-safe: status is assigned from plain literals, so it works whether the
-- column is the payment_status enum or text (see the FIN-17 note).
--
-- Activation fee destination: the system income account with code 'ACT_FEE'
-- (created per organization below). The fee is recognised as income, and it
-- is NOT credited to the member's withdrawable balance. Change this here if
-- the SACCO decides otherwise.
-- ============================================================================

-- Income account for activation fees, one per organization (idempotent).
INSERT INTO kunity.accounts (organization_id, name, code, account_category, currency, cached_balance, is_active, is_system)
SELECT o.id, 'Activation Fee Income', 'ACT_FEE', 'income', 'UGX', 0, true, true
FROM kunity.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM kunity.accounts a WHERE a.organization_id = o.id AND a.code = 'ACT_FEE'
);

CREATE OR REPLACE FUNCTION kunity.process_najiki_webhook(
  p_reference text,
  p_status text,
  p_amount numeric,
  p_external_entity_id text,
  p_payment_type text,
  p_payload jsonb,
  p_fee numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'kunity', 'pg_temp'
AS $function$
DECLARE
  v_pr kunity.payment_requests%ROWTYPE;
  v_new_status kunity.payment_requests.status%TYPE;
  v_is_success boolean;
  v_is_failure boolean;
  v_fee numeric;
  v_net numeric;
  v_type text;
  v_is_activation boolean;
  v_currency text;
  v_payload_currency text;
  v_cash_id uuid;
  v_member_account_id uuid;
  v_fee_account_id uuid;
  v_journal_entry_id uuid;
BEGIN
  v_is_success := p_status IN ('success', 'successful');
  v_is_failure := p_status IN ('failed', 'failure', 'cancelled', 'canceled', 'expired', 'rejected');

  -- 1. Input validation
  IF p_amount IS NOT NULL AND p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid amount');
  END IF;
  IF p_fee IS NOT NULL AND (p_fee < 0 OR (p_amount IS NOT NULL AND p_fee > p_amount)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid fee');
  END IF;

  -- 2. Find and lock the stored payment request
  SELECT * INTO v_pr
  FROM kunity.payment_requests
  WHERE internal_reference = p_reference
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown payment reference');
  END IF;

  -- 3. Idempotency
  IF v_pr.status::text IN ('success', 'failed') OR v_pr.journal_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'message', 'Already processed',
      'payment_request_id', v_pr.id,
      'status', v_pr.status::text,
      'journal_entry_id', v_pr.journal_entry_id
    );
  END IF;

  -- 4. Failure: record it and stop
  IF NOT v_is_success AND NOT v_is_failure THEN
    UPDATE kunity.payment_requests SET payload = p_payload WHERE id = v_pr.id;
    RETURN jsonb_build_object('message', 'Intermediate status recorded; awaiting final status', 'payment_request_id', v_pr.id);
  END IF;
  IF NOT v_is_success THEN
    v_new_status := 'failed';
    UPDATE kunity.payment_requests
    SET status = v_new_status, payload = p_payload, completed_at = CURRENT_TIMESTAMP
    WHERE id = v_pr.id;
    RETURN jsonb_build_object('message', 'Payment failed, updated status', 'payment_request_id', v_pr.id);
  END IF;

  -- 5. Verify a success against the STORED request
  IF p_amount IS NULL OR ABS(COALESCE(v_pr.amount, 0) - p_amount) > 0.01 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount mismatch: collected amount differs from the payment intent',
      'stored_amount', v_pr.amount, 'webhook_amount', p_amount);
  END IF;

  v_currency := UPPER(COALESCE(NULLIF(TRIM(v_pr.currency::text), ''), 'UGX'));
  v_payload_currency := NULLIF(UPPER(TRIM(COALESCE(p_payload->>'currency', ''))), '');
  IF v_payload_currency IS NOT NULL AND v_payload_currency <> v_currency THEN
    RETURN jsonb_build_object('success', false, 'error', 'Currency mismatch: collected currency differs from the intent',
      'stored_currency', v_currency, 'webhook_currency', v_payload_currency);
  END IF;

  v_type := COALESCE(NULLIF(TRIM(v_pr.payment_type), ''), 'deposit');
  IF NULLIF(TRIM(COALESCE(p_payment_type, '')), '') IS NOT NULL AND TRIM(p_payment_type) <> v_type THEN
    RETURN jsonb_build_object('success', false, 'error', 'Payment type mismatch: webhook type differs from the stored intent',
      'stored_type', v_type, 'webhook_type', p_payment_type);
  END IF;

  v_is_activation := (v_type = 'account_activation' OR v_pr.internal_reference LIKE 'PAY-ACT-%');

  IF NOT v_is_activation AND v_type NOT IN ('deposit', 'BUY_SMS') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unrecognized payment type - held for review',
      'payment_type', v_type, 'payment_request_id', v_pr.id);
  END IF;

  IF v_is_activation AND p_amount < kunity.activation_fee_minimum() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Activation payment is below the activation fee',
      'amount', p_amount, 'minimum', kunity.activation_fee_minimum());
  END IF;

  v_fee := COALESCE(p_fee, 0);
  v_net := p_amount - v_fee;

  -- 6. Record the success (status assigned from literals: enum-safe)
  v_new_status := 'success';
  UPDATE kunity.payment_requests
  SET status = v_new_status, payload = p_payload, amount = p_amount,
      fee = v_fee, completed_at = CURRENT_TIMESTAMP
  WHERE id = v_pr.id;

  -- BUY_SMS top-ups are credited application-side from wallet_transactions.
  IF v_type = 'BUY_SMS' THEN
    RETURN jsonb_build_object('message', 'SMS top-up recorded', 'payment_request_id', v_pr.id);
  END IF;

  -- Primary cash account (debit side)
  SELECT id INTO v_cash_id FROM kunity.accounts
  WHERE organization_id = v_pr.organization_id AND account_category = 'asset' AND is_active AND is_system
    AND (code ILIKE '%WALLET%' OR code ILIKE '%CASH%' OR name ILIKE '%WALLET%' OR name ILIKE '%CASH%')
  ORDER BY code LIMIT 1;
  IF v_cash_id IS NULL THEN
    SELECT id INTO v_cash_id FROM kunity.accounts
    WHERE organization_id = v_pr.organization_id AND account_category = 'asset' AND is_active AND is_system
    ORDER BY code LIMIT 1;
  END IF;
  IF v_cash_id IS NULL THEN
    RAISE EXCEPTION 'Missing primary cash/wallet asset account for organization %', v_pr.organization_id;
  END IF;

  IF v_is_activation THEN
    -- Activation fee is recognised as income (see header).
    SELECT id INTO v_fee_account_id FROM kunity.accounts
    WHERE organization_id = v_pr.organization_id AND code = 'ACT_FEE' AND account_category = 'income' AND is_active AND is_system
    LIMIT 1;
    IF v_fee_account_id IS NULL THEN
      RAISE EXCEPTION 'Missing activation fee income account (code ACT_FEE) for organization %', v_pr.organization_id;
    END IF;

    INSERT INTO kunity.journal_entries (organization_id, reference, description, entry_date, source_module)
    VALUES (v_pr.organization_id, v_pr.internal_reference, 'Account activation fee', CURRENT_DATE, 'najiki_webhook')
    RETURNING id INTO v_journal_entry_id;

    INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, description)
    VALUES (v_journal_entry_id, v_cash_id, NULL, 'activation', p_amount, 0, 'Activation fee received');
    INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, description)
    VALUES (v_journal_entry_id, v_fee_account_id, v_pr.member_id, 'activation', 0, p_amount, 'Activation fee income');

    UPDATE kunity.payment_requests SET journal_entry_id = v_journal_entry_id WHERE id = v_pr.id;

    UPDATE kunity.member_savings SET status = 'active'
    WHERE member_id = v_pr.member_id AND organization_id = v_pr.organization_id;
    UPDATE kunity.accounts SET is_active = true
    WHERE member_id = v_pr.member_id AND organization_id = v_pr.organization_id;

    -- members.status -> 'active' is done by trg_activate_member_on_activation_payment.
    RETURN jsonb_build_object('message', 'Account activation successful', 'payment_request_id', v_pr.id,
      'member_id', v_pr.member_id, 'journal_entry_id', v_journal_entry_id);
  END IF;

  -- Deposit: the member's active savings account (credit side)
  SELECT account_id INTO v_member_account_id FROM kunity.member_savings
  WHERE organization_id = v_pr.organization_id AND member_id = v_pr.member_id AND status = 'active' AND account_id IS NOT NULL
  ORDER BY created_at LIMIT 1;
  IF v_member_account_id IS NULL THEN
    SELECT id INTO v_member_account_id FROM kunity.accounts
    WHERE organization_id = v_pr.organization_id AND member_id = v_pr.member_id AND is_active
      AND account_category IN ('liability', 'asset', 'equity')
    ORDER BY created_at LIMIT 1;
  END IF;
  IF v_member_account_id IS NULL THEN
    RAISE EXCEPTION 'Missing active member account for member %', v_pr.member_id;
  END IF;

  -- Fee account is required whenever a fee is charged, or the journal would not balance.
  IF v_fee > 0 THEN
    SELECT id INTO v_fee_account_id FROM kunity.accounts
    WHERE organization_id = v_pr.organization_id AND account_category IN ('income', 'expense') AND is_active AND is_system
      AND code <> 'ACT_FEE'  -- activation income is never a gateway-fee account
      AND (code ILIKE 'FEE%' OR name ILIKE '%Fee%' OR name ILIKE '%Charge%')
    ORDER BY code
    LIMIT 1;
    IF v_fee_account_id IS NULL THEN
      RAISE EXCEPTION 'Missing processing fee account for organization % (fee % cannot be posted)', v_pr.organization_id, v_fee;
    END IF;
  END IF;

  INSERT INTO kunity.journal_entries (organization_id, reference, description, entry_date, source_module)
  VALUES (v_pr.organization_id, v_pr.internal_reference, 'Najiki webhook deposit', CURRENT_DATE, 'najiki_webhook')
  RETURNING id INTO v_journal_entry_id;

  INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, description)
  VALUES (v_journal_entry_id, v_cash_id, NULL, 'deposit', p_amount, 0, 'Gross deposit');
  INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, description)
  VALUES (v_journal_entry_id, v_member_account_id, v_pr.member_id, 'deposit', 0, v_net, 'Member net deposit');
  IF v_fee > 0 THEN
    INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit, description)
    VALUES (v_journal_entry_id, v_fee_account_id, NULL, 'fee', 0, v_fee, 'Processing fee');
  END IF;

  UPDATE kunity.payment_requests SET journal_entry_id = v_journal_entry_id WHERE id = v_pr.id;
  UPDATE kunity.accounts SET cached_balance = COALESCE(cached_balance, 0) + v_net WHERE id = v_member_account_id;

  BEGIN
    UPDATE kunity.sacco_wallets SET balance = balance + p_amount, last_updated = CURRENT_TIMESTAMP
    WHERE organization_id = v_pr.organization_id;
  EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'sacco_wallets table not found - skipping float update';
  END;

  RETURN jsonb_build_object(
    'message', 'Success recorded. Journal entries created.',
    'payment_request_id', v_pr.id,
    'journal_entry_id', v_journal_entry_id,
    'member_account_id', v_member_account_id,
    'gross_amount', p_amount,
    'fee', v_fee,
    'net_amount', v_net
  );
END;
$function$;
