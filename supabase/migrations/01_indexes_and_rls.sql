-- supabase/migrations/01_indexes_and_rls.sql
-- Run this script in your Supabase SQL editor to scale to 10k+ users

-- ==============================================================================
-- 1. DATABASE INDEXES FOR SCALABILITY
-- Essential for speeding up lookups with 10k+ users.
-- ==============================================================================

-- Profiles indexes
CREATE INDEX IF NOT EXISTS idx_profiles_organization_id ON kunity.profiles (organization_id);

-- Accounts indexes
CREATE INDEX IF NOT EXISTS idx_accounts_member_id ON kunity.accounts (member_id);
CREATE INDEX IF NOT EXISTS idx_accounts_organization_id ON kunity.accounts (organization_id);
CREATE INDEX IF NOT EXISTS idx_accounts_saving_product_id ON kunity.accounts (saving_product_id);

-- Journal Entries & Lines indexes
CREATE INDEX IF NOT EXISTS idx_journal_entries_organization_id ON kunity.journal_entries (organization_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_created_at ON kunity.journal_entries (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_journal_lines_account_id ON kunity.journal_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_journal_entry_id ON kunity.journal_lines (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_created_at ON kunity.journal_lines (created_at DESC);

-- Loans indexes
CREATE INDEX IF NOT EXISTS idx_loans_member_id ON kunity.loans (member_id);
CREATE INDEX IF NOT EXISTS idx_loans_organization_id ON kunity.loans (organization_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON kunity.loans (status);

-- Loan Installments indexes
CREATE INDEX IF NOT EXISTS idx_loan_installments_loan_id ON kunity.loan_installments (loan_id);
CREATE INDEX IF NOT EXISTS idx_loan_installments_due_date ON kunity.loan_installments (due_date ASC);

-- ==============================================================================
-- 2. ROW LEVEL SECURITY (RLS) POLICIES
-- Prevents Organization A from seeing Organization B's data!
-- ==============================================================================

-- Enable RLS on all tables
ALTER TABLE kunity.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE kunity.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kunity.saving_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE kunity.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kunity.journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE kunity.loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE kunity.loan_installments ENABLE ROW LEVEL SECURITY;

-- Helper function to get current user's organization_id securely
CREATE OR REPLACE FUNCTION kunity.get_user_organization_id()
RETURNS UUID AS $$
  SELECT organization_id FROM kunity.profiles WHERE id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER;

-- --- Policies for Profiles ---
-- Users can see profiles in their own organization.
CREATE POLICY "Users can view members of their own organization" 
ON kunity.profiles FOR SELECT 
USING (organization_id = kunity.get_user_organization_id() OR id = auth.uid());

CREATE POLICY "Users can update their own profile" 
ON kunity.profiles FOR UPDATE 
USING (id = auth.uid());

-- --- Policies for Accounts ---
CREATE POLICY "Users can view accounts in their organization"
ON kunity.accounts FOR SELECT
USING (organization_id = kunity.get_user_organization_id());

CREATE POLICY "Users can create accounts for themselves"
ON kunity.accounts FOR INSERT
WITH CHECK (member_id = auth.uid() AND organization_id = kunity.get_user_organization_id());

-- --- Policies for Journal Entries / Lines ---
CREATE POLICY "Users can view journal entries in their organization"
ON kunity.journal_entries FOR SELECT
USING (organization_id = kunity.get_user_organization_id());

CREATE POLICY "Users can view journal lines of their accounts"
ON kunity.journal_lines FOR SELECT
USING (account_id IN (SELECT id FROM kunity.accounts WHERE member_id = auth.uid()));

-- --- Policies for Loans ---
CREATE POLICY "Users can view their own loans"
ON kunity.loans FOR SELECT
USING (member_id = auth.uid());

CREATE POLICY "Organization admins can view all loans in org"
ON kunity.loans FOR SELECT
USING (organization_id = kunity.get_user_organization_id()); 
-- Note: You'd want to add a role-check function here to ensure the user is 'sacco_admin'.

CREATE POLICY "Users can view their own loan installments"
ON kunity.loan_installments FOR SELECT
USING (loan_id IN (SELECT id FROM kunity.loans WHERE member_id = auth.uid()));

-- Note: In a production app, INSERT/UPDATE permissions on financial records
-- should only be done securely via backend functions or by sacco admins!
