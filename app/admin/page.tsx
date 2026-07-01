'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { 
  Users, Wallet, Loader2, CheckCircle, XCircle, LogOut, FileText, Eye, EyeOff,
  Home as HomeIcon, PiggyBank, CreditCard, ChevronRight, TrendingUp, Search,
  MessageSquare, Send, Sparkles, Smartphone, Plus, RefreshCw, Check, AlertCircle,
  Key, Terminal, Copy
} from 'lucide-react';
import { BarChart, Bar as RechartsBar, XAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

const UGX  = (n: number | string) => `UGX ${Number(n).toLocaleString("en-UG")}`;

function Chip({ T }: { T: any }) {
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

export default function AdminDashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<any>(null);
  const [showBal, setShowBal] = useState(true);
  const [activeTab, setActiveTab] = useState("home");
  const [searchQuery, setSearchQuery] = useState("");
  
  const [members, setMembers] = useState<any[]>([]);
  const [pendingLoans, setPendingLoans] = useState<any[]>([]);
  const [totalLiquidity, setTotalLiquidity] = useState(0);

  // Dynamic SACCO State
  const [saccoName, setSaccoName] = useState("SaccoConnect");
  const [orgIdState, setOrgIdState] = useState<string>("");

  // SMS / Messaging States
  const [smsBalance, setSmsBalance] = useState(250);
  const [smsHistory, setSmsHistory] = useState<any[]>([]);
  const [draftText, setDraftText] = useState("");
  const [smsRecipient, setSmsRecipient] = useState("all");
  const [isSendingSms, setIsSendingSms] = useState(false);
  const [smsToast, setSmsToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [tenantCode, setTenantCode] = useState("");

  // Buy SMS Modal States
  const [showBuyModal, setShowBuyModal] = useState(false);
  const [selectedPack, setSelectedPack] = useState<any>(null);
  const [momoNumber, setMomoNumber] = useState("");
  const [isProcessingBuy, setIsProcessingBuy] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const fetchData = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
      router.push('/auth');
      return;
    }

    const token = session.access_token;

    try {
      const response = await fetch('/api/admin/data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });

      const resData = await response.json();
      if (resData.success) {
        setProfile(resData.adminProfile);
        setSaccoName(resData.saccoName);
        setMembers(resData.members);
        setPendingLoans(resData.pendingLoans);
        setOrgIdState(resData.orgId);
        setApiKey(resData.apiKey || "");
        setTenantCode(resData.tenantCode || "tenant_sacco");
        setSmsBalance(resData.smsBalance ?? 250);
        setSmsHistory(resData.smsHistory ?? []);

        // Calculate total liquidity from members' accounts
        const total = resData.members.reduce((acc: number, m: any) => 
          acc + (m.accounts ? m.accounts.reduce((sum: number, a: any) => sum + parseFloat(a.cached_balance || '0'), 0) : 0), 0
        );
        setTotalLiquidity(total);
      } else {
        console.error('Error fetching admin data:', resData.error);
      }
    } catch (err) {
      console.error('Error contacting server endpoint:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push('/');
  };

  const updateLoanStatus = async (loanId: string, status: string, memberId: string, amount: string, organizationId: string) => {
    setLoading(true);
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    try {
      const response = await fetch('/api/admin/loans', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token,
          loanId,
          status,
          memberId,
          amount,
          organizationId
        }),
      });

      const resData = await response.json();
      if (!resData.success) {
        alert(resData.error || 'Failed to update loan status');
      }
    } catch (err) {
      console.error('Error updating loan status on server:', err);
    } finally {
      await fetchData();
    }
  };

  const sendSmsBroadcast = async () => {
    if (!draftText.trim()) {
      alert("Please write a message first!");
      return;
    }

    setIsSendingSms(true);
    setSmsToast(null);

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    try {
      const res = await fetch('/api/admin/sms/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          token,
          recipientType: smsRecipient,
          message: draftText
        })
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setDraftText("");
        setSmsToast({ 
          message: `Successfully sent broadcast to ${data.recipientsCount} recipient(s)! Cost: ${data.costCredits} credits.`, 
          type: "success" 
        });
        await fetchData(); // Refresh DB balances and logs
      } else {
        setSmsToast({ 
          message: data.error || "Failed to complete SMS broadcast.", 
          type: "error" 
        });
      }
    } catch (error) {
      console.error("Broadcast error:", error);
      setSmsToast({ message: "An error occurred while communicating with the SMS gateway.", type: "error" });
    } finally {
      setIsSendingSms(false);
    }
  };

  const buySmsBundle = async () => {
    if (!momoNumber.trim()) {
      alert("Please enter your Mobile Money number!");
      return;
    }

    setIsProcessingBuy(true);

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    try {
      const res = await fetch('/api/admin/sms/topup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          token,
          credits: selectedPack.credits,
          amount: selectedPack.price,
          momoNumber
        })
      });

      const data = await res.json();

      if (res.ok && data.success) {
        const intentId = data.intent.id;
        console.log("Payment intent created successfully! Status: Pending.", intentId);
        
        // Polling NaJiki API mechanism
        let attempts = 0;
        const interval = setInterval(async () => {
          attempts++;
          try {
            const response = await fetch(`https://najiki.netlify.app/api/payments/${intentId}`);
            if (response.ok) {
              const payment = await response.json();
              if (payment.status === 'success' || payment.status === 'successful') {
                clearInterval(interval);
                
                // Call confirm route to update wallet and logs
                const confirmRes = await fetch('/api/admin/sms/topup/confirm', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    token,
                    intentId,
                    momoNumber,
                    credits: selectedPack.credits,
                    amount: selectedPack.price
                  })
                });

                const confirmData = await confirmRes.json();
                
                setShowBuyModal(false);
                setMomoNumber("");
                setSmsToast({ 
                  message: `Successfully loaded ${selectedPack.credits.toLocaleString()} SMS credits!`, 
                  type: "success" 
                });
                setSelectedPack(null);
                setIsProcessingBuy(false);
                await fetchData(); // Refresh DB balances and logs
              } else if (payment.status === 'failed') {
                clearInterval(interval);
                alert("Mobile Money payment failed. Please check your balance or PIN and try again.");
                setIsProcessingBuy(false);
              }
            }
          } catch (e) {
            console.error("Polling error", e);
          }

          if (attempts > 30) { // Timeout after 1.5 mins
            clearInterval(interval);
            alert("Payment confirmation timeout. If you completed the payment, your credits will be updated shortly.");
            setShowBuyModal(false);
            setIsProcessingBuy(false);
          }
        }, 3000);

      } else {
        alert(data.error || "Failed to initiate SMS bundle purchase.");
        setIsProcessingBuy(false);
      }
    } catch (err) {
      console.error("Error topping up SMS:", err);
      alert("An error occurred during transaction. Please try again.");
      setIsProcessingBuy(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FEF6EE]">
        <Loader2 className="w-8 h-8 animate-spin text-[#F97316]" />
      </div>
    );
  }

  const T = {
    cDeep:   "#2C1A11", // Deep espresso
    cRich:   "#4E2E1E", // Rich leather
    cMid:    "#B36239", // Terracotta sienna
    gold:    "#C19A5B", // Satin metallic gold
    goldLt:  "#F4EAD4", // Cream gold
    blue:    "#4F46E5", // Modern indigo
    sky:     "#E0E7FF",
    green:   "#15803D", // Refined forest green
    greenLt: "#DCFCE7",
    red:     "#B91C1C", // Deep crimson
    purple:  "#6D28D9",
    amber:   "#D97706",
    bg:      "#FAF8F5", // Luxurious cream white
    card:    "#FFFFFF",
    text:    "#1E120B", // Dark warm espresso text
    sub:     "#7D6F64", // Warm taupe
    ghost:   "#AFA49B",
    border:  "#EFEBE4", // Very subtle border
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: T.bg, paddingBottom: 100, fontFamily: "var(--font-sans), sans-serif", color: T.text }}>
      <header style={{ 
        background: `linear-gradient(145deg, ${T.cDeep} 0%, ${T.cRich} 100%)`, 
        color: 'white', width: '100%', padding: '0 24px', height: 72, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        boxShadow: `0 4px 24px rgba(44,26,17,0.12)`, position: 'relative', overflow: 'hidden',
        borderBottom: `1px solid rgba(255,255,255,0.06)`
      }}>
        <div style={{ position:"absolute", top:0, left:0, bottom:0, width:4, background:`linear-gradient(180deg, ${T.goldLt}, ${T.gold})` }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ backgroundColor: 'rgba(255,255,255,0.08)', padding: 10, borderRadius: 14, border: '1px solid rgba(255,255,255,0.1)' }}>
            <Wallet size={20} color={T.gold} />
          </div>
          <span style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 800, fontSize: 20, letterSpacing: '-0.02em', color: T.goldLt }}>{saccoName} <span style={{ color: 'white', fontWeight: 500 }}>Admin</span></span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em', color: 'white' }}>{profile?.full_name || 'SACCO Admin'}</div>
            <div style={{ fontSize: 10, color: T.goldLt, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, opacity: 0.8 }}>Cooperative Board</div>
          </div>
          <button 
            onClick={handleSignOut}
            style={{ padding: 10, color: 'white', backgroundColor: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s' }}
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 24px 120px', display: 'flex', flexDirection: 'column', gap: 24 }}>
        
        {/* TAB 1: HOME (JUST FULL OF ANALYTICS) */}
        {activeTab === "home" && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            
            {/* Bento Grid Analytics Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 24 }}>
              
              {/* Premium Balance Card */}
              <div style={{
                borderRadius: 24, padding: "28px 24px",
                background: `linear-gradient(135deg, ${T.cDeep} 0%, ${T.cRich} 60%, ${T.cMid} 100%)`,
                position: "relative", overflow: "hidden",
                boxShadow: `0 16px 36px rgba(44,26,17,0.18), 0 4px 12px rgba(44,26,17,0.08)`,
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                minHeight: 180, border: `1px solid rgba(255,255,255,0.05)`
              }}>
                <div style={{ position: "absolute", top: -60, right: -40, width: 200, height: 200, borderRadius: "50%", background: "rgba(255,255,255,0.03)", pointerEvents: "none" }} />
                <div style={{ position: "absolute", bottom: -60, left: -30, width: 170, height: 170, borderRadius: "50%", background: "rgba(255,255,255,0.02)", pointerEvents: "none" }} />
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, transparent 0%, ${T.gold} 40%, ${T.goldLt} 60%, ${T.gold} 80%, transparent 100%)`, opacity: 0.5 }} />

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                  <Chip T={T} />
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 13, color: T.gold, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                      {saccoName}
                    </div>
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)", letterSpacing: "0.1em", textTransform: "uppercase", marginTop: 2, fontWeight: 600 }}>
                      PREMIUM VAULT
                    </div>
                  </div>
                </div>

                <div style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6, fontWeight: 700 }}>
                    Total SACCO Liquidity
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{
                      fontFamily: 'var(--font-display), sans-serif',
                      fontSize: 30, fontWeight: 800, color: "white",
                      letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", lineHeight: 1,
                    }}>
                      {showBal ? UGX(totalLiquidity) : "••••••••••••"}
                    </div>
                    <button onClick={() => setShowBal(!showBal)} style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex", flexShrink: 0, opacity: 0.8 }}>
                      {showBal ? <EyeOff size={16} color="rgba(255,255,255,0.5)" /> : <Eye size={16} color="rgba(255,255,255,0.5)" />}
                    </button>
                  </div>
                </div>

                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", letterSpacing: "0.2em", fontWeight: 700 }}>
                  &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; SYSTEM VAULT
                </div>
              </div>

              {/* Members Stat */}
              <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 24, border: `1px solid ${T.border}`, boxShadow: '0 4px 20px rgba(44,26,17,0.02), 0 1px 2px rgba(44,26,17,0.01)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: T.sub, marginBottom: 20 }}>
                  <h2 style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: T.text }}>
                    <Users size={16} color={T.cMid} /> Active Members
                  </h2>
                  <span style={{ fontSize: 10, color: T.green, fontWeight: 700, backgroundColor: `${T.green}10`, padding: '4px 8px', borderRadius: 8, border: `1px solid ${T.green}18` }}>Verified</span>
                </div>
                <div>
                  <p style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 36, fontWeight: 900, letterSpacing: '-0.02em', color: T.text, lineHeight: 1, margin: 0 }}>
                    {members.length}
                  </p>
                  <p style={{ color: T.sub, marginTop: 8, fontSize: 12, fontWeight: 500, margin: 0, paddingTop: 6 }}>Registered members with active wallets</p>
                </div>
              </div>

              {/* Average Savings Stat */}
              <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 24, border: `1px solid ${T.border}`, boxShadow: '0 4px 20px rgba(44,26,17,0.02), 0 1px 2px rgba(44,26,17,0.01)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: T.sub, marginBottom: 20 }}>
                  <h2 style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: T.text }}>
                    <TrendingUp size={16} color={T.green} /> Average Savings
                  </h2>
                </div>
                <div>
                  <p style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 26, fontWeight: 900, letterSpacing: '-0.02em', color: T.text, lineHeight: 1, margin: 0 }}>
                    {UGX(Math.round(totalLiquidity / Math.max(members.length, 1)))}
                  </p>
                  <p style={{ color: T.sub, marginTop: 8, fontSize: 12, fontWeight: 500, margin: 0, paddingTop: 6 }}>Average savings value per member</p>
                </div>
              </div>

              {/* Loan Portfolio Value Stat */}
              <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 24, border: `1px solid ${T.border}`, boxShadow: '0 4px 20px rgba(44,26,17,0.02), 0 1px 2px rgba(44,26,17,0.01)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: T.sub, marginBottom: 20 }}>
                  <h2 style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: T.text }}>
                    <FileText size={16} color={T.blue} /> Pending Loans
                  </h2>
                </div>
                <div>
                  <p style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 26, fontWeight: 900, letterSpacing: '-0.02em', color: T.text, lineHeight: 1, margin: 0 }}>
                    {UGX(pendingLoans.reduce((sum, loan) => sum + parseFloat(loan.principal || '0'), 0))}
                  </p>
                  <p style={{ color: T.sub, marginTop: 8, fontSize: 12, fontWeight: 500, margin: 0, paddingTop: 6 }}>{pendingLoans.length} pending approval request{pendingLoans.length !== 1 ? 's' : ''}</p>
                </div>
              </div>

            </div>

            {/* Recharts Analytics Visualization */}
            <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 24, border: `1px solid ${T.border}`, boxShadow: '0 4px 20px rgba(44,26,17,0.02), 0 1px 2px rgba(44,26,17,0.01)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <div>
                  <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 800, fontSize: 18, color: T.text, display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
                    Savings Distribution Profile
                  </h3>
                  <p style={{ fontSize: 12, color: T.sub, marginTop: 4, margin: 0, fontWeight: 500 }}>Compare member savings balances across the SACCO network</p>
                </div>
              </div>

              {members.length > 0 ? (
                <div style={{ width: '100%', height: 320 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={members.map(m => ({
                      name: `${m.first_name} ${m.last_name.charAt(0)}.`,
                      balance: parseFloat(m.accounts?.[0]?.cached_balance || '0')
                    }))}>
                      <XAxis dataKey="name" stroke={T.sub} fontSize={11} tickLine={false} />
                      <Tooltip 
                        formatter={(value) => [`UGX ${Number(value).toLocaleString()}`, 'Balance']}
                        contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, boxShadow: '0 4px 20px rgba(44,26,17,0.08)' }}
                      />
                      <RechartsBar dataKey="balance" radius={[6, 6, 0, 0]}>
                        {members.map((entry, index) => (
                          <Cell 
                            key={`cell-${index}`} 
                            fill={index % 2 === 0 ? T.cDeep : T.cMid} 
                          />
                        ))}
                      </RechartsBar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div style={{ padding: '60px 0', textAlign: 'center', color: T.ghost, fontSize: 14 }}>
                  No members savings data to visualize yet.
                </div>
              )}
            </div>

            {/* Quick Sacco Stats Table */}
            <div style={{ backgroundColor: T.card, borderRadius: 24, border: `1px solid ${T.border}`, boxShadow: '0 4px 20px rgba(44,26,17,0.02), 0 1px 2px rgba(44,26,17,0.01)', overflow: 'hidden' }}>
              <div style={{ padding: '20px 24px', borderBottom: `1px solid ${T.border}`, backgroundColor: '#FAF9F6' }}>
                <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 800, fontSize: 15, color: T.text, margin: 0 }}>Cooperative Settings & Yield Metrics</h3>
              </div>
              <div style={{ padding: '8px 24px 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 24 }}>
                <div style={{ padding: '16px 0', borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 11, color: T.sub, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Annual Percentage Yield (APY)</div>
                  <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 20, fontWeight: 800, color: T.text, marginTop: 4 }}>5.0% APY</div>
                </div>
                <div style={{ padding: '16px 0', borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 11, color: T.sub, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Activation Fee</div>
                  <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 20, fontWeight: 800, color: T.cMid, marginTop: 4 }}>UGX 5,000</div>
                </div>
                <div style={{ padding: '16px 0', borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 11, color: T.sub, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Collateral Requirement</div>
                  <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 20, fontWeight: 800, color: T.text, marginTop: 4 }}>0% (Guarantor-Based)</div>
                </div>
                <div style={{ padding: '16px 0', borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 11, color: T.sub, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Cooperative State</div>
                  <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 20, fontWeight: 800, color: T.green, marginTop: 4 }}>Active Ecosystem</div>
                </div>
              </div>
            </div>

          </div>
        )}

        {/* TAB 2: MEMBERS DIRECTORY (SEARCHABLE LIST) */}
        {activeTab === "members" && (
          <div style={{ backgroundColor: T.card, borderRadius: 24, border: `1px solid ${T.border}`, boxShadow: '0 4px 20px rgba(44,26,17,0.03), 0 1px 3px rgba(44,26,17,0.01)', overflow: 'hidden' }}>
            <div style={{ padding: "24px 28px", borderBottom: `1px solid ${T.border}`, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
              <div>
                <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 800, color: T.text, display: 'flex', alignItems: 'center', gap: 10, fontSize: 18, margin: 0 }}>
                  <Users size={22} color={T.cMid} /> Member Directory
                </h3>
                <p style={{ fontSize: 12, color: T.sub, marginTop: 4, margin: 0, fontWeight: 500 }}>View, search and manage all registered cooperative members</p>
              </div>

              {/* Premium Search Box */}
              <div style={{ position: 'relative', width: '100%', maxWidth: 360 }}>
                <Search size={18} color={T.ghost} style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)' }} />
                <input 
                  type="text" 
                  placeholder="Search members by name..." 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    width: '100%', padding: '12px 16px 12px 46px', borderRadius: 14,
                    border: `1px solid ${T.border}`, backgroundColor: '#FAF9F6',
                    color: T.text, fontSize: 14, outline: 'none', transition: 'all 0.2s',
                  }}
                />
              </div>
            </div>

            <div style={{ maxHeight: 600, overflowY: 'auto' }}>
              {members.filter(m => 
                `${m.first_name} ${m.last_name}`.toLowerCase().includes(searchQuery.toLowerCase())
              ).length > 0 ? (
                members.filter(m => 
                  `${m.first_name} ${m.last_name}`.toLowerCase().includes(searchQuery.toLowerCase())
                ).map((member, idx) => (
                  <div key={member.id} style={{ padding: '20px 24px', borderBottom: idx < members.length - 1 ? `1px solid ${T.border}` : 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', transition: 'background-color 0.2s' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                      <div style={{
                        width: 44, height: 44, borderRadius: '50%',
                        backgroundColor: idx % 2 === 0 ? '#EFEBE4' : '#E8E1D5',
                        color: T.cDeep, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontWeight: 800, fontSize: 14, fontFamily: 'var(--font-display), sans-serif',
                        letterSpacing: '-0.02em', border: `1px solid rgba(44,26,17,0.06)`
                      }}>
                        {member.first_name.charAt(0)}{member.last_name.charAt(0)}
                      </div>
                      <div>
                        <p style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 800, color: T.text, fontSize: 15, margin: 0 }}>{member.first_name} {member.last_name}</p>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                          <span style={{ fontSize: 10, color: T.sub, fontWeight: 600, background: '#EFEBE4', padding: '2px 8px', borderRadius: 6 }}>ID: {member.id.substring(0,8)}</span>
                          <span style={{ fontSize: 10, color: T.green, fontWeight: 700, background: `${T.green}10`, padding: '2px 8px', borderRadius: 6, border: `1px solid ${T.green}15` }}>Active Account</span>
                        </div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 16, fontWeight: 900, color: T.text, margin: 0 }}>
                        UGX {parseFloat(member.accounts?.[0]?.cached_balance || '0').toLocaleString()}
                      </p>
                      <p style={{ fontSize: 10, color: T.sub, marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600, margin: 0 }}>Savings Balance</p>
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ padding: 64, textAlign: 'center', color: T.ghost, fontSize: 14 }}>
                  No members matched &quot;{searchQuery}&quot;
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: PENDING LOANS (APPROVE/REJECT VIEW) */}
        {activeTab === "loans" && (
          <div style={{ backgroundColor: T.card, borderRadius: 24, border: `1px solid ${T.border}`, boxShadow: '0 4px 20px rgba(44,26,17,0.03), 0 1px 3px rgba(44,26,17,0.01)', overflow: 'hidden' }}>
            <div style={{ padding: "24px 28px", borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FAF9F6' }}>
              <div>
                <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 800, color: T.text, display: 'flex', alignItems: 'center', gap: 10, fontSize: 18, margin: 0 }}>
                  <FileText size={22} color={T.cMid} /> Pending Loan Underwriting
                </h3>
                <p style={{ fontSize: 12, color: T.sub, marginTop: 4, margin: 0, fontWeight: 500 }}>Review credit requests and disburse SACCO capital securely</p>
              </div>
              <span style={{ backgroundColor: T.sky, color: T.blue, fontSize: 11, fontWeight: 800, padding: '6px 14px', borderRadius: 99, border: `1px solid rgba(79,70,229,0.1)` }}>
                {pendingLoans.length} Request{pendingLoans.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div style={{ maxHeight: 600, overflowY: 'auto' }}>
              {pendingLoans.length > 0 ? (
                pendingLoans.map((loan, idx) => (
                  <div key={loan.id} style={{ padding: 28, borderBottom: idx < pendingLoans.length - 1 ? `1px solid ${T.border}` : 'none', display: 'flex', flexDirection: 'column', gap: 18 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <div style={{
                          width: 44, height: 44, borderRadius: '50%',
                          backgroundColor: idx % 2 === 0 ? '#EFEBE4' : '#E8E1D5',
                          color: T.cDeep, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontWeight: 800, fontSize: 14, fontFamily: 'var(--font-display), sans-serif',
                          letterSpacing: '-0.02em', border: `1px solid rgba(44,26,17,0.06)`
                        }}>
                          {loan.members?.first_name?.charAt(0)}{loan.members?.last_name?.charAt(0)}
                        </div>
                        <div>
                          <p style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 800, color: T.text, fontSize: 16, margin: 0 }}>{loan.members?.first_name} {loan.members?.last_name}</p>
                          <p style={{ fontSize: 11, color: T.sub, marginTop: 4, margin: 0, fontWeight: 500 }}>Requested Date: {new Date(loan.created_at).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <p style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 22, fontWeight: 900, color: T.cDeep, margin: 0 }}>UGX {parseFloat(loan.principal).toLocaleString()}</p>
                        <p style={{ fontSize: 10, color: T.sub, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2, fontWeight: 600, margin: 0 }}>Principal Capital Requested</p>
                      </div>
                    </div>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderTop: `1px solid ${T.border}`, paddingTop: 18 }}>
                      <button 
                        onClick={() => updateLoanStatus(loan.id, 'rejected', loan.member_id, loan.principal, loan.members?.organization_id)}
                        style={{ padding: '10px 18px', border: `1px solid ${T.red}20`, color: T.red, backgroundColor: '#FEF2F2', borderRadius: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13, transition: 'all 0.2s' }}
                        title="Reject Loan"
                      >
                        <XCircle size={16} /> Reject Request
                      </button>
                      <button 
                        onClick={() => updateLoanStatus(loan.id, 'approved', loan.member_id, loan.principal, loan.members?.organization_id)}
                        style={{ padding: '10px 18px', border: 'none', color: 'white', backgroundColor: T.green, borderRadius: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13, transition: 'all 0.2s', boxShadow: `0 4px 12px rgba(21,128,61,0.2)` }}
                      >
                        <CheckCircle size={16} /> Approve & Disburse
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ padding: 72, textAlign: 'center', color: T.ghost, fontSize: 14 }}>
                  No pending loan requests currently on the ledger.
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: SMS MESSAGES TAB */}
        {activeTab === "messages" && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingBottom: 60 }}>
            
            {/* Header Area */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
                <div>
                  <h1 style={{ fontFamily: "var(--font-display), sans-serif", fontSize: 26, fontWeight: 900, color: T.text, margin: 0, letterSpacing: '-0.02em' }}>
                    Broadcast SMS Gateway
                  </h1>
                  <p style={{ fontSize: 12, color: T.sub, marginTop: 4, fontWeight: 500, margin: 0 }}>
                    Send messages and critical alert updates to your SACCO members instantly.
                  </p>
                </div>
 
                {/* SMS Wallet Widget */}
                <div style={{
                  backgroundColor: T.goldLt, border: `1px solid rgba(193,154,91,0.25)`, borderRadius: 20,
                  padding: '16px 20px', boxShadow: '0 4px 16px rgba(44,26,17,0.02)', display: 'flex', alignItems: 'center', gap: 16, minWidth: 300
                }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    backgroundColor: smsBalance < 20 ? '#FEF2F2' : 'rgba(193,154,91,0.15)', color: smsBalance < 20 ? T.red : T.cDeep,
                    border: `1px solid rgba(193,154,91,0.1)`
                  }}>
                    <Wallet size={20} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <p style={{ fontSize: 9, fontWeight: 800, color: T.cMid, textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
                          SMS WALLET
                        </p>
                        <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 20, fontWeight: 900, color: T.cDeep, lineHeight: 1.2, margin: 0, marginTop: 2 }}>
                          {smsBalance.toLocaleString()}{" "}
                          <span style={{ fontSize: 11, fontWeight: 700, color: T.sub }}>credits</span>
                        </h3>
                        <p style={{ fontSize: 10, fontWeight: 600, color: T.sub, margin: 0, marginTop: 2 }}>
                          Approx. UGX {(smsBalance * 40).toLocaleString()} value
                        </p>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                        {smsBalance < 50 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', backgroundColor: 'rgba(185,28,28,0.08)', border: '1px solid rgba(185,28,28,0.15)', borderRadius: 6 }}>
                            <AlertCircle size={10} color={T.red} />
                            <span style={{ fontSize: 8, fontWeight: 800, color: T.red, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Low</span>
                          </div>
                        )}
                        <button
                          onClick={() => {
                            setSelectedPack({ credits: 2000, price: 60000, label: "Growth Pack" });
                            setShowBuyModal(true);
                          }}
                          style={{
                            padding: '6px 12px', backgroundColor: T.cDeep, color: 'white', borderRadius: 8,
                            fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', border: 'none', cursor: 'pointer', transition: 'all 0.2s'
                          }}
                        >
                          Top Up
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
 
            {/* Layout Grid: Composer & History */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24, alignItems: 'start' }}>
              
              {/* Broadcast Composer */}
              <div style={{ gridColumn: 'span 2' }}>
                <div style={{ backgroundColor: T.card, borderRadius: 24, border: `1px solid ${T.border}`, padding: 24, boxShadow: '0 4px 20px rgba(44,26,17,0.02)' }}>
                  
                  {smsToast && (
                    <div style={{
                      padding: '12px 16px', borderRadius: 12, marginBottom: 20,
                      backgroundColor: smsToast.type === "success" ? `${T.green}12` : `${T.red}12`,
                      border: `1px solid ${smsToast.type === "success" ? `${T.green}30` : `${T.red}30`}`,
                      color: smsToast.type === "success" ? T.green : T.red,
                      fontSize: 13, display: 'flex', alignItems: 'center', gap: 8
                    }}>
                      {smsToast.type === "success" ? <CheckCircle size={16} /> : <XCircle size={16} />}
                      {smsToast.message}
                    </div>
                  )}
 
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {/* Audience Selection */}
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: T.sub, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
                        Target Audience
                      </label>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                        {[
                          { key: 'all', label: 'All Members', icon: Users, count: members.length },
                          { key: 'loans', label: 'Pending Loans', icon: CreditCard, count: pendingLoans.length }
                        ].map(grp => (
                          <div 
                            key={grp.key}
                            onClick={() => setSmsRecipient(grp.key)}
                            style={{
                              padding: '16px', borderRadius: 16, border: smsRecipient === grp.key ? `2px solid ${T.cMid}` : `1px solid ${T.border}`,
                              backgroundColor: smsRecipient === grp.key ? 'rgba(179,98,57,0.04)' : '#FAF9F6', cursor: 'pointer', transition: 'all 0.2s',
                              display: 'flex', alignItems: 'center', gap: 12
                            }}
                          >
                            <div style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: smsRecipient === grp.key ? T.cMid : '#EFEBE4', color: smsRecipient === grp.key ? 'white' : T.sub, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <grp.icon size={18} />
                            </div>
                            <div>
                              <p style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 13, fontWeight: 800, color: smsRecipient === grp.key ? T.cDeep : T.text, margin: 0 }}>{grp.label}</p>
                              <p style={{ fontSize: 11, fontWeight: 500, color: T.sub, margin: 0, marginTop: 2 }}>{grp.count} recipients</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
 
                    {/* Message Content */}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <label style={{ fontSize: 10, fontWeight: 700, color: T.sub, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Message Content</label>
                        <span style={{ fontSize: 10, fontWeight: 500, color: T.sub }}>Tip: Keep it short and actionable.</span>
                      </div>
                      <textarea
                        rows={5}
                        value={draftText}
                        onChange={(e) => setDraftText(e.target.value)}
                        placeholder="Type your message here... (e.g., Don't forget tomorrow's special cooperative assembly!)"
                        style={{
                          width: '100%', padding: '20px', backgroundColor: '#FAF9F6', border: `1px solid ${T.border}`,
                          borderRadius: 16, fontSize: 14, color: T.text, fontWeight: 500, outline: 'none', resize: 'none', transition: 'all 0.2s'
                        }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, padding: '0 4px' }}>
                        <span style={{ fontSize: 10, color: T.sub, fontWeight: 600, letterSpacing: '0.05em' }}>1 SMS ≈ 160 characters</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          {draftText.length > 160 && (
                            <span style={{ fontSize: 9, fontWeight: 800, color: T.cMid, textTransform: 'uppercase', letterSpacing: '0.08em', backgroundColor: `${T.cMid}12`, padding: '2px 8px', borderRadius: 4 }}>
                              {Math.ceil(draftText.length / 160)} Parts
                            </span>
                          )}
                          <span style={{ fontSize: 11, fontWeight: 700, color: draftText.length > 160 ? T.cMid : T.sub, letterSpacing: '-0.02em' }}>
                            {draftText.length} <span style={{ fontSize: 9, color: T.ghost, textTransform: 'uppercase', marginLeft: 2 }}>chars</span>
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Send Button */}
                    <div style={{ paddingTop: 16 }}>
                      <button
                        onClick={sendSmsBroadcast}
                        disabled={isSendingSms || !draftText.trim()}
                        style={{
                          width: '100%', padding: '16px', backgroundColor: T.cDeep, color: 'white', borderRadius: 12,
                          fontSize: 13, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', border: 'none',
                          cursor: isSendingSms || !draftText.trim() ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
                          opacity: !draftText.trim() ? 0.5 : 1, transition: 'all 0.2s', boxShadow: `0 6px 18px rgba(44,26,17,0.15)`
                        }}
                      >
                        {isSendingSms ? (
                          <>
                            <Loader2 size={16} className="animate-spin" />
                            Broadcasting...
                          </>
                        ) : (
                          <>
                            <Send size={15} />
                            Send Broadcast ({smsRecipient === 'all' ? members.length : pendingLoans.length})
                          </>
                        )}
                      </button>
                    </div>

                  </div>
                </div>

                {/* Developer API Credentials & Playground */}
                <div style={{
                  marginTop: 24,
                  backgroundColor: T.card, borderRadius: 24, border: `1px solid ${T.border}`, padding: 24,
                  boxShadow: '0 4px 20px rgba(44,26,17,0.02)'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(179,98,57,0.1)', color: T.cMid, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Key size={18} />
                    </div>
                    <div>
                      <h3 style={{ fontFamily: "var(--font-display), sans-serif", fontSize: 16, fontWeight: 900, color: T.cDeep, margin: 0 }}>
                        Najiki Developer API Access
                      </h3>
                      <p style={{ fontSize: 11, color: T.sub, margin: 0, marginTop: 2, fontWeight: 500 }}>
                        Integrate external core banking networks or systems directly to Najiki Gateway.
                      </p>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    
                    {/* API Key field */}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: T.sub, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          x-api-key header
                        </span>
                        {copiedKey && <span style={{ fontSize: 10, fontWeight: 700, color: T.green }}>Copied!</span>}
                      </div>
                      <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 16px', backgroundColor: '#FAF9F6', border: `1px solid ${T.border}`, borderRadius: 12
                      }}>
                        <code style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 11, color: T.cDeep, wordBreak: 'break-all' }}>
                          {apiKey ? `${apiKey.substring(0, 18)}••••••••••••••••` : "Generating..."}
                        </code>
                        <button
                          onClick={() => {
                            if (apiKey) {
                              navigator.clipboard.writeText(apiKey);
                              setCopiedKey(true);
                              setTimeout(() => setCopiedKey(false), 2000);
                            }
                          }}
                          style={{
                            padding: 6, backgroundColor: 'transparent', border: 'none', cursor: 'pointer',
                            color: T.sub, display: 'flex', alignItems: 'center', justifyContent: 'center'
                          }}
                        >
                          <Copy size={14} />
                        </button>
                      </div>
                    </div>

                    {/* Tenant Code field */}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: T.sub, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          tenantCode payload
                        </span>
                        {copiedCode && <span style={{ fontSize: 10, fontWeight: 700, color: T.green }}>Copied!</span>}
                      </div>
                      <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 16px', backgroundColor: '#FAF9F6', border: `1px solid ${T.border}`, borderRadius: 12
                      }}>
                        <code style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 12, color: T.text }}>
                          {tenantCode}
                        </code>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(tenantCode);
                            setCopiedCode(true);
                            setTimeout(() => setCopiedCode(false), 2000);
                          }}
                          style={{
                            padding: 6, backgroundColor: 'transparent', border: 'none', cursor: 'pointer',
                            color: T.sub, display: 'flex', alignItems: 'center', justifyContent: 'center'
                          }}
                        >
                          <Copy size={14} />
                        </button>
                      </div>
                    </div>

                    {/* CURL integration playground */}
                    <div>
                      <span style={{ display: 'block', fontSize: 10, fontWeight: 700, color: T.sub, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                        Integration Payload Template
                      </span>
                      <div style={{
                        position: 'relative', backgroundColor: '#2C1A11', borderRadius: 16, padding: '16px 20px',
                        border: '1px solid rgba(44,26,17,0.1)'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#F1E9DB', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 12 }}>
                          <Terminal size={12} color={T.gold} />
                          <span>HTTPS POST Payload Playground</span>
                        </div>
                        <pre style={{
                          margin: 0, overflowX: 'auto', fontFamily: 'var(--font-mono), monospace', fontSize: 11,
                          color: '#C19A5B', lineHeight: 1.5, paddingBottom: 8
                        }}>
{`curl -X POST ${typeof window !== 'undefined' ? window.location.origin : 'https://api.najiki.com'}/api/messaging/send \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${apiKey || 'your_api_key'}" \\
  -d '{
    "tenantCode": "${tenantCode}",
    "to": "+256770000000",
    "message": "Welcome to Najiki Sacco! Your account has been registered successfully.",
    "eventType": "WELCOME_MESSAGE"
  }'`}
                        </pre>
                      </div>
                    </div>

                  </div>
                </div>

              </div>

              {/* History Sidebar */}
              <div style={{ backgroundColor: T.goldLt, borderRadius: 24, border: `1px solid rgba(193,154,91,0.25)`, padding: 24, height: 'fit-content', maxHeight: 600, overflowY: 'auto', boxShadow: '0 4px 16px rgba(44,26,17,0.02)' }}>
                <h2 style={{ fontSize: 16, fontWeight: 900, color: T.cDeep, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8, fontFamily: "var(--font-display), sans-serif", letterSpacing: '-0.02em', textTransform: 'uppercase' }}>
                  <RefreshCw size={18} color={T.cMid} />
                  Recent Broadcasts
                </h2>
                
                {smsHistory.length === 0 ? (
                  <p style={{ fontSize: 12, color: T.sub, textAlign: 'center', padding: '40px 0', fontWeight: 500 }}>No broadcasts sent yet.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {smsHistory.map((log) => (
                      <div key={log.id} style={{ display: 'flex', gap: 12 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: T.cMid, marginTop: 6 }} />
                          <div style={{ width: 1, height: '100%', backgroundColor: 'rgba(193,154,91,0.25)', marginTop: 4 }} />
                        </div>
                        <div style={{ flex: 1, backgroundColor: T.card, borderRadius: 16, padding: 16, border: `1px solid ${T.border}` }}>
                          <p style={{ fontSize: 13, fontWeight: 600, color: T.text, margin: 0, lineHeight: 1.4 }}>{log.text}</p>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                            <span style={{ fontSize: 10, fontWeight: 800, color: T.cMid, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                              {log.count} Recipients
                            </span>
                            <span style={{ fontSize: 10, fontWeight: 600, color: T.sub }}>
                              {new Date(log.date).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>
          </div>
        )}

      </main>

      {/* FLOATING BOTTOM NAVIGATION BAR (Matches members dashboard look) */}
      <div style={{
        position:"fixed", bottom:24, left:16, right:16,
        background:`linear-gradient(to top, ${T.bg} 80%, transparent)`,
        display:"flex", justifyContent:"center",
        zIndex: 40
      }}>
        <div style={{
          width:"100%", maxWidth: 600, background: T.cDeep, borderRadius:26,
          display:"flex", padding:"8px",
          boxShadow:`0 10px 40px ${T.cDeep}80, 0 4px 12px ${T.cDeep}50`,
          border:`1px solid rgba(255,255,255,0.06)`,
        }}>
          {[
            { key:"home",     label:"Home",     Icon:HomeIcon },
            { key:"members",  label:"Members",  Icon:Users },
            { key:"loans",    label:"Loans",    Icon:CreditCard },
            { key:"messages", label:"Messages", Icon:MessageSquare },
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
                  background:on?T.cMid:"transparent",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  transition:"all 0.25s cubic-bezier(0.4,0,0.2,1)",
                  boxShadow:on?`0 6px 18px ${T.cMid}70`:"none",
                }}>
                  <Icon size={20} color={on?"white":"rgba(255,255,255,0.4)"} />
                </div>
                <span style={{
                  fontSize:11, fontWeight:on?700:400,
                  color:on?"white":"rgba(255,255,255,0.4)",
                  transition:"all 0.2s ease",
                }}>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* MOBILE MONEY SMS PURCHASE MODAL */}
      {showBuyModal && selectedPack && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(28,25,23,0.7)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center',
          alignContent: 'center', justifyContent: 'center',
          zIndex: 100, padding: 16
        }}>
          <div style={{
            backgroundColor: 'white', borderRadius: 28, width: '100%', maxWidth: 440,
            boxShadow: '0 20px 50px rgba(0,0,0,0.3)', overflow: 'hidden', border: `1px solid ${T.border}`
          }}>
            {/* Header styled like a telecom prompt */}
            <div style={{
              background: `linear-gradient(135deg, ${T.cDeep} 0%, ${T.cRich} 100%)`,
              padding: '24px 28px', color: 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <div>
                <h4 style={{ fontWeight: 800, fontSize: 16 }}>Secure Mobile Money checkout</h4>
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>Authorized via SaccoPay Gateway</p>
              </div>
              <button
                onClick={() => {
                  if (!isProcessingBuy) {
                    setShowBuyModal(false);
                    setSelectedPack(null);
                  }
                }}
                style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: 'white', width: 32, height: 32, borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 }}
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ backgroundColor: '#F8FAFC', borderRadius: 16, padding: '16px 20px', border: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 11, color: T.ghost, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Selected Bundle</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                  <strong style={{ fontSize: 16, color: T.text }}>{selectedPack.credits.toLocaleString()} SMS Credits</strong>
                  <strong style={{ fontSize: 16, color: T.cMid }}>UGX {selectedPack.price.toLocaleString()}</strong>
                </div>
                <span style={{ fontSize: 12, color: T.sub, display: 'block', marginTop: 4 }}>{selectedPack.label} &bull; Unlimited validity</span>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: T.sub, textTransform: 'uppercase', marginBottom: 8 }}>Enter Mobile Money Phone Number</label>
                <div style={{ display: 'flex', border: `1.5px solid ${T.border}`, borderRadius: 16, overflow: 'hidden', alignItems: 'center', backgroundColor: 'white', padding: '4px 16px' }}>
                  <Smartphone size={18} color={T.ghost} style={{ flexShrink: 0 }} />
                  <input
                    type="tel"
                    placeholder="e.g. 0772000111 / 0702000111"
                    value={momoNumber}
                    onChange={(e) => setMomoNumber(e.target.value)}
                    disabled={isProcessingBuy}
                    style={{
                      border: 'none', outline: 'none', padding: '12px', fontSize: 15, width: '100%', fontWeight: 600, color: T.text, backgroundColor: 'white'
                    }}
                  />
                </div>
                <span style={{ fontSize: 11, color: T.ghost, display: 'block', marginTop: 6 }}>Supports MTN Mobile Money & Airtel Money prompts.</span>
              </div>

              <button
                onClick={buySmsBundle}
                disabled={isProcessingBuy || !momoNumber.trim()}
                style={{
                  padding: '14px', border: 'none', color: 'white', backgroundColor: T.green, borderRadius: 16,
                  cursor: isProcessingBuy || !momoNumber.trim() ? 'not-allowed' : 'pointer', fontWeight: 800, fontSize: 14,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, transition: 'all 0.2s',
                  boxShadow: `0 8px 24px ${T.green}30`, opacity: !momoNumber.trim() ? 0.6 : 1
                }}
              >
                {isProcessingBuy ? (
                  <>
                    <Loader2 className="animate-spin" size={18} /> Processing SIM card PIN prompt...
                  </>
                ) : (
                  <>
                    Pay UGX {selectedPack.price.toLocaleString()} via Mobile Money
                  </>
                )}
              </button>

              <p style={{ fontSize: 11, color: T.ghost, textAlign: 'center', lineHeight: 1.4 }}>
                By clicking pay, you will receive a secure pop-up prompt on your mobile phone requesting your Mobile Money PIN to authorize the payment.
              </p>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
