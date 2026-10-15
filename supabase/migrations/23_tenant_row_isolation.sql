-- ============================================================================
-- 23_tenant_row_isolation.sql
-- Kunity SACCO — within-tenant row isolation (multi-tenancy integrity fix).
--
-- PROBLEM: several SELECT policies only checked organization_id. Any member of
-- a SACCO could read every other member's account balances, loans, profile
-- data and journal entries in THEIR OWN SACCO (cross-SACCO access was already
-- blocked). Confirmed against PostgreSQL before this change (test/rls-tests.mjs).
--
-- FIX:
--   * members see only their own rows (accounts, loans, profiles, journal
--     entries that touch one of their accounts);
--   * SACCO administrators (sacco_admin / super_admin / system_admin, scoped to
--     their tenant) can read the organization's rows;
--   * the institutional float (kunity.sacco_wallets) is admin-only.
-- Writes are unchanged: the lockdown migrations already revoke client writes;
-- all server-side money movement runs as service_role / SECURITY DEFINER.
-- ============================================================================

-- Admin check. Reads public.admin_profiles (authoritative tenant binding).
CREATE OR REPLACE FUNCTION kunity.is_org_admin(p_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, kunity, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_profiles ap
    WHERE ap.id = auth.uid()
      AND (
        ap.role IN ('super_admin', 'system_admin')
        OR (ap.role = 'sacco_admin' AND ap.tenant_id::text = p_organization_id::text)
      )
  );
$$;

REVOKE ALL ON FUNCTION kunity.is_org_admin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kunity.is_org_admin(UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Drop the over-broad policies (names as created by migrations 01, 04, 07)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view accounts in their organization" ON kunity.accounts;
DROP POLICY IF EXISTS "Users can view members of their own organization" ON kunity.profiles;
DROP POLICY IF EXISTS "Users can view journal entries in their organization" ON kunity.journal_entries;
DROP POLICY IF EXISTS "Organization admins can view all loans in org" ON kunity.loans;
DROP POLICY IF EXISTS "Users can view sacco wallets in their organization" ON kunity.sacco_wallets;

-- ---------------------------------------------------------------------------
-- accounts: own accounts, or org admins
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS accounts_select_own_or_admin ON kunity.accounts;
CREATE POLICY accounts_select_own_or_admin ON kunity.accounts
  FOR SELECT TO authenticated
  USING (member_id = auth.uid() OR kunity.is_org_admin(organization_id));

-- ---------------------------------------------------------------------------
-- loans: own loans, or org admins
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS loans_select_own_or_admin ON kunity.loans;
CREATE POLICY loans_select_own_or_admin ON kunity.loans
  FOR SELECT TO authenticated
  USING (member_id = auth.uid() OR kunity.is_org_admin(organization_id));

-- ---------------------------------------------------------------------------
-- profiles: own profile, or org admins
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS profiles_select_own_or_admin ON kunity.profiles;
CREATE POLICY profiles_select_own_or_admin ON kunity.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR kunity.is_org_admin(organization_id));

-- ---------------------------------------------------------------------------
-- journal_entries: visible when the entry touches one of the caller's own
-- accounts, or to org admins. (Previously every member saw every entry.)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS journal_entries_select_own_or_admin ON kunity.journal_entries;
CREATE POLICY journal_entries_select_own_or_admin ON kunity.journal_entries
  FOR SELECT TO authenticated
  USING (
    kunity.is_org_admin(organization_id)
    OR id IN (
      SELECT jl.journal_entry_id
      FROM kunity.journal_lines jl
      JOIN kunity.accounts a ON a.id = jl.account_id
      WHERE a.member_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- sacco_wallets (institutional float): admins only
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS sacco_wallets_select_admin ON kunity.sacco_wallets;
CREATE POLICY sacco_wallets_select_admin ON kunity.sacco_wallets
  FOR SELECT TO authenticated
  USING (kunity.is_org_admin(organization_id));
