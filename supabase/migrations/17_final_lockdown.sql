BEGIN;

-- Pin search_path on SECURITY DEFINER helper to prevent function hijack
CREATE OR REPLACE FUNCTION kunity.get_user_organization_id()
RETURNS UUID AS $$
  SELECT organization_id FROM kunity.profiles WHERE id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, kunity, pg_temp;

-- Revoke all conflicting grants to anon, authenticated in public schema from 06/09
REVOKE ALL ON public.admin_profiles FROM anon, authenticated;
REVOKE ALL ON public.sms_messages FROM anon, authenticated;
REVOKE ALL ON public.sms_templates FROM anon, authenticated;
REVOKE ALL ON public.wallets FROM anon, authenticated;
REVOKE ALL ON public.wallet_transactions FROM anon, authenticated;

-- Strip all write access to kunity from clients
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'kunity'
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE kunity.%I FROM anon, authenticated', r.tablename);
  END LOOP;
END $$;

-- Let's also revoke public execution on any functions
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
      ('public','debit_sms_wallet'),
      ('kunity', 'member_withdraw_atomic'),
      ('kunity', 'member_repay_loan_atomic'),
      ('kunity', 'member_apply_loan'),
      ('kunity', 'disburse_loan_atomic')
    )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC, anon, authenticated', r.s, r.f, r.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role', r.s, r.f, r.args);
  END LOOP;
END $$;

COMMIT;
