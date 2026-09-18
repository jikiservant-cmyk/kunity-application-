-- supabase/migrations/04_insert_rls_policies.sql
-- Fix permission denied errors by adding INSERT, UPDATE, SELECT policies

-- ==============================================================================
-- 1. Organizations policies (needed to create default org)
-- ==============================================================================
ALTER TABLE kunity.organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view organizations"
ON kunity.organizations FOR SELECT
USING (true);

CREATE POLICY "Allow inserting organizations"
ON kunity.organizations FOR INSERT
WITH CHECK (true);

-- ==============================================================================
-- 2. Profiles policies (needed for user sign up)
-- ==============================================================================
CREATE POLICY "Allow inserting profiles"
ON kunity.profiles FOR INSERT
WITH CHECK (id = auth.uid());

-- ==============================================================================
-- 3. Members policies
-- ==============================================================================
ALTER TABLE kunity.members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view members in their organization"
ON kunity.members FOR SELECT
USING (organization_id IN (
  SELECT organization_id FROM kunity.profiles WHERE id = auth.uid()
));

CREATE POLICY "Allow inserting members"
ON kunity.members FOR INSERT
WITH CHECK (id = auth.uid());

CREATE POLICY "Users can update their own member record"
ON kunity.members FOR UPDATE
USING (id = auth.uid());

-- ==============================================================================
-- 4. Saving products policies
-- ==============================================================================
CREATE POLICY "Anyone can view saving products"
ON kunity.savings_products FOR SELECT
USING (true);

CREATE POLICY "Allow inserting saving products"
ON kunity.savings_products FOR INSERT
WITH CHECK (true);

-- ==============================================================================
-- 5. Member savings policies
-- ==============================================================================
ALTER TABLE kunity.member_savings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own member savings"
ON kunity.member_savings FOR SELECT
USING (member_id = auth.uid());

CREATE POLICY "Allow inserting member savings"
ON kunity.member_savings FOR INSERT
WITH CHECK (member_id = auth.uid());

-- ==============================================================================
-- 6. Payment requests policies
-- ==============================================================================
ALTER TABLE kunity.payment_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own payment requests"
ON kunity.payment_requests FOR SELECT
USING (member_id = auth.uid());

CREATE POLICY "Allow inserting payment requests"
ON kunity.payment_requests FOR INSERT
WITH CHECK (member_id = auth.uid());

CREATE POLICY "Allow updating payment requests"
ON kunity.payment_requests FOR UPDATE
USING (true);

-- ==============================================================================
-- 7. Sacco wallets policies
-- ==============================================================================
ALTER TABLE kunity.sacco_wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view sacco wallets in their organization"
ON kunity.sacco_wallets FOR SELECT
USING (organization_id IN (
  SELECT organization_id FROM kunity.profiles WHERE id = auth.uid()
));
