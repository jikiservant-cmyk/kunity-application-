-- ============================================================================
-- 24: Per-SACCO join codes + lock down organization columns exposed to anon
--
-- 1. Every SACCO gets a join_code. Members register via /auth?sacco=<code>.
--    The SACCO admin can regenerate it (old links stop working immediately).
-- 2. Anonymous and logged-in clients may read ONLY the non-sensitive columns
--    of kunity.organizations. Before this, the table-level GRANT in migration
--    14 exposed every column of active SACCOs to the public anon key, including
--    api_key (the SACCO's integration key) — and join_code would have leaked
--    the same way.
-- Service-role routes are unaffected by GRANTs.
-- ============================================================================

-- 1. Column + backfill (existing SACCOs get a code now, not after deploy)
ALTER TABLE kunity.organizations ADD COLUMN IF NOT EXISTS join_code TEXT;

UPDATE kunity.organizations
SET join_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
WHERE join_code IS NULL;

ALTER TABLE kunity.organizations
  ALTER COLUMN join_code SET DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
ALTER TABLE kunity.organizations ALTER COLUMN join_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_join_code_key ON kunity.organizations (join_code);

-- 2. Column-level read grants for client roles (no api_key, no join_code)
REVOKE SELECT ON kunity.organizations FROM anon, authenticated;
GRANT SELECT (id, name, code, is_active, currency, created_at)
  ON kunity.organizations TO anon, authenticated;
-- Row policy organizations_read_active (migration 14) is kept as-is.
