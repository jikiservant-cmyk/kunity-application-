'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { 
  Home, PiggyBank, CreditCard, Clock, User,
  Eye, EyeOff, Bell, ChevronRight,
  ArrowUpRight, ArrowDownRight,
  Plus, Send, Download, Upload, Shield, Phone, TrendingUp, CheckCircle, LogOut,
  Loader2
} from 'lucide-react';

/* ── Design Tokens ────────────────────────────── */
const T = {
  cDeep:   "#05071A",
  cRich:   "#0C1A68",
  cMid:    "#1540D4",
  gold:    "#C8A83E",
  goldLt:  "#F0D898",
  blue:    "#2262F0",
  sky:     "#38BDF8",
  green:   "#059669",
  greenLt: "#34D399",
  red:     "#F43F5E",
  purple:  "#7C3AED",
  amber:   "#D97706",
  bg:      "#F2F5FD",
  card:    "#FFFFFF",
  text:    "#05071A",
  med:     "#374151",
  sub:     "#6B7280",
  ghost:   "#9CA3AF",
  border:  "#E4E9F4",
  navBg:   "#05071A",
  navAct:  "#2262F0",
};

const UGX  = (n: number | string) => `UGX ${Number(n).toLocaleString("en-UG")}`;
const UGXM = (n: number | string) => {
  const num = Number(n);
  return num >= 1_000_000
    ? `UGX ${(num / 1_000_000).toFixed(2)}M`
    : `UGX ${(num / 1_000).toFixed(0)}K`;
};

function Chip() {
  return (
    <div style={{
      width:38, height:28, borderRadius:6,
      background:`linear-gradient(135deg, ${T.gold} 0%, ${T.goldLt} 50%, ${T.gold} 100%)`,
      display:"grid", gridTemplateRows:"repeat(3,1fr)",
      padding:"5px 4px", gap:2,
    }}>
      {[0.3,0.15,0.3].map((o,i)=>(
        <div key={i} style={{ background:`rgba(100,60,0,${o})`, borderRadius:1 }} />
      ))}
    </div>
  );
}

function Card({ children, style={} }: any) {
  return (
    <div style={{
      background:T.card, borderRadius:22,
      padding:"18px",
      boxShadow:"0 4px 28px rgba(5,7,26,0.08), 0 1px 6px rgba(5,7,26,0.04)",
      ...style,
    }}>{children}</div>
  );
}

function Bar({ pct, gradient }: any) {
  return (
    <div style={{ height:8, borderRadius:99, background:"#EAEEFC", overflow:"hidden" }}>
      <div style={{
        height:"100%", width:`${Math.min(pct,100)}%`, borderRadius:99,
        background:gradient,
        transition:"width 0.7s cubic-bezier(0.4,0,0.2,1)",
      }} />
    </div>
  );
}

const iconMeta = (cat: string, type: string) => {
  if (type==="cr") {
    if (cat==="earn")    return { bg:"#FEF3C7", color:T.amber  };
    if (cat==="loan_disbursement") return { bg:"#EEF2FF", color:T.blue   };
    return                      { bg:"#D1FAE5", color:T.green  };
  }
  if (cat==="repayment_principal")      return { bg:"#EEF2FF", color:T.blue   };
  if (cat==="withdrawal")      return { bg:"#FEE2E2", color:T.red    };
  return                        { bg:"#FEE2E2", color:T.red    };
};

function TxnRow({ t, last }: any) {
  const isCr = t.type==="cr";
  const { bg, color } = iconMeta(t.cat, t.type);
  return (
    <div style={{
      display:"flex", alignItems:"center", gap:14,
      padding:"14px 0",
      borderBottom:last ? "none" : `1px solid ${T.border}`,
    }}>
      <div style={{
        width:46, height:46, borderRadius:15, flexShrink:0,
        background:bg,
        display:"flex", alignItems:"center", justifyContent:"center",
      }}>
        {isCr
          ? <ArrowDownRight size={20} color={color} />
          : <ArrowUpRight   size={20} color={color} />}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontWeight:600, fontSize:14, color:T.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", textTransform: 'capitalize' }}>
          {t.label}
        </div>
        <div style={{ fontSize:12, color:T.sub, marginTop:3 }}>{t.date}</div>
      </div>
      <div style={{ fontWeight:700, fontSize:14, color:isCr?T.green:T.text, flexShrink:0, fontVariantNumeric:"tabular-nums" }}>
        {isCr?"+":"−"}{UGX(t.amount)}
      </div>
    </div>
  );
}

export default function MemberDashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("home");
  const [showBal, setShowBal] = useState(true);
  
  const [profile, setProfile] = useState<any>(null);
  const [member, setMember] = useState<any>(null);
  const [wallet, setWallet] = useState<any>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loans, setLoans] = useState<any[]>([]);

  // Action states & Modals
  const [actionLoading, setActionLoading] = useState(false);
  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState('');

  const fetchData = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
      router.push('/auth');
      return;
    }

    const { data: profileData } = await supabase.schema('public').from('admin_profiles').select('*').eq('id', session.user.id).single();
    setProfile(profileData);

    const { data: memberData } = await supabase.schema('kuntiy').from('members').select('*').eq('profile_id', session.user.id).single();
    setMember(memberData);

    if (memberData) {
      const { data: accountData } = await supabase.schema('kuntiy').from('accounts').select('*').eq('member_id', memberData.id).single();
      setWallet(accountData);

      if (accountData) {
        const { data: txData } = await supabase.schema('kuntiy').from('journal_lines').select('*, journal_entries(description, created_at)').eq('account_id', accountData.id).order('created_at', { ascending: false }).limit(20);
        setTransactions(txData || []);
      }

      const { data: loanData } = await supabase.schema('kuntiy').from('loans').select('*, loan_installments(paid_principal, paid_interest)').eq('member_id', memberData.id).order('created_at', { ascending: false });
      setLoans(loanData || []);
    }

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

  const activeLoan = loans.find(l => l.status === 'active' || l.status === 'approved' || l.status === 'disbursed');
  const loanTotal = activeLoan ? parseFloat(activeLoan.principal) : 0;
  const loanPaid = activeLoan?.loan_installments?.reduce((sum: number, inst: any) => sum + parseFloat(inst.paid_principal || "0"), 0) || 0;

  const performAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amountInput || !wallet || !member || !profile) return;
    
    const amount = parseFloat(amountInput);
    if (amount <= 0) return;

    setActionLoading(true);

    if (activeModal === 'deposit') {
      const newBalance = parseFloat(wallet.cached_balance || "0") + amount;
      await supabase.schema('kuntiy').from('accounts').update({ cached_balance: newBalance }).eq('id', wallet.id);
      
      const { data: entry } = await supabase.schema('kuntiy').from('journal_entries').insert({
        organization_id: member.organization_id,
        description: 'Wallet Deposit',
        created_by: profile.id
      }).select('id').single();

      if (entry) {
        await supabase.schema('kuntiy').from('journal_lines').insert({
          journal_entry_id: entry.id,
          account_id: wallet.id,
          member_id: member.id,
          line_type: 'deposit',
          debit: amount
        });
      }
    } else if (activeModal === 'withdraw') {
      if (amount > parseFloat(wallet.cached_balance || "0")) {
        alert("Insufficient funds!");
        setActionLoading(false);
        return;
      }
      
      const newBalance = parseFloat(wallet.cached_balance || "0") - amount;
      await supabase.schema('kuntiy').from('accounts').update({ cached_balance: newBalance }).eq('id', wallet.id);
      
      const { data: entry } = await supabase.schema('kuntiy').from('journal_entries').insert({
        organization_id: member.organization_id,
        description: 'Wallet Withdrawal',
        created_by: profile.id
      }).select('id').single();

      if (entry) {
        await supabase.schema('kuntiy').from('journal_lines').insert({
          journal_entry_id: entry.id,
          account_id: wallet.id,
          member_id: member.id,
          line_type: 'withdrawal',
          credit: amount
        });
      }
    } else if (activeModal === 'loan') {
      await supabase.schema('kuntiy').from('loans').insert({
        organization_id: member.organization_id,
        member_id: member.id,
        principal: amount,
        interest_rate: 10,
        status: 'pending',
        created_by: profile.id
      });
    } else if (activeModal === 'repay' && activeLoan) {
      if (amount > parseFloat(wallet.cached_balance || "0")) {
        alert("Insufficient wallet balance for loan repayment!");
        setActionLoading(false);
        return;
      }
      if (amount > (loanTotal - loanPaid)) {
        alert("Amount exceeds remaining loan balance!");
        setActionLoading(false);
        return;
      }
      
      const newBalance = parseFloat(wallet.cached_balance || "0") - amount;
      await supabase.schema('kuntiy').from('accounts').update({ cached_balance: newBalance }).eq('id', wallet.id);
      
      const { data: entry } = await supabase.schema('kuntiy').from('journal_entries').insert({
        organization_id: member.organization_id,
        description: 'Loan Repayment',
        created_by: profile.id
      }).select('id').single();

      if (entry) {
        await supabase.schema('kuntiy').from('journal_lines').insert({
          journal_entry_id: entry.id,
          account_id: wallet.id,
          member_id: member.id,
          line_type: 'repayment_principal',
          credit: amount,
          loan_id: activeLoan.id
        });
        
        await supabase.schema('kuntiy').from('loan_repayments').insert({
          organization_id: member.organization_id,
          loan_id: activeLoan.id,
          journal_entry_id: entry.id,
          member_id: member.id,
          principal_paid: amount,
          created_by: profile.id
        });
        
        const newPaidAmount = loanPaid + amount;
        if (newPaidAmount >= loanTotal) {
          await supabase.schema('kuntiy').from('loans').update({ status: 'completed' }).eq('id', activeLoan.id);
        }
      }
    }

    setAmountInput('');
    setActiveModal(null);
    await fetchData();
    setActionLoading(false);
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#F2F5FD]">
        <Loader2 className="w-8 h-8 animate-spin text-[#1540D4]" />
      </div>
    );
  }

  // Derived Data
  const memberObj = {
    name: profile?.full_name || 'Member',
    id: `SCO-${member?.id?.toString().slice(0, 4) || '0000'}`,
    initials: (profile?.full_name || 'M').split(' ').map((n: string) => n[0]).join('').substring(0, 2).toUpperCase(),
    phone: member?.phone_number || 'N/A',
    since: member?.created_at ? new Date(member.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'Unknown',
    branch: 'Main Branch'
  };

  const balances = {
    wallet: parseFloat(wallet?.cached_balance || '0'),
    savings: 0,
    shares: 0,
    loan: loanTotal - loanPaid
  };

  const parsedTxns = transactions.map(tx => {
    const isDeposit = tx.line_type === 'deposit' || tx.line_type === 'loan_disbursement';
    return {
      id: tx.id,
      type: isDeposit ? 'cr' : 'dr',
      label: tx.journal_entries?.description || tx.line_type.replace('_', ' '),
      sub: isDeposit ? 'Received' : 'Sent',
      amount: parseFloat(tx.debit || "0") || parseFloat(tx.credit || "0"),
      date: new Date(tx.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      cat: tx.line_type
    };
  });

  return (
    <div style={{
      maxWidth:600, margin:"0 auto", height:"100vh", position: 'relative',
      background:T.bg, display:"flex", flexDirection:"column",
      fontFamily:"-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif",
      overflow:"hidden",
      WebkitFontSmoothing:"antialiased",
      MozOsxFontSmoothing:"grayscale",
    }}>
      <div style={{ flex:1, overflowY:"auto", overflowX:"hidden", paddingBottom: 80 }}>
        
        {activeTab === "home" && (
          <div style={{ padding:"24px 18px 0" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:28 }}>
              <div>
                <div style={{ fontSize:13, color:T.sub, marginBottom:3 }}>Good morning 👋</div>
                <div style={{ fontSize:23, fontWeight:800, color:T.text, letterSpacing:"-0.02em" }}>
                  {memberObj.name.split(" ")[0]}
                </div>
              </div>
              <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                <div style={{ position:"relative" }}>
                  <button onClick={handleSignOut} style={{
                    width:44, height:44, borderRadius:14,
                    background:T.card, border:`1px solid ${T.border}`, cursor:"pointer",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    boxShadow:"0 2px 12px rgba(5,7,26,0.08)",
                  }}>
                    <LogOut size={19} color={T.red} />
                  </button>
                </div>
                <div style={{
                  width:44, height:44, borderRadius:14,
                  background:`linear-gradient(135deg, ${T.cDeep}, ${T.cMid})`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontWeight:800, fontSize:15, color:"white",
                  boxShadow:`0 6px 18px ${T.blue}50`,
                }}>
                  {memberObj.initials}
                </div>
              </div>
            </div>

            {/* Premium Balance Card */}
            <div style={{
              borderRadius:28, padding:"28px 24px 24px", marginBottom:28,
              background:`linear-gradient(145deg, ${T.cDeep} 0%, ${T.cRich} 45%, ${T.cMid} 100%)`,
              position:"relative", overflow:"hidden",
              boxShadow:`0 24px 64px ${T.cDeep}90, 0 8px 24px ${T.cDeep}60`,
            }}>
              <div style={{ position:"absolute", top:-60, right:-40, width:200, height:200, borderRadius:"50%", background:"rgba(255,255,255,0.04)", pointerEvents:"none" }} />
              <div style={{ position:"absolute", bottom:-60, left:-30, width:170, height:170, borderRadius:"50%", background:"rgba(255,255,255,0.03)", pointerEvents:"none" }} />
              <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:`linear-gradient(90deg, transparent 0%, ${T.gold} 40%, ${T.goldLt} 60%, ${T.gold} 80%, transparent 100%)`, opacity:0.7 }} />

              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:26 }}>
                <Chip />
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontSize:12, color:T.gold, fontWeight:700, letterSpacing:"0.14em", textTransform:"uppercase" }}>
                    SaccoConnect
                  </div>
                  <div style={{ fontSize:9, color:"rgba(255,255,255,0.35)", letterSpacing:"0.12em", textTransform:"uppercase", marginTop:2 }}>
                    Premium
                  </div>
                </div>
              </div>

              <div style={{ marginBottom:4 }}>
                <div style={{ fontSize:10, color:"rgba(255,255,255,0.45)", textTransform:"uppercase", letterSpacing:"0.14em", marginBottom:10 }}>
                  Wallet Balance
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  <div style={{
                    fontSize:34, fontWeight:800, color:"white",
                    letterSpacing:"-0.03em", fontVariantNumeric:"tabular-nums", lineHeight:1,
                  }}>
                    {showBal ? UGX(balances.wallet) : "••••••••••••"}
                  </div>
                  <button onClick={()=>setShowBal(!showBal)} style={{ background:"none", border:"none", cursor:"pointer", padding:2, display:"flex", flexShrink:0 }}>
                    {showBal ? <EyeOff size={18} color="rgba(255,255,255,0.45)" /> : <Eye size={18} color="rgba(255,255,255,0.45)" />}
                  </button>
                </div>
              </div>

              <div style={{ fontSize:12, color:"rgba(255,255,255,0.3)", letterSpacing:"0.18em", marginBottom:26, marginTop:10 }}>
                ●●●● ●●●● {memberObj.id.replace("SCO-","")}
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:10 }}>
                {[
                  { label:"Main Savings", val:balances.wallet },
                  { label:"Active Loan",  val:balances.loan    },
                ].map(item=>(
                  <div key={item.label} style={{
                    background:"rgba(255,255,255,0.08)",
                    border:"1px solid rgba(255,255,255,0.1)",
                    borderRadius:14, padding:"11px 10px",
                  }}>
                    <div style={{ fontSize:10, color:"rgba(255,255,255,0.45)", marginBottom:6, letterSpacing:"0.08em", textTransform:"uppercase" }}>
                      {item.label}
                    </div>
                    <div style={{ fontSize:13, fontWeight:700, color:"white", fontVariantNumeric:"tabular-nums" }}>
                      {showBal ? UGXM(item.val) : "•••"}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Quick Actions */}
            <div style={{ marginBottom:28 }}>
              <div style={{ fontSize:17, fontWeight:800, color:T.text, marginBottom:16, letterSpacing:"-0.01em" }}>Quick Actions</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12 }}>
                {[
                  { label:"Deposit",  Icon:Download,   grad:`linear-gradient(145deg,#1540A0,${T.blue})`, sh:`${T.blue}45`, id: 'deposit'  },
                  { label:"Withdraw", Icon:Upload,     grad:`linear-gradient(145deg,#4C1D95,${T.purple})`,sh:`${T.purple}45`, id: 'withdraw'},
                  { label:"Get Loan", Icon:Plus,       grad:`linear-gradient(145deg,#064E3B,${T.green})`, sh:`${T.green}45`, id: 'loan' },
                  { label:"Pay Loan", Icon:CreditCard, grad:`linear-gradient(145deg,#78350F,${T.amber})`, sh:`${T.amber}45`, id: 'repay' },
                ].map(({ label, Icon, grad, sh, id })=>(
                  <button key={label} onClick={() => setActiveModal(id)} style={{ background:"none", border:"none", cursor:"pointer", padding:0 }}>
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:9 }}>
                      <div style={{
                        width:56, height:56, borderRadius:18,
                        background:grad,
                        display:"flex", alignItems:"center", justifyContent:"center",
                        boxShadow:`0 8px 20px ${sh}`,
                      }}>
                        <Icon size={22} color="white" />
                      </div>
                      <span style={{ fontSize:11, fontWeight:600, color:T.sub }}>{label}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Recent Activity */}
            <Card style={{ marginBottom:24 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                <div style={{ fontSize:16, fontWeight:700, color:T.text }}>Recent Activity</div>
                <button onClick={()=>setActiveTab("history")} style={{ background:"none", border:"none", cursor:"pointer", fontSize:13, color:T.blue, fontWeight:700 }}>
                  See all &rarr;
                </button>
              </div>
              {parsedTxns.slice(0,4).map((t,i)=>(
                <TxnRow key={t.id} t={t} last={i===(Math.min(parsedTxns.length, 4)-1)} />
              ))}
              {parsedTxns.length === 0 && (
                <div style={{ textAlign:"center", padding:"24px 0", color:T.ghost, fontSize:14 }}>No activity yet</div>
              )}
            </Card>
          </div>
        )}

        {activeTab === "savings" && (
          <div style={{ padding:"24px 18px 0" }}>
            <div style={{ fontSize:22, fontWeight:800, color:T.text, marginBottom:22, letterSpacing:"-0.02em" }}>My Savings</div>
            <div style={{
              borderRadius:26, padding:"28px 24px", marginBottom:22,
              background:`linear-gradient(145deg, #022C22 0%, #065F46 50%, ${T.green} 100%)`,
              position:"relative", overflow:"hidden",
              boxShadow:`0 24px 56px rgba(2,44,34,0.55), 0 8px 24px rgba(2,44,34,0.35)`,
            }}>
              <div style={{ position:"absolute", top:-50, right:-30, width:170, height:170, borderRadius:"50%", background:"rgba(255,255,255,0.05)", pointerEvents:"none" }} />
              <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:`linear-gradient(90deg, transparent, ${T.greenLt}, transparent)`, opacity:0.5 }} />
              <div style={{ fontSize:10, color:"rgba(255,255,255,0.45)", textTransform:"uppercase", letterSpacing:"0.14em", marginBottom:10 }}>Main Wallet Total Savings</div>
              <div style={{ fontSize:36, fontWeight:800, color:"white", letterSpacing:"-0.03em", fontVariantNumeric:"tabular-nums", lineHeight:1, marginBottom:14 }}>
                {UGX(balances.wallet)}
              </div>
            </div>

            <Card style={{ marginBottom:20 }}>
              <div style={{ fontSize:15, fontWeight:700, color:T.text, marginBottom:16 }}>Breakdown</div>
              {[
                { label:"Primary Wallet", amount:balances.wallet, pct:100, color:T.blue   },
              ].map((b,i,arr)=>(
                <div key={b.label} style={{ padding:"13px 0", borderBottom:i<arr.length-1?`1px solid ${T.border}`:"none" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <div style={{ width:10, height:10, borderRadius:"50%", background:b.color }} />
                      <span style={{ fontSize:14, color:T.text }}>{b.label}</span>
                    </div>
                    <span style={{ fontWeight:700, fontSize:14, color:T.text, fontVariantNumeric:"tabular-nums" }}>
                      {UGX(b.amount)}
                    </span>
                  </div>
                  <Bar pct={b.pct} gradient={`linear-gradient(90deg, ${b.color}, ${b.color}88)`} />
                </div>
              ))}
            </Card>

            <button onClick={() => setActiveModal('deposit')} style={{
              width:"100%", padding:"18px", borderRadius:18, border:"none", cursor:"pointer",
              background:`linear-gradient(135deg, #022C22 0%, ${T.green} 100%)`,
              color:"white", fontWeight:700, fontSize:16, marginTop:8, marginBottom:8,
              display:"flex", alignItems:"center", justifyContent:"center", gap:10,
              boxShadow:`0 10px 28px ${T.green}50`, letterSpacing:"-0.01em"
            }}>
              <Download size={20} /> Deposit Funds
            </button>
          </div>
        )}

        {activeTab === "loans" && (
          <div style={{ padding:"24px 18px 0" }}>
            <div style={{ fontSize:22, fontWeight:800, color:T.text, marginBottom:22, letterSpacing:"-0.02em" }}>My Loans</div>

            <div style={{
              borderRadius:26, padding:"28px 24px", marginBottom:22,
              background:`linear-gradient(145deg, #07104A 0%, #0E1E80 50%, ${T.cMid} 100%)`,
              position:"relative", overflow:"hidden",
              boxShadow:`0 24px 56px rgba(7,16,74,0.55), 0 8px 24px rgba(7,16,74,0.35)`,
            }}>
              <div style={{ position:"absolute", top:-50, right:-30, width:170, height:170, borderRadius:"50%", background:"rgba(255,255,255,0.05)", pointerEvents:"none" }} />
              <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:`linear-gradient(90deg, transparent, ${T.sky}, transparent)`, opacity:0.45 }} />
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div>
                  <div style={{ fontSize:10, color:"rgba(255,255,255,0.45)", textTransform:"uppercase", letterSpacing:"0.14em", marginBottom:10 }}>Outstanding Balance</div>
                  <div style={{ fontSize:36, fontWeight:800, color:"white", letterSpacing:"-0.03em", fontVariantNumeric:"tabular-nums", lineHeight:1 }}>
                    {UGX(balances.loan)}
                  </div>
                </div>
              </div>
            </div>

            {loans.length > 0 ? loans.map(l=>{
              const currentTotal = parseFloat(l.principal);
              const currentPaid = l.loan_installments?.reduce((sum: number, inst: any) => sum + parseFloat(inst.paid_principal || "0"), 0) || 0;
              const pct = currentTotal > 0 ? Math.round((currentPaid/currentTotal)*100) : 0;
              const done = l.status==="completed" || l.status==="rejected";
              
              return (
                <Card key={l.id} style={{ marginBottom:14 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 }}>
                    <div>
                      <div style={{ fontSize:15, fontWeight:700, color:T.text }}>Personal Loan</div>
                      <div style={{ fontSize:13, color:T.sub, marginTop:3, fontVariantNumeric:"tabular-nums" }}>Principal: {UGX(currentTotal)}</div>
                    </div>
                    <div style={{
                      padding:"5px 13px", borderRadius:20, fontSize:12, fontWeight:700,
                      background:l.status === 'completed' ? "#ECFDF5" : l.status === 'rejected' ? "#FEE2E2" : l.status === 'pending' ? "#FEF3C7" : "#EFF6FF",
                      color:l.status === 'completed' ? "#065F46" : l.status === 'rejected' ? "#991B1B" : l.status === 'pending' ? "#B45309" : "#1E40AF",
                      display:"flex", alignItems:"center", gap:5, textTransform: 'capitalize'
                    }}>
                      {l.status === 'completed' ? <><CheckCircle size={12} /> Cleared</> : `● ${l.status}`}
                    </div>
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10 }}>
                    <span style={{ fontSize:13, color:T.sub, fontVariantNumeric:"tabular-nums" }}>Repaid: {UGX(currentPaid)}</span>
                    <span style={{ fontSize:15, fontWeight:800, color:done?T.green:T.blue, fontVariantNumeric:"tabular-nums" }}>{pct}%</span>
                  </div>
                  <Bar pct={pct} gradient={done
                    ? `linear-gradient(90deg, ${T.green}, ${T.greenLt})`
                    : `linear-gradient(90deg, ${T.blue}, ${T.sky})`} />
                </Card>
              );
            }) : (
              <div style={{ textAlign:"center", padding:"48px 0", color:T.ghost, fontSize:14 }}>No loan history</div>
            )}

            <button onClick={() => setActiveModal('loan')} disabled={!!activeLoan} style={{
              width:"100%", padding:"18px", borderRadius:18, border:"none", cursor: activeLoan ? "not-allowed" : "pointer",
              background:`linear-gradient(135deg, ${T.cDeep} 0%, ${T.blue} 100%)`,
              color:"white", fontWeight:700, fontSize:16, marginTop:8, marginBottom:8,
              display:"flex", alignItems:"center", justifyContent:"center", gap:10,
              boxShadow:`0 10px 28px ${T.blue}50`, letterSpacing:"-0.01em", opacity: activeLoan ? 0.5 : 1
            }}>
              <Plus size={20} /> {activeLoan ? 'Loan Already Active' : 'Apply for Loan'}
            </button>
            <button onClick={() => setActiveModal('repay')} disabled={!activeLoan} style={{
              width:"100%", padding:"18px", borderRadius:18, border:`2px solid ${T.blue}`, cursor: !activeLoan ? "not-allowed" : "pointer",
              background:'transparent',
              color:T.blue, fontWeight:700, fontSize:16, marginTop:8, marginBottom:8,
              display:"flex", alignItems:"center", justifyContent:"center", gap:10,
              letterSpacing:"-0.01em", opacity: !activeLoan ? 0.5 : 1
            }}>
              <CreditCard size={20} /> Repay Loan
            </button>
          </div>
        )}

        {activeTab === "history" && (
          <div style={{ padding:"24px 18px 0" }}>
            <div style={{ fontSize:22, fontWeight:800, color:T.text, marginBottom:22, letterSpacing:"-0.02em" }}>History</div>
            <Card>
              {parsedTxns.length>0
                ? parsedTxns.map((t,i)=>(
                    <TxnRow key={t.id} t={t} last={i===parsedTxns.length-1} />
                  ))
                : <div style={{ textAlign:"center", padding:"48px 0", color:T.ghost, fontSize:14 }}>No transactions found</div>
              }
            </Card>
          </div>
        )}

        {activeTab === "profile" && (
          <div>
            <div style={{
              padding:"52px 18px 80px", textAlign:"center",
              background:`linear-gradient(145deg, ${T.cDeep} 0%, ${T.cRich} 55%, ${T.cMid} 100%)`,
              position:"relative", overflow:"hidden",
            }}>
              <div style={{ position:"absolute", top:-60, right:-40, width:180, height:180, borderRadius:"50%", background:"rgba(255,255,255,0.04)", pointerEvents:"none" }} />
              <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:`linear-gradient(90deg, transparent, ${T.gold}, transparent)`, opacity:0.6 }} />
              <div style={{
                width:84, height:84, borderRadius:"50%", margin:"0 auto 16px",
                background:`linear-gradient(135deg, ${T.cMid}, ${T.sky})`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:30, fontWeight:800, color:"white",
                boxShadow:`0 0 0 5px rgba(255,255,255,0.12), 0 0 0 10px rgba(255,255,255,0.05), 0 12px 32px ${T.cDeep}80`,
              }}>
                {memberObj.initials}
              </div>
              <div style={{ fontSize:21, fontWeight:800, color:"white", letterSpacing:"-0.02em" }}>
                {memberObj.name}
              </div>
              <div style={{ fontSize:13, color:"rgba(255,255,255,0.45)", marginTop:5 }}>
                {memberObj.id} &middot; Since {memberObj.since}
              </div>
              <div style={{
                marginTop:14, display:"inline-flex", alignItems:"center", gap:7,
                padding:"7px 18px", borderRadius:22,
                background:"rgba(52,211,153,0.12)",
                border:"1px solid rgba(52,211,153,0.28)",
                fontSize:12, fontWeight:700, color:"#34D399",
              }}>
                ● Active Member
              </div>
            </div>

            <div style={{ padding:"0 18px", marginTop:-36 }}>
              <Card style={{ marginBottom:14 }}>
                <div style={{ fontSize:14, fontWeight:700, color:T.text, marginBottom:14 }}>Account Info</div>
                {[
                  { label:"Phone",     val:memberObj.phone  },
                  { label:"Member ID", val:memberObj.id     },
                  { label:"Branch",    val:memberObj.branch },
                  { label:"Joined",    val:memberObj.since  },
                  { label:"Role",      val:profile?.role    },
                ].map((row,i,arr)=>(
                  <div key={row.label} style={{
                    display:"flex", justifyContent:"space-between", alignItems:"center",
                    padding:"12px 0",
                    borderBottom:i<arr.length-1?`1px solid ${T.border}`:"none",
                  }}>
                    <span style={{ fontSize:14, color:T.sub }}>{row.label}</span>
                    <span style={{ fontSize:14, fontWeight:600, color:T.text, textTransform: 'capitalize' }}>{row.val}</span>
                  </div>
                ))}
              </Card>

              <Card style={{ marginBottom:24 }}>
                <div style={{ fontSize:14, fontWeight:700, color:T.text, marginBottom:14 }}>Settings</div>
                <button onClick={handleSignOut} style={{
                  display:"flex", alignItems:"center", gap:14, width:"100%",
                  padding:"13px 0", background:"transparent", outline:"none",
                  borderTop:"none", borderLeft:"none", borderRight:"none",
                  borderBottom:"none", cursor:"pointer",
                }}>
                  <div style={{
                    width:46, height:46, borderRadius:15,
                    background:`linear-gradient(145deg, #991B1B, ${T.red})`, boxShadow:`0 6px 16px ${T.red}40`,
                    display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
                  }}>
                    <LogOut size={19} color="white" />
                  </div>
                  <span style={{ fontSize:14, fontWeight:600, color:T.text, flex:1, textAlign: 'left' }}>Sign Out</span>
                  <ChevronRight size={16} color={T.ghost} />
                </button>
              </Card>
            </div>
          </div>
        )}

      </div>

      {/* Floating Bottom Nav */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        padding:"8px 16px 16px",
        background:`linear-gradient(to top, ${T.bg} 80%, transparent)`,
        display:"flex", justifyContent:"center",
        zIndex: 40
      }}>
        <div style={{
          width:"100%", background:T.navBg, borderRadius:26,
          display:"flex", padding:"8px",
          boxShadow:`0 10px 40px ${T.cDeep}80, 0 4px 12px ${T.cDeep}50`,
          border:`1px solid rgba(255,255,255,0.06)`,
        }}>
          {[
            { key:"home",    label:"Home",    Icon:Home       },
            { key:"savings", label:"Savings", Icon:PiggyBank  },
            { key:"loans",   label:"Loans",   Icon:CreditCard },
            { key:"history", label:"History", Icon:Clock      },
            { key:"profile", label:"Profile", Icon:User       },
          ].map(({ key, label, Icon })=>{
            const on = activeTab===key;
            return (
              <button key={key} onClick={()=>setActiveTab(key)} style={{
                flex:1, background:"none", border:"none", cursor:"pointer",
                display:"flex", flexDirection:"column", alignItems:"center",
                gap:4, padding:"8px 0",
              }}>
                <div style={{
                  width:on?50:34, height:36, borderRadius:on?14:"50%",
                  background:on?T.navAct:"transparent",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  transition:"all 0.25s cubic-bezier(0.4,0,0.2,1)",
                  boxShadow:on?`0 6px 18px ${T.navAct}70`:"none",
                }}>
                  <Icon size={20} color={on?"white":"rgba(255,255,255,0.3)"} />
                </div>
                <span style={{
                  fontSize:10, fontWeight:on?700:400,
                  color:on?"white":"rgba(255,255,255,0.3)",
                  transition:"all 0.2s ease",
                }}>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Action Modals */}
      {activeModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 100,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center'
        }}>
          <div style={{
            background: 'white', width: '100%', maxWidth: 600,
            borderTopLeftRadius: 24, borderTopRightRadius: 24,
            padding: '24px', animation: 'slideUp 0.3s ease-out'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ fontSize: 20, fontWeight: 700, color: T.text, textTransform: 'capitalize' }}>
                {activeModal === 'loan' ? 'Request Loan' : 
                 activeModal === 'repay' ? 'Repay Loan' : activeModal}
              </h3>
              <button onClick={() => setActiveModal(null)} style={{ background: 'none', border: 'none', color: T.sub, fontSize: 24, cursor: 'pointer' }}>&times;</button>
            </div>
            
            <form onSubmit={performAction} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <input
                type="number"
                min="1"
                required
                value={amountInput}
                onChange={e => setAmountInput(e.target.value)}
                placeholder="Amount (UGX)"
                style={{
                  width: '100%', padding: '16px', borderRadius: 16, border: `1px solid ${T.border}`,
                  fontSize: 18, background: '#F9FAFB', outline: 'none'
                }}
              />
              <button disabled={actionLoading} type="submit" style={{
                width: '100%', padding: '16px', borderRadius: 16, background: T.blue, color: 'white',
                fontSize: 16, fontWeight: 700, border: 'none', cursor: 'pointer',
                opacity: actionLoading ? 0.7 : 1
              }}>
                {actionLoading ? 'Processing...' : 'Confirm'}
              </button>
            </form>
          </div>
        </div>
      )}
      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
