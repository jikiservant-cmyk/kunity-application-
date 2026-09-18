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
            Run the SQL migration scripts located in <code>supabase/migrations/</code> or <code>supabase/00_EMERGENCY_LOCKDOWN_FINAL.sql</code> in your Supabase SQL Editor. This will bootstrap the schema with all required tables, atomic RPC functions, and Row Level Security (RLS) policies.
          </p>
        </div>
      </div>
    </div>
  );
}
