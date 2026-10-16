-- Migration 33: a payment request's member must belong to the same organization.
-- member_id stays nullable (e.g. SMS top-ups are not made by a member). The composite FK
-- is MATCH SIMPLE by default, so a row with a NULL member_id is not checked.
--
-- Re-runnable: the constraint additions are guarded, so reapplying the migration
-- folder (a fresh deploy, a retried pipeline, or a manual re-run) is a no-op
-- instead of "constraint already exists".
BEGIN;

DO $mig33$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'kunity.members'::regclass
      AND conname = 'members_org_id_id_key'
  ) THEN
    ALTER TABLE kunity.members
      ADD CONSTRAINT members_org_id_id_key UNIQUE (organization_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'kunity.payment_requests'::regclass
      AND conname = 'payment_requests_member_org_match_fkey'
  ) THEN
    ALTER TABLE kunity.payment_requests
      ADD CONSTRAINT payment_requests_member_org_match_fkey
      FOREIGN KEY (organization_id, member_id)
      REFERENCES kunity.members (organization_id, id)
      NOT VALID;
  END IF;
END;
$mig33$;

-- Validating an already-validated constraint is a no-op, so this stays idempotent.
ALTER TABLE kunity.payment_requests
  VALIDATE CONSTRAINT payment_requests_member_org_match_fkey;

COMMENT ON CONSTRAINT payment_requests_member_org_match_fkey ON kunity.payment_requests
  IS 'Migration 33: a payment request member must belong to the same organization.';

COMMIT;
