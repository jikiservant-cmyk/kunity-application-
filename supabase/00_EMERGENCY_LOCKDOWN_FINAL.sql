-- ============================================================================
-- 00_EMERGENCY_LOCKDOWN_FINAL.sql
-- Kunity SACCO — Final applied database lockdown patch
-- Executed on live Supabase database
-- ============================================================================

BEGIN;

-- Lock every live overload of the sensitive RPCs.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, p.proname AS f,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname, p.proname) IN (
      ('kunity','process_najiki_webhook'),
      ('kunity','process_livepay_webhook'),
      ('kunity','credit_tenant_wallet'),
      ('kunity','debit_tenant_wallet'),
      ('public','credit_sms_wallet'),
      ('public','debit_sms_wallet')
    )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC, anon, authenticated', r.s, r.f, r.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role', r.s, r.f, r.args);
  END LOOP;
END $$;

-- Pin SECURITY DEFINER functions in the application schemas.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, p.proname AS f,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef AND n.nspname IN ('kunity','public')
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog, public, kunity, pg_temp', r.s, r.f, r.args);
  END LOOP;
END $$;

-- Remove client writes while preserving existing SELECT privileges.
REVOKE ALL ON ALL TABLES IN SCHEMA kunity FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA kunity FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA kunity
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

-- Drop all policies on the specifically locked tables so no old write policy survives.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE (schemaname, tablename) IN (
      ('public','admin_profiles'),
      ('kunity','payment_requests'),
      ('kunity','members'),
      ('kunity','organizations'),
      ('kunity','savings_products')
    )
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- Admin profiles: authenticated users can only read their own row.
ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_profiles FORCE ROW LEVEL SECURITY;
GRANT SELECT ON public.admin_profiles TO authenticated;
CREATE POLICY admin_profiles_select_own ON public.admin_profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

-- Payment requests: authenticated users can only read their own requests.
CREATE POLICY payment_requests_select_own ON kunity.payment_requests
  FOR SELECT TO authenticated USING (member_id = auth.uid());
CREATE POLICY payment_requests_no_insert ON kunity.payment_requests
  FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY payment_requests_no_update ON kunity.payment_requests
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY payment_requests_no_delete ON kunity.payment_requests
  FOR DELETE TO authenticated USING (false);

-- Members: self-read only; writes are server-side.
CREATE POLICY members_select_own ON kunity.members
  FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY members_no_insert ON kunity.members
  FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY members_no_update ON kunity.members
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY members_no_delete ON kunity.members
  FOR DELETE TO authenticated USING (false);

-- Registration dropdown: only active organizations are public.
GRANT SELECT ON kunity.organizations TO anon, authenticated;
CREATE POLICY organizations_read_active ON kunity.organizations
  FOR SELECT TO anon, authenticated USING (is_active = true);
CREATE POLICY organizations_no_insert ON kunity.organizations
  FOR INSERT TO anon, authenticated WITH CHECK (false);
CREATE POLICY organizations_no_update ON kunity.organizations
  FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY organizations_no_delete ON kunity.organizations
  FOR DELETE TO anon, authenticated USING (false);

-- Savings products: public read only; creation remains server-side.
GRANT SELECT ON kunity.savings_products TO authenticated;
CREATE POLICY savings_products_select ON kunity.savings_products
  FOR SELECT TO authenticated USING (true);
CREATE POLICY savings_products_no_insert ON kunity.savings_products
  FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY savings_products_no_update ON kunity.savings_products
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY savings_products_no_delete ON kunity.savings_products
  FOR DELETE TO authenticated USING (false);

-- Member trigger uses only columns confirmed in the live schema.
CREATE OR REPLACE FUNCTION kunity.guard_member_self_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, kunity, pg_temp
AS $fn$
DECLARE v_role text;
BEGIN
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')
  );

  IF TG_OP = 'UPDATE' AND v_role IN ('anon', 'authenticated') THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
       OR NEW.member_number IS DISTINCT FROM OLD.member_number
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'Cannot modify protected member fields';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_guard_member_self_update ON kunity.members;
CREATE TRIGGER trg_guard_member_self_update
  BEFORE UPDATE ON kunity.members
  FOR EACH ROW EXECUTE FUNCTION kunity.guard_member_self_update();

-- Default-deny the actual legacy public tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'applications','wallets','wallet_transactions','sms_messages',
    'sms_configs','sms_templates','sms_webhook_logs','tenants'
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

COMMIT;
