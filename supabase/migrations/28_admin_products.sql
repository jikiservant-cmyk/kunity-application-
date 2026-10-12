-- supabase/migrations/28_admin_products.sql
-- Admin-managed savings and loan products. Column shapes match the LIVE tables:
--   kunity.savings_products  (deposit_frequency is 'weekly' only, live check constraint)
--   kunity.loan_products     (min_principal / max_principal; max NULL = no upper limit)
--
--   * Both tables: RLS on, anon/authenticated revoked. Access is through server routes
--     (service role) only, which scope every query to the caller's SACCO.
--   * kunity.loans.loan_product_id records which product a loan was applied under.
--   * kunity.member_apply_loan_for_product applies a loan with the PRODUCT'S rate and
--     limits. The caller never supplies a rate. Deleted or inactive products are refused.
--   * The original member_apply_loan (fixed 10%) is kept but no longer called.
--
-- Loan approval and disbursement are unchanged. processing_fee and term_months are stored
-- on the product but NOT applied to loans yet (no fee or term column on loans).

CREATE TABLE IF NOT EXISTS kunity.loan_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES kunity.organizations(id),
  name TEXT NOT NULL,
  interest_rate NUMERIC NOT NULL,
  min_principal NUMERIC DEFAULT 0,
  max_principal NUMERIC,
  term_months INTEGER,
  processing_fee NUMERIC DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE kunity.loan_products ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kunity.loan_products FROM PUBLIC, anon, authenticated;
GRANT ALL ON kunity.loan_products TO service_role;

ALTER TABLE kunity.savings_products
  ADD COLUMN IF NOT EXISTS interest_rate NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_balance NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allows_withdrawals BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS deposit_frequency TEXT DEFAULT 'weekly',
  ADD COLUMN IF NOT EXISTS target_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE kunity.loans
  ADD COLUMN IF NOT EXISTS loan_product_id UUID REFERENCES kunity.loan_products(id);

CREATE OR REPLACE FUNCTION kunity.member_apply_loan_for_product(
  p_member_id UUID,
  p_organization_id UUID,
  p_product_id UUID,
  p_amount NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, kunity, pg_temp
AS $$
DECLARE
  v_member_status TEXT;
  v_product RECORD;
  v_loan_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Loan amount must be greater than zero';
  END IF;

  SELECT status INTO v_member_status
  FROM kunity.members
  WHERE id = p_member_id AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found in this organization';
  END IF;

  IF v_member_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Membership is not active (status: %)', v_member_status;
  END IF;

  SELECT * INTO v_product
  FROM kunity.loan_products
  WHERE id = p_product_id
    AND organization_id = p_organization_id
    AND is_active IS TRUE
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan product is not available in this organization';
  END IF;

  IF p_amount < COALESCE(v_product.min_principal, 0) THEN
    RAISE EXCEPTION 'Loan amount must be at least % for this product', COALESCE(v_product.min_principal, 0);
  END IF;

  IF v_product.max_principal IS NOT NULL AND p_amount > v_product.max_principal THEN
    RAISE EXCEPTION 'Loan amount must be at most % for this product', v_product.max_principal;
  END IF;

  INSERT INTO kunity.loans (organization_id, member_id, principal, interest_rate, status,
                            created_by, created_at, updated_at, loan_product_id)
  VALUES (p_organization_id, p_member_id, p_amount, v_product.interest_rate, 'pending',
          p_member_id, NOW(), NOW(), v_product.id)
  RETURNING id INTO v_loan_id;

  RETURN jsonb_build_object('success', true, 'loan_id', v_loan_id, 'interest_rate', v_product.interest_rate);
END;
$$;

REVOKE ALL ON FUNCTION kunity.member_apply_loan_for_product(UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.member_apply_loan_for_product(UUID, UUID, UUID, NUMERIC) TO service_role;
