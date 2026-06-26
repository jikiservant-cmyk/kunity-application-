-- supabase/migrations/07_clean_kuntiy_references.sql
--
-- This script completely cleanses the database of any stale or broken references to the 
-- old typo schema "kuntiy" or "kuntiy.accounts" (e.g. inside RLS policies, triggers, or functions).
-- Run this entire script in your Supabase SQL Editor to resolve the "relation kuntiy.accounts does not exist" error.

-- 1. Ensure the old typo schema is completely removed with CASCADE
DROP SCHEMA IF EXISTS kuntiy CASCADE;

-- 2. Drop any potentially broken RLS policies on kunity.journal_lines or other tables
-- that might have been created with subqueries pointing to the old kuntiy schema.
DROP POLICY IF EXISTS "Users can view journal lines of their accounts" ON kunity.journal_lines;
DROP POLICY IF EXISTS "Users can view accounts in their organization" ON kunity.accounts;
DROP POLICY IF EXISTS "Users can create accounts for themselves" ON kunity.accounts;

-- 3. Re-create the policies cleanly pointing to kunity.accounts (correct schema!)
CREATE POLICY "Users can view accounts in their organization"
ON kunity.accounts FOR SELECT
USING (organization_id = kunity.get_user_organization_id());

CREATE POLICY "Users can create accounts for themselves"
ON kunity.accounts FOR INSERT
WITH CHECK (member_id = auth.uid() AND organization_id = kunity.get_user_organization_id());

CREATE POLICY "Users can view journal lines of their accounts"
ON kunity.journal_lines FOR SELECT
USING (account_id IN (
  SELECT id FROM kunity.accounts WHERE member_id = auth.uid()
));

-- 4. Clean up any leftover triggers on kunity tables that might reference the old schema or trigger functions
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users CASCADE;
DROP TRIGGER IF EXISTS tr_on_auth_user_created ON auth.users CASCADE;
DROP TRIGGER IF EXISTS signup_copy_trigger ON auth.users CASCADE;
DROP TRIGGER IF EXISTS handle_new_user_trigger ON auth.users CASCADE;

-- 5. Drop any potential old trigger functions that might still reference kuntiy
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;
DROP FUNCTION IF EXISTS kunity.handle_new_user() CASCADE;

-- 6. Ensure proper permissions are configured on the correct kunity schema
GRANT USAGE ON SCHEMA kunity TO postgres, anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA kunity TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA kunity TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA kunity GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
