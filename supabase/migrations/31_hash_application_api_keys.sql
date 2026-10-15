-- ============================================================================
-- 31_hash_application_api_keys.sql
--
-- PENTEST 2026-10-13: application API keys were stored and looked up in
-- plaintext (public.applications.api_key). Anyone who could read that column
-- (a backup, a support export, a database leak) could use the SMS gateway.
--
-- This migration stores only a SHA-256 digest of each key:
--   * existing keys are hashed in place, so integrators keep working
--     (the gateway hashes the presented key and compares digests);
--   * the plaintext column is cleared;
--   * keys are shown once when issued or rotated (POST /api/admin/api-key).
--
-- Idempotent.
-- ============================================================================

ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS api_key_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS applications_api_key_hash_key
  ON public.applications (api_key_hash);

-- Hash any key that is still stored in plaintext, then clear the plaintext.
UPDATE public.applications
   SET api_key_hash = encode(sha256(convert_to(api_key, 'UTF8')), 'hex'),
       api_key = NULL
 WHERE api_key IS NOT NULL
   AND api_key_hash IS NULL;
