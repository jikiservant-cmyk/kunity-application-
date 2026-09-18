-- supabase/migrations/08_sms_wallets_and_logs.sql

-- 1. Create Tenant Wallet Table in kunity schema
CREATE TABLE IF NOT EXISTS kunity.tenant_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID UNIQUE NOT NULL REFERENCES kunity.organizations(id) ON DELETE CASCADE,
    balance DECIMAL(14, 4) NOT NULL DEFAULT 0.00,
    currency VARCHAR(10) NOT NULL DEFAULT 'UGX',
    is_active BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Create Wallet Transaction Ledger Table in kunity schema
CREATE TABLE IF NOT EXISTS kunity.wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES kunity.tenant_wallets(id) ON DELETE CASCADE,
    type VARCHAR(10) NOT NULL, -- 'DEBIT' or 'CREDIT'
    amount DECIMAL(14, 4) NOT NULL,
    running_balance DECIMAL(14, 4) NOT NULL,
    description TEXT,
    reference VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Create SMS Message Log Table in kunity schema
CREATE TABLE IF NOT EXISTS kunity.sms_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES kunity.organizations(id) ON DELETE CASCADE,
    recipient_phone VARCHAR(30) NOT NULL,
    message TEXT NOT NULL,
    cost DECIMAL(14, 4) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'sent', 'delivered', 'failed', 'rejected_insufficient_funds'
    event_type VARCHAR(100), -- 'WELCOME_MESSAGE' or 'DEPOSIT_ALERT'
    provider_sms_id VARCHAR(100),
    failure_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. Add api_key column to kunity.organizations to support external API authentication
ALTER TABLE kunity.organizations ADD COLUMN IF NOT EXISTS api_key VARCHAR(100) UNIQUE;

-- 5. Create indexes for high scalability (10k+ users)
CREATE INDEX IF NOT EXISTS idx_tenant_wallets_tenant_id ON kunity.tenant_wallets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON kunity.wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_sms_logs_tenant_id ON kunity.sms_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sms_logs_status ON kunity.sms_logs(status);

-- 6. Enable Row Level Security (RLS)
ALTER TABLE kunity.tenant_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE kunity.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kunity.sms_logs ENABLE ROW LEVEL SECURITY;

-- 7. Drop existing policies if they exist to prevent duplication
DROP POLICY IF EXISTS "Users can view tenant wallets in their organization" ON kunity.tenant_wallets;
DROP POLICY IF EXISTS "Users can view wallet transactions in their organization" ON kunity.wallet_transactions;
DROP POLICY IF EXISTS "Users can view sms logs in their organization" ON kunity.sms_logs;

-- 8. Create select policies based on organization_id
CREATE POLICY "Users can view tenant wallets in their organization"
ON kunity.tenant_wallets FOR SELECT
USING (tenant_id = kunity.get_user_organization_id());

CREATE POLICY "Users can view wallet transactions in their organization"
ON kunity.wallet_transactions FOR SELECT
USING (wallet_id IN (
    SELECT id FROM kunity.tenant_wallets WHERE tenant_id = kunity.get_user_organization_id()
));

CREATE POLICY "Users can view sms logs in their organization"
ON kunity.sms_logs FOR SELECT
USING (tenant_id = kunity.get_user_organization_id());

-- 9. Ensure correct permissions are granted on the kunity schema tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA kunity TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA kunity TO anon, authenticated;
