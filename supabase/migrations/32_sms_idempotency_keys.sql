-- ============================================================================
-- 32_sms_idempotency_keys.sql
--
-- PENTEST 2026-10-13 (messaging): a retried SMS request (API integrator timeout,
-- admin double-click) was dispatched and charged again. The wallet debit is idempotent
-- per key, but a replay returns the same wallet row as a first call, so the caller
-- could not tell a replay from a new debit and sent the SMS again.
--
-- This table records a request key BEFORE anything is sent. The insert is atomic
-- (primary key), so exactly one request can claim a key. A second request with the same
-- key is refused.
--
-- Only the service role uses it. Client roles get no access.
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sms_idempotency_keys (
  scope       text        NOT NULL,            -- e.g. 'api:<application_id>' or 'broadcast:<tenant_id>'
  idem_key    text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, idem_key)
);

ALTER TABLE public.sms_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_idempotency_keys FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sms_idempotency_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sms_idempotency_keys TO service_role;
