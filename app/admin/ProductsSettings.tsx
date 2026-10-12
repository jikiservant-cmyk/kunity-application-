'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

// Admin Settings > Products: create and activate/deactivate this SACCO's savings
// and loan products. All reads and writes go through /api/admin/products, which
// scopes everything to the admin's own SACCO.

const C = {
  text: '#1C1917', sub: '#78716C', ghost: '#A8A29E', border: '#F0E8DF',
  card: '#FFFFFF', cardWarm: '#FCFAEE', cMid: '#F97316', green: '#3D9970',
  red: '#EF4444', redLt: '#FEE2E2', greenLt: '#DCFCE7',
};

type Toast = { type: 'success' | 'error'; text: string };

interface SavingsProduct {
  id: string; name: string; interest_rate: number; min_balance: number;
  allows_withdrawals: boolean; deposit_frequency: string; is_active: boolean;
}
interface LoanProduct {
  id: string; name: string; interest_rate: number; min_principal: number | null;
  max_principal: number | null; is_active: boolean;
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 12, border: `1px solid ${C.border}`,
  fontSize: 14, background: '#F9FAFB', outline: 'none', boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = { fontSize: 11, color: C.sub, fontWeight: 700, marginBottom: 4, display: 'block' };
const buttonStyle: React.CSSProperties = {
  padding: '10px 16px', borderRadius: 12, border: 'none', background: C.cMid,
  color: 'white', fontWeight: 800, fontSize: 13, cursor: 'pointer',
};

async function callProducts(body: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Your session has expired. Please sign in again.');
  const res = await fetch('/api/admin/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: session.access_token, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function StatusPill({ active }: { active: boolean }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 800, padding: '3px 8px', borderRadius: 999,
      background: active ? C.greenLt : C.redLt, color: active ? C.green : C.red,
    }}>
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

export default function ProductsSettings({ orgId, onToast }: { orgId: string; onToast: (t: Toast) => void }) {
  const [savings, setSavings] = useState<SavingsProduct[]>([]);
  const [loans, setLoans] = useState<LoanProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // savings form
  const [sName, setSName] = useState('');
  const [sRate, setSRate] = useState('');
  const [sMin, setSMin] = useState('');
  const [sWithdraw, setSWithdraw] = useState(true);

  // loan form
  const [lName, setLName] = useState('');
  const [lRate, setLRate] = useState('');
  const [lMin, setLMin] = useState('');
  const [lMax, setLMax] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await callProducts({ action: 'list', organizationId: orgId || undefined });
      setSavings(data.savingsProducts || []);
      setLoans(data.loanProducts || []);
    } catch (e: any) {
      onToast({ type: 'error', text: e.message || 'Could not load products' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (orgId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const createSavings = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await callProducts({
        action: 'create_savings', organizationId: orgId || undefined,
        name: sName, interestRate: sRate, minBalance: sMin || 0,
        depositFrequency: 'weekly', allowsWithdrawals: sWithdraw,
      });
      onToast({ type: 'success', text: `Savings product "${sName.trim()}" created.` });
      setSName(''); setSRate(''); setSMin(''); setSWithdraw(true);
      await load();
    } catch (err: any) {
      onToast({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const createLoan = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await callProducts({
        action: 'create_loan', organizationId: orgId || undefined,
        name: lName, interestRate: lRate, minAmount: lMin || 0, maxAmount: lMax,
      });
      onToast({ type: 'success', text: `Loan product "${lName.trim()}" created.` });
      setLName(''); setLRate(''); setLMin(''); setLMax('');
      await load();
    } catch (err: any) {
      onToast({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (productType: 'savings' | 'loan', id: string, isActive: boolean) => {
    setBusy(true);
    try {
      await callProducts({ action: 'set_active', organizationId: orgId || undefined, productType, productId: id, isActive: !isActive });
      onToast({ type: 'success', text: isActive ? 'Product deactivated. New members and loans cannot use it.' : 'Product activated.' });
      await load();
    } catch (err: any) {
      onToast({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* ── Savings products ───────────────────────────────── */}
      <div style={{ backgroundColor: C.cardWarm, borderRadius: 16, padding: '20px 24px', border: `1px solid ${C.border}` }}>
        <h4 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: C.text }}>Savings products</h4>
        <p style={{ margin: '4px 0 14px', fontSize: 12, color: C.sub }}>
          Members open a savings plan from these. Deactivating a product stops new plans; existing plans are not changed.
        </p>

        {loading && savings.length === 0 && <p style={{ fontSize: 13, color: C.sub }}>Loading…</p>}
        {!loading && savings.length === 0 && <p style={{ fontSize: 13, color: C.sub }}>No savings products yet. Add one below.</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {savings.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: C.card, borderRadius: 12, padding: '12px 14px', border: `1px solid ${C.border}` }}>
              <div>
                <div style={{ fontWeight: 800, color: C.text, fontSize: 14 }}>{p.name} <StatusPill active={p.is_active} /></div>
                <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>
                  {p.interest_rate}% · {p.deposit_frequency} deposits · min balance UGX {Number(p.min_balance || 0).toLocaleString()} · withdrawals {p.allows_withdrawals ? 'allowed' : 'locked'}
                </div>
              </div>
              <button disabled={busy} onClick={() => toggle('savings', p.id, p.is_active)} style={{ ...buttonStyle, background: 'white', color: p.is_active ? C.red : C.green, border: `1px solid ${C.border}` }}>
                {p.is_active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          ))}
        </div>

        <form onSubmit={createSavings} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, alignItems: 'end' }}>
          <div><label style={labelStyle}>Name</label><input required style={inputStyle} value={sName} onChange={e => setSName(e.target.value)} placeholder="e.g. Standard Savings" maxLength={60} /></div>
          <div><label style={labelStyle}>Interest rate (% a year)</label><input required type="number" min="0" max="100" step="0.01" style={inputStyle} value={sRate} onChange={e => setSRate(e.target.value)} /></div>
          <div><label style={labelStyle}>Minimum balance (UGX)</label><input type="number" min="0" step="100" style={inputStyle} value={sMin} onChange={e => setSMin(e.target.value)} placeholder="0" /></div>
          <div>
            <label style={labelStyle}>Deposit frequency</label>
            <input style={{ ...inputStyle, background: '#F3F4F6' }} value="Weekly" disabled readOnly />
          </div>
          <label style={{ fontSize: 13, color: C.text, display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10 }}>
            <input type="checkbox" checked={sWithdraw} onChange={e => setSWithdraw(e.target.checked)} /> Allow withdrawals
          </label>
          <button disabled={busy} type="submit" style={buttonStyle}>{busy ? 'Saving…' : 'Add savings product'}</button>
        </form>
      </div>

      {/* ── Loan products ──────────────────────────────────── */}
      <div style={{ backgroundColor: C.cardWarm, borderRadius: 16, padding: '20px 24px', border: `1px solid ${C.border}` }}>
        <h4 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: C.text }}>Loan products</h4>
        <p style={{ margin: '4px 0 14px', fontSize: 12, color: C.sub }}>
          Members choose one of these when they apply for a loan. The rate and amount limits come from the product.
          Members can only apply when at least one loan product is active.
        </p>

        {!loading && loans.length === 0 && <p style={{ fontSize: 13, color: C.sub }}>No loan products yet. Add one below.</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {loans.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: C.card, borderRadius: 12, padding: '12px 14px', border: `1px solid ${C.border}` }}>
              <div>
                <div style={{ fontWeight: 800, color: C.text, fontSize: 14 }}>{p.name} <StatusPill active={p.is_active} /></div>
                <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>
                  {p.interest_rate}% · UGX {Number(p.min_principal || 0).toLocaleString()}{p.max_principal != null ? ` – ${Number(p.max_principal).toLocaleString()}` : ' and up (no maximum)'}
                </div>
              </div>
              <button disabled={busy} onClick={() => toggle('loan', p.id, p.is_active)} style={{ ...buttonStyle, background: 'white', color: p.is_active ? C.red : C.green, border: `1px solid ${C.border}` }}>
                {p.is_active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          ))}
        </div>

        <form onSubmit={createLoan} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, alignItems: 'end' }}>
          <div><label style={labelStyle}>Name</label><input required style={inputStyle} value={lName} onChange={e => setLName(e.target.value)} placeholder="e.g. Development Loan" maxLength={60} /></div>
          <div><label style={labelStyle}>Interest rate (%)</label><input required type="number" min="0" max="100" step="0.01" style={inputStyle} value={lRate} onChange={e => setLRate(e.target.value)} /></div>
          <div><label style={labelStyle}>Minimum amount (UGX)</label><input type="number" min="0" step="1000" style={inputStyle} value={lMin} onChange={e => setLMin(e.target.value)} placeholder="0" /></div>
          <div><label style={labelStyle}>Maximum amount (UGX, optional)</label><input type="number" min="1" step="1000" style={inputStyle} value={lMax} onChange={e => setLMax(e.target.value)} placeholder="No maximum" /></div>
          <button disabled={busy} type="submit" style={buttonStyle}>{busy ? 'Saving…' : 'Add loan product'}</button>
        </form>
      </div>
    </div>
  );
}
