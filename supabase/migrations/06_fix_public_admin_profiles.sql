-- supabase/migrations/06_fix_public_admin_profiles.sql
-- Drop any leftover triggers or writes to kunity.profiles and ensure public.admin_profiles table.

-- 1. Grant usage on the public schema so the service_role and authenticated users can access it
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

-- 2. Create the admin_profiles table under the public schema if it does not already exist
CREATE TABLE IF NOT EXISTS public.admin_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID,
  role VARCHAR(50) DEFAULT 'member',
  app_type VARCHAR(50) DEFAULT 'sacco',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Grant full select/insert/update/delete permissions on the public.admin_profiles table
GRANT ALL PRIVILEGES ON TABLE public.admin_profiles TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_profiles TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
