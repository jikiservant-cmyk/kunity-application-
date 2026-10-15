-- Migration 34: debit_sms_wallet refuses a debit whose tenant does not own the wallet.
-- This is the definition live already runs (captured from the live database). The repo's
-- migration 21 version did not check p_tenant_id. Re-applying this on live is a no-op.
CREATE OR REPLACE FUNCTION public.debit_sms_wallet(p_wallet_id text, p_amount numeric, p_idempotency_key text, p_tenant_id text, p_description text DEFAULT 'SMS deduction'::text)
 RETURNS SETOF wallets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'kunity', 'pg_temp'
AS $function$
DECLARE
  v_wallet public.wallets%ROWTYPE;
  v_wallet_exists boolean;
BEGIN
  -- 1) Input validation
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be a positive number';
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'Idempotency key is required';
  END IF;

  -- 2) Serialize concurrent debits per wallet
  PERFORM 1
  FROM public.wallets
  WHERE id = p_wallet_id
  FOR UPDATE;

  -- Ensure wallet exists for this tenant
  SELECT EXISTS (
    SELECT 1
    FROM public.wallets
    WHERE id = p_wallet_id
      AND tenant_id = p_tenant_id
  ) INTO v_wallet_exists;

  IF NOT v_wallet_exists THEN
    RAISE EXCEPTION 'Wallet not found for tenant: %', p_wallet_id;
  END IF;

  -- 3) Idempotent ledger insert
  WITH inserted AS (
    INSERT INTO public.wallet_transactions (
      id,
      wallet_id,
      tenant_id,
      direction,
      amount,
      currency,
      note,
      reference,
      description,
      created_at,
      updated_at
    )
    SELECT
      gen_random_uuid(),
      w.id,
      w.tenant_id,
      'debit'::text,
      p_amount,
      w.currency,
      'SMS deduction (idempotent)'::text,
      p_idempotency_key,
      p_description,
      now(),
      now()
    FROM public.wallets w
    WHERE w.id = p_wallet_id
      AND w.tenant_id = p_tenant_id
    ON CONFLICT (wallet_id, reference)
      WHERE reference IS NOT NULL AND direction = 'debit'
    DO NOTHING
    RETURNING wallet_id
  )
  -- 4) Deduct wallet balance only if ledger insert happened, and prevent negatives
  UPDATE public.wallets w
  SET
    balance = w.balance - p_amount,
    updated_at = now()
  WHERE w.id = p_wallet_id
    AND w.tenant_id = p_tenant_id
    AND EXISTS (SELECT 1 FROM inserted)
    AND w.balance >= p_amount
  RETURNING w.*
  INTO v_wallet;

  -- 5) Handle idempotency replay or insufficient funds
  IF v_wallet.id IS NULL THEN
    -- If insert replayed, return current wallet
    SELECT * INTO v_wallet
    FROM public.wallets
    WHERE id = p_wallet_id
      AND tenant_id = p_tenant_id;

    IF v_wallet.id IS NULL THEN
      RAISE EXCEPTION 'Wallet not found after debit attempt: %', p_wallet_id;
    END IF;

    -- If balance would go negative, raise
    IF v_wallet.balance < p_amount THEN
      RAISE EXCEPTION 'Insufficient wallet balance';
    END IF;
  END IF;

  RETURN NEXT v_wallet;
  RETURN;
END;
$function$;
