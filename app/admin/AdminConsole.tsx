'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import {
  Users, Send, Shield, RefreshCw, LogOut,
  CheckCircle2, Search, Eye, EyeOff, TrendingUp, ChevronRight,
  UserCheck, Clock, Coins, ArrowRight, MessageSquare, Loader2,
  Phone, DoorOpen, Landmark, Wallet, Banknote, XCircle
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts';

/* ────────────────────────────────────────────────────────────────────────────
   COMMUNITY DESK DESIGN LANGUAGE
   A warm, tactile, hand-tended ledger. Paper, ink, stamps and soft edges —
   built to feel like someone made it, not something that generated it.
──────────────────────────────────────────────────────────────────────────── */
const T = {
  paper:    "#F6F0E5",
  sheet:    "#FFFDF8",
  sheetWarm:"#FBF4E6",
  ink:      "#2A2118",
  inkSoft:  "#7A6F5E",
  inkGhost: "#ABA094",
  line:     "#E9DFCB",
  lineDark: "#DCCFB4",
  forest:   "#2F6B4F",
  forestDk: "#24553E",
  forestLt: "#E3F0E7",
  ember:    "#C2501E",
  emberLt:  "#FAEADC",
  gold:     "#B07E1B",
  goldLt:   "#F8EED3",
  rust:     "#B3402F",
  rustLt:   "#F8E6E2",
  sky:      "#41648A",
  skyLt:    "#E9EFF6",
  navBg:    "#33261B",
  navAct:   "#E8912D",
};

/* ── Formatting helpers ─────────────────────────────────────────────────── */
const UGX = (n: number | string) => `UGX ${Number(n || 0).toLocaleString("en-UG")}`;
const UGXShort = (n: number | string) => {
  const num = Number(n || 0);
  if (num >= 1_000_000) return `UGX ${(num / 1_000_000).toFixed(num % 1_000_000 === 0 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (num >= 100_000) return `UGX ${Math.round(num / 1_000)}K`;
  return UGX(num);
};

const timeAgo = (iso?: string | null) => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(iso).toLocaleDateString('en-UG', { day: 'numeric', month: 'short' });
};

const fullName = (m: any) => `${m?.first_name || ''} ${m?.last_name || ''}`.trim() || 'Unnamed member';

/* Warm duotone avatar, picked deterministically from the name */
const AVATAR_TONES: [string, string][] = [
  ["#FBE9D9", "#8C4A1D"],
  ["#E3F0E7", "#2F6B4F"],
  ["#F8EED3", "#8A6413"],
  ["#EDE4F4", "#5E3D8C"],
  ["#E9EFF6", "#41648A"],
  ["#F8E6E2", "#8C3226"],
];
const avatarTone = (seed: string) => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
};

function Avatar({ name, size = 44, radius = 14 }: { name: string; size?: number; radius?: number }) {
  const [bg, fg] = avatarTone(name);
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'M';
  return (
    <div style={{
      width: size, height: size, borderRadius: radius, flexShrink: 0,
      backgroundColor: bg, color: fg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 800, fontSize: size * 0.34, letterSpacing: '0.02em',
      fontFamily: 'var(--font-display), sans-serif',
      border: `1.5px solid ${fg}18`,
    }}>
      {initials}
    </div>
  );
}

/* Paper sheet card — soft ink edge, gentle offset shadow */
function Sheet({ children, style = {}, ...rest }: any) {
  return (
    <div style={{
      backgroundColor: T.sheet,
      borderRadius: 18,
      border: `1.5px solid ${T.line}`,
      boxShadow: '3px 4px 0 rgba(42,33,24,0.05)',
      ...style,
    }} {...rest}>
      {children}
    </div>
  );
}

/* Ink-stamp chip, slightly rotated like a real rubber stamp */
function Stamp({ label, tone = 'forest', rotate = -2 }: { label: string; tone?: 'forest' | 'ember' | 'gold' | 'rust' | 'sky' | 'ghost'; rotate?: number }) {
  const tones: Record<string, [string, string]> = {
    forest: [T.forestLt, T.forestDk],
    ember:  [T.emberLt, T.ember],
    gold:   [T.goldLt, T.gold],
    rust:   [T.rustLt, T.rust],
    sky:    [T.skyLt, T.sky],
    ghost:  ['#F1ECE2', T.inkGhost],
  };
  const [bg, fg] = tones[tone] || tones.ghost;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      transform: `rotate(${rotate}deg)`,
      backgroundColor: bg, color: fg,
      border: `2px dashed ${fg}55`,
      borderRadius: 8, padding: '2px 9px',
      fontSize: 10.5, fontWeight: 900, letterSpacing: '0.07em', textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

function MicroLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase',
      letterSpacing: '0.09em', color: T.inkGhost,
    }}>
      {children}
    </span>
  );
}

/* Hand-drawn squiggle under a heading */
function Squiggle({ color = T.gold, width = 74 }: { color?: string; width?: number }) {
  return (
    <svg width={width} height="7" viewBox="0 0 74 7" fill="none" style={{ display: 'block', marginTop: 3 }}>
      <path d="M2 4.5C10 2 16 6 24 4.2C32 2.4 38 6 46 4.4C54 2.8 60 5.8 72 3.4" stroke={color} strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

function Btn({ children, onClick, disabled, variant = 'primary', small, style = {}, title }: any) {
  const styles: Record<string, React.CSSProperties> = {
    primary: { backgroundColor: T.forest, color: '#fff', border: 'none', boxShadow: `0 3px 0 ${T.forestDk}` },
    ember:   { backgroundColor: T.ember, color: '#fff', border: 'none', boxShadow: `0 3px 0 #93390F` },
    danger:  { backgroundColor: T.rustLt, color: T.rust, border: `1.5px solid ${T.rust}30`, boxShadow: 'none' },
    ghost:   { backgroundColor: 'transparent', color: T.inkSoft, border: `1.5px solid ${T.line}`, boxShadow: 'none' },
    paper:   { backgroundColor: T.sheetWarm, color: T.ink, border: `1.5px solid ${T.line}`, boxShadow: 'none' },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: small ? '7px 13px' : '10px 18px',
        borderRadius: 12, fontWeight: 800, fontSize: small ? 12.5 : 13.5,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transition: 'transform 0.06s ease, box-shadow 0.06s ease',
        fontFamily: 'inherit',
        ...styles[variant as string],
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function IconBtn({ children, onClick, title }: any) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 40, height: 40, borderRadius: 12,
        backgroundColor: T.sheet, border: `1.5px solid ${T.line}`, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '2px 3px 0 rgba(42,33,24,0.05)',
      }}
    >
      {children}
    </button>
  );
}

const memberBalance = (m: any) =>
  (m.accounts || []).reduce((sum: number, a: any) => sum + parseFloat(a.cached_balance || '0'), 0) || 0;

const isPendingMember = (m: any) => m.status === 'pending' || m.status === 'pending_approval' || !m.status;

const statusStamp = (m: any) => {
  if (m.status === 'active') return <Stamp label="Inside" tone="forest" />;
  if (m.status === 'suspended') return <Stamp label="Paused" tone="rust" />;
  if (m.status === 'rejected') return <Stamp label="Declined" tone="rust" />;
  return <Stamp label="Waiting" tone="gold" />;
};

/* ══════════════════════════════════════════════════════════════════════════
   THE ADMIN CONSOLE
══════════════════════════════════════════════════════════════════════════ */
export default function AdminConsole({ initialTab = 'overview' }: { initialTab?: 'overview' | 'approvals' | 'members' | 'loans' | 'sms' | 'tenant' }) {
  const router = useRouter();

  // ── Core state (unchanged data contract with /api/admin/*) ──────────────
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sessionUser, setSessionUser] = useState<any>(null);
  const [adminProfile, setAdminProfile] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'approvals' | 'members' | 'loans' | 'sms' | 'tenant'>(initialTab);

  useEffect(() => { setActiveTab(initialTab); }, [initialTab]);

  const [saccoName, setSaccoName] = useState('K-Unity SACCO');
  const [tenantCode, setTenantCode] = useState('k-unity-sac');
  const [orgId, setOrgId] = useState('');
  const [apiKey, setApiKey] = useState('');

  const [stats, setStats] = useState({
    totalMembers: 0, activeMembers: 0, pendingMembers: 0, suspendedMembers: 0, rejectedMembers: 0,
    totalLiquidity: 0, avgSavingsPerMember: 0,
    totalLoansRequestedAmount: 0, totalLoansDisbursedAmount: 0, pendingLoansAmount: 0,
    pendingLoansCount: 0, activeLoansCount: 0, completedLoansCount: 0, totalLoansCount: 0,
    saccoWalletBalance: 0, totalDepositsVolume: 0,
  });

  const [members, setMembers] = useState<any[]>([]);
  const [pendingLoans, setPendingLoans] = useState<any[]>([]);
  const [allLoans, setAllLoans] = useState<any[]>([]);
  const [recentTransactions, setRecentTransactions] = useState<any[]>([]);
  const [smsBalance, setSmsBalance] = useState(0);
  const [smsRate, setSmsRate] = useState(50);
  const [smsHistory, setSmsHistory] = useState<any[]>([]);

  // UI controls
  const [hideBalances, setHideBalances] = useState(false);
  const [searchMemberQuery, setSearchMemberQuery] = useState('');
  const [memberStatusFilter, setMemberStatusFilter] = useState<'all' | 'active' | 'pending' | 'suspended'>('all');
  const [selectedMemberModal, setSelectedMemberModal] = useState<any>(null);
  const [processingMemberId, setProcessingMemberId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  // SMS broadcast
  const [smsRecipientType, setSmsRecipientType] = useState<'all' | 'single' | 'custom'>('all');
  const [singleRecipientPhone, setSingleRecipientPhone] = useState('');
  const [customPhoneList, setCustomPhoneList] = useState('');
  const [smsMessageText, setSmsMessageText] = useState('');
  const [isSendingSms, setIsSendingSms] = useState(false);

  // Buy SMS
  const [showBuyModal, setShowBuyModal] = useState(false);
  const [selectedPack, setSelectedPack] = useState<any>(null);
  const [momoNumber, setMomoNumber] = useState('');
  const [isProcessingBuy, setIsProcessingBuy] = useState(false);

  // Loan underwriting
  const [processingLoanId, setProcessingLoanId] = useState<string | null>(null);

  // Toast auto-clear
  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 4500);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const todayLine = useMemo(
    () => new Date().toLocaleDateString('en-UG', { weekday: 'long', day: 'numeric', month: 'long' }),
    []
  );

  const adminFirstName = useMemo(() => {
    const raw = adminProfile?.full_name || sessionUser?.email?.split('@')[0] || '';
    return raw.split(' ')[0] || 'Admin';
  }, [adminProfile, sessionUser]);

  /* ── Data loading ─────────────────────────────────────────────────────── */
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
        body: JSON.stringify({ token: session.access_token })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setOrgId(data.orgId);
        setSaccoName(data.saccoName || 'K-Unity SACCO');
        setTenantCode(data.tenantCode || 'kunity');
        setApiKey(data.apiKey || '');
        setStats(data.stats || {});
        setMembers(data.members || []);
        setPendingLoans(data.pendingLoans || []);
        setAllLoans(data.allLoans || []);
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

  /* ── Actions (same API contracts as before) ───────────────────────────── */
  const handleMemberAction = async (memberId: string, action: 'approve' | 'reject' | 'suspend' | 'set_pending') => {
    try {
      setProcessingMemberId(memberId);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const res = await fetch('/api/admin/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.access_token, memberId, action, organizationId: orgId })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setToastMessage({ type: 'success', text: data.message });
        if (selectedMemberModal?.id === memberId) {
          setSelectedMemberModal((prev: any) => prev ? { ...prev, status: action === 'approve' ? 'active' : action === 'reject' ? 'rejected' : action === 'suspend' ? 'suspended' : 'pending' } : null);
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

  /* Letting someone in — with a soft guard when the fee has not landed yet */
  const approveApplicant = (m: any) => {
    if (!m.activation_payment) {
      const ok = typeof window === 'undefined'
        ? true
        : window.confirm(
            `${fullName(m)} has not paid the activation fee yet.\n\nLet them in anyway? (Their membership will activate without a recorded fee payment.)`
          );
      if (!ok) return;
    }
    handleMemberAction(m.id, 'approve');
  };

  const handleLoanAction = async (loanId: string, status: 'approved' | 'rejected', memberId: string, amount: number) => {
    try {
      setProcessingLoanId(loanId);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const res = await fetch('/api/admin/loans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.access_token, loanId, status, memberId, amount, organizationId: orgId })
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

  const handleSendBroadcast = async () => {
    if (!smsMessageText.trim()) {
      setToastMessage({ type: 'error', text: 'Write the message first — even a short one will do.' });
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
          setToastMessage({ type: 'error', text: 'Enter the phone number first.' });
          setIsSendingSms(false);
          return;
        }
        recipients = [singleRecipientPhone.trim()];
      } else {
        recipients = customPhoneList.split(/[\n,]+/).map(p => p.trim()).filter(Boolean);
      }

      if (recipients.length === 0) {
        setToastMessage({ type: 'error', text: 'No phone numbers to send to.' });
        setIsSendingSms(false);
        return;
      }

      const res = await fetch('/api/admin/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.access_token, recipients, message: smsMessageText, organizationId: orgId })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setToastMessage({ type: 'success', text: `On its way to ${recipients.length} phone${recipients.length > 1 ? 's' : ''}!` });
        setSmsMessageText('');
        await fetchAdminData();
      } else {
        setToastMessage({ type: 'error', text: data.error || 'Failed to send SMS' });
      }
    } catch (err: any) {
      setToastMessage({ type: 'error', text: err.message });
    } finally {
      setIsSendingSms(false);
    }
  };

  const handleBuySms = async () => {
    if (!momoNumber.trim() || !selectedPack) {
      setToastMessage({ type: 'error', text: 'Type the Mobile Money number to pay with.' });
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
        setToastMessage({ type: 'success', text: 'Check your phone — enter your PIN to finish the payment.' });
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

  /* ── Derived collections ──────────────────────────────────────────────── */
  const pendingMembersList = useMemo(
    () => members.filter(isPendingMember),
    [members]
  );

  // Applicants who have PAID the activation fee — longest waiting first
  const paidApplicants = useMemo(() =>
    pendingMembersList
      .filter(m => m.activation_payment)
      .sort((a, b) => new Date(a.activation_payment.paid_at || 0).getTime() - new Date(b.activation_payment.paid_at || 0).getTime()),
    [pendingMembersList]
  );

  // Applicants who have applied but not yet settled the fee
  const unpaidApplicants = useMemo(
    () => pendingMembersList.filter(m => !m.activation_payment),
    [pendingMembersList]
  );

  const filteredMembers = useMemo(() => {
    return members.filter(m => {
      const name = fullName(m).toLowerCase();
      const phone = (m.phone || '').toLowerCase();
      const email = (m.email || '').toLowerCase();
      const query = searchMemberQuery.toLowerCase();
      const matchesQuery = name.includes(query) || phone.includes(query) || email.includes(query);
      if (!matchesQuery) return false;
      if (memberStatusFilter === 'all') return true;
      if (memberStatusFilter === 'active') return m.status === 'active';
      if (memberStatusFilter === 'pending') return isPendingMember(m);
      if (memberStatusFilter === 'suspended') return m.status === 'suspended';
      return true;
    });
  }, [members, searchMemberQuery, memberStatusFilter]);

  const attentionCount = paidApplicants.length + pendingLoans.length + unpaidApplicants.length;

  // The one-sentence human summary for the greeting block
  const deskSummary = useMemo(() => {
    const parts: string[] = [];
    if (paidApplicants.length > 0) {
      parts.push(`${paidApplicants.length} ${paidApplicants.length === 1 ? 'person has' : 'people have'} paid and ${paidApplicants.length === 1 ? 'is' : 'are'} waiting at the door`);
    }
    if (pendingLoans.length > 0) {
      parts.push(`${pendingLoans.length} loan${pendingLoans.length === 1 ? '' : 's'} need${pendingLoans.length === 1 ? 's' : ''} your decision`);
    }
    if (unpaidApplicants.length > 0) {
      parts.push(`${unpaidApplicants.length} applied but ${unpaidApplicants.length === 1 ? 'hasn’t' : 'haven’t'} paid yet`);
    }
    if (parts.length === 0) return 'Nothing is waiting on you — the books are balanced and everyone’s in.';
    if (parts.length === 1) return parts[0] + '.';
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] + '.';
  }, [paidApplicants, pendingLoans, unpaidApplicants]);

  // Honest projection chart (clearly labelled as an estimate)
  const trendData = useMemo(() => {
    const months = ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];
    const baseSavings = Math.max((stats.totalLiquidity || 5000000) * 0.12, 400000);
    const baseDisbursed = Math.max((stats.totalLoansDisbursedAmount || 2000000) * 0.15, 200000);
    return months.map((m, idx) => {
      const mult = 0.85 + (idx * 0.12) + (idx % 2 === 0 ? 0.08 : -0.05);
      return {
        month: m,
        Savings: Math.round(baseSavings * mult),
        Lending: Math.round(baseDisbursed * mult * 0.75),
      };
    });
  }, [stats.totalLiquidity, stats.totalLoansDisbursedAmount]);

  const mask = (n: number | string) => (hideBalances ? 'UGX ••••••' : UGX(n));

  /* ── Shared sub-renderers ─────────────────────────────────────────────── */

  // A person waiting at the door (paid or not) — used on Home + Approvals
  const renderApplicantCard = (m: any, expanded: boolean) => {
    const name = fullName(m);
    const pay = m.activation_payment;
    return (
      <Sheet key={m.id} style={{ padding: '18px 18px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <Avatar name={name} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 900, fontSize: 16.5, color: T.ink, fontFamily: 'var(--font-display), sans-serif', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {name}
                {pay ? <Stamp label={`Paid ${UGXShort(pay.amount)}`} tone="forest" /> : <Stamp label="Not paid yet" tone="ghost" rotate={1.5} />}
              </div>
              <div style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 3 }}>
                Applied {timeAgo(m.created_at) || 'recently'}
                {pay ? ` · Paid ${timeAgo(pay.paid_at)}${pay.provider ? ` via ${pay.provider}` : ''}` : ' · Will show here once they pay'}
              </div>
            </div>
          </div>
        </div>

        {expanded && (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12,
            backgroundColor: T.sheetWarm, borderRadius: 14, border: `1px solid ${T.line}`,
            padding: '12px 14px', marginTop: 14,
          }}>
            <div>
              <MicroLabel>Phone</MicroLabel>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.ink, marginTop: 3 }}>{m.phone || '—'}</div>
            </div>
            <div>
              <MicroLabel>National ID</MicroLabel>
              <div style={{ fontSize: 13, fontWeight: 700, color: m.national_id ? T.ink : T.gold, marginTop: 3 }}>{m.national_id || 'Not captured'}</div>
            </div>
            <div>
              <MicroLabel>Next of kin</MicroLabel>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.ink, marginTop: 3 }}>
                {m.next_of_kin_name || '—'}{m.next_of_kin_phone ? ` (${m.next_of_kin_phone})` : ''}
              </div>
            </div>
            {pay?.reference && (
              <div>
                <MicroLabel>Payment ref</MicroLabel>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.inkSoft, marginTop: 3, fontFamily: 'monospace' }}>{pay.reference}</div>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 15, flexWrap: 'wrap' }}>
          <Btn
            variant="primary"
            onClick={() => approveApplicant(m)}
            disabled={processingMemberId === m.id}
            style={{ flex: 1, minWidth: 150 }}
          >
            {processingMemberId === m.id
              ? <><Loader2 size={15} className="animate-spin" /> Letting them in…</>
              : <><DoorOpen size={16} /> Let {m.first_name || 'them'} in ✓</>}
          </Btn>
          <Btn variant="paper" onClick={() => setSelectedMemberModal(m)}>Details</Btn>
          <Btn
            variant="danger"
            onClick={() => handleMemberAction(m.id, 'reject')}
            disabled={processingMemberId === m.id}
          >
            Decline
          </Btn>
        </div>
      </Sheet>
    );
  };

    const renderDeskRow = (m: any) => {
    const name = fullName(m);
    const pay = m.activation_payment;
    return (
      <div key={m.id} style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '11px 2px',
      }}>
        <Avatar name={name} size={38} radius={12} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: T.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 1 }}>
            {pay ? <>Paid {UGXShort(pay.amount)} {timeAgo(pay.paid_at)} — ready to enter</> : <>Applied {timeAgo(m.created_at)} — hasn’t paid yet</>}
          </div>
        </div>
        {pay ? (
          <Btn small variant="primary" onClick={() => approveApplicant(m)} disabled={processingMemberId === m.id}>
            {processingMemberId === m.id ? <Loader2 size={13} className="animate-spin" /> : 'Let in ✓'}
          </Btn>
        ) : (
          <Btn small variant="paper" onClick={() => setActiveTabAndRoute('approvals')}>Review</Btn>
        )}
      </div>
    );
  };

  const setActiveTabAndRoute = (tab: typeof activeTab, route?: string) => {
    setActiveTab(tab);
    const routes: Record<string, string> = {
      overview: '/admin', approvals: '/admin/approvals', members: '/admin/members',
      loans: '/admin/loans', sms: '/admin/sms', tenant: '/admin/settings',
    };
    window.history.pushState(null, '', route || routes[tab]);
  };

  const goToTab = (tab: typeof activeTab) => setActiveTabAndRoute(tab);

  /* ── Loading screen ───────────────────────────────────────────────────── */
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', backgroundColor: T.paper, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
        <div style={{
          width: 62, height: 62, borderRadius: 18, backgroundColor: T.sheet,
          border: `1.5px solid ${T.line}`, boxShadow: '3px 4px 0 rgba(42,33,24,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Landmark size={30} color={T.ember} className="animate-pulse" />
        </div>
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 800, fontSize: 17, color: T.ink, margin: 0 }}>
            Opening the front desk…
          </p>
          <p style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 5 }}>Counting the books and brewing the tea</p>
        </div>
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════════════
     SHELL
  ══════════════════════════════════════════════════════════════════ */
  return (
    <div style={{
      maxWidth: 620,
      margin: '0 auto',
      height: '100vh',
      position: 'relative',
      background: T.paper,
      display: 'flex',
      flexDirection: 'column',
      fontFamily: "var(--font-sans), -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif",
      overflow: 'hidden',
      WebkitFontSmoothing: 'antialiased',
      boxShadow: '0 0 0 1.5px ' + T.line,
    }}>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '22px 18px 120px' }}>

        {/* ── Masthead ─────────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 13, flexShrink: 0,
              backgroundColor: T.ember, color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 900, fontSize: 18, fontFamily: 'var(--font-display), sans-serif',
              boxShadow: '0 3px 0 #93390F',
            }}>
              {saccoName.charAt(0).toUpperCase()}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 900, fontSize: 15.5, color: T.ink, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {saccoName}
              </div>
              <div style={{ fontSize: 11.5, color: T.inkSoft, marginTop: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: T.forest }} />
                Front desk · {adminFirstName}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <IconBtn onClick={() => fetchAdminData()} title="Refresh">
              <RefreshCw size={16} color={T.inkSoft} className={refreshing ? 'animate-spin' : ''} />
            </IconBtn>
            <IconBtn
              onClick={async () => { await supabase.auth.signOut(); router.push('/auth'); }}
              title="Sign out"
            >
              <LogOut size={16} color={T.rust} />
            </IconBtn>
          </div>
        </div>

        {/* ════════════════════════════════════════════════════════════
            TAB: HOME
        ════════════════════════════════════════════════════════════ */}
        {activeTab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

            {/* Greeting */}
            <div>
              <div style={{ fontSize: 13, color: T.inkSoft }}>{todayLine}</div>
              <h1 style={{
                fontFamily: 'var(--font-display), sans-serif',
                fontSize: 27, fontWeight: 900, color: T.ink,
                letterSpacing: '-0.02em', lineHeight: 1.15, margin: '4px 0 0',
              }}>
                {greeting}, {adminFirstName}.
              </h1>
              <Squiggle />
              <p style={{ fontSize: 14, color: T.inkSoft, lineHeight: 1.55, margin: '12px 0 0', maxWidth: 440 }}>
                {deskSummary}
              </p>
            </div>

            {/* On your desk — the people waiting on you */}
            {attentionCount > 0 && (
              <Sheet style={{ padding: '16px 18px 8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <div>
                    <MicroLabel>On your desk</MicroLabel>
                    <Squiggle color={T.ember} width={58} />
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 800, color: T.ember }}>
                    {attentionCount} waiting
                  </span>
                </div>

                {paidApplicants.slice(0, 3).map(renderDeskRow)}

                {pendingLoans.slice(0, 2).map((loan: any) => (
                  <div key={loan.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 2px', borderTop: `1px dashed ${T.line}` }}>
                    <div style={{
                      width: 38, height: 38, borderRadius: 12, flexShrink: 0,
                      backgroundColor: T.goldLt, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Banknote size={18} color={T.gold} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 14, color: T.ink }}>
                        {loan.members?.first_name} {loan.members?.last_name}
                      </div>
                      <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 1 }}>
                        Wants a loan of {UGXShort(loan.principal)} · {timeAgo(loan.created_at)}
                      </div>
                    </div>
                    <Btn small variant="ember" onClick={() => goToTab('loans')}>Decide</Btn>
                  </div>
                ))}

                {(paidApplicants.length > 3 || unpaidApplicants.length > 0) && (
                  <button
                    onClick={() => goToTab('approvals')}
                    style={{
                      width: '100%', background: 'none', border: 'none', cursor: 'pointer',
                      padding: '12px 2px', borderTop: `1px dashed ${T.line}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      fontSize: 13, fontWeight: 800, color: T.ember, fontFamily: 'inherit',
                    }}
                  >
                    See everyone at the door ({paidApplicants.length + unpaidApplicants.length})
                    <ArrowRight size={14} />
                  </button>
                )}
                <div style={{ height: 8 }} />
              </Sheet>
            )}

            {/* The money */}
            <Sheet style={{ padding: '18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div>
                  <MicroLabel>The money</MicroLabel>
                  <Squiggle />
                </div>
                <button
                  onClick={() => setHideBalances(!hideBalances)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.inkGhost, display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit' }}
                >
                  {hideBalances ? <EyeOff size={14} /> : <Eye size={14} />}
                  {hideBalances ? 'Show' : 'Hide'}
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 }}>
                {/* Big liquidity number */}
                <div style={{
                  gridRow: 'span 2',
                  backgroundColor: T.forestDk, borderRadius: 15, padding: '16px 16px 14px',
                  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                  border: `1.5px solid #1B4030`,
                  boxShadow: '3px 4px 0 rgba(42,33,24,0.12)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#BFDCC9', fontSize: 11.5, fontWeight: 700 }}>
                    <Wallet size={14} /> Kept for members
                  </div>
                  <div>
                    <div style={{
                      fontFamily: 'var(--font-display), sans-serif', fontWeight: 900,
                      fontSize: 25, color: '#fff', letterSpacing: '-0.01em', lineHeight: 1.1,
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {mask(stats.totalLiquidity)}
                    </div>
                    <div style={{ fontSize: 11.5, color: '#9CC4A9', marginTop: 6 }}>
                      saved by {stats.activeMembers} active member{stats.activeMembers === 1 ? '' : 's'} · avg {hideBalances ? '••••' : UGXShort(stats.avgSavingsPerMember)} each
                    </div>
                  </div>
                </div>

                {/* Loans out */}
                <div style={{ backgroundColor: T.goldLt, borderRadius: 15, padding: '13px 14px', border: `1.5px solid ${T.lineDark}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.gold, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    <Banknote size={13} /> Out on loans
                  </div>
                  <div style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 900, fontSize: 17, color: T.ink, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
                    {mask(stats.totalLoansDisbursedAmount)}
                  </div>
                  <div style={{ fontSize: 11, color: T.inkSoft, marginTop: 3 }}>
                    {stats.activeLoansCount} active · {stats.completedLoansCount} repaid
                  </div>
                </div>

                {/* SACCO reserve */}
                <div style={{ backgroundColor: T.emberLt, borderRadius: 15, padding: '13px 14px', border: `1.5px solid #EED4BF` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: T.ember, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    <Landmark size={13} /> SACCO reserve
                  </div>
                  <div style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 900, fontSize: 17, color: T.ink, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
                    {mask(stats.saccoWalletBalance)}
                  </div>
                  <div style={{ fontSize: 11, color: T.inkSoft, marginTop: 3 }}>
                    the cooperative’s own pot
                  </div>
                </div>
              </div>
            </Sheet>

            {/* Trend — honestly labelled */}
            <Sheet style={{ padding: '18px 18px 10px' }}>
              <MicroLabel>Savings vs lending — shape of the last months</MicroLabel>
              <div style={{ fontSize: 11.5, color: T.inkGhost, marginTop: 4 }}>Estimate based on current balances, for orientation only</div>
              <div style={{ height: 150, marginTop: 12, marginLeft: -12 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="deskSave" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={T.forest} stopOpacity={0.32} />
                        <stop offset="100%" stopColor={T.forest} stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="deskLend" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={T.ember} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={T.ember} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={T.line} strokeDasharray="3 5" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: T.inkGhost }} axisLine={false} tickLine={false} dy={6} />
                    <YAxis hide domain={['auto', 'auto']} />
                    <Tooltip
                      formatter={(v: any) => UGX(Number(v))}
                      contentStyle={{ borderRadius: 12, border: `1.5px solid ${T.line}`, backgroundColor: T.sheet, fontSize: 12, boxShadow: '3px 4px 0 rgba(42,33,24,0.08)' }}
                      labelStyle={{ fontWeight: 800, color: T.ink }}
                    />
                    <Area type="monotone" dataKey="Savings" stroke={T.forest} strokeWidth={2.4} fill="url(#deskSave)" />
                    <Area type="monotone" dataKey="Lending" stroke={T.ember} strokeWidth={2.2} fill="url(#deskLend)" strokeDasharray="1 0" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Sheet>

            {/* Latest movements */}
            <Sheet style={{ padding: '16px 18px 8px' }}>
              <MicroLabel>Latest movements</MicroLabel>
              <Squiggle width={52} />
              {recentTransactions.length > 0 ? (
                <>
                  {recentTransactions.slice(0, 6).map((tx: any, i: number) => (
                    <div key={tx.id || i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 2px', borderBottom: i < Math.min(recentTransactions.length, 6) - 1 ? `1px dashed ${T.line}` : 'none' }}>
                      <div style={{
                        width: 34, height: 34, borderRadius: 11, flexShrink: 0,
                        backgroundColor: T.forestLt, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <Coins size={15} color={T.forest} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 700, color: T.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {tx.memberName && tx.memberName !== 'Cooperative Vault' ? tx.memberName : tx.description}
                        </div>
                        <div style={{ fontSize: 11.5, color: T.inkGhost, marginTop: 1 }}>{timeAgo(tx.createdAt)}</div>
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 13.5, color: T.forest, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        +{UGXShort(tx.amount)}
                      </div>
                    </div>
                  ))}
                  <div style={{ height: 8 }} />
                </>
              ) : (
                <p style={{ fontSize: 13, color: T.inkSoft, padding: '14px 2px' }}>
                  Nothing has moved yet. When members start saving, you’ll see it here first.
                </p>
              )}
            </Sheet>

            {/* Quick actions */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Btn variant="paper" onClick={() => goToTab('sms')} style={{ flex: 1, minWidth: 140 }}>
                <MessageSquare size={15} color={T.sky} /> Text the members
              </Btn>
              <Btn variant="paper" onClick={fetchAdminData} style={{ flex: 1, minWidth: 140 }}>
                <RefreshCw size={15} color={T.inkSoft} /> Recount the books
              </Btn>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════
            TAB: APPROVALS — THE FRONT DOOR
        ════════════════════════════════════════════════════════════ */}
        {activeTab === 'approvals' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                <h1 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 24, fontWeight: 900, color: T.ink, letterSpacing: '-0.02em', margin: 0 }}>
                  Who’s at the door
                </h1>
                {pendingMembersList.length > 0 && (
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: T.ember }}>
                    {pendingMembersList.length} waiting
                  </span>
                )}
              </div>
              <Squiggle />
              <p style={{ fontSize: 13.5, color: T.inkSoft, lineHeight: 1.55, margin: '10px 0 0', maxWidth: 460 }}>
                People join, pay their activation fee, and then wait here.
                Only you can open the door — check their payment and details, then let them in.
                They’ll get a welcome SMS the moment you do.
              </p>
            </div>

            {/* Paid & ready */}
            {paidApplicants.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 2px 12px' }}>
                  <UserCheck size={15} color={T.forest} />
                  <span style={{ fontSize: 12.5, fontWeight: 900, color: T.forestDk, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    Paid — ready to enter ({paidApplicants.length})
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {paidApplicants.map((m) => renderApplicantCard(m, true))}
                </div>
              </div>
            )}

            {/* Applied, not yet paid */}
            {unpaidApplicants.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 2px 12px' }}>
                  <Clock size={15} color={T.gold} />
                  <span style={{ fontSize: 12.5, fontWeight: 900, color: T.gold, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    Applied — waiting for payment ({unpaidApplicants.length})
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {unpaidApplicants.map((m) => renderApplicantCard(m, true))}
                </div>
                <p style={{ fontSize: 12, color: T.inkGhost, lineHeight: 1.5, margin: '10px 4px 0' }}>
                  Normally the fee comes first — but if someone paid cash at the office or you’re making an exception,
                  you can still let them in from here. We’ll ask you to confirm first.
                </p>
              </div>
            )}

            {/* Empty desk */}
            {pendingMembersList.length === 0 && (
              <Sheet style={{ padding: '46px 26px', textAlign: 'center' }}>
                <div style={{
                  width: 62, height: 62, borderRadius: 20, margin: '0 auto 16px',
                  backgroundColor: T.forestLt, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <CheckCircle2 size={32} color={T.forest} />
                </div>
                <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 19, fontWeight: 900, color: T.ink, margin: 0 }}>
                  The door is clear
                </h3>
                <p style={{ fontSize: 13.5, color: T.inkSoft, lineHeight: 1.6, maxWidth: 340, margin: '8px auto 0' }}>
                  Nobody is waiting to join {saccoName} right now.
                  When someone signs up and pays their fee, they’ll appear right here.
                </p>
              </Sheet>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════
            TAB: MEMBERS
        ════════════════════════════════════════════════════════════ */}
        {activeTab === 'members' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div>
              <h1 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 24, fontWeight: 900, color: T.ink, letterSpacing: '-0.02em', margin: 0 }}>
                The membership book
              </h1>
              <Squiggle />
              <p style={{ fontSize: 13.5, color: T.inkSoft, margin: '10px 0 0' }}>
                {stats.activeMembers} active · {stats.pendingMembers} at the door · {stats.suspendedMembers} paused
              </p>
            </div>

            {/* Search */}
            <div style={{ position: 'relative' }}>
              <Search size={16} color={T.inkGhost} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }} />
              <input
                type="text"
                placeholder="Find someone by name, phone or email…"
                value={searchMemberQuery}
                onChange={(e) => setSearchMemberQuery(e.target.value)}
                style={{
                  width: '100%', padding: '12px 14px 12px 42px', borderRadius: 14,
                  border: `1.5px solid ${T.line}`, backgroundColor: T.sheet,
                  fontSize: 13.5, color: T.ink, outline: 'none', fontFamily: 'inherit',
                  boxShadow: '2px 3px 0 rgba(42,33,24,0.04)',
                }}
              />
            </div>

            {/* Filter chips */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                { id: 'all', label: `Everyone (${members.length})` },
                { id: 'active', label: `Inside (${stats.activeMembers})` },
                { id: 'pending', label: `Waiting (${stats.pendingMembers})` },
                { id: 'suspended', label: `Paused (${stats.suspendedMembers})` },
              ].map((f) => (
                <button
                  key={f.id}
                  onClick={() => setMemberStatusFilter(f.id as any)}
                  style={{
                    padding: '7px 14px', borderRadius: 99, cursor: 'pointer',
                    backgroundColor: memberStatusFilter === f.id ? T.ink : T.sheet,
                    color: memberStatusFilter === f.id ? T.paper : T.inkSoft,
                    border: `1.5px solid ${memberStatusFilter === f.id ? T.ink : T.line}`,
                    fontSize: 12.5, fontWeight: 800, fontFamily: 'inherit',
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Member rows */}
            <Sheet style={{ padding: '6px 16px' }}>
              {filteredMembers.length > 0 ? filteredMembers.map((m, i) => {
                const name = fullName(m);
                return (
                  <button
                    key={m.id}
                    onClick={() => setSelectedMemberModal(m)}
                    style={{
                      width: '100%', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0',
                      borderBottom: i < filteredMembers.length - 1 ? `1px dashed ${T.line}` : 'none',
                    }}
                  >
                    <Avatar name={name} size={40} radius={13} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 800, fontSize: 14.5, color: T.ink }}>{name}</span>
                        {statusStamp(m)}
                      </div>
                      <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Phone size={11} /> {m.phone || 'no phone'}
                        {m.activation_payment && isPendingMember(m) && (
                          <span style={{ color: T.forest, fontWeight: 700 }}>· fee paid</span>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 13.5, color: T.ink, fontVariantNumeric: 'tabular-nums' }}>
                        {hideBalances ? '••••' : UGXShort(memberBalance(m))}
                      </div>
                      <div style={{ fontSize: 10.5, color: T.inkGhost, marginTop: 2 }}>
                        {(m.accounts || []).length} account{(m.accounts || []).length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <ChevronRight size={16} color={T.inkGhost} style={{ flexShrink: 0 }} />
                  </button>
                );
              }) : (
                <div style={{ padding: '38px 10px', textAlign: 'center', color: T.inkGhost, fontSize: 13.5 }}>
                  Nobody matches that. Try a different name or clear the filter.
                </div>
              )}
            </Sheet>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════
            TAB: LOANS
        ════════════════════════════════════════════════════════════ */}
        {activeTab === 'loans' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h1 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 24, fontWeight: 900, color: T.ink, letterSpacing: '-0.02em', margin: 0 }}>
                  Loan decisions
                </h1>
                {pendingLoans.length > 0 && (
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: T.gold }}>
                    {pendingLoans.length} to decide
                  </span>
                )}
              </div>
              <Squiggle />
              <p style={{ fontSize: 13.5, color: T.inkSoft, margin: '10px 0 0', maxWidth: 440, lineHeight: 1.55 }}>
                Real money belonging to real neighbours. Look at the member, their savings, and the amount — then decide with a clear head.
              </p>
            </div>

            {pendingLoans.length > 0 ? (
              pendingLoans.map((loan: any) => {
                const borrower = fullName(loan.members);
                return (
                  <Sheet key={loan.id} style={{ padding: 18 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <Avatar name={borrower} size={42} />
                        <div>
                          <div style={{ fontWeight: 900, fontSize: 16, color: T.ink, fontFamily: 'var(--font-display), sans-serif' }}>{borrower}</div>
                          <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 2 }}>{loan.members?.phone || 'No phone'} · asked {timeAgo(loan.created_at)}</div>
                        </div>
                      </div>
                      <Stamp label="Undecided" tone="gold" />
                    </div>

                    <div style={{
                      backgroundColor: T.sheetWarm, borderRadius: 14, border: `1px solid ${T.line}`,
                      padding: '14px 16px', marginTop: 14,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <MicroLabel>They asked for</MicroLabel>
                        <strong style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 20, color: T.ink, fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>
                          {UGX(loan.principal)}
                        </strong>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.inkSoft, marginTop: 8 }}>
                        <span>{loan.duration_months || 3} months to repay</span>
                        <span>{loan.interest_rate || 5}% interest</span>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 10, marginTop: 14 }}>
                      <Btn
                        variant="danger"
                        onClick={() => handleLoanAction(loan.id, 'rejected', loan.member_id, parseFloat(loan.principal))}
                        disabled={processingLoanId === loan.id}
                      >
                        Not this time
                      </Btn>
                      <Btn
                        variant="primary"
                        onClick={() => handleLoanAction(loan.id, 'approved', loan.member_id, parseFloat(loan.principal))}
                        disabled={processingLoanId === loan.id}
                      >
                        {processingLoanId === loan.id
                          ? <><Loader2 size={15} className="animate-spin" /> Sending money…</>
                          : <>Approve & disburse ✓</>}
                      </Btn>
                    </div>
                  </Sheet>
                );
              })
            ) : (
              <Sheet style={{ padding: '44px 26px', textAlign: 'center' }}>
                <div style={{
                  width: 62, height: 62, borderRadius: 20, margin: '0 auto 16px',
                  backgroundColor: T.goldLt, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Banknote size={30} color={T.gold} />
                </div>
                <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 19, fontWeight: 900, color: T.ink, margin: 0 }}>
                  No loans waiting
                </h3>
                <p style={{ fontSize: 13.5, color: T.inkSoft, lineHeight: 1.6, maxWidth: 320, margin: '8px auto 0' }}>
                  Every application has been decided. New requests will land here for your yes or no.
                </p>
              </Sheet>
            )}

            {/* Loan book summary */}
            {allLoans.length > 0 && (
              <Sheet style={{ padding: '16px 18px' }}>
                <MicroLabel>The loan book</MicroLabel>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 12 }}>
                  {[
                    { label: 'Active', count: stats.activeLoansCount, amount: stats.totalLoansDisbursedAmount, bg: T.skyLt, fg: T.sky },
                    { label: 'Repaid', count: stats.completedLoansCount, amount: null, bg: T.forestLt, fg: T.forest },
                    { label: 'Total ever', count: stats.totalLoansCount, amount: stats.totalLoansRequestedAmount, bg: T.sheetWarm, fg: T.inkSoft },
                  ].map((b) => (
                    <div key={b.label} style={{ backgroundColor: b.bg, borderRadius: 13, padding: '11px 12px' }}>
                      <div style={{ fontSize: 10.5, fontWeight: 800, color: b.fg, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{b.label}</div>
                      <div style={{ fontFamily: 'var(--font-display), sans-serif', fontWeight: 900, fontSize: 20, color: T.ink, marginTop: 4 }}>{b.count}</div>
                      {b.amount !== null && b.amount !== undefined && (
                        <div style={{ fontSize: 10.5, color: T.inkGhost, marginTop: 2 }}>{UGXShort(b.amount)}</div>
                      )}
                    </div>
                  ))}
                </div>
              </Sheet>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════
            TAB: SMS
        ════════════════════════════════════════════════════════════ */}
        {activeTab === 'sms' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div>
              <h1 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 24, fontWeight: 900, color: T.ink, letterSpacing: '-0.02em', margin: 0 }}>
                Word of mouth
              </h1>
              <Squiggle />
              <p style={{ fontSize: 13.5, color: T.inkSoft, margin: '10px 0 0', maxWidth: 420, lineHeight: 1.55 }}>
                Meeting reminders, rate changes, gentle nudges — write it once and it reaches every pocket.
              </p>
            </div>

            {/* Composer */}
            <Sheet style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 15 }}>
              <div>
                <MicroLabel>Who should get it</MicroLabel>
                <div style={{ display: 'flex', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
                  {[
                    { id: 'all', label: `All members (${members.filter(m => m.phone).length})` },
                    { id: 'single', label: 'One person' },
                    { id: 'custom', label: 'A list of numbers' },
                  ].map((target) => (
                    <button
                      key={target.id}
                      onClick={() => setSmsRecipientType(target.id as any)}
                      style={{
                        padding: '7px 14px', borderRadius: 99, cursor: 'pointer',
                        backgroundColor: smsRecipientType === target.id ? T.ink : 'transparent',
                        color: smsRecipientType === target.id ? T.paper : T.inkSoft,
                        border: `1.5px solid ${smsRecipientType === target.id ? T.ink : T.line}`,
                        fontSize: 12.5, fontWeight: 800, fontFamily: 'inherit',
                      }}
                    >
                      {target.label}
                    </button>
                  ))}
                </div>
              </div>

              {smsRecipientType === 'single' && (
                <div>
                  <MicroLabel>Their phone number</MicroLabel>
                  <input
                    type="tel"
                    placeholder="e.g. 0772 000 111"
                    value={singleRecipientPhone}
                    onChange={(e) => setSingleRecipientPhone(e.target.value)}
                    style={{
                      width: '100%', marginTop: 8, padding: '11px 14px', borderRadius: 12,
                      border: `1.5px solid ${T.line}`, backgroundColor: T.sheetWarm,
                      fontSize: 13.5, color: T.ink, outline: 'none', fontFamily: 'inherit',
                    }}
                  />
                </div>
              )}

              {smsRecipientType === 'custom' && (
                <div>
                  <MicroLabel>Numbers, separated by commas</MicroLabel>
                  <textarea
                    rows={2}
                    placeholder="0772 000 111, 0702 000 222…"
                    value={customPhoneList}
                    onChange={(e) => setCustomPhoneList(e.target.value)}
                    style={{
                      width: '100%', marginTop: 8, padding: '11px 14px', borderRadius: 12,
                      border: `1.5px solid ${T.line}`, backgroundColor: T.sheetWarm,
                      fontSize: 13.5, color: T.ink, outline: 'none', fontFamily: 'inherit', resize: 'vertical',
                    }}
                  />
                </div>
              )}

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <MicroLabel>Your message</MicroLabel>
                  <span style={{ fontSize: 11, color: smsMessageText.length > 160 ? T.ember : T.inkGhost, fontWeight: 700 }}>
                    {smsMessageText.length}/160 · {Math.ceil(smsMessageText.length / 160) || 1} SMS
                  </span>
                </div>
                <textarea
                  rows={4}
                  placeholder={`Hello from ${saccoName}! Quick reminder about Saturday’s meeting — bring a friend…`}
                  value={smsMessageText}
                  onChange={(e) => setSmsMessageText(e.target.value)}
                  style={{
                    width: '100%', marginTop: 8, padding: '12px 14px', borderRadius: 13,
                    border: `1.5px solid ${T.line}`, backgroundColor: T.sheetWarm,
                    fontSize: 13.5, lineHeight: 1.55, color: T.ink, outline: 'none',
                    fontFamily: 'inherit', resize: 'vertical',
                  }}
                />
                <div style={{ fontSize: 11.5, color: T.inkGhost, marginTop: 6 }}>
                  Each member costs {UGX(smsRate || 50)} per SMS unit. You have <strong style={{ color: smsBalance < 50 ? T.rust : T.ink }}>{smsBalance.toLocaleString()}</strong> SMS left.
                </div>
              </div>

              <Btn variant="ember" onClick={handleSendBroadcast} disabled={isSendingSms || !smsMessageText.trim()} style={{ padding: '13px' }}>
                {isSendingSms
                  ? <><Loader2 size={15} className="animate-spin" /> Sending…</>
                  : <><Send size={15} /> Send it out</>}
              </Btn>
            </Sheet>

            {/* SMS credit packs */}
            <Sheet style={{ padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <MicroLabel>Top up SMS credit</MicroLabel>
                  <Squiggle width={56} />
                </div>
                <span style={{ fontSize: 13, fontWeight: 900, color: T.ink, backgroundColor: T.sheetWarm, padding: '5px 12px', borderRadius: 10, border: `1px solid ${T.line}` }}>
                  {smsBalance.toLocaleString()} left
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {[
                  { credits: 200, price: 10000, tag: 'A quick top-up' },
                  { credits: 500, price: 25000, tag: 'Most people pick this' },
                  { credits: 1200, price: 50000, tag: 'Good for a busy month' },
                  { credits: 3000, price: 100000, tag: 'The serious one' },
                ].map((pack) => (
                  <div
                    key={pack.credits}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                      padding: '12px 14px', borderRadius: 14, backgroundColor: T.sheetWarm,
                      border: `1px solid ${T.line}`,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 14, color: T.ink }}>
                        {pack.credits.toLocaleString()} SMS
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: T.inkSoft }}> · {UGX(pack.price)}</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: T.inkSoft, marginTop: 2 }}>{pack.tag}</div>
                    </div>
                    <Btn
                      small
                      variant="primary"
                      onClick={() => { setSelectedPack(pack); setShowBuyModal(true); }}
                    >
                      Buy
                    </Btn>
                  </div>
                ))}
              </div>
            </Sheet>

            {/* History */}
            {smsHistory.length > 0 && (
              <Sheet style={{ padding: '16px 18px 8px' }}>
                <MicroLabel>Sent recently</MicroLabel>
                <Squiggle width={44} />
                {smsHistory.slice(0, 8).map((log: any, i: number) => (
                  <div key={log.id || i} style={{ padding: '11px 2px', borderBottom: i < Math.min(smsHistory.length, 8) - 1 ? `1px dashed ${T.line}` : 'none' }}>
                    <div style={{ fontSize: 13, color: T.ink, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {log.text}
                    </div>
                    <div style={{ fontSize: 11.5, color: T.inkGhost, marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
                      <span>to {log.recipients}</span>
                      <span>{timeAgo(log.date)}</span>
                    </div>
                  </div>
                ))}
                <div style={{ height: 8 }} />
              </Sheet>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════
            TAB: SETTINGS
        ════════════════════════════════════════════════════════════ */}
        {activeTab === 'tenant' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div>
              <h1 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 24, fontWeight: 900, color: T.ink, letterSpacing: '-0.02em', margin: 0 }}>
                The back office
              </h1>
              <Squiggle />
              <p style={{ fontSize: 13.5, color: T.inkSoft, margin: '10px 0 0', maxWidth: 420, lineHeight: 1.55 }}>
                The boring-but-important drawer: names, codes and keys. You’ll rarely need it — and that’s a good thing.
              </p>
            </div>

            <Sheet style={{ padding: 18 }}>
              <MicroLabel>Your cooperative</MicroLabel>
              <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginTop: 12 }}>
                <div style={{
                  width: 50, height: 50, borderRadius: 15, backgroundColor: T.ember, color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 900, fontSize: 22, fontFamily: 'var(--font-display), sans-serif',
                  boxShadow: '0 3px 0 #93390F', flexShrink: 0,
                }}>
                  {saccoName.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 17, color: T.ink }}>{saccoName}</div>
                  <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 2 }}>
                    Code <strong style={{ color: T.ink }}>{tenantCode}</strong> · UGX · Mobile money connected
                  </div>
                </div>
              </div>

              <div style={{
                marginTop: 16, backgroundColor: T.sheetWarm, borderRadius: 13,
                border: `1px solid ${T.line}`, padding: '11px 14px',
                fontSize: 11.5, color: T.inkSoft, fontFamily: 'monospace', wordBreak: 'break-all',
              }}>
                org id · {orgId}
              </div>
            </Sheet>

            <Sheet style={{ padding: 18 }}>
              <MicroLabel>API key — keep it in the drawer</MicroLabel>
              <p style={{ fontSize: 12.5, color: T.inkSoft, lineHeight: 1.55, margin: '9px 0 12px' }}>
                This key lets other systems talk to your SACCO. Anyone holding it can act as you, so treat it like the office keys.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <input
                  type="text"
                  readOnly
                  value={apiKey || ''}
                  style={{
                    flex: 1, padding: '11px 14px', borderRadius: 11, minWidth: 0,
                    backgroundColor: T.sheetWarm, border: `1.5px solid ${T.line}`,
                    fontFamily: 'monospace', fontSize: 12, color: T.ink, outline: 'none',
                  }}
                />
                <Btn
                  variant="paper"
                  onClick={() => {
                    navigator.clipboard.writeText(apiKey || '');
                    setToastMessage({ type: 'success', text: 'Copied — now keep it somewhere safe.' });
                  }}
                >
                  Copy
                </Btn>
              </div>
            </Sheet>

            <Sheet style={{ padding: 18 }}>
              <MicroLabel>You</MicroLabel>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Avatar name={adminProfile?.full_name || adminFirstName} size={42} />
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 15, color: T.ink }}>{adminProfile?.full_name || adminFirstName}</div>
                    <div style={{ fontSize: 12, color: T.inkSoft, marginTop: 1 }}>{sessionUser?.email}</div>
                  </div>
                </div>
                <Btn
                  variant="danger"
                  onClick={async () => { await supabase.auth.signOut(); router.push('/auth'); }}
                >
                  <LogOut size={14} /> Sign out
                </Btn>
              </div>
            </Sheet>

            <p style={{ fontSize: 11.5, color: T.inkGhost, textAlign: 'center', margin: '4px 0 0' }}>
              Sacco Connect front desk · made with care for {saccoName}
            </p>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════
            MODAL: MEMBER DOSSIER
        ════════════════════════════════════════════════════════════ */}
        {selectedMemberModal && (
          <div
            onClick={() => setSelectedMemberModal(null)}
            style={{
              position: 'fixed', inset: 0,
              backgroundColor: 'rgba(42,33,24,0.55)', backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
              zIndex: 100,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                backgroundColor: T.paper, borderRadius: '26px 26px 0 0', width: '100%', maxWidth: 620,
                maxHeight: '88vh', overflowY: 'auto',
                boxShadow: '0 -12px 50px rgba(0,0,0,0.25)',
                border: `1.5px solid ${T.lineDark}`,
              }}
            >
              {/* Handle + head */}
              <div style={{ padding: '10px 0 0', display: 'flex', justifyContent: 'center' }}>
                <div style={{ width: 44, height: 5, borderRadius: 99, backgroundColor: T.lineDark }} />
              </div>
              <div style={{ padding: '16px 22px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                  <Avatar name={fullName(selectedMemberModal)} size={48} />
                  <div>
                    <div style={{ fontWeight: 900, fontSize: 19, color: T.ink, fontFamily: 'var(--font-display), sans-serif' }}>
                      {fullName(selectedMemberModal)}
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {statusStamp(selectedMemberModal)}
                      {selectedMemberModal.activation_payment && isPendingMember(selectedMemberModal) && (
                        <Stamp label={`Paid ${UGXShort(selectedMemberModal.activation_payment.amount)}`} tone="forest" rotate={1.5} />
                      )}
                    </div>
                  </div>
                </div>
                <IconBtn onClick={() => setSelectedMemberModal(null)} title="Close">✕</IconBtn>
              </div>

              <div style={{ padding: '18px 22px 26px', display: 'flex', flexDirection: 'column', gap: 14 }}>

                {/* Activation payment evidence */}
                {isPendingMember(selectedMemberModal) && (
                  <div style={{
                    backgroundColor: selectedMemberModal.activation_payment ? T.forestLt : T.sheetWarm,
                    borderRadius: 14, border: `1.5px solid ${selectedMemberModal.activation_payment ? T.forest + '40' : T.line}`,
                    padding: '13px 16px',
                  }}>
                    {selectedMemberModal.activation_payment ? (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 800, color: T.forestDk }}>
                          <CheckCircle2 size={15} /> Activation fee received
                        </div>
                        <div style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 5, lineHeight: 1.5 }}>
                          {UGX(selectedMemberModal.activation_payment.amount)} · {timeAgo(selectedMemberModal.activation_payment.paid_at)}
                          {selectedMemberModal.activation_payment.provider ? ` · ${selectedMemberModal.activation_payment.provider}` : ''}
                          {selectedMemberModal.activation_payment.reference ? ` · ref ${selectedMemberModal.activation_payment.reference}` : ''}
                        </div>
                      </>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: T.inkSoft, lineHeight: 1.5 }}>
                        <Clock size={15} color={T.gold} style={{ flexShrink: 0, marginTop: 1 }} />
                        <span>No activation payment yet. They probably opened the app but haven’t settled the fee — you can wait, or let them in anyway from the Approvals tab.</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Detail grid */}
                <Sheet style={{ padding: '4px 16px' }}>
                  {[
                    ['Phone', selectedMemberModal.phone || '—'],
                    ['Email', selectedMemberModal.email || '—'],
                    ['National ID (NIN)', selectedMemberModal.national_id || '—'],
                    ['Date of birth', selectedMemberModal.date_of_birth || '—'],
                    ['Next of kin', `${selectedMemberModal.next_of_kin_name || '—'}${selectedMemberModal.next_of_kin_phone ? ` (${selectedMemberModal.next_of_kin_phone})` : ''}`],
                    ['Joined us', selectedMemberModal.created_at ? new Date(selectedMemberModal.created_at).toLocaleDateString('en-UG', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'],
                    ['Saved with us', hideBalances ? '••••' : UGX(memberBalance(selectedMemberModal))],
                  ].map(([k, v], i, arr) => (
                    <div key={k as string} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14,
                      padding: '11px 0',
                      borderBottom: i < arr.length - 1 ? `1px dashed ${T.line}` : 'none',
                    }}>
                      <span style={{ fontSize: 12.5, color: T.inkSoft }}>{k}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: T.ink, textAlign: 'right', wordBreak: 'break-word' }}>{v}</span>
                    </div>
                  ))}
                </Sheet>

                {/* Actions */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {isPendingMember(selectedMemberModal) && (
                    <>
                      <Btn
                        variant="primary"
                        onClick={() => approveApplicant(selectedMemberModal)}
                        disabled={processingMemberId === selectedMemberModal.id}
                        style={{ padding: '13px' }}
                      >
                        {processingMemberId === selectedMemberModal.id
                          ? <><Loader2 size={15} className="animate-spin" /> Letting them in…</>
                          : <><DoorOpen size={16} /> Let {selectedMemberModal.first_name || 'them'} in ✓</>}
                      </Btn>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <Btn variant="danger" onClick={() => handleMemberAction(selectedMemberModal.id, 'reject')} disabled={processingMemberId === selectedMemberModal.id}>
                          Decline
                        </Btn>
                        <Btn variant="ghost" onClick={() => setSelectedMemberModal(null)}>Decide later</Btn>
                      </div>
                    </>
                  )}
                  {selectedMemberModal.status === 'active' && (
                    <>
                      <Btn variant="danger" onClick={() => handleMemberAction(selectedMemberModal.id, 'suspend')} disabled={processingMemberId === selectedMemberModal.id}>
                        Pause this membership
                      </Btn>
                      <Btn variant="ghost" onClick={() => setSelectedMemberModal(null)}>Close</Btn>
                    </>
                  )}
                  {selectedMemberModal.status === 'suspended' && (
                    <>
                      <Btn variant="primary" onClick={() => handleMemberAction(selectedMemberModal.id, 'approve')} disabled={processingMemberId === selectedMemberModal.id}>
                        Welcome them back ✓
                      </Btn>
                      <Btn variant="ghost" onClick={() => setSelectedMemberModal(null)}>Close</Btn>
                    </>
                  )}
                  {selectedMemberModal.status === 'rejected' && (
                    <>
                      <Btn variant="paper" onClick={() => handleMemberAction(selectedMemberModal.id, 'set_pending')} disabled={processingMemberId === selectedMemberModal.id}>
                        Give them another chance
                      </Btn>
                      <Btn variant="ghost" onClick={() => setSelectedMemberModal(null)}>Close</Btn>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════
            MODAL: SMS TOP-UP (MOBILE MONEY)
        ════════════════════════════════════════════════════════════ */}
        {showBuyModal && selectedPack && (
          <div
            onClick={() => { if (!isProcessingBuy) { setShowBuyModal(false); setSelectedPack(null); } }}
            style={{
              position: 'fixed', inset: 0,
              backgroundColor: 'rgba(42,33,24,0.55)', backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
              zIndex: 100,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                backgroundColor: T.paper, borderRadius: '26px 26px 0 0', width: '100%', maxWidth: 620,
                boxShadow: '0 -12px 50px rgba(0,0,0,0.25)',
                border: `1.5px solid ${T.lineDark}`,
              }}
            >
              <div style={{ padding: '10px 0 0', display: 'flex', justifyContent: 'center' }}>
                <div style={{ width: 44, height: 5, borderRadius: 99, backgroundColor: T.lineDark }} />
              </div>

              <div style={{ padding: '18px 24px 30px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ textAlign: 'center' }}>
                  <MicroLabel>Mobile Money checkout</MicroLabel>
                  <div style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 26, fontWeight: 900, color: T.ink, marginTop: 8 }}>
                    {selectedPack.credits.toLocaleString()} SMS
                  </div>
                  <div style={{ fontSize: 14.5, fontWeight: 800, color: T.ember, marginTop: 3 }}>
                    {UGX(selectedPack.price)}
                  </div>
                  <p style={{ fontSize: 12.5, color: T.inkSoft, margin: '8px 0 0' }}>
                    MTN MoMo or Airtel Money — we’ll ping your phone for the PIN.
                  </p>
                </div>

                <div>
                  <MicroLabel>Paying from</MicroLabel>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10, marginTop: 8,
                    backgroundColor: T.sheet, borderRadius: 13, padding: '0 14px', height: 50,
                    border: `1.5px solid ${T.line}`,
                  }}>
                    <Phone size={16} color={T.inkGhost} />
                    <input
                      type="tel"
                      placeholder="0772 000 111"
                      value={momoNumber}
                      onChange={(e) => setMomoNumber(e.target.value)}
                      disabled={isProcessingBuy}
                      style={{ border: 'none', background: 'transparent', outline: 'none', flex: 1, fontSize: 14.5, fontWeight: 700, color: T.ink, fontFamily: 'inherit' }}
                    />
                  </div>
                </div>

                <Btn variant="primary" onClick={handleBuySms} disabled={isProcessingBuy || !momoNumber.trim()} style={{ padding: '14px' }}>
                  {isProcessingBuy
                    ? <><Loader2 size={16} className="animate-spin" /> Waiting for your PIN…</>
                    : <>Pay {UGX(selectedPack.price)}</>}
                </Btn>
              </div>
            </div>
          </div>
        )}

        {/* ── Toast ────────────────────────────────────────────────── */}
        {toastMessage && (
          <div style={{
            position: 'fixed', top: 18, left: '50%', transform: 'translateX(-50%)',
            zIndex: 200, maxWidth: 420, width: 'calc(100% - 32px)',
            backgroundColor: toastMessage.type === 'success' ? T.forestDk : T.rust,
            color: '#fff', borderRadius: 14, padding: '12px 16px',
            display: 'flex', alignItems: 'center', gap: 10,
            boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
            fontSize: 13.5, fontWeight: 700, lineHeight: 1.4,
          }}>
            {toastMessage.type === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
            {toastMessage.text}
          </div>
        )}

      </div>

      {/* ── Bottom navigation — worn leather tab bar ────────────────────── */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        padding: '8px 14px 16px',
        background: `linear-gradient(to top, ${T.paper} 82%, transparent)`,
        display: 'flex', justifyContent: 'center',
        zIndex: 50, pointerEvents: 'none',
      }}>
        <div style={{
          pointerEvents: 'auto',
          width: '100%', backgroundColor: T.navBg, borderRadius: 22,
          display: 'flex', padding: '7px',
          boxShadow: '0 8px 26px rgba(42,33,24,0.45), 0 2px 0 rgba(255,255,255,0.06) inset',
          border: `1px solid rgba(255,255,255,0.07)`,
        }}>
          {[
            { key: 'overview',  label: 'Desk',     Icon: TrendingUp, route: '/admin' },
            { key: 'approvals', label: 'The door', Icon: DoorOpen, badge: pendingMembersList.length, route: '/admin/approvals' },
            { key: 'members',   label: 'Members',  Icon: Users, badge: members.length, route: '/admin/members' },
            { key: 'loans',     label: 'Loans',    Icon: Banknote, badge: pendingLoans.length, route: '/admin/loans' },
            { key: 'sms',       label: 'SMS',      Icon: Send, route: '/admin/sms' },
            { key: 'tenant',    label: 'Office',   Icon: Shield, route: '/admin/settings' },
          ].map(({ key, label, Icon, badge, route }) => {
            const on = activeTab === key;
            return (
              <button
                key={key}
                onClick={() => setActiveTabAndRoute(key as any, route)}
                style={{
                  flex: 1, background: 'none', border: 'none', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  gap: 3, padding: '7px 0', position: 'relative', fontFamily: 'inherit',
                }}
              >
                <div style={{
                  width: on ? 46 : 32, height: 33, borderRadius: on ? 13 : '50%',
                  backgroundColor: on ? T.navAct : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.22s cubic-bezier(0.4,0,0.2,1)',
                  position: 'relative',
                }}>
                  <Icon size={19} color={on ? '#33261B' : 'rgba(246,240,229,0.42)'} strokeWidth={on ? 2.4 : 2} />
                  {badge !== undefined && badge > 0 && (
                    <span style={{
                      position: 'absolute', top: -4, right: -5,
                      backgroundColor: '#E4573D', color: 'white',
                      fontSize: 9, fontWeight: 900, borderRadius: 99,
                      padding: '1px 5px', minWidth: 16, height: 16,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: `1.5px solid ${T.navBg}`,
                    }}>
                      {badge}
                    </span>
                  )}
                </div>
                <span style={{
                  fontSize: 9.5, fontWeight: on ? 800 : 600,
                  color: on ? T.paper : 'rgba(246,240,229,0.42)',
                  transition: 'color 0.2s ease', whiteSpace: 'nowrap',
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
