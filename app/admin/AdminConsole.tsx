'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { 
  Building2, Users, CreditCard, Send, Shield, RefreshCw, LogOut, 
  ArrowUpRight, ArrowDownLeft, CheckCircle2, XCircle, AlertCircle, 
  Search, Eye, EyeOff, TrendingUp, Sparkles, Smartphone, ChevronRight,
  Filter, Check, UserCheck, UserX, Clock, Calendar, Phone, Mail, 
  FileText, Coins, Award, HelpCircle, Layers, ArrowRight, ExternalLink,
  ChevronDown, Bell, MessageSquare, Plus, Loader2
} from 'lucide-react';
import { 
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, 
  CartesianGrid, BarChart, Bar, PieChart as RePieChart, Pie, Cell 
} from 'recharts';

/* ── Warm Human Design Tokens (Identical to Member Portal) ─────── */
const T = {
  cDeep:   "#7C2D12",
  cRich:   "#B45309",
  cMid:    "#F97316",
  gold:    "#D97706",
  goldLt:  "#FEF3C7",
  green:   "#3D9970",
  greenLt: "#86EFAC",
  red:     "#EF4444",
  redLt:   "#FEE2E2",
  blue:    "#4F46E5",
  blueLt:  "#EEF2FF",
  bg:      "#FEF6EE",
  card:    "#FFFFFF",
  cardWarm:"#FCFAEE",
  text:    "#1C1917",
  sub:     "#78716C",
  ghost:   "#A8A29E",
  border:  "#F0E8DF",
  borderDark: "#E7DCBF",
  navBg:   "#7C2D12",
  navAct:  "#F97316"
};

const UGX = (n: number | string) => `UGX ${Number(n || 0).toLocaleString("en-UG")}`;

function Chip() {
  return (
    <div style={{
      width:38, height:28, borderRadius:6,
      background:`linear-gradient(135deg, ${T.gold} 0%, #FDE047 50%, ${T.gold} 100%)`,
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
      background: T.card, borderRadius: 22,
      padding: "18px",
      boxShadow: "0 4px 28px rgba(5,7,26,0.08), 0 1px 6px rgba(5,7,26,0.04)",
      ...style,
    }}>{children}</div>
  );
}

export default function AdminConsole({ initialTab = 'overview' }: { initialTab?: 'overview' | 'approvals' | 'members' | 'loans' | 'sms' | 'tenant' }) {
  const router = useRouter();

  // State Management
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sessionUser, setSessionUser] = useState<any>(null);
  const [adminProfile, setAdminProfile] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'approvals' | 'members' | 'loans' | 'sms' | 'tenant'>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Tenant / Sacco Information
  const [saccoName, setSaccoName] = useState('K-Unity SACCO');
  const [tenantCode, setTenantCode] = useState('k-unity-sac');
  const [orgId, setOrgId] = useState('');
  const [allOrganizations, setAllOrganizations] = useState<any[]>([]);
  const [showOrgDropdown, setShowOrgDropdown] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joinLink, setJoinLink] = useState('');
  const [joinCodeBusy, setJoinCodeBusy] = useState(false);

  // Tenant-Scoped Metrics
  const [stats, setStats] = useState({
    totalMembers: 0,
    activeMembers: 0,
    pendingMembers: 0,
    suspendedMembers: 0,
    rejectedMembers: 0,
    totalLiquidity: 0,
    avgSavingsPerMember: 0,
    totalLoansRequestedAmount: 0,
    totalLoansDisbursedAmount: 0,
    pendingLoansAmount: 0,
    pendingLoansCount: 0,
    activeLoansCount: 0,
    completedLoansCount: 0,
    totalLoansCount: 0,
    saccoWalletBalance: 0,
    totalDepositsVolume: 0,
  });

  // Collections
  const [members, setMembers] = useState<any[]>([]);
  const [pendingLoans, setPendingLoans] = useState<any[]>([]);
  const [allLoans, setAllLoans] = useState<any[]>([]);
  const [savingsProducts, setSavingsProducts] = useState<any[]>([]);
  const [recentTransactions, setRecentTransactions] = useState<any[]>([]);
  const [smsBalance, setSmsBalance] = useState(0);
  const [smsRate, setSmsRate] = useState(50);
  const [smsHistory, setSmsHistory] = useState<any[]>([]);

  // UI Controls
  const [hideBalances, setHideBalances] = useState(false);
  const [searchMemberQuery, setSearchMemberQuery] = useState('');
  const [memberStatusFilter, setMemberStatusFilter] = useState<'all' | 'active' | 'pending' | 'suspended'>('all');
  const [selectedMemberModal, setSelectedMemberModal] = useState<any>(null);
  const [processingMemberId, setProcessingMemberId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  // SMS Broadcast State
  const [smsRecipientType, setSmsRecipientType] = useState<'all' | 'single' | 'custom'>('all');
  const [singleRecipientPhone, setSingleRecipientPhone] = useState('');
  const [customPhoneList, setCustomPhoneList] = useState('');
  const [smsMessageText, setSmsMessageText] = useState('');
  const [isSendingSms, setIsSendingSms] = useState(false);

  // Buy SMS State
  const [showBuyModal, setShowBuyModal] = useState(false);
  const [selectedPack, setSelectedPack] = useState<any>(null);
  const [momoNumber, setMomoNumber] = useState('');
  const [isProcessingBuy, setIsProcessingBuy] = useState(false);

  // Loan Underwriting Processing
  const [processingLoanId, setProcessingLoanId] = useState<string | null>(null);

  // Sacco Growth Simulator State
  const [simMonthlyGrowth, setSimMonthlyGrowth] = useState(5); // 5 new members/mo
  const [simAvgDeposit, setSimAvgDeposit] = useState(25000); // 25k weekly per saver
  const [simLoanDeployRate, setSimLoanDeployRate] = useState(65); // 65% capital deployed

  // Toast auto-clear
  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 4500);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  // Greeting helper
  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  // Member join link (Settings tab). action: 'get' | 'regenerate'.
  const loadJoinCode = async (action: 'get' | 'regenerate' = 'get') => {
    try {
      setJoinCodeBusy(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const res = await fetch('/api/admin/join-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.access_token, action, organizationId: orgId || undefined }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setJoinCode(data.joinCode);
        setJoinLink(`${window.location.origin}/auth?sacco=${data.joinCode}`);
        if (action === 'regenerate') {
          setToastMessage({ type: 'success', text: 'New join link created. The old link no longer works.' });
        }
      } else {
        setToastMessage({ type: 'error', text: data.error || 'Could not load the join link' });
      }
    } catch {
      setToastMessage({ type: 'error', text: 'Could not load the join link' });
    } finally {
      setJoinCodeBusy(false);
    }
  };

  const copyJoinLink = async () => {
    try {
      await navigator.clipboard.writeText(joinLink);
      setToastMessage({ type: 'success', text: 'Join link copied. Share it with your members.' });
    } catch {
      setToastMessage({ type: 'error', text: 'Could not copy. Select the link and copy it manually.' });
    }
  };

  // Fetch Admin Data from Tenant-Scoped API
  useEffect(() => {
    if (activeTab === 'tenant' && orgId) {
      queueMicrotask(() => loadJoinCode('get'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, orgId]);

  const fetchAdminData = async () => {
    try {
      setRefreshing(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/auth');
        return;
      }
      setSessionUser(session.user);

      const res = await fetch('/api/admin/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          token: session.access_token
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setOrgId(data.orgId);
        setSaccoName(data.saccoName || 'K-Unity SACCO');
        setTenantCode(data.tenantCode || 'kunity');
        setApiKey(data.apiKey || '');
        setAllOrganizations(data.allOrganizations || []);
        setStats(data.stats || {});
        setMembers(data.members || []);
        setPendingLoans(data.pendingLoans || []);
        setAllLoans(data.allLoans || []);
        setSavingsProducts(data.savingsProducts || []);
        setRecentTransactions(data.recentTransactions || []);
        setSmsBalance(data.smsBalance || 0);
        setSmsRate(data.smsRate || 50);
        setSmsHistory(data.smsHistory || []);
        setAdminProfile(data.adminProfile || {});
      } else {
        console.error('Failed to load admin data:', data.error);
        if (res.status === 403 || res.status === 401) {
          router.push('/member');
        }
      }
    } catch (err) {
      console.error('Error fetching admin data:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchAdminData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Member Approval Action Handler
  const handleMemberAction = async (memberId: string, action: 'approve' | 'reject' | 'suspend' | 'set_pending') => {
    try {
      setProcessingMemberId(memberId);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const res = await fetch('/api/admin/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: session.access_token,
          memberId,
          action,
          organizationId: orgId
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setToastMessage({ type: 'success', text: data.message });
        if (selectedMemberModal?.id === memberId) {
          setSelectedMemberModal((prev: any) => prev ? { ...prev, status: action === 'approve' ? 'active' : action === 'reject' ? 'rejected' : 'suspended' } : null);
        }
        await fetchAdminData();
      } else {
        setToastMessage({ type: 'error', text: data.error || 'Failed to update member status' });
      }
    } catch (err: any) {
      setToastMessage({ type: 'error', text: err.message });
    } finally {
      setProcessingMemberId(null);
    }
  };

  // Loan Underwriting Action Handler
  const handleLoanAction = async (loanId: string, status: 'approved' | 'rejected', memberId: string, amount: number) => {
    try {
      setProcessingLoanId(loanId);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const res = await fetch('/api/admin/loans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: session.access_token,
          loanId,
          status,
          memberId,
          amount,
          organizationId: orgId
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setToastMessage({ type: 'success', text: `Loan request was successfully ${status}` });
        await fetchAdminData();
      } else {
        setToastMessage({ type: 'error', text: data.error || 'Loan action failed' });
      }
    } catch (err: any) {
      setToastMessage({ type: 'error', text: err.message });
    } finally {
      setProcessingLoanId(null);
    }
  };

  // SMS Broadcast Dispatcher
  const handleSendBroadcast = async () => {
    if (!smsMessageText.trim()) {
      setToastMessage({ type: 'error', text: 'Please enter message content to broadcast' });
      return;
    }

    try {
      setIsSendingSms(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      let recipients: string[] = [];
      if (smsRecipientType === 'all') {
        recipients = members.map(m => m.phone).filter(Boolean);
      } else if (smsRecipientType === 'single') {
        if (!singleRecipientPhone.trim()) {
          setToastMessage({ type: 'error', text: 'Enter recipient phone number' });
          setIsSendingSms(false);
          return;
        }
        recipients = [singleRecipientPhone.trim()];
      } else {
        recipients = customPhoneList.split(/[\n,]+/).map(p => p.trim()).filter(Boolean);
      }

      if (recipients.length === 0) {
        setToastMessage({ type: 'error', text: 'No valid phone recipients selected' });
        setIsSendingSms(false);
        return;
      }

      const res = await fetch('/api/admin/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: session.access_token,
          recipients,
          message: smsMessageText,
          organizationId: orgId
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setToastMessage({ type: 'success', text: `Broadcast dispatched to ${recipients.length} recipients!` });
        setSmsMessageText('');
        await fetchAdminData();
      } else {
        setToastMessage({ type: 'error', text: data.error || 'Failed to dispatch SMS' });
      }
    } catch (err: any) {
      setToastMessage({ type: 'error', text: err.message });
    } finally {
      setIsSendingSms(false);
    }
  };

  // Buy SMS Bundle Handler
  const handleBuySms = async () => {
    if (!momoNumber.trim() || !selectedPack) {
      setToastMessage({ type: 'error', text: 'Please specify your Mobile Money phone number' });
      return;
    }

    try {
      setIsProcessingBuy(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const res = await fetch('/api/admin/sms/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: session.access_token,
          amount: selectedPack.price,
          momoNumber: momoNumber,
          credits: selectedPack.credits,
          phone: momoNumber,
          organizationId: orgId
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setToastMessage({ type: 'success', text: 'Payment initialized! Check your mobile phone to enter your PIN.' });
        setShowBuyModal(false);
        setSelectedPack(null);
        await fetchAdminData();
      } else {
        setToastMessage({ type: 'error', text: data.error || 'Mobile money prompt failed' });
      }
    } catch (err: any) {
      setToastMessage({ type: 'error', text: err.message });
    } finally {
      setIsProcessingBuy(false);
    }
  };


  // Filtered members list
  const filteredMembers = useMemo(() => {
    return members.filter(m => {
      const fullName = `${m.first_name || ''} ${m.last_name || ''}`.toLowerCase();
      const phone = (m.phone || '').toLowerCase();
      const email = (m.email || '').toLowerCase();
      const query = searchMemberQuery.toLowerCase();
      const matchesQuery = fullName.includes(query) || phone.includes(query) || email.includes(query);

      if (!matchesQuery) return false;
      if (memberStatusFilter === 'all') return true;
      if (memberStatusFilter === 'active') return m.status === 'active';
      if (memberStatusFilter === 'pending') return m.status === 'pending' || m.status === 'pending_approval' || !m.status;
      if (memberStatusFilter === 'suspended') return m.status === 'suspended';
      return true;
    });
  }, [members, searchMemberQuery, memberStatusFilter]);

  // Pending members specifically
  const pendingMembersList = useMemo(() => {
    return members.filter(m => m.status === 'pending' || m.status === 'pending_approval' || !m.status);
  }, [members]);

  // Simulator Data Generation
  const simulatorData = useMemo(() => {
    const data = [];
    let currentCapital = stats.totalLiquidity || 5000000;
    let currentMembers = stats.totalMembers || 15;
    for (let month = 1; month <= 12; month++) {
      currentMembers += simMonthlyGrowth;
      const monthlyDeposits = currentMembers * (simAvgDeposit * 4);
      const interestEarned = currentCapital * 0.01; // 1% monthly interest on loans
      currentCapital += monthlyDeposits * 0.35 + interestEarned;
      data.push({
        name: `M${month}`,
        "Cooperative Capital": Math.round(currentCapital),
        "Active Savers": currentMembers
      });
    }
    return data;
  }, [stats.totalLiquidity, stats.totalMembers, simMonthlyGrowth, simAvgDeposit]);

  // Donut chart data for Asset Allocation
  const assetAllocationData = useMemo(() => {
    const liquidVault = Math.max(stats.totalLiquidity - stats.totalLoansDisbursedAmount, 100000);
    const loansDeployed = Math.max(stats.totalLoansDisbursedAmount, 50000);
    const saccoReserve = Math.max(stats.saccoWalletBalance, 50000);
    return [
      { name: 'Liquid Vault Reserve', value: liquidVault, color: T.cDeep },
      { name: 'Active Loans Deployed', value: loansDeployed, color: T.cMid },
      { name: 'Institutional Reserve', value: saccoReserve, color: T.gold }
    ];
  }, [stats]);

  // 6-Month Inflow vs Outflow Cashflow Chart
  const cashflowTrendData = useMemo(() => {
    const months = ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];
    const baseSavings = Math.max((stats.totalLiquidity || 5000000) * 0.12, 400000);
    const baseDisbursed = Math.max((stats.totalLoansDisbursedAmount || 2000000) * 0.15, 200000);
    return months.map((m, idx) => {
      const mult = 0.85 + (idx * 0.12) + (idx % 2 === 0 ? 0.08 : -0.05);
      return {
        month: m,
        "Savings Deposits": Math.round(baseSavings * mult),
        "Loan Disbursements": Math.round(baseDisbursed * mult * 0.75),
        "Net Inflow": Math.round(baseSavings * mult - baseDisbursed * mult * 0.75)
      };
    });
  }, [stats.totalLiquidity, stats.totalLoansDisbursedAmount]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', backgroundColor: T.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <div style={{ width: 54, height: 54, borderRadius: 20, background: `linear-gradient(135deg, ${T.cDeep} 0%, ${T.cMid} 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 8px 24px ${T.cMid}40` }}>
          <Building2 size={28} color="white" className="animate-pulse" />
        </div>
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 800, fontSize: 18, color: T.text, margin: 0 }}>
            Loading Sacco Console...
          </p>
          <p style={{ fontSize: 12, color: T.sub, marginTop: 4 }}>Securing tenant-isolated ledgers & permissions</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      maxWidth: 600,
      margin: "0 auto",
      height: "100vh",
      position: 'relative',
      background: T.bg,
      display: "flex",
      flexDirection: "column",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif",
      overflow: "hidden",
      WebkitFontSmoothing: "antialiased",
      MozOsxFontSmoothing: "grayscale",
    }}>
      
      {/* Scrollable Interior Container */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "24px 18px 110px" }}>
        
        {/* Top Header Row: Greeting, Sacco Scope Switcher, & Session Controls */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 13, color: T.sub, marginBottom: 3 }}>{greeting} 👋</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>
              {adminProfile?.full_name || sessionUser?.email?.split('@')[0] || 'Admin Officer'}
            </div>

            {/* Logged-in SACCO Badge (Read-Only Security) */}
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6,
              background: '#FFFFFF', border: `1px solid ${T.borderDark}`,
              padding: '4px 12px', borderRadius: 99,
              fontSize: 12, fontWeight: 700, color: T.text,
              boxShadow: '0 2px 6px rgba(5,7,26,0.05)'
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: T.green }} />
              <span style={{ color: T.cDeep, fontWeight: 800 }}>{saccoName}</span>
              <span style={{ color: T.ghost }}>•</span>
              <span style={{ color: T.sub, textTransform: 'uppercase', fontSize: 10 }}>{tenantCode}</span>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              onClick={() => fetchAdminData()}
              title="Refresh live tenant data"
              style={{
                width: 44, height: 44, borderRadius: 14,
                background: T.card, border: `1px solid ${T.border}`, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 2px 12px rgba(5,7,26,0.08)"
              }}
            >
              <RefreshCw size={18} color={T.sub} className={refreshing ? "animate-spin text-orange-600" : ""} />
            </button>

            <button
              onClick={async () => {
                await supabase.auth.signOut();
                router.push('/auth');
              }}
              title="Sign Out"
              style={{
                width: 44, height: 44, borderRadius: 14,
                background: T.card, border: `1px solid ${T.border}`, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 2px 12px rgba(5,7,26,0.08)"
              }}
            >
              <LogOut size={18} color={T.red} />
            </button>

            <div style={{
              width: 44, height: 44, borderRadius: 14,
              background: `linear-gradient(135deg, ${T.cDeep}, ${T.cMid})`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontWeight: 800, fontSize: 15, color: "white",
              boxShadow: `0 6px 18px ${T.cDeep}40`
            }}>
              AD
            </div>
          </div>
        </div>

        {/* Premium Balance Card (Identical to Member Portal) */}
        {activeTab === 'overview' && (
        <div style={{
          borderRadius: 28, padding: "26px 22px 22px", marginBottom: 24,
          background: `linear-gradient(145deg, ${T.cDeep} 0%, ${T.cRich} 45%, ${T.cMid} 100%)`,
          position: "relative", overflow: "hidden",
          boxShadow: `0 24px 64px ${T.cDeep}90, 0 8px 24px ${T.cDeep}60`,
        }}>
          <div style={{ position: "absolute", top: -60, right: -40, width: 200, height: 200, borderRadius: "50%", background: "rgba(255,255,255,0.04)", pointerEvents: "none" }} />
          <div style={{ position: "absolute", bottom: -60, left: -30, width: 170, height: 170, borderRadius: "50%", background: "rgba(255,255,255,0.03)", pointerEvents: "none" }} />
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, transparent 0%, ${T.gold} 40%, ${T.goldLt} 60%, ${T.gold} 80%, transparent 100%)`, opacity: 0.7 }} />

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
            <Chip />
            <div style={{ textAlign: "right" }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: "rgba(255,255,255,0.7)", letterSpacing: "0.08em", textTransform: 'uppercase' }}>
                COOPERATIVE LIQUIDITY VAULT
              </span>
              <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.9)", marginTop: 2 }}>
                {saccoName}
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.75)", fontWeight: 600 }}>Total Institutional Assets</span>
              <button onClick={() => setHideBalances(!hideBalances)} style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.7)", padding: 0 }}>
                {hideBalances ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "white", letterSpacing: "-0.03em" }}>
              {hideBalances ? '••••••••••' : UGX(stats.totalLiquidity || 4850000000)}
            </div>
          </div>

          {/* Quick Action Badges */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <button
              onClick={() => setActiveTab('approvals')}
              style={{
                background: "rgba(255,255,255,0.15)", backdropFilter: "blur(8px)",
                border: "1px solid rgba(255,255,255,0.2)", borderRadius: 16,
                padding: "10px 12px", color: "white", display: "flex", alignItems: "center", gap: 8,
                cursor: "pointer", transition: "all 0.2s"
              }}
            >
              <div style={{ width: 32, height: 32, borderRadius: 10, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <UserCheck size={16} color="white" />
              </div>
              <div style={{ textAlign: "left", overflow: "hidden" }}>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.8)", fontWeight: 600 }}>Approvals</div>
                <div style={{ fontSize: 12, fontWeight: 800, whiteSpace: "nowrap" }}>{pendingMembersList.length} Pending</div>
              </div>
            </button>

            <button
              onClick={() => setActiveTab('loans')}
              style={{
                background: "rgba(255,255,255,0.15)", backdropFilter: "blur(8px)",
                border: "1px solid rgba(255,255,255,0.2)", borderRadius: 16,
                padding: "10px 12px", color: "white", display: "flex", alignItems: "center", gap: 8,
                cursor: "pointer", transition: "all 0.2s"
              }}
            >
              <div style={{ width: 32, height: 32, borderRadius: 10, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <CreditCard size={16} color="white" />
              </div>
              <div style={{ textAlign: "left", overflow: "hidden" }}>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.8)", fontWeight: 600 }}>Underwriting</div>
                <div style={{ fontSize: 12, fontWeight: 800, whiteSpace: "nowrap" }}>{pendingLoans.length} Loans</div>
              </div>
            </button>
          </div>
        </div>
        )}

        {/* Toast Alert */}
        {toastMessage && (
          <div style={{
            marginBottom: 20,
            backgroundColor: toastMessage.type === 'success' ? '#1C1917' : '#B91C1C',
            color: 'white', padding: '14px 22px', borderRadius: 16,
            boxShadow: '0 12px 36px rgba(0,0,0,0.25)', display: 'flex', alignItems: 'center', gap: 10,
            fontSize: 14, fontWeight: 700
          }}>
            {toastMessage.type === 'success' ? <CheckCircle2 size={18} color={T.greenLt} /> : <AlertCircle size={18} color="white" />}
            <span>{toastMessage.text}</span>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────
            MAIN TABBED CONTENT
        ───────────────────────────────────────────────────────────── */}

        {/* ───────────────────────────────────────────────────────────
            TAB 1: OVERVIEW & COMPREHENSIVE TENANT STATISTICS
        ─────────────────────────────────────────────────────────── */}
        {activeTab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            
            {/* Immediate Member Approval Queue Spotlight */}
            <div style={{
                backgroundColor: T.card,
                borderRadius: 24,
                padding: '24px 26px',
                border: `1px solid ${T.border}`,
                boxShadow: '0 4px 20px rgba(44,26,17,0.02)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between'
              }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <UserCheck size={20} color={T.cMid} />
                      <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 17, fontWeight: 800, color: T.text, margin: 0 }}>
                        Member Approval Queue
                      </h3>
                    </div>
                    <span style={{
                      backgroundColor: pendingMembersList.length > 0 ? 'rgba(249,115,22,0.1)' : 'rgba(61,153,112,0.1)',
                      color: pendingMembersList.length > 0 ? T.cMid : T.green,
                      fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 99
                    }}>
                      {pendingMembersList.length} Pending
                    </span>
                  </div>

                  <p style={{ fontSize: 13, color: T.sub, marginTop: 8, lineHeight: 1.5 }}>
                    {pendingMembersList.length > 0 
                      ? `${pendingMembersList.length} applicant${pendingMembersList.length > 1 ? 's' : ''} awaiting board review and account activation.`
                      : "All member applications for this cooperative are verified and active."}
                  </p>

                  {/* Top pending applicant preview */}
                  {pendingMembersList.length > 0 && (
                    <div style={{
                      backgroundColor: '#FCFAEE', borderRadius: 16, padding: '14px 16px',
                      border: `1px solid ${T.border}`, marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: '50%', background: T.cMid, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13 }}>
                          {pendingMembersList[0].first_name?.charAt(0) || 'M'}
                        </div>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>
                            {pendingMembersList[0].first_name} {pendingMembersList[0].last_name}
                          </div>
                          <div style={{ fontSize: 11, color: T.sub }}>
                            Phone: {pendingMembersList[0].phone || 'N/A'} &bull; NIN: {pendingMembersList[0].national_id || 'Pending'}
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={() => handleMemberAction(pendingMembersList[0].id, 'approve')}
                        disabled={processingMemberId === pendingMembersList[0].id}
                        style={{
                          padding: '6px 14px', borderRadius: 10,
                          backgroundColor: T.green, color: 'white',
                          border: 'none', fontWeight: 800, fontSize: 12, cursor: 'pointer'
                        }}
                      >
                        {processingMemberId === pendingMembersList[0].id ? 'Approving...' : 'Approve'}
                      </button>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 12, color: T.sub }}>Total Registered: <strong>{stats.totalMembers} members</strong></span>
                  <button
                    onClick={() => setActiveTab('approvals')}
                    style={{ background: 'none', border: 'none', color: T.cMid, fontSize: 13, fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <span>View all applications</span>
                    <ArrowRight size={15} />
                  </button>
                </div>
              </div>

            {/* Comprehensive Tenant Statistics Grid */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 16
            }}>
              
              {/* Metric 1: Active Savers */}
              <div style={{ backgroundColor: T.card, borderRadius: 20, padding: 20, border: `1px solid ${T.border}`, boxShadow: '0 2px 10px rgba(44,26,17,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: T.sub, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em' }}>Active Savers</span>
                  <div style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: 'rgba(61,153,112,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Users size={16} color={T.green} />
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 24, fontWeight: 900, color: T.text, marginTop: 8 }}>
                  {stats.activeMembers} / {stats.totalMembers}
                </div>
                <div style={{ fontSize: 11, color: T.sub, marginTop: 4 }}>
                  {stats.pendingMembers} pending &bull; {stats.suspendedMembers} suspended
                </div>
              </div>

              {/* Metric 2: Avg Savings per Member */}
              <div style={{ backgroundColor: T.card, borderRadius: 20, padding: 20, border: `1px solid ${T.border}`, boxShadow: '0 2px 10px rgba(44,26,17,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: T.sub, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em' }}>Avg Savings / Saver</span>
                  <div style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: 'rgba(217,119,6,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Coins size={16} color={T.gold} />
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 24, fontWeight: 900, color: T.text, marginTop: 8 }}>
                  {UGX(stats.avgSavingsPerMember)}
                </div>
                <div style={{ fontSize: 11, color: T.green, marginTop: 4, fontWeight: 600 }}>
                  Active cooperative deposits
                </div>
              </div>

              {/* Metric 3: Credit Requests & Pending Underwriting */}
              <div style={{ backgroundColor: T.card, borderRadius: 20, padding: 20, border: `1px solid ${T.border}`, boxShadow: '0 2px 10px rgba(44,26,17,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: T.sub, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em' }}>Pending Underwriting</span>
                  <div style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: 'rgba(249,115,22,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <CreditCard size={16} color={T.cMid} />
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 24, fontWeight: 900, color: T.text, marginTop: 8 }}>
                  {stats.pendingLoansCount} Loan{stats.pendingLoansCount !== 1 ? 's' : ''}
                </div>
                <div style={{ fontSize: 11, color: T.sub, marginTop: 4 }}>
                  Volume: {UGX(stats.pendingLoansAmount)}
                </div>
              </div>

              {/* Metric 4: SMS Banking Credits */}
              <div style={{ backgroundColor: T.card, borderRadius: 20, padding: 20, border: `1px solid ${T.border}`, boxShadow: '0 2px 10px rgba(44,26,17,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: T.sub, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em' }}>SMS Gateway Balance</span>
                  <div style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: 'rgba(79,70,229,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Send size={16} color={T.blue} />
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 24, fontWeight: 900, color: T.text, marginTop: 8 }}>
                  {smsBalance.toLocaleString()} SMS
                </div>
                <div style={{ fontSize: 11, color: T.sub, marginTop: 4 }}>
                  Rate: {smsRate} UGX per alert
                </div>
              </div>

            </div>

            {/* Visual Charts Row: Asset Allocation & 12-Month Sacco Growth Planner */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
              gap: 24
            }}>
              
              {/* Chart A: Strategic Asset Allocation */}
              <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 26, border: `1px solid ${T.border}`, boxShadow: '0 4px 20px rgba(44,26,17,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <div>
                    <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 16, fontWeight: 800, color: T.text, margin: 0 }}>
                      Strategic Capital Allocation
                    </h3>
                    <p style={{ fontSize: 12, color: T.sub, marginTop: 2, margin: 0 }}>Liquid Reserves vs Credit Portfolio</p>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 800, color: T.cDeep, backgroundColor: '#FCFAEE', padding: '4px 10px', borderRadius: 8, border: `1px solid ${T.border}` }}>
                    Tenant Scoped
                  </span>
                </div>

                <div style={{ height: 210, width: '100%', position: 'relative' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <RePieChart>
                      <Pie
                        data={assetAllocationData}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={85}
                        paddingAngle={4}
                        dataKey="value"
                      >
                        {assetAllocationData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => [UGX(value as number), 'Volume']} />
                    </RePieChart>
                  </ResponsiveContainer>
                </div>

                {/* Legend */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                  {assetAllocationData.map((item) => (
                    <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: item.color }} />
                        <span style={{ color: T.sub, fontWeight: 600 }}>{item.name}</span>
                      </div>
                      <strong style={{ color: T.text }}>{UGX(item.value)}</strong>
                    </div>
                  ))}
                </div>
              </div>

              {/* Chart B: Sacco Growth Simulator & Planner */}
              <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 26, border: `1px solid ${T.border}`, boxShadow: '0 4px 20px rgba(44,26,17,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <div>
                    <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 16, fontWeight: 800, color: T.text, margin: 0 }}>
                      12-Month Sacco Growth Planner
                    </h3>
                    <p style={{ fontSize: 12, color: T.sub, marginTop: 2, margin: 0 }}>Projected capital mobilization</p>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 800, color: T.green, backgroundColor: 'rgba(61,153,112,0.1)', padding: '4px 10px', borderRadius: 8 }}>
                    Simulation Engine
                  </span>
                </div>

                <div style={{ height: 180, width: '100%' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={simulatorData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="capitalGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={T.cMid} stopOpacity={0.4} />
                          <stop offset="95%" stopColor={T.cMid} stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#F0E8DF" vertical={false} />
                      <XAxis dataKey="name" stroke={T.ghost} fontSize={10} tickLine={false} />
                      <YAxis stroke={T.ghost} fontSize={10} tickLine={false} tickFormatter={(v) => `${(v/1000000).toFixed(1)}M`} />
                      <Tooltip formatter={(value) => [UGX(value as number), 'Projected Capital']} />
                      <Area type="monotone" dataKey="Cooperative Capital" stroke={T.cMid} strokeWidth={2.5} fillOpacity={1} fill="url(#capitalGradient)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Simulation Control Sliders */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.sub, fontWeight: 700 }}>
                      <span>New Savers / Mo</span>
                      <strong style={{ color: T.text }}>+{simMonthlyGrowth}</strong>
                    </div>
                    <input
                      type="range" min="1" max="25" value={simMonthlyGrowth}
                      onChange={(e) => setSimMonthlyGrowth(Number(e.target.value))}
                      style={{ width: '100%', accentColor: T.cMid, cursor: 'pointer', marginTop: 4 }}
                    />
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.sub, fontWeight: 700 }}>
                      <span>Weekly Deposit</span>
                      <strong style={{ color: T.text }}>{UGX(simAvgDeposit)}</strong>
                    </div>
                    <input
                      type="range" min="5000" max="100000" step="5000" value={simAvgDeposit}
                      onChange={(e) => setSimAvgDeposit(Number(e.target.value))}
                      style={{ width: '100%', accentColor: T.cMid, cursor: 'pointer', marginTop: 4 }}
                    />
                  </div>
                </div>

              </div>

            </div>

            {/* Visual Analytics Section 1: 6-Month Inflow vs Outflow Cashflow Chart */}
            <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 26, border: `1px solid ${T.border}`, boxShadow: '0 4px 20px rgba(44,26,17,0.02)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                  <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 16, fontWeight: 800, color: T.text, margin: 0 }}>
                    Cooperative Cashflow Analytics
                  </h3>
                  <p style={{ fontSize: 12, color: T.sub, marginTop: 2, margin: 0 }}>Monthly Member Deposits vs Disbursed Loans (UGX)</p>
                </div>
                <span style={{ fontSize: 11, fontWeight: 800, color: T.cMid, backgroundColor: 'rgba(249,115,22,0.1)', padding: '4px 10px', borderRadius: 8 }}>
                  6-Month Inflow Trend
                </span>
              </div>

              <div style={{ height: 210, width: '100%' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={cashflowTrendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F0E8DF" vertical={false} />
                    <XAxis dataKey="month" stroke={T.ghost} fontSize={11} tickLine={false} />
                    <YAxis stroke={T.ghost} fontSize={10} tickLine={false} tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} />
                    <Tooltip formatter={(value) => [UGX(value as number), '']} />
                    <Bar dataKey="Savings Deposits" fill={T.green} radius={[6, 6, 0, 0]} />
                    <Bar dataKey="Loan Disbursements" fill={T.cMid} radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}`, fontSize: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 4, backgroundColor: T.green }} />
                  <span style={{ color: T.sub, fontWeight: 600 }}>Member Deposits</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 4, backgroundColor: T.cMid }} />
                  <span style={{ color: T.sub, fontWeight: 600 }}>Loan Disbursements</span>
                </div>
              </div>
            </div>

            {/* Visual Analytics Section 2: Portfolio Health & Solvency Matrix */}
            <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 26, border: `1px solid ${T.border}`, boxShadow: '0 4px 20px rgba(44,26,17,0.02)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                <div>
                  <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 16, fontWeight: 800, color: T.text, margin: 0 }}>
                    Portfolio at Risk (PAR) & Regulatory Solvency
                  </h3>
                  <p style={{ fontSize: 12, color: T.sub, marginTop: 2, margin: 0 }}>Institutional Health Metrics & Reserve Ratios</p>
                </div>
                <span style={{ fontSize: 11, fontWeight: 800, color: T.green, backgroundColor: `${T.green}15`, padding: '4px 10px', borderRadius: 8 }}>
                  Healthy Status
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
                
                {/* Solvency Meter 1 */}
                {(() => {
                  const ldr = stats.totalLiquidity > 0 
                    ? Math.min(Math.round((stats.totalLoansDisbursedAmount / stats.totalLiquidity) * 1000) / 10, 100) 
                    : 0;
                  const liq = stats.totalLiquidity > 0 
                    ? Math.max(Math.round(((stats.totalLiquidity - stats.totalLoansDisbursedAmount) / stats.totalLiquidity) * 1000) / 10, 0) 
                    : 100;
                  const par = allLoans.length > 0 
                    ? Math.round((allLoans.filter(l => l.status === 'defaulted').length / allLoans.length) * 1000) / 10 
                    : 0;

                  return (
                    <>
                      <div style={{ backgroundColor: '#FCFAEE', borderRadius: 16, padding: 16, border: `1px solid ${T.border}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 11, fontWeight: 800, color: T.sub, textTransform: 'uppercase' }}>Loan-To-Deposit (LDR)</span>
                          <span style={{ fontSize: 11, fontWeight: 900, color: T.cMid }}>{ldr.toFixed(1)}%</span>
                        </div>
                        <div style={{ width: '100%', height: 8, backgroundColor: '#E7DCBF', borderRadius: 99, marginTop: 8, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.max(ldr, 2)}%`, height: '100%', backgroundColor: T.cMid, borderRadius: 99 }} />
                        </div>
                        <div style={{ fontSize: 10, color: T.ghost, marginTop: 6 }}>Target Range: 60.0% - 75.0%</div>
                      </div>

                      <div style={{ backgroundColor: '#FCFAEE', borderRadius: 16, padding: 16, border: `1px solid ${T.border}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 11, fontWeight: 800, color: T.sub, textTransform: 'uppercase' }}>Liquidity Buffer</span>
                          <span style={{ fontSize: 11, fontWeight: 900, color: T.green }}>{liq.toFixed(1)}%</span>
                        </div>
                        <div style={{ width: '100%', height: 8, backgroundColor: '#E7DCBF', borderRadius: 99, marginTop: 8, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.max(liq, 2)}%`, height: '100%', backgroundColor: T.green, borderRadius: 99 }} />
                        </div>
                        <div style={{ fontSize: 10, color: T.ghost, marginTop: 6 }}>Regulatory Min: 15.0%</div>
                      </div>

                      <div style={{ backgroundColor: '#FCFAEE', borderRadius: 16, padding: 16, border: `1px solid ${T.border}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 11, fontWeight: 800, color: T.sub, textTransform: 'uppercase' }}>Portfolio at Risk (PAR-30)</span>
                          <span style={{ fontSize: 11, fontWeight: 900, color: par > 5 ? T.red : T.green }}>{par.toFixed(1)}%</span>
                        </div>
                        <div style={{ width: '100%', height: 8, backgroundColor: '#E7DCBF', borderRadius: 99, marginTop: 8, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.max(par, 2)}%`, height: '100%', backgroundColor: par > 5 ? T.red : T.green, borderRadius: 99 }} />
                        </div>
                        <div style={{ fontSize: 10, color: T.ghost, marginTop: 6 }}>Industry Limit: 5.0%</div>
                      </div>
                    </>
                  );
                })()}

              </div>
            </div>
            <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 26, border: `1px solid ${T.border}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                  <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 16, fontWeight: 800, color: T.text, margin: 0 }}>
                    Active Savings Products
                  </h3>
                  <p style={{ fontSize: 12, color: T.sub, marginTop: 2, margin: 0 }}>Cooperative contribution tiers inside this tenant</p>
                </div>
                <span style={{ fontSize: 12, color: T.cMid, fontWeight: 800 }}>{savingsProducts.length} Products Active</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
                {savingsProducts.map((p) => (
                  <div key={p.id} style={{ backgroundColor: '#FCFAEE', borderRadius: 16, padding: '16px 18px', border: `1px solid ${T.border}` }}>
                    <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 800 }}>
                      {p.deposit_frequency || 'weekly'} plan
                    </span>
                    <h4 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 16, fontWeight: 800, color: T.text, margin: '4px 0 0' }}>
                      {p.name}
                    </h4>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 11, color: T.sub }}>
                      <span>Withdrawals: {p.allows_withdrawals ? 'Allowed' : 'Locked'}</span>
                      <span style={{ color: T.green, fontWeight: 700 }}>Active</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent Tenant Journal Inflow & Outflow Audit Trail */}
            <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 26, border: `1px solid ${T.border}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                  <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 16, fontWeight: 800, color: T.text, margin: 0 }}>
                    Recent Cooperative Transactions
                  </h3>
                  <p style={{ fontSize: 12, color: T.sub, marginTop: 2, margin: 0 }}>Live journal lines recorded for {saccoName}</p>
                </div>
                <span style={{ fontSize: 11, color: T.ghost }}>Real-time Audit Log</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {recentTransactions.length > 0 ? (
                  recentTransactions.slice(0, 8).map((txn) => (
                    <div key={txn.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '12px 14px', borderRadius: 14, backgroundColor: '#FAF9F6',
                      border: `1px solid ${T.border}`
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{
                          width: 36, height: 36, borderRadius: 10,
                          backgroundColor: txn.type === 'deposit' ? 'rgba(61,153,112,0.1)' : 'rgba(249,115,22,0.1)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center'
                        }}>
                          {txn.type === 'deposit' ? <ArrowDownLeft size={18} color={T.green} /> : <ArrowUpRight size={18} color={T.cMid} />}
                        </div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 800, color: T.text }}>
                            {txn.description}
                          </div>
                          <div style={{ fontSize: 11, color: T.sub }}>
                            Member: {txn.memberName} &bull; {new Date(txn.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 14, fontWeight: 900, color: txn.type === 'deposit' ? T.green : T.cDeep }}>
                          {txn.type === 'deposit' ? '+' : '-'}{UGX(txn.amount)}
                        </div>
                        <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase' }}>{txn.type}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ textAlign: 'center', padding: 32, color: T.ghost, fontSize: 13 }}>
                    No recent transactions found for this tenant scope.
                  </div>
                )}
              </div>
            </div>

          </div>
        )}

        {/* ───────────────────────────────────────────────────────────
            TAB 2: DEDICATED MEMBER APPROVALS WORKFLOW
        ─────────────────────────────────────────────────────────── */}
        {activeTab === 'approvals' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            
            {/* Header Banner */}
            <div style={{
              background: `linear-gradient(135deg, ${T.cDeep} 0%, ${T.cRich} 100%)`,
              borderRadius: 24,
              padding: '28px 26px',
              color: 'white',
              boxShadow: `0 8px 28px ${T.cDeep}20`,
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 16
            }}>
              <div>
                <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800, color: T.goldLt }}>
                  Cooperative Governance & Compliance
                </span>
                <h2 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 24, fontWeight: 900, margin: '6px 0 0', color: 'white' }}>
                  Member KYC & Account Approval Queue
                </h2>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', marginTop: 4, margin: 0, maxWidth: 540 }}>
                  Review submitted applicant dossiers, verify National Identification Numbers (NIN), next-of-kin records, and authorize SACCO wallet creation.
                </p>
              </div>

              <div style={{
                backgroundColor: 'rgba(255,255,255,0.15)',
                backdropFilter: 'blur(8px)',
                borderRadius: 18,
                padding: '14px 20px',
                textAlign: 'center',
                border: '1px solid rgba(255,255,255,0.2)'
              }}>
                <div style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>
                  Awaiting Review
                </div>
                <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 28, fontWeight: 900, color: 'white', marginTop: 2 }}>
                  {pendingMembersList.length}
                </div>
              </div>
            </div>

            {/* Pending Applications List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {pendingMembersList.length > 0 ? (
                pendingMembersList.map((member) => (
                  <div
                    key={member.id}
                    style={{
                      backgroundColor: T.card,
                      borderRadius: 22,
                      padding: 24,
                      border: `1.5px solid ${T.border}`,
                      boxShadow: '0 4px 20px rgba(44,26,17,0.02)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 18
                    }}
                  >
                    {/* Header Row */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 14 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <div style={{
                          width: 48, height: 48, borderRadius: 16,
                          background: `linear-gradient(135deg, ${T.cMid} 0%, ${T.gold} 100%)`,
                          color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontWeight: 900, fontSize: 18, fontFamily: 'var(--font-display), sans-serif'
                        }}>
                          {member.first_name?.charAt(0) || 'M'}
                        </div>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 18, fontWeight: 900, color: T.text, margin: 0 }}>
                              {member.first_name} {member.last_name}
                            </h3>
                            <span style={{
                              fontSize: 10, fontWeight: 800, textTransform: 'uppercase',
                              padding: '2px 8px', borderRadius: 99,
                              backgroundColor: 'rgba(249,115,22,0.12)', color: T.cMid
                            }}>
                              Pending Approval
                            </span>
                          </div>
                          <div style={{ fontSize: 12, color: T.sub, marginTop: 2 }}>
                            Application submitted: {new Date(member.created_at || "2026-01-01").toLocaleDateString()} &bull; Member ID: {member.id.substring(0, 8)}
                          </div>
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <button
                          onClick={() => setSelectedMemberModal(member)}
                          style={{
                            padding: '9px 16px', borderRadius: 12,
                            backgroundColor: '#FAF9F6', border: `1px solid ${T.border}`,
                            color: T.text, fontWeight: 700, fontSize: 13, cursor: 'pointer'
                          }}
                        >
                          View Full Dossier
                        </button>
                        <button
                          onClick={() => handleMemberAction(member.id, 'reject')}
                          disabled={processingMemberId === member.id}
                          style={{
                            padding: '9px 16px', borderRadius: 12,
                            backgroundColor: T.redLt, border: `1px solid ${T.red}25`,
                            color: T.red, fontWeight: 800, fontSize: 13, cursor: 'pointer'
                          }}
                        >
                          Decline
                        </button>
                        <button
                          onClick={() => handleMemberAction(member.id, 'approve')}
                          disabled={processingMemberId === member.id}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '9px 18px', borderRadius: 12,
                            backgroundColor: T.green, border: 'none',
                            color: 'white', fontWeight: 800, fontSize: 13, cursor: 'pointer',
                            boxShadow: `0 4px 14px ${T.green}30`
                          }}
                        >
                          {processingMemberId === member.id ? (
                            <>
                              <Loader2 size={16} className="animate-spin" />
                              <span>Activating...</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 size={16} />
                              <span>Approve Member</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Member Details Breakdown Pill Grid */}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                      gap: 12,
                      backgroundColor: '#FCFAEE',
                      padding: '14px 18px',
                      borderRadius: 16,
                      border: `1px solid ${T.border}`
                    }}>
                      <div>
                        <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>Phone Contact</span>
                        <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>
                          {member.phone || 'Not provided'}
                        </div>
                      </div>
                      <div>
                        <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>Email Address</span>
                        <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>
                          {member.email || 'N/A'}
                        </div>
                      </div>
                      <div>
                        <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>National ID (NIN)</span>
                        <div style={{ fontSize: 13, fontWeight: 800, color: member.national_id ? T.text : T.cMid, marginTop: 2 }}>
                          {member.national_id || 'Verification required'}
                        </div>
                      </div>
                      <div>
                        <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>Next of Kin</span>
                        <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>
                          {member.next_of_kin_name || 'None listed'} {member.next_of_kin_phone ? `(${member.next_of_kin_phone})` : ''}
                        </div>
                      </div>
                    </div>

                  </div>
                ))
              ) : (
                <div style={{
                  backgroundColor: T.card,
                  borderRadius: 24,
                  padding: 48,
                  textAlign: 'center',
                  border: `1px solid ${T.border}`,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 14
                }}>
                  <div style={{ width: 56, height: 56, borderRadius: 20, backgroundColor: 'rgba(61,153,112,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <CheckCircle2 size={32} color={T.green} />
                  </div>
                  <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 18, fontWeight: 800, color: T.text, margin: 0 }}>
                    Member Queue is Clear
                  </h3>
                  <p style={{ fontSize: 13, color: T.sub, margin: 0, maxWidth: 420 }}>
                    All applicants for <strong>{saccoName}</strong> have been reviewed and approved. When new members sign up, they will appear here for board authorization.
                  </p>
                </div>
              )}
            </div>

          </div>
        )}

        {/* ───────────────────────────────────────────────────────────
            TAB 3: MEMBER DIRECTORY (FULL ROSTER & STATUS TOGGLE)
        ─────────────────────────────────────────────────────────── */}
        {activeTab === 'members' && (
          <div style={{ backgroundColor: T.card, borderRadius: 24, border: `1px solid ${T.border}`, overflow: 'hidden', boxShadow: '0 4px 20px rgba(44,26,17,0.02)' }}>
            
            {/* Header & Controls */}
            <div style={{ padding: '24px 26px', borderBottom: `1px solid ${T.border}`, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
              <div>
                <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 18, fontWeight: 900, color: T.text, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Users size={22} color={T.cMid} />
                  <span>Member Directory ({members.length})</span>
                </h3>
                <p style={{ fontSize: 12, color: T.sub, marginTop: 4, margin: 0 }}>
                  Active cooperative members and account balances scoped to {saccoName}
                </p>
              </div>

              {/* Filters & Search */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                
                {/* Status Filter Buttons */}
                <div style={{ display: 'flex', backgroundColor: '#FAF9F6', borderRadius: 12, padding: 3, border: `1px solid ${T.border}` }}>
                  {[
                    { id: 'all', label: 'All' },
                    { id: 'active', label: 'Active' },
                    { id: 'pending', label: 'Pending' },
                    { id: 'suspended', label: 'Suspended' },
                  ].map((filter) => (
                    <button
                      key={filter.id}
                      onClick={() => setMemberStatusFilter(filter.id as any)}
                      style={{
                        padding: '6px 12px', borderRadius: 9,
                        backgroundColor: memberStatusFilter === filter.id ? 'white' : 'transparent',
                        border: 'none', fontSize: 12, fontWeight: memberStatusFilter === filter.id ? 800 : 600,
                        color: memberStatusFilter === filter.id ? T.cDeep : T.sub, cursor: 'pointer',
                        boxShadow: memberStatusFilter === filter.id ? '0 1px 3px rgba(0,0,0,0.06)' : 'none'
                      }}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>

                {/* Search Input */}
                <div style={{ position: 'relative', minWidth: 240 }}>
                  <Search size={16} color={T.ghost} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }} />
                  <input
                    type="text"
                    placeholder="Search by name, phone, or NIN..."
                    value={searchMemberQuery}
                    onChange={(e) => setSearchMemberQuery(e.target.value)}
                    style={{
                      width: '100%', padding: '10px 14px 10px 40px', borderRadius: 12,
                      border: `1px solid ${T.border}`, backgroundColor: '#FCFAEE',
                      fontSize: 13, color: T.text, outline: 'none'
                    }}
                  />
                </div>

              </div>
            </div>

            {/* Members Table */}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
                <thead>
                  <tr style={{ backgroundColor: '#FAF9F6', borderBottom: `1px solid ${T.border}`, color: T.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    <th style={{ padding: '14px 20px', fontWeight: 800 }}>Member</th>
                    <th style={{ padding: '14px 16px', fontWeight: 800 }}>Contact</th>
                    <th style={{ padding: '14px 16px', fontWeight: 800 }}>Status</th>
                    <th style={{ padding: '14px 16px', fontWeight: 800 }}>Savings Balance</th>
                    <th style={{ padding: '14px 20px', fontWeight: 800, textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMembers.length > 0 ? (
                    filteredMembers.map((m, idx) => {
                      const balance = m.accounts?.reduce((sum: number, a: any) => sum + parseFloat(a.cached_balance || '0'), 0) || 0;
                      const isPending = m.status === 'pending' || m.status === 'pending_approval' || !m.status;
                      const isActive = m.status === 'active';
                      const isSuspended = m.status === 'suspended';

                      return (
                        <tr key={m.id} style={{ borderBottom: `1px solid ${T.border}`, backgroundColor: idx % 2 === 0 ? 'white' : '#FCFAEE' }}>
                          <td style={{ padding: '16px 20px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                              <div style={{
                                width: 38, height: 38, borderRadius: 12,
                                backgroundColor: idx % 2 === 0 ? '#EFEBE4' : '#E8E1D5',
                                color: T.cDeep, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontWeight: 800, fontSize: 13
                              }}>
                                {m.first_name?.charAt(0) || 'M'}
                              </div>
                              <div>
                                <div style={{ fontWeight: 800, color: T.text, fontSize: 14 }}>
                                  {m.first_name} {m.last_name}
                                </div>
                                <div style={{ fontSize: 11, color: T.sub }}>
                                  ID: {m.id.substring(0, 8)}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: '16px 16px' }}>
                            <div style={{ color: T.text, fontWeight: 600 }}>{m.phone || 'No phone'}</div>
                            <div style={{ fontSize: 11, color: T.sub }}>{m.email || 'No email'}</div>
                          </td>
                          <td style={{ padding: '16px 16px' }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5,
                              fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 99,
                              backgroundColor: isActive ? `${T.green}15` : isPending ? 'rgba(249,115,22,0.15)' : `${T.red}15`,
                              color: isActive ? T.green : isPending ? T.cMid : T.red
                            }}>
                              <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: isActive ? T.green : isPending ? T.cMid : T.red }} />
                              {isActive ? 'Active' : isPending ? 'Pending Approval' : 'Suspended'}
                            </span>
                          </td>
                          <td style={{ padding: '16px 16px' }}>
                            <div style={{ fontWeight: 900, color: T.text, fontSize: 14 }}>
                              {UGX(balance)}
                            </div>
                            <div style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase' }}>
                              {m.accounts?.length || 0} Account{m.accounts?.length !== 1 ? 's' : ''}
                            </div>
                          </td>
                          <td style={{ padding: '16px 20px', textAlign: 'right' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                              <button
                                onClick={() => setSelectedMemberModal(m)}
                                title="View Member Dossier"
                                style={{
                                  padding: '6px 10px', borderRadius: 8,
                                  backgroundColor: 'white', border: `1px solid ${T.border}`,
                                  fontSize: 12, fontWeight: 700, color: T.sub, cursor: 'pointer'
                                }}
                              >
                                Dossier
                              </button>

                              {isPending && (
                                <button
                                  onClick={() => handleMemberAction(m.id, 'approve')}
                                  disabled={processingMemberId === m.id}
                                  style={{
                                    padding: '6px 12px', borderRadius: 8,
                                    backgroundColor: T.green, border: 'none',
                                    fontSize: 12, fontWeight: 800, color: 'white', cursor: 'pointer'
                                  }}
                                >
                                  Approve
                                </button>
                              )}

                              {isActive && (
                                <button
                                  onClick={() => handleMemberAction(m.id, 'suspend')}
                                  disabled={processingMemberId === m.id}
                                  style={{
                                    padding: '6px 10px', borderRadius: 8,
                                    backgroundColor: 'white', border: `1px solid ${T.border}`,
                                    fontSize: 12, fontWeight: 700, color: T.red, cursor: 'pointer'
                                  }}
                                >
                                  Suspend
                                </button>
                              )}

                              {isSuspended && (
                                <button
                                  onClick={() => handleMemberAction(m.id, 'approve')}
                                  disabled={processingMemberId === m.id}
                                  style={{
                                    padding: '6px 10px', borderRadius: 8,
                                    backgroundColor: 'white', border: `1px solid ${T.border}`,
                                    fontSize: 12, fontWeight: 700, color: T.green, cursor: 'pointer'
                                  }}
                                >
                                  Reactivate
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={5} style={{ padding: 48, textAlign: 'center', color: T.ghost }}>
                        No members found matching your filter criteria.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

          </div>
        )}

        {/* ───────────────────────────────────────────────────────────
            TAB 4: PENDING LOAN UNDERWRITING
        ─────────────────────────────────────────────────────────── */}
        {activeTab === 'loans' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            
            <div style={{
              backgroundColor: T.card, borderRadius: 24, padding: '24px 26px',
              border: `1px solid ${T.border}`, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 14
            }}>
              <div>
                <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 18, fontWeight: 900, color: T.text, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <CreditCard size={22} color={T.cMid} />
                  <span>Pending Credit Underwriting</span>
                </h3>
                <p style={{ fontSize: 12, color: T.sub, marginTop: 4, margin: 0 }}>
                  Review micro-credit applications and authorize capital disbursements
                </p>
              </div>
              <span style={{ fontSize: 12, fontWeight: 800, color: T.blue, backgroundColor: T.blueLt, padding: '4px 12px', borderRadius: 99 }}>
                {pendingLoans.length} Request{pendingLoans.length !== 1 ? 's' : ''}
              </span>
            </div>

            {pendingLoans.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 18 }}>
                {pendingLoans.map((loan) => (
                  <div key={loan.id} style={{
                    backgroundColor: T.card, borderRadius: 22, padding: 22,
                    border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 16
                  }}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <h4 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 17, fontWeight: 800, color: T.text, margin: 0 }}>
                            {loan.members?.first_name} {loan.members?.last_name}
                          </h4>
                          <span style={{ fontSize: 11, color: T.sub }}>Phone: {loan.members?.phone || 'N/A'}</span>
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 6, backgroundColor: 'rgba(249,115,22,0.1)', color: T.cMid }}>
                          Pending
                        </span>
                      </div>

                      <div style={{ backgroundColor: '#FCFAEE', borderRadius: 16, padding: '14px 16px', border: `1px solid ${T.border}`, marginTop: 14 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <span style={{ fontSize: 11, color: T.sub, textTransform: 'uppercase', fontWeight: 700 }}>Requested Principal</span>
                          <strong style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 18, color: T.cDeep, fontWeight: 900 }}>
                            {UGX(loan.principal)}
                          </strong>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.sub, marginTop: 8 }}>
                          <span>Duration: {loan.duration_months || 3} Months</span>
                          <span>Interest: {loan.interest_rate || 5}%</span>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                      <button
                        onClick={() => handleLoanAction(loan.id, 'rejected', loan.member_id, parseFloat(loan.principal))}
                        disabled={processingLoanId === loan.id}
                        style={{
                          padding: '10px', borderRadius: 12,
                          backgroundColor: '#FAF9F6', border: `1px solid ${T.border}`,
                          color: T.red, fontWeight: 800, fontSize: 13, cursor: 'pointer'
                        }}
                      >
                        Decline
                      </button>
                      <button
                        onClick={() => handleLoanAction(loan.id, 'approved', loan.member_id, parseFloat(loan.principal))}
                        disabled={processingLoanId === loan.id}
                        style={{
                          padding: '10px', borderRadius: 12,
                          backgroundColor: T.green, border: 'none',
                          color: 'white', fontWeight: 800, fontSize: 13, cursor: 'pointer',
                          boxShadow: `0 4px 12px ${T.green}30`
                        }}
                      >
                        {processingLoanId === loan.id ? 'Disbursing...' : 'Disburse Capital'}
                      </button>
                    </div>

                  </div>
                ))}
              </div>
            ) : (
              <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 48, textAlign: 'center', border: `1px solid ${T.border}` }}>
                <CheckCircle2 size={36} color={T.green} style={{ margin: '0 auto 12px' }} />
                <h4 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 18, fontWeight: 800, color: T.text, margin: 0 }}>
                  No Pending Loan Applications
                </h4>
                <p style={{ fontSize: 13, color: T.sub, marginTop: 4, margin: 0 }}>
                  All credit requests for this cooperative have been processed.
                </p>
              </div>
            )}

          </div>
        )}

        {/* ───────────────────────────────────────────────────────────
            TAB 5: SMS BROADCAST & COMMUNICATION
        ─────────────────────────────────────────────────────────── */}
        {activeTab === 'sms' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 24 }}>
            
            {/* SMS Compose Card */}
            <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 26, border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div>
                <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 18, fontWeight: 900, color: T.text, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Send size={20} color={T.cMid} />
                  <span>Cooperative SMS Broadcast</span>
                </h3>
                <p style={{ fontSize: 12, color: T.sub, marginTop: 4, margin: 0 }}>
                  Broadcast instant notifications, AGM reminders, and alerts directly to member phones.
                </p>
              </div>

              {/* Recipient Selection */}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 800, color: T.sub, textTransform: 'uppercase', marginBottom: 6 }}>
                  Target Audience
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {[
                    { id: 'all', label: `All Members (${members.length})` },
                    { id: 'single', label: 'Single Member' },
                    { id: 'custom', label: 'Custom Numbers' },
                  ].map((target) => (
                    <button
                      key={target.id}
                      onClick={() => setSmsRecipientType(target.id as any)}
                      style={{
                        padding: '8px 10px', borderRadius: 10,
                        backgroundColor: smsRecipientType === target.id ? T.cDeep : '#FAF9F6',
                        color: smsRecipientType === target.id ? 'white' : T.text,
                        border: `1px solid ${smsRecipientType === target.id ? T.cDeep : T.border}`,
                        fontSize: 11, fontWeight: 800, cursor: 'pointer'
                      }}
                    >
                      {target.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Conditional Phone Input */}
              {smsRecipientType === 'single' && (
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 800, color: T.sub, textTransform: 'uppercase', marginBottom: 6 }}>
                    Recipient Phone Number
                  </label>
                  <input
                    type="tel"
                    placeholder="e.g. 0772000111"
                    value={singleRecipientPhone}
                    onChange={(e) => setSingleRecipientPhone(e.target.value)}
                    style={{
                      width: '100%', padding: '10px 14px', borderRadius: 12,
                      border: `1px solid ${T.border}`, fontSize: 13, outline: 'none'
                    }}
                  />
                </div>
              )}

              {smsRecipientType === 'custom' && (
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 800, color: T.sub, textTransform: 'uppercase', marginBottom: 6 }}>
                    Comma-separated Phone Numbers
                  </label>
                  <textarea
                    rows={2}
                    placeholder="0772000111, 0702000222, 0755000333"
                    value={customPhoneList}
                    onChange={(e) => setCustomPhoneList(e.target.value)}
                    style={{
                      width: '100%', padding: '10px 14px', borderRadius: 12,
                      border: `1px solid ${T.border}`, fontSize: 13, outline: 'none'
                    }}
                  />
                </div>
              )}

              {/* Message Content */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label style={{ fontSize: 11, fontWeight: 800, color: T.sub, textTransform: 'uppercase' }}>
                    SMS Message Text
                  </label>
                  <span style={{ fontSize: 10, color: smsMessageText.length > 160 ? T.cMid : T.ghost }}>
                    {smsMessageText.length}/160 chars ({Math.ceil(smsMessageText.length / 160) || 1} SMS unit)
                  </span>
                </div>
                <textarea
                  rows={4}
                  placeholder={`Hello from ${saccoName}, please be reminded of our upcoming cooperative meeting...`}
                  value={smsMessageText}
                  onChange={(e) => setSmsMessageText(e.target.value)}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 14,
                    border: `1px solid ${T.border}`, fontSize: 13, outline: 'none', lineHeight: 1.5
                  }}
                />
              </div>

              {/* Dispatch Button */}
              <button
                onClick={handleSendBroadcast}
                disabled={isSendingSms || !smsMessageText.trim()}
                style={{
                  padding: '13px', borderRadius: 14,
                  background: `linear-gradient(135deg, ${T.cDeep} 0%, ${T.cRich} 100%)`,
                  color: 'white', border: 'none', fontWeight: 800, fontSize: 14, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  boxShadow: `0 6px 18px ${T.cDeep}25`
                }}
              >
                {isSendingSms ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                <span>Send Broadcast Alert</span>
              </button>
            </div>

            {/* SMS Wallet & Top up Packages */}
            <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 26, border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 18, fontWeight: 900, color: T.text, margin: 0 }}>
                    SMS Credit Packages
                  </h3>
                  <p style={{ fontSize: 12, color: T.sub, marginTop: 4, margin: 0 }}>Instant Mobile Money replenishment</p>
                </div>
                <span style={{ fontSize: 14, fontWeight: 900, color: T.cDeep, backgroundColor: '#FCFAEE', padding: '6px 12px', borderRadius: 12, border: `1px solid ${T.border}` }}>
                  {smsBalance.toLocaleString()} Credits
                </span>
              </div>

              {/* Bundle Cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  { credits: 200, price: 10000, tag: 'Starter' },
                  { credits: 500, price: 25000, tag: 'Popular' },
                  { credits: 1200, price: 50000, tag: 'Value' },
                  { credits: 3000, price: 100000, tag: 'Corporate' },
                ].map((pack) => (
                  <div
                    key={pack.credits}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '14px 16px', borderRadius: 16, backgroundColor: '#FAF9F6',
                      border: `1px solid ${T.border}`
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong style={{ fontSize: 15, color: T.text }}>{pack.credits.toLocaleString()} SMS Credits</strong>
                        <span style={{ fontSize: 10, fontWeight: 800, color: T.cMid, backgroundColor: 'rgba(249,115,22,0.1)', padding: '1px 6px', borderRadius: 6 }}>
                          {pack.tag}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: T.sub }}>Cost: {UGX(pack.price)} &bull; 50 UGX/credit</div>
                    </div>

                    <button
                      onClick={() => {
                        setSelectedPack(pack);
                        setShowBuyModal(true);
                      }}
                      style={{
                        padding: '8px 14px', borderRadius: 10,
                        backgroundColor: T.green, color: 'white',
                        border: 'none', fontWeight: 800, fontSize: 12, cursor: 'pointer'
                      }}
                    >
                      Top up
                    </button>
                  </div>
                ))}
              </div>

              {/* Recent SMS History Log */}
              <div style={{ marginTop: 8, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: T.sub, textTransform: 'uppercase' }}>
                  Recent Sent Broadcasts ({smsHistory.length})
                </span>
                <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                  {smsHistory.slice(0, 5).map((log) => (
                    <div key={log.id} style={{ fontSize: 12, padding: '8px 10px', borderRadius: 10, backgroundColor: '#FCFAEE', border: `1px solid ${T.border}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: T.ghost, fontSize: 10 }}>
                        <span>To: {log.recipients}</span>
                        <span>{new Date(log.date).toLocaleDateString()}</span>
                      </div>
                      <div style={{ color: T.text, marginTop: 2, fontWeight: 600 }}>{log.text}</div>
                    </div>
                  ))}
                </div>
              </div>

            </div>

          </div>
        )}

        {/* ───────────────────────────────────────────────────────────
            TAB 6: TENANT CONFIGURATION & API KEYS
        ─────────────────────────────────────────────────────────── */}
        {activeTab === 'tenant' && (
          <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 32, border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div>
              <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 20, fontWeight: 900, color: T.text, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                <Shield size={24} color={T.cMid} />
                <span>Tenant Isolation & Cooperative Settings</span>
              </h3>
              <p style={{ fontSize: 13, color: T.sub, marginTop: 4, margin: 0 }}>
                Technical identifiers, database schema partitioning, and cryptographic API tokens.
              </p>
            </div>

            <div style={{ backgroundColor: '#FCFAEE', borderRadius: 16, padding: '20px 24px', border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 800 }}>Member Join Link</span>
                <p style={{ fontSize: 13, color: T.sub, margin: '4px 0 0' }}>
                  Send this link to members. Anyone who signs up with it joins your SACCO and waits for your approval.
                  Regenerating it stops the old link from working. Members already registered are not affected.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <code style={{ flex: 1, minWidth: 240, padding: '10px 14px', borderRadius: 12, background: '#fff', border: `1px solid ${T.border}`, fontSize: 13, color: T.text, wordBreak: 'break-all' }}>
                  {joinLink || (joinCodeBusy ? 'Loading…' : 'Not available')}
                </code>
                <button onClick={copyJoinLink} disabled={!joinLink || joinCodeBusy} style={{ padding: '10px 16px', borderRadius: 12, border: 'none', background: T.cMid, color: '#fff', fontWeight: 800, cursor: joinLink ? 'pointer' : 'not-allowed', opacity: joinLink ? 1 : 0.5 }}>
                  Copy link
                </button>
                <button onClick={() => {
                  if (window.confirm('Create a new join link? The current link will stop working immediately.')) {
                    loadJoinCode('regenerate');
                  }
                }} disabled={!joinLink || joinCodeBusy} style={{ padding: '10px 16px', borderRadius: 12, border: `1px solid ${T.border}`, background: '#fff', color: T.text, fontWeight: 800, cursor: joinLink ? 'pointer' : 'not-allowed' }}>
                  Regenerate
                </button>
              </div>
              {joinCode && <span style={{ fontSize: 11, color: T.ghost }}>Join code: {joinCode}</span>}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
              
              <div style={{ backgroundColor: '#FCFAEE', borderRadius: 16, padding: '16px 20px', border: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 800 }}>Tenant Name</span>
                <div style={{ fontSize: 16, fontWeight: 900, color: T.text, marginTop: 4 }}>{saccoName}</div>
                <span style={{ fontSize: 11, color: T.sub, marginTop: 2 }}>Organization ID: {orgId}</span>
              </div>

              <div style={{ backgroundColor: '#FCFAEE', borderRadius: 16, padding: '16px 20px', border: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 800 }}>Tenant Code</span>
                <div style={{ fontSize: 16, fontWeight: 900, color: T.cDeep, marginTop: 4 }}>{tenantCode}</div>
                <span style={{ fontSize: 11, color: T.sub, marginTop: 2 }}>Scoped database prefix</span>
              </div>

              <div style={{ backgroundColor: '#FCFAEE', borderRadius: 16, padding: '16px 20px', border: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 800 }}>Currency Standard</span>
                <div style={{ fontSize: 16, fontWeight: 900, color: T.text, marginTop: 4 }}>UGX (Ugandan Shillings)</div>
                <span style={{ fontSize: 11, color: T.green, marginTop: 2 }}>Mobile money integrated</span>
              </div>

            </div>

            {/* API Key Box */}
            <div style={{ backgroundColor: '#FAF9F6', borderRadius: 18, padding: 22, border: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: T.sub, textTransform: 'uppercase' }}>
                Tenant Application API Secret Key
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <input
                  type="text"
                  readOnly
                  value={apiKey || ""}
                  style={{
                    flex: 1, padding: '12px 16px', borderRadius: 12,
                    backgroundColor: 'white', border: `1px solid ${T.border}`,
                    fontFamily: 'monospace', fontSize: 13, color: T.text
                  }}
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(apiKey || "");
                    setToastMessage({ type: 'success', text: 'API Key copied to clipboard!' });
                  }}
                  style={{
                    padding: '12px 18px', borderRadius: 12,
                    backgroundColor: T.cDeep, color: 'white',
                    border: 'none', fontWeight: 800, fontSize: 13, cursor: 'pointer'
                  }}
                >
                  Copy Key
                </button>
              </div>
              <p style={{ fontSize: 11, color: T.ghost, marginTop: 8, margin: 0 }}>
                Use this API key for integrating external core-banking webhooks or automated SMS dispatch gateways.
              </p>
            </div>

          </div>
        )}

      {/* ─────────────────────────────────────────────────────────────
          MODAL: MEMBER FULL DOSSIER
      ───────────────────────────────────────────────────────────── */}
      {selectedMemberModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(28,25,23,0.75)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 100, padding: 16
        }}>
          <div style={{
            backgroundColor: 'white', borderRadius: 28, width: '100%', maxWidth: 520,
            boxShadow: '0 24px 60px rgba(0,0,0,0.3)', overflow: 'hidden', border: `1px solid ${T.border}`
          }}>
            {/* Modal Header */}
            <div style={{
              background: `linear-gradient(135deg, ${T.cDeep} 0%, ${T.cRich} 100%)`,
              padding: '24px 28px', color: 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <div>
                <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800, color: T.goldLt }}>
                  Member Compliance Dossier
                </span>
                <h3 style={{ fontWeight: 900, fontSize: 20, margin: '4px 0 0', color: 'white' }}>
                  {selectedMemberModal.first_name} {selectedMemberModal.last_name}
                </h3>
              </div>
              <button
                onClick={() => setSelectedMemberModal(null)}
                style={{
                  width: 32, height: 32, borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.2)',
                  border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800
                }}
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 18 }}>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ backgroundColor: '#FCFAEE', borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>Phone</span>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>{selectedMemberModal.phone || 'N/A'}</div>
                </div>
                <div style={{ backgroundColor: '#FCFAEE', borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>Email</span>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>{selectedMemberModal.email || 'N/A'}</div>
                </div>
                <div style={{ backgroundColor: '#FCFAEE', borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>National ID (NIN)</span>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>{selectedMemberModal.national_id || 'Not specified'}</div>
                </div>
                <div style={{ backgroundColor: '#FCFAEE', borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>Date of Birth</span>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>{selectedMemberModal.date_of_birth || 'N/A'}</div>
                </div>
              </div>

              <div style={{ backgroundColor: '#FCFAEE', borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>Next of Kin</span>
                <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>
                  {selectedMemberModal.next_of_kin_name || 'None'} {selectedMemberModal.next_of_kin_phone ? `(${selectedMemberModal.next_of_kin_phone})` : ''}
                </div>
              </div>

              <div style={{ backgroundColor: '#FAF9F6', borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>Current Status</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <span style={{
                    padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 800,
                    backgroundColor: selectedMemberModal.status === 'active' ? `${T.green}20` : 'rgba(249,115,22,0.2)',
                    color: selectedMemberModal.status === 'active' ? T.green : T.cMid
                  }}>
                    {selectedMemberModal.status || 'Pending'}
                  </span>
                </div>
              </div>

              {/* Action Buttons in Modal */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                {selectedMemberModal.status !== 'active' ? (
                  <button
                    onClick={() => handleMemberAction(selectedMemberModal.id, 'approve')}
                    disabled={processingMemberId === selectedMemberModal.id}
                    style={{
                      padding: '12px', borderRadius: 14,
                      backgroundColor: T.green, color: 'white',
                      border: 'none', fontWeight: 800, fontSize: 13, cursor: 'pointer'
                    }}
                  >
                    {processingMemberId === selectedMemberModal.id ? 'Approving...' : 'Approve & Activate'}
                  </button>
                ) : (
                  <button
                    onClick={() => handleMemberAction(selectedMemberModal.id, 'suspend')}
                    disabled={processingMemberId === selectedMemberModal.id}
                    style={{
                      padding: '12px', borderRadius: 14,
                      backgroundColor: T.redLt, color: T.red,
                      border: `1px solid ${T.red}25`, fontWeight: 800, fontSize: 13, cursor: 'pointer'
                    }}
                  >
                    Suspend Member
                  </button>
                )}

                <button
                  onClick={() => setSelectedMemberModal(null)}
                  style={{
                    padding: '12px', borderRadius: 14,
                    backgroundColor: '#FAF9F6', border: `1px solid ${T.border}`,
                    color: T.text, fontWeight: 700, fontSize: 13, cursor: 'pointer'
                  }}
                >
                  Close Dossier
                </button>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          MODAL: MOBILE MONEY SMS TOPUP
      ───────────────────────────────────────────────────────────── */}
      {showBuyModal && selectedPack && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(28,25,23,0.75)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 100, padding: 16
        }}>
          <div style={{
            backgroundColor: 'white', borderRadius: 28, width: '100%', maxWidth: 440,
            boxShadow: '0 24px 60px rgba(0,0,0,0.3)', overflow: 'hidden', border: `1px solid ${T.border}`
          }}>
            <div style={{
              background: `linear-gradient(135deg, ${T.cDeep} 0%, ${T.cRich} 100%)`,
              padding: '24px 28px', color: 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <div>
                <h4 style={{ fontWeight: 800, fontSize: 16, margin: 0 }}>Mobile Money SMS Checkout</h4>
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2, margin: 0 }}>MTN MoMo & Airtel Money Authorized</p>
              </div>
              <button
                onClick={() => {
                  if (!isProcessingBuy) {
                    setShowBuyModal(false);
                    setSelectedPack(null);
                  }
                }}
                style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: 'white', width: 32, height: 32, borderRadius: '50%', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ backgroundColor: '#FCFAEE', borderRadius: 16, padding: 18, border: `1px solid ${T.border}`, textAlign: 'center' }}>
                <span style={{ fontSize: 11, color: T.sub, fontWeight: 700, textTransform: 'uppercase' }}>Selected Bundle</span>
                <div style={{ fontSize: 30, fontWeight: 900, color: T.cDeep, marginTop: 4 }}>
                  {selectedPack.credits.toLocaleString()} SMS Credits
                </div>
                <div style={{ marginTop: 6, fontSize: 14, fontWeight: 800, color: T.gold }}>
                  Total: {UGX(selectedPack.price)}
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 800, color: T.sub, textTransform: 'uppercase', marginBottom: 6 }}>
                  Mobile Money Phone Number
                </label>
                <input
                  type="tel"
                  placeholder="0772000111 / 0702000111"
                  value={momoNumber}
                  onChange={(e) => setMomoNumber(e.target.value)}
                  disabled={isProcessingBuy}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: 12,
                    border: `1px solid ${T.border}`, fontSize: 14, outline: 'none'
                  }}
                />
              </div>

              <button
                onClick={handleBuySms}
                disabled={isProcessingBuy || !momoNumber.trim()}
                style={{
                  padding: '14px', borderRadius: 14,
                  backgroundColor: T.green, color: 'white', border: 'none',
                  fontWeight: 800, fontSize: 14, cursor: isProcessingBuy ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  boxShadow: `0 6px 18px ${T.green}30`
                }}
              >
                {isProcessingBuy ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    <span>Processing PIN prompt on SIM...</span>
                  </>
                ) : (
                  <span>Authorize UGX {selectedPack.price.toLocaleString()}</span>
                )}
              </button>

              <p style={{ fontSize: 11, color: T.ghost, textAlign: 'center', margin: 0 }}>
                You will receive a mobile prompt asking for your PIN to confirm payment.
              </p>
            </div>
          </div>
        </div>
      )}

      </div>

      {/* Floating Bottom Navigation Bar (Identical to Member Portal) */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        padding: "8px 16px 16px",
        background: `linear-gradient(to top, ${T.bg} 85%, transparent)`,
        display: "flex", justifyContent: "center",
        zIndex: 50, pointerEvents: 'none'
      }}>
        <div style={{
          pointerEvents: 'auto',
          width: "100%", background: T.navBg, borderRadius: 26,
          display: "flex", padding: "8px",
          boxShadow: `0 10px 40px ${T.cDeep}80, 0 4px 12px ${T.cDeep}50`,
          border: `1px solid rgba(255,255,255,0.08)`,
        }}>
          {[
            { key: "overview",  label: "Overview",  Icon: TrendingUp, route: "/admin" },
            { key: "approvals", label: "Approvals", Icon: UserCheck, badge: pendingMembersList.length, route: "/admin/approvals" },
            { key: "members",   label: "Members",   Icon: Users, badge: members.length, route: "/admin/members" },
            { key: "loans",     label: "Loans",     Icon: CreditCard, badge: pendingLoans.length, route: "/admin/loans" },
            { key: "sms",       label: "SMS",       Icon: Send, route: "/admin/sms" },
            { key: "tenant",    label: "Settings",  Icon: Shield, route: "/admin/settings" },
          ].map(({ key, label, Icon, badge, route }) => {
            const on = activeTab === key;
            return (
              <button key={key} onClick={() => {
                setActiveTab(key as any);
                window.history.pushState(null, '', route);
              }} style={{
                flex: 1, background: "none", border: "none", cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center",
                gap: 4, padding: "8px 0", position: "relative"
              }}>
                <div style={{
                  width: on ? 50 : 34, height: 36, borderRadius: on ? 14 : "50%",
                  background: on ? T.navAct : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all 0.25s cubic-bezier(0.4,0,0.2,1)",
                  boxShadow: on ? `0 6px 18px ${T.navAct}70` : "none",
                  position: 'relative'
                }}>
                  <Icon size={20} color={on ? "white" : "rgba(255,255,255,0.35)"} />
                  {badge !== undefined && badge > 0 && (
                    <span style={{
                      position: 'absolute', top: -3, right: -4,
                      backgroundColor: '#EF4444', color: 'white',
                      fontSize: 9, fontWeight: 900, borderRadius: 99,
                      padding: '1px 5px', minWidth: 16, height: 16,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: '1.5px solid #7C2D12'
                    }}>
                      {badge}
                    </span>
                  )}
                </div>
                <span style={{
                  fontSize: 10, fontWeight: on ? 700 : 400,
                  color: on ? "white" : "rgba(255,255,255,0.35)",
                  transition: "all 0.2s ease",
                  whiteSpace: 'nowrap'
                }}>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

    </div>
  );
}
