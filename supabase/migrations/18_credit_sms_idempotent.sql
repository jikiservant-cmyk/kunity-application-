BEGIN;

CREATE OR REPLACE FUNCTION public.credit_sms_wallet_idempotent(
    p_wallet_id UUID,
    p_transaction_id UUID,
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
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be positive';
    END IF;

    -- Lock transaction row
    SELECT * INTO v_tx 
    FROM public.wallet_transactions 
    WHERE id = p_transaction_id 
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Transaction not found';
    END IF;

    IF v_tx.note = 'success' OR v_tx.status = 'success' THEN
        -- Already credited
        RETURN QUERY SELECT * FROM public.wallets WHERE id = p_wallet_id;
        RETURN;
    END IF;

    -- Mark as success
    UPDATE public.wallet_transactions
    SET note = 'success', status = 'success', updated_at = NOW()
    WHERE id = p_transaction_id;

    -- Credit wallet
    RETURN QUERY
    UPDATE public.wallets
    SET 
        balance = balance + p_amount,
        updated_at = NOW()
    WHERE id = p_wallet_id
    RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.credit_sms_wallet_idempotent(UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_sms_wallet_idempotent(UUID, UUID, NUMERIC) TO service_role;

COMMIT;
