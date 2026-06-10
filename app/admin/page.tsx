'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { 
  Users, Wallet, Loader2, CheckCircle, XCircle, LogOut, FileText
} from 'lucide-react';

export default function AdminDashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<any>(null);
  
  const [members, setMembers] = useState<any[]>([]);
  const [pendingLoans, setPendingLoans] = useState<any[]>([]);
  const [totalLiquidity, setTotalLiquidity] = useState(0);

  const fetchData = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
      router.push('/auth');
      return;
    }

    const { data: profileData } = await supabase.schema('public').from('admin_profiles').select('*').eq('id', session.user.id).single();
    
    if (profileData?.role !== 'sacco_admin' && profileData?.role !== 'super_admin') {
      router.push('/member');
      return;
    }
    setProfile(profileData);

    const { data: membersData } = await supabase
      .schema('kuntiy')
      .from('members')
      .select('*, accounts(cached_balance)');
      
    if (membersData) {
      setMembers(membersData);
      const total = membersData.reduce((acc, m) => acc + (m.accounts ? m.accounts.reduce((sum: number, a: any) => sum + parseFloat(a.cached_balance || '0'), 0) : 0), 0);
      setTotalLiquidity(total);
    }

    const { data: loansData } = await supabase
      .schema('kuntiy')
      .from('loans')
      .select('*, members(first_name, last_name, organization_id)')
      .eq('status', 'pending');
      
    if (loansData) setPendingLoans(loansData);

    setLoading(false);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push('/');
  };

  const updateLoanStatus = async (loanId: string, status: string, memberId: string, amount: string, organizationId: string) => {
    await supabase.schema('kuntiy').from('loans').update({ status }).eq('id', loanId);
    
    if (status === 'approved') {
       const { data: account } = await supabase.schema('kuntiy').from('accounts').select('id, cached_balance').eq('member_id', memberId).single();
       if (account) {
         const newBalance = parseFloat(account.cached_balance || "0") + parseFloat(amount);
         await supabase.schema('kuntiy').from('accounts').update({ cached_balance: newBalance }).eq('id', account.id);
         
         const { data: entry } = await supabase.schema('kuntiy').from('journal_entries').insert({
            organization_id: organizationId,
            description: 'Loan Disbursement'
         }).select('id').single();

         if (entry) {
            await supabase.schema('kuntiy').from('journal_lines').insert({
               journal_entry_id: entry.id,
               account_id: account.id,
               member_id: memberId,
               line_type: 'loan_disbursement',
               debit: parseFloat(amount)
            });
         }
       }
    }
    
    await fetchData();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FEF6EE]">
        <Loader2 className="w-8 h-8 animate-spin text-[#F97316]" />
      </div>
    );
  }

  const T = {
    cDeep:   "#7C2D12",
    cRich:   "#B45309",
    cMid:    "#F97316",
    gold:    "#D97706",
    goldLt:  "#FDE047",
    blue:    "#818CF8",
    sky:     "#A5B4FC",
    green:   "#3D9970",
    greenLt: "#86EFAC",
    red:     "#F43F5E",
    purple:  "#7C3AED",
    amber:   "#F59E0B",
    bg:      "#FEF6EE",
    card:    "#FFFFFF",
    text:    "#1C1917",
    sub:     "#78716C",
    ghost:   "#A8A29E",
    border:  "#F0E8DF",
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: T.bg, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif" }}>
      <header style={{ 
        background: `linear-gradient(145deg, ${T.cDeep} 0%, ${T.cRich} 100%)`, 
        color: 'white', width: '100%', padding: '0 24px', height: 72, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        boxShadow: `0 4px 24px rgba(5,7,26,0.15)`, position: 'relative', overflow: 'hidden'
      }}>
        <div style={{ position:"absolute", top:0, left:0, bottom:0, width:4, background:`linear-gradient(180deg, ${T.goldLt}, ${T.gold})` }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ backgroundColor: 'rgba(255,255,255,0.1)', padding: 8, borderRadius: 12 }}>
            <Wallet size={20} color={T.goldLt} />
          </div>
          <span style={{ fontWeight: 800, fontSize: 18, letterSpacing: '-0.02em' }}>SaccoConnect Admin</span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{profile?.full_name}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Administrator</div>
          </div>
          <button 
            onClick={handleSignOut}
            style={{ padding: 10, color: 'white', backgroundColor: 'transparent', border: 'none', borderRadius: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 24 }}>
          <div style={{ backgroundColor: T.card, borderRadius: 28, padding: 32, border: `1px solid ${T.border}`, boxShadow: '0 4px 28px rgba(5,7,26,0.06)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: T.sub, marginBottom: 32 }}>
              <h2 style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 10 }}>
                <Wallet size={20} color={T.blue} /> Total Liquidity
              </h2>
            </div>
            <div>
              <p style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', color: T.text, lineHeight: 1 }}>
                UGX {totalLiquidity.toLocaleString(undefined, {minimumFractionDigits: 2})}
              </p>
              <p style={{ color: T.sub, marginTop: 12, fontSize: 14 }}>Combined members&apos; wallet balances</p>
            </div>
          </div>

          <div style={{ backgroundColor: T.card, borderRadius: 28, padding: 32, border: `1px solid ${T.border}`, boxShadow: '0 4px 28px rgba(5,7,26,0.06)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: T.sub, marginBottom: 32 }}>
              <h2 style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 10 }}>
                <Users size={20} color={T.amber} /> Active Members
              </h2>
            </div>
            <div>
              <p style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', color: T.text, lineHeight: 1 }}>
                {members.length}
              </p>
              <p style={{ color: T.sub, marginTop: 12, fontSize: 14 }}>Registered in the cooperative</p>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 24 }}>
          {/* Pending Loans */}
          <div style={{ backgroundColor: T.card, borderRadius: 28, border: `1px solid ${T.border}`, boxShadow: '0 4px 28px rgba(5,7,26,0.06)', overflow: 'hidden' }}>
            <div style={{ padding: 24, borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#F8FAFC' }}>
              <h3 style={{ fontWeight: 700, color: T.text, display: 'flex', alignItems: 'center', gap: 10, fontSize: 16 }}>
                <FileText size={20} color={T.blue} /> Pending Loans
              </h3>
              <span style={{ backgroundColor: '#EEF2FF', color: T.blue, fontSize: 12, fontWeight: 800, padding: '4px 12px', borderRadius: 99 }}>
                {pendingLoans.length}
              </span>
            </div>
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {pendingLoans.length > 0 ? (
                pendingLoans.map((loan, idx) => (
                  <div key={loan.id} style={{ padding: 24, borderBottom: idx < pendingLoans.length - 1 ? `1px solid ${T.border}` : 'none', display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div>
                      <p style={{ fontWeight: 700, color: T.text, fontSize: 16 }}>{loan.members?.first_name} {loan.members?.last_name}</p>
                      <p style={{ fontSize: 13, color: T.sub, marginTop: 4 }}>Requested: {new Date(loan.created_at).toLocaleDateString()}</p>
                      <p style={{ fontSize: 20, fontWeight: 800, color: T.blue, marginTop: 8 }}>UGX {parseFloat(loan.principal).toLocaleString()}</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <button 
                        onClick={() => updateLoanStatus(loan.id, 'rejected', loan.member_id, loan.principal, loan.members?.organization_id)}
                        style={{ padding: '10px 16px', border: `1px solid ${T.red}40`, color: T.red, backgroundColor: '#FEF2F2', borderRadius: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14 }}
                        title="Reject Loan"
                      >
                        <XCircle size={18} /> Reject
                      </button>
                      <button 
                        onClick={() => updateLoanStatus(loan.id, 'approved', loan.member_id, loan.principal, loan.members?.organization_id)}
                        style={{ padding: '10px 16px', border: 'none', color: 'white', backgroundColor: T.green, borderRadius: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14 }}
                      >
                        <CheckCircle size={18} /> Approve
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ padding: 48, textAlign: 'center', color: T.ghost, fontSize: 15 }}>
                  No pending loan requests.
                </div>
              )}
            </div>
          </div>

          {/* Member Directory */}
          <div style={{ backgroundColor: T.card, borderRadius: 28, border: `1px solid ${T.border}`, boxShadow: '0 4px 28px rgba(5,7,26,0.06)', overflow: 'hidden' }}>
            <div style={{ padding: 24, borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontWeight: 700, color: T.text, display: 'flex', alignItems: 'center', gap: 10, fontSize: 16 }}>
                <Users size={20} color={T.ghost} /> Member Directory
              </h3>
            </div>
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {members.map((member, idx) => (
                <div key={member.id} style={{ padding: '20px 24px', borderBottom: idx < members.length - 1 ? `1px solid ${T.border}` : 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <p style={{ fontWeight: 600, color: T.text, fontSize: 15 }}>{member.first_name} {member.last_name}</p>
                    <p style={{ fontSize: 12, color: T.sub, marginTop: 4 }}>Member</p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontSize: 15, fontWeight: 700, color: T.green, fontVariantNumeric: 'tabular-nums' }}>
                      UGX {parseFloat(member.accounts?.[0]?.cached_balance || '0').toLocaleString()}
                    </p>
                    <p style={{ fontSize: 11, color: T.ghost, marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Wallet Balance</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

      </main>
    </div>
  );
}
