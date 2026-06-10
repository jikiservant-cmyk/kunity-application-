import React from 'react';
import { Database, AlertTriangle, Key } from 'lucide-react';

export default function SetupRequired() {
  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full bg-white rounded-2xl shadow-xl shadow-zinc-200 border border-zinc-100 p-8 space-y-6">
        <div className="w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mb-6">
          <AlertTriangle size={24} />
        </div>
        
        <div>
          <h1 className="text-2xl font-display font-bold text-zinc-900">Supabase Setup Required</h1>
          <p className="text-zinc-600 mt-2">
            You requested to use Supabase for your Sacco platform. Please set up your project 
            by adding the following keys to your AI Studio Environment Secrets:
          </p>
        </div>

        <div className="bg-zinc-100 p-4 rounded-xl space-y-3 font-mono text-sm shadow-inner">
          <div className="flex items-center space-x-3 text-zinc-800">
            <Key size={16} className="text-zinc-400" />
            <span>NEXT_PUBLIC_SUPABASE_URL</span>
          </div>
          <div className="flex items-center space-x-3 text-zinc-800">
            <Key size={16} className="text-zinc-400" />
            <span>NEXT_PUBLIC_SUPABASE_ANON_KEY</span>
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-zinc-100">
          <h2 className="text-lg font-semibold text-zinc-900 flex items-center gap-2">
            <Database size={20} className="text-indigo-600"/>
            Database Schema Needed
          </h2>
          <p className="text-sm text-zinc-600">
            Run the following SQL in your Supabase SQL Editor to bootstrap the Sacco Management schema:
          </p>
          <pre className="bg-zinc-900 text-zinc-300 p-4 rounded-xl text-xs overflow-x-auto whitespace-pre-wrap">
{`-- Sacco Schema Bootstrap
CREATE TYPE user_role AS ENUM ('admin', 'member');
CREATE TYPE transaction_type AS ENUM ('deposit', 'withdrawal', 'loan_disbursement', 'loan_repayment');
CREATE TYPE loan_status AS ENUM ('pending', 'approved', 'active', 'paid', 'rejected');

CREATE TABLE profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  full_name TEXT NOT NULL,
  role user_role DEFAULT 'member',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) UNIQUE NOT NULL,
  balance NUMERIC(12,2) DEFAULT 0.00,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES wallets(id) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  type transaction_type NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  paid_amount NUMERIC(12,2) DEFAULT 0.00,
  status loan_status DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Basic RLS setup (In production, harden these rules)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loans ENABLE ROW LEVEL SECURITY;`}
          </pre>
        </div>
      </div>
    </div>
  );
}
