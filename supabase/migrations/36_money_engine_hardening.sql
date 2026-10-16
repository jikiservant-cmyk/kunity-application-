-- ============================================================================
-- 36_money_engine_hardening.sql
-- Harden SMS wallet credits/refunds and normalize wrapped NaJiki currencies.
-- All balance mutations remain server-role-only and atomic.
-- ============================================================================
BEGIN;

-- Keep a relation from each refund row to the debit it reverses. The live wallet
-- ids/transaction ids vary between uuid and text deployments, so store the source
-- id as text and compare identifiers via ::text in the RPCs.
ALTER TABLE public.wallet_transactions
  ADD COLUMN IF NOT EXISTS sms_refund_debit_id text;

CREATE INDEX IF NOT EXISTS wallet_transactions_sms_refund_debit_idx
  ON public.wallet_transactions (wallet_id, sms_refund_debit_id)
  WHERE sms_refund_debit_id IS NOT NULL AND direction = 'credit';

-- Backfill refunds created by migration 21 where their reference identifies the
-- debit. This lets the new RPC recognize a replay after deployment.
UPDATE public.wallet_transactions AS refund
SET sms_refund_debit_id = debit.id::text
FROM public.wallet_transactions AS debit
WHERE refund.direction = 'credit'
  AND refund.note = 'refund'
  AND refund.sms_refund_debit_id IS NULL
  AND debit.direction = 'debit'
  AND debit.wallet_id::text = refund.wallet_id::text
  AND (
    refund.reference = 'refund_' || debit.reference
    OR (
      debit.description IS NOT NULL
      AND left(debit.description, length('najiki_sms:')) = 'najiki_sms:'
      AND refund.reference = 'refund_najiki_' || substring(debit.description FROM length('najiki_sms:') + 1)
    )
  );

-- SMS topups must be the exact pending credit row being confirmed. Do not trust
-- a caller-supplied amount or allow a debit/other transaction to become a topup.
CREATE OR REPLACE FUNCTION public.credit_sms_wallet_idempotent(
  p_wallet_id text,
  p_transaction_id text,
  p_amount numeric
)
RETURNS SETOF public.wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_tx public.wallet_transactions%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Amount must be a finite positive number';
  END IF;
  IF p_wallet_id IS NULL OR length(trim(p_wallet_id)) = 0
     OR p_transaction_id IS NULL OR length(trim(p_transaction_id)) = 0 THEN
    RAISE EXCEPTION 'Wallet and transaction ids are required';
  END IF;

  SELECT * INTO v_tx
  FROM public.wallet_transactions
  WHERE id::text = p_transaction_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;

  IF v_tx.wallet_id IS NULL OR v_tx.wallet_id::text <> p_wallet_id THEN
    RAISE EXCEPTION 'Transaction does not belong to wallet %', p_wallet_id;
  END IF;
  IF v_tx.tenant_id IS NULL OR v_tx.type::text IS DISTINCT FROM 'sms_topup'
     OR v_tx.direction::text IS DISTINCT FROM 'credit' THEN
    RAISE EXCEPTION 'Transaction is not a tenant-bound SMS top-up credit';
  END IF;
  IF v_tx.amount IS NULL OR v_tx.amount <= 0
     OR v_tx.amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_tx.amount IS DISTINCT FROM p_amount THEN
    RAISE EXCEPTION 'Amount does not match the stored SMS top-up';
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE id::text = p_wallet_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found: %', p_wallet_id;
  END IF;
  IF v_wallet.tenant_id IS NULL OR v_wallet.tenant_id::text <> v_tx.tenant_id::text THEN
    RAISE EXCEPTION 'SMS top-up tenant does not match wallet tenant';
  END IF;
  IF v_tx.currency IS NOT NULL AND v_wallet.currency IS NOT NULL
     AND upper(v_tx.currency::text) <> upper(v_wallet.currency::text) THEN
    RAISE EXCEPTION 'SMS top-up currency does not match wallet currency';
  END IF;

  -- Validate class/ownership/amount before accepting an idempotent replay.
  IF v_tx.note = 'success' OR v_tx.status::text = 'success' THEN
    RETURN NEXT v_wallet;
    RETURN;
  END IF;
  IF (v_tx.note IS NOT NULL AND v_tx.note <> 'pending')
     OR (v_tx.status IS NOT NULL AND v_tx.status::text <> 'pending') THEN
    RAISE EXCEPTION 'SMS top-up transaction is not pending';
  END IF;

  UPDATE public.wallet_transactions
  SET note = 'success', status = 'success', updated_at = now()
  WHERE id::text = p_transaction_id;

  UPDATE public.wallets
  SET balance = balance + p_amount, updated_at = now()
  WHERE id::text = p_wallet_id
  RETURNING * INTO v_wallet;

  RETURN NEXT v_wallet;
  RETURN;
END;
$function$;

-- The explicit four-argument RPC binds a refund to the source debit reference.
-- Row-locking the debit serializes competing refunds; sms_refund_debit_id makes
-- idempotency independent of the caller's refund reference.
CREATE OR REPLACE FUNCTION public.refund_sms_wallet(
  p_wallet_id text,
  p_amount numeric,
  p_reference text,
  p_debit_reference text
)
RETURNS SETOF public.wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_wallet public.wallets%ROWTYPE;
  v_debit public.wallet_transactions%ROWTYPE;
  v_existing public.wallet_transactions%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Refund amount must be a finite positive number';
  END IF;
  IF p_wallet_id IS NULL OR length(trim(p_wallet_id)) = 0
     OR p_reference IS NULL OR length(trim(p_reference)) = 0
     OR p_debit_reference IS NULL OR length(trim(p_debit_reference)) = 0 THEN
    RAISE EXCEPTION 'Wallet, refund reference, and debit reference are required';
  END IF;

  SELECT * INTO v_debit
  FROM public.wallet_transactions
  WHERE wallet_id::text = p_wallet_id
    AND reference = p_debit_reference
    AND direction::text = 'debit'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source debit not found for refund';
  END IF;
  IF v_debit.amount IS NULL OR v_debit.amount <= 0
     OR v_debit.amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_debit.amount IS DISTINCT FROM p_amount THEN
    RAISE EXCEPTION 'Refund amount does not match the source debit';
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE id::text = p_wallet_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found: %', p_wallet_id;
  END IF;
  IF v_debit.tenant_id IS NULL OR v_wallet.tenant_id IS NULL
     OR v_debit.tenant_id::text <> v_wallet.tenant_id::text THEN
    RAISE EXCEPTION 'Source debit tenant does not match wallet tenant';
  END IF;

  -- A same-reference replay is successful only if it belongs to this debit and
  -- carries the same amount. Legacy refund rows are recognized and backfilled.
  SELECT * INTO v_existing
  FROM public.wallet_transactions
  WHERE wallet_id::text = p_wallet_id
    AND reference = p_reference
    AND direction::text = 'credit'
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.note IS DISTINCT FROM 'refund'
       AND v_existing.sms_refund_debit_id IS NULL THEN
      RAISE EXCEPTION 'Refund reference is already used by another credit';
    END IF;
    IF v_existing.sms_refund_debit_id IS NOT NULL
       AND v_existing.sms_refund_debit_id <> v_debit.id::text THEN
      RAISE EXCEPTION 'Refund reference belongs to a different debit';
    END IF;
    IF v_existing.amount IS DISTINCT FROM p_amount THEN
      RAISE EXCEPTION 'Refund reference reused with a different amount';
    END IF;
    IF v_existing.sms_refund_debit_id IS NULL THEN
      UPDATE public.wallet_transactions
      SET sms_refund_debit_id = v_debit.id::text
      WHERE id::text = v_existing.id::text;
    END IF;
    RETURN NEXT v_wallet;
    RETURN;
  END IF;

  SELECT * INTO v_existing
  FROM public.wallet_transactions
  WHERE wallet_id::text = p_wallet_id
    AND sms_refund_debit_id = v_debit.id::text
    AND direction::text = 'credit'
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'Source debit has already been refunded';
  END IF;

  INSERT INTO public.wallet_transactions (
    id, wallet_id, tenant_id, direction, amount, currency, note,
    reference, description, sms_refund_debit_id, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_wallet.id, v_wallet.tenant_id, 'credit', v_debit.amount,
    COALESCE(v_debit.currency, v_wallet.currency, 'UGX'), 'refund', p_reference,
    'SMS refund for debit ' || v_debit.reference, v_debit.id::text, now(), now()
  );

  UPDATE public.wallets
  SET balance = balance + v_debit.amount, updated_at = now()
  WHERE id::text = p_wallet_id
  RETURNING * INTO v_wallet;

  RETURN NEXT v_wallet;
  RETURN;
END;
$function$;

-- Backward-compatible, source-bound wrapper for app instances that still call
-- the original three-argument signature during a rolling deployment. New code
-- passes p_debit_reference explicitly. Unsupported reference formats fail closed.
CREATE OR REPLACE FUNCTION public.refund_sms_wallet(
  p_wallet_id text,
  p_amount numeric,
  p_reference text
)
RETURNS SETOF public.wallets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_debit_reference text;
  v_sms_id text;
BEGIN
  IF p_reference IS NULL OR length(trim(p_reference)) = 0 THEN
    RAISE EXCEPTION 'Refund reference is required';
  END IF;

  IF left(p_reference, length('refund_najiki_')) = 'refund_najiki_' THEN
    v_sms_id := substring(p_reference FROM length('refund_najiki_') + 1);
    SELECT wt.reference INTO v_debit_reference
    FROM public.wallet_transactions AS wt
    WHERE wt.wallet_id::text = p_wallet_id
      AND wt.direction::text = 'debit'
      AND wt.description = 'najiki_sms:' || v_sms_id
    ORDER BY wt.created_at DESC
    LIMIT 1;
  ELSIF left(p_reference, length('refund_')) = 'refund_' THEN
    v_debit_reference := substring(p_reference FROM length('refund_') + 1);
  ELSE
    RAISE EXCEPTION 'Unsupported refund reference format';
  END IF;

  IF v_debit_reference IS NULL OR length(trim(v_debit_reference)) = 0 THEN
    RAISE EXCEPTION 'Source debit not found for refund';
  END IF;

  RETURN QUERY
  SELECT * FROM public.refund_sms_wallet(p_wallet_id, p_amount, p_reference, v_debit_reference);
END;
$function$;

-- Normalize wrapped NaJiki payloads before the existing atomic ledger function
-- checks currency. The legacy function remains the sole writer; direct client
-- execution of the renamed implementation is revoked.
--
-- Re-runnable: the rename only happens the first time. On a later run the
-- pre-hardening implementation already exists, the rename is skipped, and the
-- wrapper below is replaced in place.
DO $mig36_rename$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'kunity'
      AND p.proname = 'process_najiki_webhook_pre_currency_hardening'
  ) THEN
    ALTER FUNCTION kunity.process_najiki_webhook(text, text, numeric, text, text, jsonb, numeric)
      RENAME TO process_najiki_webhook_pre_currency_hardening;
  END IF;
END;
$mig36_rename$;

REVOKE ALL ON FUNCTION kunity.process_najiki_webhook_pre_currency_hardening(text, text, numeric, text, text, jsonb, numeric)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION kunity.process_najiki_webhook_pre_currency_hardening(text, text, numeric, text, text, jsonb, numeric)
  TO postgres;

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
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_payload->'data') = 'object'
     AND (v_payload->'data') ? 'currency' THEN
    v_payload := jsonb_set(v_payload, '{currency}', v_payload->'data'->'currency', true);
  END IF;

  RETURN kunity.process_najiki_webhook_pre_currency_hardening(
    p_reference, p_status, p_amount, p_external_entity_id, p_payment_type, v_payload, p_fee
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.credit_sms_wallet_idempotent(text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_sms_wallet_idempotent(text, text, numeric)
  TO service_role;

REVOKE ALL ON FUNCTION public.refund_sms_wallet(text, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_sms_wallet(text, numeric, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.refund_sms_wallet(text, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_sms_wallet(text, numeric, text)
  TO service_role;

REVOKE ALL ON FUNCTION kunity.process_najiki_webhook(text, text, numeric, text, text, jsonb, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.process_najiki_webhook(text, text, numeric, text, text, jsonb, numeric)
  TO service_role;

COMMIT;
