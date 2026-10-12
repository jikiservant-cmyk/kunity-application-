-- supabase/migrations/28_admin_products.sql
-- Admin-managed savings and loan products.
--
--   * kunity.loan_products: per-SACCO loan products (rate, min/max amount, active flag).
--     Writes and reads go through server routes (service role) only.
--   * savings_products: make sure the columns the app writes exist (idempotent).
--   * kunity.loans.loan_product_id: which product a loan was applied under.
--   * kunity.member_apply_loan_for_product: applies a loan using the PRODUCT'S rate and
--     limits, never a caller-supplied rate. Replaces the hardcoded 10% for product loans.
--     The original member_apply_loan (10%) is left in place but is no longer called.
--
-- Loan approval and disbursement are unchanged.

CREATE TABLE IF NOT EXISTS kunity.loan_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES kunity.organizations(id),
  name TEXT NOT NULL,
  interest_rate NUMERIC(10,4) NOT NULL CHECK (interest_rate >= 0 AND interest_rate <= 100),
  min_amount NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  max_amount NUMERIC(20,2) NOT NULL CHECK (max_amount > 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT loan_products_amount_range CHECK (max_amount >= min_amount)
);

CREATE INDEX IF NOT EXISTS loan_products_org_active_idx
  ON kunity.loan_products (organization_id, is_active);

ALTER TABLE kunity.loan_products ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kunity.loan_products FROM PUBLIC, anon, authenticated;
GRANT ALL ON kunity.loan_products TO service_role;

ALTER TABLE kunity.savings_products
  ADD COLUMN IF NOT EXISTS interest_rate NUMERIC(10,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_balance NUMERIC(20,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allows_withdrawals BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS deposit_frequency TEXT DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

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
  WHERE id = p_product_id AND organization_id = p_organization_id AND is_active;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan product is not available in this organization';
  END IF;

  IF p_amount < v_product.min_amount OR p_amount > v_product.max_amount THEN
    RAISE EXCEPTION 'Loan amount must be between % and % for this product', v_product.min_amount, v_product.max_amount;
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
