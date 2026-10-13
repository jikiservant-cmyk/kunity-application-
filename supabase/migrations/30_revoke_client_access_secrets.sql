-- ============================================================================
-- 30_revoke_client_access_secrets.sql
--
-- PENTEST 2026-10-13 (defense in depth).
--
-- Migration 09 granted SELECT/INSERT/UPDATE/DELETE on these tables to the
-- anon and authenticated roles. Migration 14 turned on RLS for them with no
-- client policy, so the grant was effectively blocked. That protection
-- depended only on RLS. `applications.api_key` is the credential for the
-- SMS gateway (/api/messaging/send), so the table must not be reachable from
-- client roles at all.
--
-- All code that reads these tables runs server-side with the service role,
-- which is unaffected by this REVOKE. Nothing in the browser reads them.
--
-- Idempotent: each table is skipped if it does not exist.
-- ============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['applications', 'sms_configs', 'sms_webhook_logs'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;
