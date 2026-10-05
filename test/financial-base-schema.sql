-- ============================================================================
-- test/financial-base-schema.sql
-- Minimal base schema for verifying the financial RPCs against real
-- PostgreSQL (via PGlite). Reconstructed from the columns the application
-- and RPC migrations reference. NOT a full production schema.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS kunity;

-- Supabase roles (needed by the GRANT/REVOKE statements in the migrations)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

DO $$ BEGIN
  CREATE TYPE kunity.payment_status AS ENUM ('pending', 'processing', 'success', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS kunity.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  currency TEXT DEFAULT 'UGX',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kunity.members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES kunity.organizations(id),
  status TEXT NOT NULL DEFAULT 'pending',
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kunity.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES kunity.organizations(id),
  member_id UUID REFERENCES kunity.members(id),
  name TEXT,
  code TEXT,
  account_category TEXT NOT NULL DEFAULT 'asset',
  currency TEXT DEFAULT 'UGX',
  cached_balance NUMERIC(20,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kunity.payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES kunity.organizations(id),
  member_id UUID NOT NULL REFERENCES kunity.members(id),
  amount NUMERIC(20,2) NOT NULL,
  currency TEXT DEFAULT 'UGX',
  phone_number TEXT,
  status kunity.payment_status NOT NULL DEFAULT 'pending',
  direction TEXT DEFAULT 'inbound',
  idempotency_key TEXT,
  internal_reference TEXT UNIQUE,
  payment_type TEXT,
  payload JSONB,
  provider TEXT,
  fee NUMERIC(20,2),
  journal_entry_id UUID,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kunity.journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES kunity.organizations(id),
  reference TEXT,
  description TEXT,
  entry_date DATE DEFAULT CURRENT_DATE,
  source_module TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kunity.journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES kunity.journal_entries(id),
  account_id UUID NOT NULL REFERENCES kunity.accounts(id),
  member_id UUID REFERENCES kunity.members(id),
  line_type TEXT,
  debit NUMERIC(20,2) NOT NULL DEFAULT 0,
  credit NUMERIC(20,2) NOT NULL DEFAULT 0,
  loan_id UUID,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kunity.loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES kunity.organizations(id),
  member_id UUID NOT NULL REFERENCES kunity.members(id),
  principal NUMERIC(20,2) NOT NULL,
  interest_rate NUMERIC(10,4) DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- NOTE: kunity.loan_repayments is deliberately NOT created here — no migration
-- in the repository creates it, which is FIN-01b. The fix migration (21) adds it.

CREATE TABLE IF NOT EXISTS kunity.member_savings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES kunity.organizations(id),
  member_id UUID NOT NULL REFERENCES kunity.members(id),
  savings_product_id UUID,
  account_id UUID REFERENCES kunity.accounts(id),
  status TEXT DEFAULT 'active',
  opened_date DATE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kunity.savings_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES kunity.organizations(id),
  name TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kunity.sacco_wallets (
  organization_id UUID PRIMARY KEY REFERENCES kunity.organizations(id),
  balance NUMERIC(20,2) NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  balance NUMERIC(20,2) NOT NULL DEFAULT 0,
  sms_rate NUMERIC(10,2) NOT NULL DEFAULT 50,
  currency TEXT DEFAULT 'UGX',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES public.wallets(id),
  tenant_id UUID,
  direction TEXT NOT NULL,
  amount NUMERIC(20,2) NOT NULL,
  currency TEXT DEFAULT 'UGX',
  note TEXT,
  status TEXT,
  reference TEXT,
  description TEXT,
  type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
