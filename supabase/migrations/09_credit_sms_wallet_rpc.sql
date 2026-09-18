-- Create an RPC function to atomically credit a wallet's balance
CREATE OR REPLACE FUNCTION public.credit_sms_wallet(
    p_wallet_id text,
    p_amount numeric
)
RETURNS SETOF public.wallets
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Prevent negative or zero top-ups
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be positive';
    END IF;

    RETURN QUERY
    UPDATE public.wallets
    SET 
        balance = balance + p_amount,
        updated_at = now()
    WHERE id = p_wallet_id
    RETURNING *;
END;
$$;

-- Secure the function so it can only be called by the service role
REVOKE EXECUTE ON FUNCTION public.credit_sms_wallet(text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_sms_wallet(text, numeric) TO service_role;
