-- supabase/migrations/29_product_access_and_loan_terms.sql
-- Product tables access, loan product constraints, and product-based loan application.
--
-- Originally applied to the live database as hand-written SQL. Committed here so git
-- matches the database. Safe to re-run: every step is idempotent.
--
-- Changes from the first live run:
--   * savings_products keeps a SELECT grant and an own-SACCO SELECT policy for members.
--     The member app reads savings_products directly (plan list and the plan/product join),
--     so revoking it entirely would empty the member dashboard. Writes stay server-only.
--   * loan_products stays fully server-only (members list products through /api/member/loan-products).

BEGIN;

-- Columns the functions below rely on. Already present on the live database; no-op there.
ALTER TABLE kunity.members
  ADD COLUMN IF NOT EXISTS profile_id uuid,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE kunity.loans
  ADD COLUMN IF NOT EXISTS term_months integer;

-- Product tables: create only if absent (live layout kept).
CREATE TABLE IF NOT EXISTS kunity.loan_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES kunity.organizations(id),
  name text NOT NULL,
  interest_rate numeric NOT NULL,
  min_principal numeric DEFAULT 0,
  max_principal numeric,
  term_months integer,
  processing_fee numeric DEFAULT 0,
  is_active boolean DEFAULT true,
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Sensible product settings. Idempotent.
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kunity.loan_products'::regclass AND conname = 'loan_products_interest_rate_valid') THEN
    ALTER TABLE kunity.loan_products ADD CONSTRAINT loan_products_interest_rate_valid
      CHECK (interest_rate >= 0 AND interest_rate::text NOT IN ('NaN', 'Infinity', '-Infinity'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kunity.loan_products'::regclass AND conname = 'loan_products_min_principal_valid') THEN
    ALTER TABLE kunity.loan_products ADD CONSTRAINT loan_products_min_principal_valid
      CHECK (min_principal IS NULL OR (min_principal >= 0 AND min_principal::text NOT IN ('NaN', 'Infinity', '-Infinity')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kunity.loan_products'::regclass AND conname = 'loan_products_max_principal_valid') THEN
    ALTER TABLE kunity.loan_products ADD CONSTRAINT loan_products_max_principal_valid
      CHECK (max_principal IS NULL OR (max_principal >= COALESCE(min_principal, 0) AND max_principal::text NOT IN ('NaN', 'Infinity', '-Infinity')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kunity.loan_products'::regclass AND conname = 'loan_products_term_months_valid') THEN
    ALTER TABLE kunity.loan_products ADD CONSTRAINT loan_products_term_months_valid
      CHECK (term_months IS NULL OR term_months > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kunity.loan_products'::regclass AND conname = 'loan_products_processing_fee_valid') THEN
    ALTER TABLE kunity.loan_products ADD CONSTRAINT loan_products_processing_fee_valid
      CHECK (processing_fee IS NULL OR (processing_fee >= 0 AND processing_fee::text NOT IN ('NaN', 'Infinity', '-Infinity')));
  END IF;
END;
$constraints$;

ALTER TABLE kunity.savings_products
  ADD COLUMN IF NOT EXISTS interest_rate numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_balance numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allows_withdrawals boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS deposit_frequency text DEFAULT 'weekly',
  ADD COLUMN IF NOT EXISTS target_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE kunity.loans
  ADD COLUMN IF NOT EXISTS loan_product_id uuid REFERENCES kunity.loan_products(id);

ALTER TABLE kunity.loan_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE kunity.savings_products ENABLE ROW LEVEL SECURITY;

-- Drop stale product policies (including the old open read), then re-create the one member read.
DO $drop_product_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'kunity'
      AND tablename IN ('loan_products', 'savings_products')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', v_policy.policyname, v_policy.schemaname, v_policy.tablename);
  END LOOP;
END;
$drop_product_policies$;

REVOKE ALL ON TABLE kunity.loan_products FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE kunity.savings_products FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA kunity TO service_role;
GRANT ALL ON TABLE kunity.loan_products TO service_role;
GRANT ALL ON TABLE kunity.savings_products TO service_role;

-- The signed-in member's own SACCO id. SECURITY DEFINER so the policy below does not
-- depend on members' own RLS. Returns only an id, never member data.
CREATE OR REPLACE FUNCTION kunity.current_member_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, kunity, pg_temp
AS $helper$
  SELECT m.organization_id FROM kunity.members m WHERE m.id = auth.uid() LIMIT 1
$helper$;

REVOKE ALL ON FUNCTION kunity.current_member_org_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kunity.current_member_org_id() TO authenticated;

-- Members may READ savings products of their own SACCO (inactive/deleted ones too, so
-- existing plans keep showing their product name). No writes.
GRANT SELECT ON TABLE kunity.savings_products TO authenticated;
CREATE POLICY savings_products_select_own_sacco ON kunity.savings_products
  FOR SELECT TO authenticated
  USING (organization_id = kunity.current_member_org_id());

-- Member savings may only be opened under an active product of the member's own SACCO.
CREATE OR REPLACE FUNCTION kunity.member_can_join_savings_product(p_product_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, kunity, pg_temp
AS $helper$
  SELECT EXISTS (
    SELECT 1
    FROM kunity.members m
    JOIN kunity.savings_products sp
      ON sp.id = p_product_id
     AND sp.organization_id = m.organization_id
    WHERE m.id = auth.uid()
      AND sp.is_active IS TRUE
      AND sp.deleted_at IS NULL
  )
$helper$;

REVOKE ALL ON FUNCTION kunity.member_can_join_savings_product(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.member_can_join_savings_product(uuid) TO authenticated;

DROP POLICY IF EXISTS member_savings_insert_own_sacco_match ON kunity.member_savings;
CREATE POLICY member_savings_insert_own_sacco_match
  ON kunity.member_savings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    member_id = auth.uid()
    AND kunity.member_can_join_savings_product(savings_product_id)
  );

-- Loan application under a product. The rate, term and limits come from the product.
CREATE OR REPLACE FUNCTION kunity.member_apply_loan_for_product(
  p_member_id uuid,
  p_organization_id uuid,
  p_product_id uuid,
  p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, kunity, pg_temp
AS $function$
DECLARE
  v_member_status text;
  v_member_profile_id uuid;
  v_product kunity.loan_products%ROWTYPE;
  v_loan_id uuid;
BEGIN
  IF p_amount IS NULL
     OR p_amount <= 0
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Loan amount must be a finite number greater than zero';
  END IF;

  SELECT m.status, m.profile_id
  INTO v_member_status, v_member_profile_id
  FROM kunity.members m
  WHERE m.id = p_member_id
    AND m.organization_id = p_organization_id
    AND m.deleted_at IS NULL
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member not found in this organization';
  END IF;

  IF v_member_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Membership is not active (status: %)', v_member_status;
  END IF;

  SELECT lp.*
  INTO v_product
  FROM kunity.loan_products lp
  WHERE lp.id = p_product_id
    AND lp.organization_id = p_organization_id
    AND lp.is_active IS TRUE
    AND lp.deleted_at IS NULL
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan product is not available in this organization';
  END IF;

  IF p_amount < COALESCE(v_product.min_principal, 0) THEN
    RAISE EXCEPTION 'Loan amount must be at least % for this product', COALESCE(v_product.min_principal, 0);
  END IF;

  IF v_product.max_principal IS NOT NULL AND p_amount > v_product.max_principal THEN
    RAISE EXCEPTION 'Loan amount must be at most % for this product', v_product.max_principal;
  END IF;

  INSERT INTO kunity.loans (
    organization_id, member_id, principal, interest_rate, term_months,
    status, created_by, loan_product_id
  )
  VALUES (
    p_organization_id, p_member_id, p_amount, v_product.interest_rate, v_product.term_months,
    'pending', v_member_profile_id, v_product.id
  )
  RETURNING id INTO v_loan_id;

  RETURN jsonb_build_object(
    'success', true,
    'loan_id', v_loan_id,
    'loan_product_id', v_product.id,
    'interest_rate', v_product.interest_rate,
    'term_months', v_product.term_months
  );
END;
$function$;

REVOKE ALL ON FUNCTION kunity.member_apply_loan_for_product(uuid, uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION kunity.member_apply_loan_for_product(uuid, uuid, uuid, numeric) TO service_role;

COMMIT;
