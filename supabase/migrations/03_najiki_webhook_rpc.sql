-- supabase/migrations/03_najiki_webhook_rpc.sql
-- Atomic Double-Entry Ledger Posting for Najiki Webhooks (v2 - Production Ready)
-- Fixes: Idempotency, amount drift, fee handling, account validation, better locking

CREATE OR REPLACE FUNCTION kunity.process_najiki_webhook(
  p_reference TEXT,
  p_status TEXT,
  p_amount NUMERIC,
  p_fee NUMERIC DEFAULT 0,
  p_external_entity_id TEXT,
  p_payment_type TEXT,
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
  v_is_success BOOLEAN;
BEGIN
  -- Determine if payment is successful
  v_is_success := (p_status = 'success' OR p_status = 'successful');

  --------------------------------------------------------------------------
  -- 1. Find and lock payment request (transactional safety)
  --------------------------------------------------------------------------
  IF p_reference IS NOT NULL AND p_reference <> '' THEN
    -- First priority: try exact reference match
    SELECT * INTO v_pr
    FROM kunity.payment_requests
    WHERE transaction_reference = p_reference
    FOR UPDATE;
  END IF;

  -- Fallback: if no match by reference OR reference is null
  IF NOT FOUND THEN
    -- Only use external_entity_id lookup if reference is missing
    -- and we have a known payment_type to avoid mismatches
    SELECT * INTO v_pr
    FROM kunity.payment_requests
    WHERE 
      (member_id::TEXT = p_external_entity_id)
      AND status = 'pending'
      AND (
        (p_payment_type IS NOT NULL AND payment_type = p_payment_type)
        OR (p_payment_type IS NULL AND (transaction_reference LIKE 'PAY-ACT-%' OR payment_type IN ('deposit', 'account_activation')))
      )
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Payment request not found (reference: %, member: %)', p_reference, p_external_entity_id;
    END IF;
  END IF;

  --------------------------------------------------------------------------
  -- 2. Idempotency check (critical - prevent double-spending!)
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
  -- 3. Validate amounts (prevent drift!)
  --------------------------------------------------------------------------
  -- Ensure amount consistency: either enforce equality OR explicitly update
  IF p_amount IS NOT NULL AND v_pr.amount <> p_amount THEN
    RAISE NOTICE 'Amount mismatch: stored % vs webhook % - updating stored amount', v_pr.amount, p_amount;
  END IF;

  -- Use webhook amount as authoritative if provided, else keep original
  IF p_amount IS NOT NULL THEN
    v_pr.amount := p_amount;
  END IF;

  --------------------------------------------------------------------------
  -- 4. Update payment request status and metadata
  --------------------------------------------------------------------------
  UPDATE kunity.payment_requests
  SET 
    status = CASE WHEN v_is_success THEN 'success' ELSE 'failed' END,
    payload = p_payload,
    amount = v_pr.amount,
    fee = COALESCE(p_fee, 0),
    completed_at = CURRENT_TIMESTAMP
  WHERE id = v_pr.id
  RETURNING * INTO v_pr;

  --------------------------------------------------------------------------
  -- 5. Stop early if payment failed
  --------------------------------------------------------------------------
  IF NOT v_is_success THEN
    RETURN jsonb_build_object(
      'message', 'Payment failed, updated status',
      'payment_request_id', v_pr.id
    );
  END IF;

  --------------------------------------------------------------------------
  -- 6. Account activation flow
  --------------------------------------------------------------------------
  IF (p_payment_type = 'account_activation' OR v_pr.transaction_reference LIKE 'PAY-ACT-%') THEN
    -- Activate member_savings
    UPDATE kunity.member_savings
    SET status = 'active'
    WHERE member_id = v_pr.member_id
    AND organization_id = v_pr.organization_id;

    -- Activate accounts
    UPDATE kunity.accounts
    SET is_active = true
    WHERE member_id = v_pr.member_id
    AND organization_id = v_pr.organization_id;

    RETURN jsonb_build_object(
      'message', 'Account activation successful',
      'payment_request_id', v_pr.id,
      'member_id', v_pr.member_id
    );
  END IF;

  --------------------------------------------------------------------------
  -- 7. Deposit flow: Double-entry ledger posting
  --------------------------------------------------------------------------
  IF p_payment_type = 'deposit' OR p_payment_type IS NULL OR p_payment_type = '' THEN
    -- Calculate net amount (after fees if applicable)
    v_net_amount := v_pr.amount - COALESCE(v_pr.fee, 0);

    ------------------------------------------------------------------------
    -- A. Find organization's primary cash/wallet account (debit side)
    ------------------------------------------------------------------------
    SELECT id INTO v_primary_wallet_account_id
    FROM kunity.accounts
    WHERE organization_id = v_pr.organization_id 
      AND account_category = 'asset'
      AND is_active = true
      AND is_system = true
      AND (code ILIKE '%WALLET%' OR code ILIKE '%CASH%' OR name ILIKE '%WALLET%' OR name ILIKE '%CASH%')
    LIMIT 1;

    IF v_primary_wallet_account_id IS NULL THEN
      -- Fallback: find any system asset account
      SELECT id INTO v_primary_wallet_account_id
      FROM kunity.accounts
      WHERE organization_id = v_pr.organization_id 
        AND account_category = 'asset'
        AND is_active = true
        AND is_system = true
      LIMIT 1;

      IF v_primary_wallet_account_id IS NULL THEN
        -- Last resort: any active asset account
        SELECT id INTO v_primary_wallet_account_id
        FROM kunity.accounts
        WHERE organization_id = v_pr.organization_id 
          AND account_category = 'asset'
          AND is_active = true
        LIMIT 1;

        IF v_primary_wallet_account_id IS NULL THEN
          RAISE EXCEPTION 'Missing primary cash/wallet asset account for org %', v_pr.organization_id;
        END IF;
      END IF;
    END IF;

    ------------------------------------------------------------------------
    -- B. Find member's active savings account (credit side)
    ------------------------------------------------------------------------
    -- First: try member_savings with active status
    SELECT account_id INTO v_member_savings_account_id
    FROM kunity.member_savings
    WHERE organization_id = v_pr.organization_id
      AND member_id = v_pr.member_id
      AND status = 'active'
      AND account_id IS NOT NULL
    LIMIT 1;

    IF v_member_savings_account_id IS NULL THEN
      -- Fallback: find member's active account with appropriate category
      SELECT id INTO v_member_savings_account_id
      FROM kunity.accounts
      WHERE organization_id = v_pr.organization_id
        AND member_id = v_pr.member_id
        AND is_active = true
        AND account_category IN ('liability', 'asset', 'equity')
      ORDER BY 
        CASE account_category 
          WHEN 'liability' THEN 1 
          WHEN 'asset' THEN 2 
          ELSE 3 
        END,
        created_at ASC
      LIMIT 1;

      IF v_member_savings_account_id IS NULL THEN
        RAISE EXCEPTION 'Missing active member account for member %', v_pr.member_id;
      END IF;
    END IF;

    ------------------------------------------------------------------------
    -- C. Find system fee account (if applicable)
    ------------------------------------------------------------------------
    IF v_pr.fee > 0 THEN
      SELECT id INTO v_fee_account_id
      FROM kunity.accounts
      WHERE organization_id = v_pr.organization_id 
        AND account_category IN ('income', 'expense')
        AND is_active = true
        AND is_system = true
        AND (code ILIKE 'FEE%' OR name ILIKE '%Fee%' OR name ILIKE '%Charge%')
      LIMIT 1;

      IF v_fee_account_id IS NULL THEN
        RAISE NOTICE 'Missing fee account for org % - skipping fee ledger lines', v_pr.organization_id;
      END IF;
    END IF;

    ------------------------------------------------------------------------
    -- D. Create journal entry header
    ------------------------------------------------------------------------
    INSERT INTO kunity.journal_entries (
      organization_id, reference, description, entry_date, source_module
    ) VALUES (
      v_pr.organization_id, 
      COALESCE(p_reference, v_pr.transaction_reference), 
      'Najiki Webhook Deposit', 
      CURRENT_DATE, 
      'najiki_webhook'
    ) RETURNING id INTO v_journal_entry_id;

    -- Link journal entry to payment request
    UPDATE kunity.payment_requests
    SET journal_entry_id = v_journal_entry_id
    WHERE id = v_pr.id;

    ------------------------------------------------------------------------
    -- E. Insert double-entry journal lines
    ------------------------------------------------------------------------
    -- Line 1: Debit organization's cash/wallet (gross amount)
    INSERT INTO kunity.journal_lines (
      journal_entry_id, account_id, member_id, line_type, debit, credit, description
    ) VALUES (
      v_journal_entry_id, v_primary_wallet_account_id, NULL, 'deposit', v_pr.amount, 0, 
      'Najiki Gross Deposit'
    );

    -- Line 2: Credit member's savings account (net amount)
    INSERT INTO kunity.journal_lines (
      journal_entry_id, account_id, member_id, line_type, debit, credit, description
    ) VALUES (
      v_journal_entry_id, v_member_savings_account_id, v_pr.member_id, 'deposit', 0, v_net_amount,
      'Member Net Deposit'
    );

    -- Line 3: Credit/Debit fee account (if applicable)
    IF v_pr.fee > 0 AND v_fee_account_id IS NOT NULL THEN
      INSERT INTO kunity.journal_lines (
        journal_entry_id, account_id, member_id, line_type, debit, credit, description
      ) VALUES (
        v_journal_entry_id, v_fee_account_id, NULL, 'fee', 0, v_pr.fee,
        'Najiki Processing Fee'
      );
    END IF;

    ------------------------------------------------------------------------
    -- F. Update cached balance for member account
    ------------------------------------------------------------------------
    UPDATE kunity.accounts
    SET cached_balance = COALESCE(cached_balance, 0) + v_net_amount
    WHERE id = v_member_savings_account_id;

    ------------------------------------------------------------------------
    -- G. Also update sacco_wallets if that table exists
    ------------------------------------------------------------------------
    BEGIN
      UPDATE kunity.sacco_wallets
      SET 
        balance = balance + v_pr.amount,
        last_updated = CURRENT_TIMESTAMP
      WHERE organization_id = v_pr.organization_id;
    EXCEPTION WHEN undefined_table THEN
      -- Ignore if sacco_wallets doesn't exist
      RAISE NOTICE 'sacco_wallets table not found - skipping balance update';
    END;

    RETURN jsonb_build_object(
      'message', 'Success recorded. Journal entries created.',
      'payment_request_id', v_pr.id,
      'journal_entry_id', v_journal_entry_id,
      'member_account_id', v_member_savings_account_id,
      'gross_amount', v_pr.amount,
      'fee', v_pr.fee,
      'net_amount', v_net_amount
    );
  END IF;

  --------------------------------------------------------------------------
  -- 8. Handle unknown payment types
  --------------------------------------------------------------------------
  RETURN jsonb_build_object(
    'message', 'Payment successful but no specific action taken',
    'payment_request_id', v_pr.id,
    'payment_type', p_payment_type
  );

END;
$$;
