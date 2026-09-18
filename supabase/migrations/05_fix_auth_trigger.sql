-- supabase/migrations/05_fix_auth_trigger.sql
-- Fix "Database error saving new user" by dropping obsolete/broken triggers on auth.users.
--
-- Since our Next.js application handles member and profile creation programmatically
-- inside the secure backend API route (/api/auth/profile), database-level triggers on 
-- auth.users referencing the old typo schema "kuntiy" are redundant and cause sign-up failures.

-- 1. Drop the triggers on the auth.users table
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users CASCADE;
DROP TRIGGER IF EXISTS tr_on_auth_user_created ON auth.users CASCADE;
DROP TRIGGER IF EXISTS signup_copy_trigger ON auth.users CASCADE;
DROP TRIGGER IF EXISTS handle_new_user_trigger ON auth.users CASCADE;

-- 2. Drop the trigger functions
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;
DROP FUNCTION IF EXISTS kunity.handle_new_user() CASCADE;

-- 3. Ensure the schema "kunity" exists (and drop "kuntiy" if any remains)
CREATE SCHEMA IF NOT EXISTS kunity;
DROP SCHEMA IF EXISTS kuntiy CASCADE;

-- 4. Clean up permissions on kunity schema for postgrest / authenticated roles
GRANT USAGE ON SCHEMA kunity TO postgres, anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA kunity TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA kunity TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA kunity GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
