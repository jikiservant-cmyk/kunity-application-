-- Add/ensure an idempotency uniqueness rule for wallet debits
CREATE UNIQUE INDEX IF NOT EXISTS wallets_debit_idempotency_uq
ON public.wallet_transactions(wallet_id, reference)
WHERE reference IS NOT NULL AND direction = 'debit';

-- Create an RPC function to atomically debit a wallet's balance
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
  v_rows_affected int;
BEGIN
  -- 1) Input validation
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be a positive number';
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'Idempotency key is required';
  END IF;

  -- 2) Idempotent ledger insert
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
      'success'::text,
      p_idempotency_key,
      p_description,
      now(),
      now()
    FROM public.wallets w
    WHERE w.id = p_wallet_id
    ON CONFLICT ON CONSTRAINT wallets_debit_idempotency_uq DO NOTHING
    RETURNING wallet_id
  )
  -- 3) Deduct wallet balance
  UPDATE public.wallets w
  SET
    balance = w.balance - p_amount,
    updated_at = now()
  WHERE w.id = p_wallet_id
    AND EXISTS (SELECT 1 FROM inserted);

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

  -- 4) Return the wallet
  SELECT * INTO v_wallet FROM public.wallets WHERE id = p_wallet_id;
  IF v_wallet.id IS NULL THEN
    RAISE EXCEPTION 'Wallet not found: %', p_wallet_id;
  END IF;

  RETURN NEXT v_wallet;
  RETURN;
END;
$$;
