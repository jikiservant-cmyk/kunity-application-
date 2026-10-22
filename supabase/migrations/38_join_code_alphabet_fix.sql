-- ============================================================================
-- 38: Join-code alphabet fix — DB-minted codes must pass the app's validator
--
-- BUG: migration 24 minted join_code from UUID hex
--   (upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)) -> 0-9A-F),
-- but lib/join-code.ts normalizeJoinCode() only accepts the 31-char no-look-alike
-- alphabet 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' (no 0/O/1/I/L). Any code containing
-- '0' or '1' (~74% of hex codes) was rejected by /api/organizations/resolve and
-- /api/auth/profile as "This join link is not valid" — dead on arrival, even
-- though it was the SACCO's real code. Regenerated codes (JS generateJoinCode)
-- were fine, which is why the mismatch went unnoticed.
--
-- Fix, in layers (reviewed 2026-10-21):
--   1. kunity.generate_join_code(): uniformly random bytes (a v4 UUID's
--      version/variant bytes are skipped — they are fixed, not uniform), with
--      rejection sampling to remove modulo bias; same alphabet/length as the
--      TS generator. Installed as the column DEFAULT FIRST so any concurrent
--      insert after that point mints a conforming code.
--   2. kunity.join_code_aliases: BEFORE replacing anything, snapshot every
--      non-conforming code -> organization. Links already shared with members
--      keep resolving through this closed mapping (service-role only), without
--      loosening the alphabet: a look-alike variant is not in the alias table
--      and resolves to nothing. Admin "regenerate" clears the aliases (the UI
--      promises older links stop working on rotation).
--   3. Backfill: replace ONLY codes that fail the app's pattern. Codes that
--      already conform are left untouched (their links stay live).
--   4. CHECK constraint + NOT NULL: every stored join_code passes
--      normalizeJoinCode() from now on, so generator and validator cannot
--      drift apart again. NOT NULL is re-asserted (migration 24 already sets
--      it) so the CHECK can never be bypassed by a NULL.
--
-- Runs in a single transaction (house style, cf. migration 20) so no insert can
-- land between the backfill and the CHECK with an old-format code. Every step is
-- idempotent: if a statement-by-statement runner ever leaves a straggler row and
-- the CHECK fails, re-running this file snapshots and heals it.
-- ============================================================================

BEGIN;

-- 1. Shared generator: 10 chars from the 31-char no-look-alike alphabet.
CREATE OR REPLACE FUNCTION kunity.generate_join_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  alphabet CONSTANT text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea;
  code text := '';
  i int;
  b int;
BEGIN
  -- Mirrors lib/join-code.ts generateJoinCode(). Randomness comes from
  -- gen_random_uuid() (CSPRNG-backed). A v4 UUID carries fixed version/variant
  -- bits in bytes 6 and 8, so those two are skipped: every byte we consume is
  -- uniformly random. Rejection sampling (248 = 8 * 31: drop byte values 248+)
  -- then removes the modulo bias of byte % 31.
  WHILE length(code) < 10 LOOP
    bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    i := 0;
    WHILE i < 16 AND length(code) < 10 LOOP
      IF i <> 6 AND i <> 8 THEN
        b := get_byte(bytes, i);
        IF b < 248 THEN
          code := code || substr(alphabet, (b % 31) + 1, 1);
        END IF;
      END IF;
      i := i + 1;
    END LOOP;
  END LOOP;
  RETURN code;
END;
$$;

-- Service-role only (house style, cf. migration 32). Required: migration 05
-- ALTERs DEFAULT PRIVILEGES in this schema toward anon/authenticated, so an
-- un-revoked table here would leak the code->SACCO mapping to the anon key.
CREATE TABLE IF NOT EXISTS kunity.join_code_aliases (
  legacy_code    TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES kunity.organizations(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE kunity.join_code_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE kunity.join_code_aliases FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE kunity.join_code_aliases FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE kunity.join_code_aliases TO service_role;

-- 2. Preserve already-shared links FIRST: snapshot every code we are about to
--    replace. ON CONFLICT keeps the file idempotent on re-runs.
INSERT INTO kunity.join_code_aliases (legacy_code, organization_id)
SELECT join_code, id
FROM kunity.organizations
WHERE join_code IS NOT NULL
  AND join_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$'
ON CONFLICT (legacy_code) DO NOTHING;

-- 3. New default BEFORE the backfill: any insert from this point on mints a
--    conforming code even if statements were to run outside one transaction.
ALTER TABLE kunity.organizations
  ALTER COLUMN join_code SET DEFAULT kunity.generate_join_code();

-- 4. Backfill: heal only non-conforming codes (retry on the unique index).
DO $$
DECLARE
  org RECORD;
  candidate text;
BEGIN
  FOR org IN
    SELECT id FROM kunity.organizations
    WHERE join_code IS NULL
       OR join_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$'
  LOOP
    LOOP
      BEGIN
        candidate := kunity.generate_join_code();
        UPDATE kunity.organizations SET join_code = candidate WHERE id = org.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        NULL; -- astronomically unlikely; draw another code and retry
      END;
    END LOOP;
  END LOOP;
END $$;

-- 5. Re-assert NOT NULL (set by migration 24; belt-and-braces so a NULL can
--    never slip past the format CHECK, which treats NULL as satisfied).
ALTER TABLE kunity.organizations
  ALTER COLUMN join_code SET NOT NULL;

-- 6. Hard invariant: stored codes always pass normalizeJoinCode().
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_join_code_format_chk'
      AND conrelid = 'kunity.organizations'::regclass
  ) THEN
    ALTER TABLE kunity.organizations
      ADD CONSTRAINT organizations_join_code_format_chk
      CHECK (join_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$');
  END IF;
END $$;

COMMIT;
