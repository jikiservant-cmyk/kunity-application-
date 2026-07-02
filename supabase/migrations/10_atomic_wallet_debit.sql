-- supabase/migrations/10_atomic_wallet_debit.sql

DROP FUNCTION IF EXISTS kunity.debit_tenant_wallet(text, numeric);
DROP FUNCTION IF EXISTS kunity.credit_tenant_wallet(text, numeric);

CREATE OR REPLACE FUNCTION kunity.debit_tenant_wallet(
  p_wallet_id uuid,
  p_amount numeric
) RETURNS json AS $$
DECLARE
  v_wallet record;
  v_new_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Invalid debit amount');
  END IF;

  -- Row-level lock to prevent concurrent modifications
  SELECT * INTO v_wallet
  FROM kunity.tenant_wallets
  WHERE id = p_wallet_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Wallet not found');
  END IF;

  IF NOT v_wallet.is_active THEN
    RETURN json_build_object('success', false, 'error', 'Wallet is inactive');
  END IF;

  IF v_wallet.balance < p_amount THEN
    RETURN json_build_object('success', false, 'error', 'Insufficient funds');
  END IF;

  v_new_balance := v_wallet.balance - p_amount;

  UPDATE kunity.tenant_wallets
  SET balance = v_new_balance, updated_at = NOW()
  WHERE id = p_wallet_id;

  RETURN json_build_object('success', true, 'new_balance', v_new_balance);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION kunity.credit_tenant_wallet(
  p_wallet_id uuid,
  p_amount numeric
) RETURNS json AS $$
DECLARE
  v_wallet record;
  v_new_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN json_build_object('success', false, 'error', 'Invalid credit amount');
  END IF;

  -- Row-level lock to prevent concurrent modifications
  SELECT * INTO v_wallet
  FROM kunity.tenant_wallets
  WHERE id = p_wallet_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Wallet not found');
  END IF;

  v_new_balance := v_wallet.balance + p_amount;

  UPDATE kunity.tenant_wallets
  SET balance = v_new_balance, updated_at = NOW()
  WHERE id = p_wallet_id;

  RETURN json_build_object('success', true, 'new_balance', v_new_balance);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

