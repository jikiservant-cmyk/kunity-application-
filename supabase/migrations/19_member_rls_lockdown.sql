BEGIN;

-- Drop all existing policies on kunity.members
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'kunity' AND tablename = 'members'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON kunity.members', r.policyname);
  END LOOP;
END $$;

ALTER TABLE kunity.members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can only view their own profile"
ON kunity.members FOR SELECT
TO authenticated
USING (id = auth.uid());

COMMIT;
