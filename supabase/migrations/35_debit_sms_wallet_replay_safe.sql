-- Migration 35: debit_sms_wallet treats a replay of an existing debit as success, even if the
-- wallet balance has since dropped. Before this, the balance check ran first, so a retried
-- debit could fail with "Insufficient wallet balance" although it had already been applied.
-- A reused key with a different amount is refused. Explicit REVOKE/GRANT keep the function
-- callable by service_role only.
BEGIN;

CREATE OR REPLACE FUNCTION public.debit_sms_wallet(
  p_wallet_id text,
  p_amount numeric,
  p_idempotency_key text,
  p_tenant_id text,
  p_description text DEFAULT 'SMS deduction'::text
)
RETURNS SETOF wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'kunity', 'pg_temp'
AS $function$
DECLARE
  v_wallet public.wallets%ROWTYPE;
  v_wallet_exists boolean;
  v_existing_tx public.wallet_transactions%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be a positive number';
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'Idempotency key is required';
  END IF;

  -- Serialize operations for this wallet and tenant.
  PERFORM 1
  FROM public.wallets
  WHERE id = p_wallet_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  SELECT EXISTS (
    SELECT 1
    FROM public.wallets
    WHERE id = p_wallet_id
      AND tenant_id = p_tenant_id
  ) INTO v_wallet_exists;

  IF NOT v_wallet_exists THEN
    RAISE EXCEPTION 'Wallet not found for tenant: %', p_wallet_id;
  END IF;

  -- A replay is successful regardless of the wallet's current balance.
  SELECT wt.*
  INTO v_existing_tx
  FROM public.wallet_transactions AS wt
  WHERE wt.wallet_id = p_wallet_id
    AND wt.tenant_id = p_tenant_id
    AND wt.reference = p_idempotency_key
    AND wt.direction = 'debit'
  LIMIT 1;

  IF FOUND THEN
    IF v_existing_tx.amount IS DISTINCT FROM p_amount THEN
      RAISE EXCEPTION 'Idempotency key reused with a different amount';
    END IF;

    SELECT *
    INTO v_wallet
    FROM public.wallets
    WHERE id = p_wallet_id
      AND tenant_id = p_tenant_id;

    RETURN NEXT v_wallet;
    RETURN;
  END IF;

  -- Check funds only after ruling out a replay, and before creating a ledger row.
  SELECT *
  INTO v_wallet
  FROM public.wallets
  WHERE id = p_wallet_id
    AND tenant_id = p_tenant_id;

  IF v_wallet.balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance';
  END IF;

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
    FROM public.wallets AS w
    WHERE w.id = p_wallet_id
      AND w.tenant_id = p_tenant_id
    ON CONFLICT (wallet_id, reference)
      WHERE reference IS NOT NULL AND direction = 'debit'
    DO NOTHING
    RETURNING wallet_id
  )
  UPDATE public.wallets AS w
  SET
    balance = w.balance - p_amount,
    updated_at = now()
  WHERE w.id = p_wallet_id
    AND w.tenant_id = p_tenant_id
    AND EXISTS (SELECT 1 FROM inserted)
    AND w.balance >= p_amount
  RETURNING w.* INTO v_wallet;

  IF v_wallet.id IS NULL THEN
    -- Covers a conflict with a transaction inserted by another writer.
    SELECT wt.*
    INTO v_existing_tx
    FROM public.wallet_transactions AS wt
    WHERE wt.wallet_id = p_wallet_id
      AND wt.tenant_id = p_tenant_id
      AND wt.reference = p_idempotency_key
      AND wt.direction = 'debit'
    LIMIT 1;

    IF FOUND THEN
      IF v_existing_tx.amount IS DISTINCT FROM p_amount THEN
        RAISE EXCEPTION 'Idempotency key reused with a different amount';
      END IF;

      SELECT *
      INTO v_wallet
      FROM public.wallets
      WHERE id = p_wallet_id
        AND tenant_id = p_tenant_id;

      RETURN NEXT v_wallet;
      RETURN;
    END IF;

    SELECT *
    INTO v_wallet
    FROM public.wallets
    WHERE id = p_wallet_id
      AND tenant_id = p_tenant_id;

    IF v_wallet.id IS NULL THEN
      RAISE EXCEPTION 'Wallet not found after debit attempt: %', p_wallet_id;
    END IF;

    IF v_wallet.balance < p_amount THEN
      RAISE EXCEPTION 'Insufficient wallet balance';
    END IF;

    RAISE EXCEPTION 'Debit was not applied';
  END IF;

  RETURN NEXT v_wallet;
  RETURN;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.debit_sms_wallet(text, numeric, text, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.debit_sms_wallet(text, numeric, text, text, text)
  TO service_role;

COMMIT;
