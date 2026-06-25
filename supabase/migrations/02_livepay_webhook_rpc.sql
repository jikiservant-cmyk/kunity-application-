-- supabase/migrations/02_livepay_webhook_rpc.sql
-- Atomic Double-Entry Ledger Posting for LivePay Webhooks

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
AS $$
DECLARE
  v_pr kunity.payment_requests%ROWTYPE;
  v_net_amount NUMERIC;
  v_journal_entry_id UUID;
  v_primary_wallet_account_id UUID;
  v_member_savings_account_id UUID;
  v_fee_account_id UUID;
BEGIN
  -- 1. Fetch the payment request
  SELECT * INTO v_pr
  FROM kunity.payment_requests
  WHERE internal_reference = p_internal_reference
  FOR UPDATE; -- Lock to prevent concurrent duplicate webhooks

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment request with internal_reference % not found', p_internal_reference;
  END IF;

  -- 2. Idempotency Check
  -- If already processed (success or failed), return early
  IF v_pr.status IN ('success', 'failed') THEN
    RETURN jsonb_build_object(
      'message', 'Already processed',
      'payment_request_id', v_pr.id,
      'status', v_pr.status,
      'journal_entry_id', v_pr.journal_entry_id
    );
  END IF;

  -- Update payload and status
  UPDATE kunity.payment_requests
  SET 
    status = p_status::kunity.payment_status,
    payload = p_payload,
    fee = p_fee,
    amount = COALESCE(p_amount, amount), -- use payload amount if provided, else keep existing
    completed_at = now()
  WHERE id = v_pr.id
  RETURNING * INTO v_pr;

  -- 3. If the payment failed, we stop here (no ledger entries)
  IF p_status != 'success' THEN
    RETURN jsonb_build_object(
      'message', 'Payment failed, updated status',
      'payment_request_id', v_pr.id
    );
  END IF;

  -- 4. Payment is successful -> Double Entry Ledger logic

  v_net_amount := v_pr.amount - COALESCE(v_pr.fee, 0);

  -- 4A. Find the Primary Cash/Wallet Asset Account for this Organization
  SELECT id INTO v_primary_wallet_account_id
  FROM kunity.accounts
  WHERE organization_id = v_pr.organization_id 
    AND account_category = 'asset'
    AND is_active = true
    AND (code ILIKE '%WALLET%' OR code ILIKE '%CASH%' OR name ILIKE '%WALLET%' OR name ILIKE '%MOBILE%')
  LIMIT 1;

  IF v_primary_wallet_account_id IS NULL THEN
    RAISE EXCEPTION 'Missing primary cash/wallet asset account for org %', v_pr.organization_id;
  END IF;

  -- 4B. Find the Member's Active Savings Account Liability
  SELECT account_id INTO v_member_savings_account_id
  FROM kunity.member_savings
  WHERE organization_id = v_pr.organization_id
    AND member_id = v_pr.member_id
    AND status = 'active'
    AND account_id IS NOT NULL
  LIMIT 1;

  IF v_member_savings_account_id IS NULL THEN
    RAISE EXCEPTION 'Missing active member savings account for member %', v_pr.member_id;
  END IF;

  -- 4C. Find the Fee Income/Expense Account
  -- Enforcing is_system = true and looking for a specific code pattern to avoid random matches
  SELECT id INTO v_fee_account_id
  FROM kunity.accounts
  WHERE organization_id = v_pr.organization_id 
    AND account_category IN ('income', 'expense')
    AND is_active = true
    AND is_system = true
    AND (code ILIKE 'FEE%' OR name ILIKE '%Fee%')
  LIMIT 1;

  IF v_pr.fee > 0 AND v_fee_account_id IS NULL THEN
    RAISE EXCEPTION 'Missing system fee account for org %. Cannot process fee of %.', v_pr.organization_id, v_pr.fee;
  END IF;

  -- 5. Create Journal Entry Header
  INSERT INTO kunity.journal_entries (
    organization_id, reference, description, entry_date, source_module
  ) VALUES (
    v_pr.organization_id, 
    v_pr.internal_reference, 
    'LivePay Webhook Deposit', 
    CURRENT_DATE, 
    'livepay_webhook'
  ) RETURNING id INTO v_journal_entry_id;

  -- Update payment_request with journal link
  UPDATE kunity.payment_requests
  SET journal_entry_id = v_journal_entry_id
  WHERE id = v_pr.id;

  -- 6. Insert Journal Lines (3-line entry)

  -- Line 1: Debit SACCO Wallet (Asset) -> Gross Amount
  INSERT INTO kunity.journal_lines (
    journal_entry_id, account_id, member_id, line_type, debit, credit, description
  ) VALUES (
    v_journal_entry_id, v_primary_wallet_account_id, NULL, 'deposit', v_pr.amount, 0, 'LivePay Gross Deposit'
  );

  -- Line 2: Credit Member Savings (Liability) -> Net Amount
  INSERT INTO kunity.journal_lines (
    journal_entry_id, account_id, member_id, line_type, debit, credit, description
  ) VALUES (
    v_journal_entry_id, v_member_savings_account_id, v_pr.member_id, 'share_contribution', 0, v_net_amount, 'Member Net Saving'
  );

  -- Line 3: Credit/Debit Fee Account -> Fee Amount
  -- If fee account exists and fee > 0, record the fee
  IF v_fee_account_id IS NOT NULL AND v_pr.fee > 0 THEN
    -- Assuming fee is an income for SACCO if deducted from member, or expense if charged to SACCO.
    -- Here we do a credit to balance: debit (gross) = credit (net) + credit (fee)
    INSERT INTO kunity.journal_lines (
      journal_entry_id, account_id, member_id, line_type, debit, credit, description
    ) VALUES (
      v_journal_entry_id, v_fee_account_id, NULL, 'fee', 0, v_pr.fee, 'LivePay Processing Fee'
    );
  END IF;

  -- 7. Update Sacco Wallet Balance explicitly
  UPDATE kunity.sacco_wallets
  SET 
    balance = balance + v_pr.amount,
    last_updated = now()
  WHERE organization_id = v_pr.organization_id;

  RETURN jsonb_build_object(
    'message', 'Success recorded. Journal entries created.',
    'payment_request_id', v_pr.id,
    'journal_entry_id', v_journal_entry_id
  );

END;
$$;
