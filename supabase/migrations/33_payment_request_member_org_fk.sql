-- Migration 33: a payment request's member must belong to the same organization.
-- member_id stays nullable (e.g. SMS top-ups are not made by a member). The composite FK
-- is MATCH SIMPLE by default, so a row with a NULL member_id is not checked.
BEGIN;
ALTER TABLE kunity.members
  ADD CONSTRAINT members_org_id_id_key UNIQUE (organization_id, id);
ALTER TABLE kunity.payment_requests
  ADD CONSTRAINT payment_requests_member_org_match_fkey
  FOREIGN KEY (organization_id, member_id)
  REFERENCES kunity.members (organization_id, id)
  NOT VALID;
ALTER TABLE kunity.payment_requests
  VALIDATE CONSTRAINT payment_requests_member_org_match_fkey;
COMMENT ON CONSTRAINT payment_requests_member_org_match_fkey ON kunity.payment_requests
  IS 'Migration 33: a payment request member must belong to the same organization.';
COMMIT;
