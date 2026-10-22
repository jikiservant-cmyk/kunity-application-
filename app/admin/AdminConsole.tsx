'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import ProductsSettings from './ProductsSettings';
import AdminOverview, { type AdminConsoleTab } from './AdminOverview';
import AdminSmsWorkspace, { type AdminSmsRecipientType } from './AdminSmsWorkspace';
import styles from './AdminConsole.module.css';
import { 
  Building2, Users, CreditCard, Send, Shield, RefreshCw, LogOut, 
  ArrowUpRight, ArrowDownLeft, CheckCircle2, XCircle, AlertCircle, 
  Search, TrendingUp, Sparkles, ChevronRight,
  Filter, Check, UserCheck, UserX, Clock, Calendar, Phone, Mail, 
  FileText, Coins, Award, HelpCircle, Layers, ArrowRight, ExternalLink,
  ChevronDown, Bell, MessageSquare, Plus, Loader2, Download
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  normalizeSmsAmount,
  smsAmountBounds,
  smsTopupForAmount,
} from '@/lib/sms-bundles';

/* ── Admin workspace palette ──────────────────────────────────── */
const T = {
  cDeep:   "#1D4ED8",
  cRich:   "#2563EB",
  cMid:    "#1677FF",
  gold:    "#D97706",
  goldLt:  "#FEF3C7",
  green:   "#12A779",
  greenLt: "#86EFAC",
  red:     "#EF4444",
  redLt:   "#FEE2E2",
  blue:    "#1677FF",
  blueLt:  "#EDF4FF",
  bg:      "#F3F5F9",
  card:    "#FFFFFF",
  cardWarm:"#F8FAFD",
  text:    "#182235",
  sub:     "#68758A",
  ghost:   "#98A3B5",
  border:  "#E5EAF2",
  borderDark: "#DCE5F2"
};

const UGX = (n: number | string) => `UGX ${Number(n || 0).toLocaleString("en-UG")}`;

// Uganda mobile money: 07XXXXXXXX, 2567XXXXXXXX or +2567XXXXXXXX (spaces/dashes allowed).
const isValidMomo = (value: string) =>
  /^(?:\+?256|0)7\d{8}$/.test(value.replace(/[\s-]/g, ''));

type AdminNavigationItem = {
  key: AdminConsoleTab;
  label: string;
  href: string;
  Icon: LucideIcon;
};

const ADMIN_NAV_ITEMS: AdminNavigationItem[] = [
  { key: 'overview', label: 'Overview', href: '/admin', Icon: TrendingUp },
  { key: 'approvals', label: 'Approvals', href: '/admin/approvals', Icon: UserCheck },
  { key: 'members', label: 'Members', href: '/admin/members', Icon: Users },
  { key: 'loans', label: 'Loans', href: '/admin/loans', Icon: CreditCard },
  { key: 'sms', label: 'SMS', href: '/admin/sms', Icon: Send },
  { key: 'tenant', label: 'Settings', href: '/admin/settings', Icon: Shield },
];

export default function AdminConsole({ initialTab = 'overview' }: { initialTab?: AdminConsoleTab }) {
  const router = useRouter();

  // State Management
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sessionUser, setSessionUser] = useState<any>(null);
  const [adminProfile, setAdminProfile] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<AdminConsoleTab>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Tenant / Sacco Information
  const [saccoName, setSaccoName] = useState('K-Unity SACCO');
  const [tenantCode, setTenantCode] = useState('k-unity-sac');
  const [orgId, setOrgId] = useState('');
  const [allOrganizations, setAllOrganizations] = useState<any[]>([]);
  const [showOrgDropdown, setShowOrgDropdown] = useState(false);
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
  const smsRequestIdRef = useRef<string | null>(null);
  const [smsLowBalance, setSmsLowBalance] = useState(false);
  const [smsRate, setSmsRate] = useState(50);
  const [smsHistory, setSmsHistory] = useState<any[]>([]);
  const [exportingReport, setExportingReport] = useState<string | null>(null);

  // UI Controls
  const [hideBalances, setHideBalances] = useState(false);
  const [overviewSearchQuery, setOverviewSearchQuery] = useState('');
  const [searchMemberQuery, setSearchMemberQuery] = useState('');
  const [memberStatusFilter, setMemberStatusFilter] = useState<'all' | 'active' | 'pending' | 'suspended'>('all');
  const [selectedMemberModal, setSelectedMemberModal] = useState<any>(null);
  const [processingMemberId, setProcessingMemberId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  // SMS Broadcast State
  const [smsRecipientType, setSmsRecipientType] = useState<AdminSmsRecipientType>('all');
  const [singleRecipientPhone, setSingleRecipientPhone] = useState('');
  const [customPhoneList, setCustomPhoneList] = useState('');
  const [smsMessageText, setSmsMessageText] = useState('');
  const [isSendingSms, setIsSendingSms] = useState(false);

  // Buy SMS State
  const [showBuyModal, setShowBuyModal] = useState(false);
  const [buyAmount, setBuyAmount] = useState('25000');
  const [momoNumber, setMomoNumber] = useState('');
  const [isProcessingBuy, setIsProcessingBuy] = useState(false);
  // Immersive checkout overlay — same pending → success → failed sequence as the
  // member portal's mobile-money deposit.
  const [topupPrompt, setTopupPrompt] = useState<{
    credits: number;
    price: number;
    phone: string;
    status: 'pending' | 'success' | 'failed';
    message?: string;
  } | null>(null);

  // No hardcoded packs: the admin types the amount to spend and the server
  // derives the SMS count from this SACCO's DB-stored rate (wallets.sms_rate).
  const parsedBuyAmount = normalizeSmsAmount(Number(buyAmount));
  const buyBounds = smsAmountBounds(smsRate);
  const buyQuote = parsedBuyAmount === null
    ? null
    : smsTopupForAmount(parsedBuyAmount, smsRate);
  const quotedBuyCredits = buyQuote?.credits ?? null;
  const quotedBuyCharge = buyQuote?.amount ?? null;

  // Loan Underwriting Processing
  const [processingLoanId, setProcessingLoanId] = useState<string | null>(null);

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

  // ── Download SACCO Books ──────────────────────────────────────────
  // Fetches the CSV with the admin's session token and hands the browser a
  // file download (the API audit-logs every export).
  const downloadReport = async (report: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setToastMessage({ type: 'error', text: 'Your session has expired. Please sign in again.' });
        return;
      }
      setExportingReport(report);
      const res = await fetch(`/api/admin/export?report=${encodeURIComponent(report)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setToastMessage({ type: 'error', text: data.error || 'Could not prepare the download.' });
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || `${report}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const count = res.headers.get('x-rows-count');
      setToastMessage({ type: 'success', text: `${filename} downloaded${count ? ` (${count} rows)` : ''}.` });
    } catch {
      setToastMessage({ type: 'error', text: 'Could not prepare the download.' });
    } finally {
      setExportingReport(null);
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
        setAllOrganizations(data.allOrganizations || []);
        setStats(data.stats || {});
        setMembers(data.members || []);
        setPendingLoans(data.pendingLoans || []);
        setAllLoans(data.allLoans || []);
        setSavingsProducts(data.savingsProducts || []);
        setRecentTransactions(data.recentTransactions || []);
        setSmsBalance(data.smsBalance || 0);
        setSmsLowBalance(!!data.smsLowBalance);
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
  const handleMemberAction = async (memberId: string, action: 'reject' | 'suspend' | 'set_pending') => {
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
          setSelectedMemberModal((prev: any) => prev ? { ...prev, status: action === 'reject' ? 'rejected' : 'suspended' } : null);
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

      // "All members" is resolved on the server from the database, so every member is included.
      let recipients: string[] = [];
      if (smsRecipientType === 'all') {
        recipients = [];
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

      if (smsRecipientType !== 'all' && recipients.length === 0) {
        setToastMessage({ type: 'error', text: 'No valid phone recipients selected' });
        setIsSendingSms(false);
        return;
      }

      // One request ID per draft: a retry after a lost response is refused by the server
      // instead of broadcasting twice. A new draft gets a new ID.
      if (!smsRequestIdRef.current) {
        smsRequestIdRef.current = `bc-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      }
      const res = await fetch('/api/admin/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: session.access_token,
          recipientType: smsRecipientType === 'all' ? 'all' : undefined,
          recipients,
          message: smsMessageText,
          organizationId: orgId,
          requestId: smsRequestIdRef.current
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        smsRequestIdRef.current = null;
        const sent = data.recipientsCount ?? recipients.length;
        const skipped = data.skippedInvalid ? ` (${data.skippedInvalid} member record(s) had no valid number and were skipped)` : '';
        setToastMessage({ type: 'success', text: `Broadcast dispatched to ${sent} recipients!${skipped}` });
        setSmsMessageText('');
        await fetchAdminData();
      } else {
        // A dispatch that sent nothing (e.g. gateway down) is retryable: drop
        // the draft's request ID so the next attempt is not refused as a repeat.
        if (typeof data.sentCount === 'number' && data.sentCount === 0) {
          smsRequestIdRef.current = null;
        }
        setToastMessage({ type: 'error', text: data.error || 'Failed to dispatch SMS' });
      }
    } catch (err: any) {
      setToastMessage({ type: 'error', text: err.message });
    } finally {
      setIsSendingSms(false);
    }
  };

  // Buy SMS Bundle Handler — mirrors the member portal checkout:
  // sheet → PIN overlay (pending) → success / failed, no toast-and-close.
  const openBuySheet = (amount?: number) => {
    if (typeof amount === 'number') setBuyAmount(String(amount));
    setShowBuyModal(true);
  };

  const closeBuySheet = () => {
    if (isProcessingBuy) return;
    setShowBuyModal(false);
  };

  const handleBuySms = async () => {
    if (buyQuote === null || parsedBuyAmount === null) {
      alert(buyBounds
        ? `Enter an amount between ${UGX(buyBounds.min)} and ${UGX(buyBounds.max)}.`
        : 'SMS pricing is unavailable right now. Please contact support.');
      return;
    }

    if (!momoNumber.trim()) {
      alert('Please provide a phone number');
      return;
    }
    if (!isValidMomo(momoNumber)) {
      alert('Phone number must be exactly 10 digits starting with 0 (e.g. 0772123456) for Ugandan networks.');
      return;
    }

    setIsProcessingBuy(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        alert('Your session has expired. Please log in again.');
        return;
      }

      const res = await fetch('/api/admin/sms/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: session.access_token,
          momoNumber: momoNumber,
          amount: parsedBuyAmount,
          phone: momoNumber,
          organizationId: orgId
        })
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        // Hand over to the immersive overlay. The sheet closes; the overlay owns
        // the rest of the journey so the admin can see exactly what is happening.
        setTopupPrompt({
          // Prefer the server's authoritative numbers; fall back to the local
          // estimate only if the response omits them.
          credits: Number(data.credits) || buyQuote.credits,
          price: Number(data.amount) || buyQuote.amount,
          phone: momoNumber.trim(),
          status: 'pending',
        });
        setShowBuyModal(false);
        setMomoNumber('');
        void waitForTopupConfirmation(session.access_token, data.intentId || data.intent?.id);
      } else {
        alert(data.error || 'Mobile money prompt failed');
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setIsProcessingBuy(false);
    }
  };

  // Polls the server until the NaJiki payment is confirmed and the credits are added.
  // The confirm route checks NaJiki and credits idempotently, so repeated polls are safe.
  // Drives the checkout overlay instead of a toast, matching the member portal.
  const waitForTopupConfirmation = async (accessToken: string, intentId?: string) => {
    if (!intentId) {
      setTopupPrompt((prev) => prev ? {
        ...prev,
        status: 'failed',
        message: 'The payment request did not return a reference. If you were charged, your credits will still be applied automatically.',
      } : prev);
      return;
    }

    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const res = await fetch('/api/admin/sms/topup/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: accessToken, intentId })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          const credits = data.addedCredits ?? data.newBalanceCredits;
          setTopupPrompt((prev) => prev ? {
            ...prev,
            status: 'success',
            message: data.message === 'Already processed'
              ? 'This top-up was already credited to your SMS wallet.'
              : credits
                ? `${credits.toLocaleString()} SMS credits were added to your wallet.`
                : 'Your SMS credits were added to your wallet.',
          } : prev);
          await fetchAdminData();
          return;
        }
        // Still waiting on the mobile money PIN, or NaJiki is briefly unreachable: keep polling.
        const pending = res.status === 400 && /not yet successful|Failed to verify/i.test(String(data.error || ''));
        if (!pending) {
          setTopupPrompt((prev) => prev ? {
            ...prev,
            status: 'failed',
            message: data.error || 'The top-up could not be confirmed.',
          } : prev);
          return;
        }
      } catch {
        // Network blip: keep polling.
      }
    }

    setTopupPrompt((prev) => prev ? {
      ...prev,
      status: 'failed',
      message: 'The top-up is not confirmed yet. If you paid, the credits are added automatically once NaJiki confirms it.',
    } : prev);
  };


  // Immersive Mobile Money checkout overlay — the member portal's PIN prompt,
  // reused for admin SMS bundle purchases so both flows feel identical.
  const renderTopupOverlay = () => {
    if (!topupPrompt) return null;

    const dismiss = () => setTopupPrompt(null);

    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(28, 25, 23, 0.95)', zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        backdropFilter: 'blur(8px)',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif"
      }}>
        <div style={{
          background: '#FFFFFF', width: '100%', maxWidth: 440,
          borderRadius: 28, padding: '36px 24px 28px',
          textAlign: 'center', boxShadow: '0 20px 50px rgba(0,0,0,0.3)',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          position: 'relative'
        }}>
          {topupPrompt.status !== 'pending' && (
            <button
              onClick={dismiss}
              aria-label="Close"
              style={{
                position: 'absolute', top: 20, right: 20,
                background: 'none', border: 'none', color: '#887563',
                fontSize: 24, cursor: 'pointer', padding: 4
              }}
            >
              &times;
            </button>
          )}

          {topupPrompt.status === 'pending' && (
            <>
              <div style={{ position: 'relative', width: 100, height: 100, marginBottom: 28 }}>
                <div style={{
                  position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                  borderRadius: '50%', background: '#F973161A',
                  animation: 'kunitySmsPulse 2s infinite ease-in-out'
                }} />
                <div style={{
                  width: 100, height: 100, borderRadius: '50%',
                  background: '#F973161F', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  border: '2px solid #F97316'
                }}>
                  <Phone size={44} color="#F97316" className="animate-bounce" />
                </div>
              </div>

              <h3 style={{ fontSize: 24, fontWeight: 800, color: '#1C1917', margin: '0 0 12px 0' }}>
                Confirm on Your Phone
              </h3>

              <p style={{ fontSize: 15, color: '#57534E', lineHeight: 1.6, margin: '0 0 24px' }}>
                A secure push notification has been sent to your mobile phone at <strong style={{ color: '#1C1917' }}>{topupPrompt.phone}</strong>.
                <br />
                Please unlock your phone and enter your <strong style={{ color: '#F97316' }}>Mobile Money PIN</strong> to authorize the payment of <strong style={{ color: '#1C1917' }}>{UGX(topupPrompt.price)}</strong> for {topupPrompt.credits.toLocaleString()} SMS credits.
              </p>

              <div style={{ width: '100%', background: '#FFFBF7', border: '1px dashed #EAE0CC', borderRadius: 16, padding: '16px 20px', marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, textAlign: 'left' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#3D9970' }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#1C1917' }}>Payment request dispatched</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }}>
                  <Loader2 size={16} className="animate-spin" style={{ color: '#F97316' }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#F97316' }}>Waiting for SIM PIN authentication...</span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#A5927D', fontSize: 12 }}>
                <span>Do not close this page while processing</span>
              </div>
            </>
          )}

          {topupPrompt.status === 'success' && (
            <>
              <div style={{
                width: 90, height: 90, borderRadius: '50%',
                background: '#ECFDF5', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                border: '3px solid #10B981', marginBottom: 24
              }}>
                <CheckCircle2 size={52} color="#10B981" />
              </div>

              <h3 style={{ fontSize: 24, fontWeight: 800, color: '#1C1917', margin: '0 0 12px 0' }}>
                Payment Successful!
              </h3>

              <p style={{ fontSize: 15, color: '#57534E', lineHeight: 1.6, margin: '0 0 28px' }}>
                Awesome! We received your payment of <strong style={{ color: '#1C1917' }}>{UGX(topupPrompt.price)}</strong> via Mobile Money.
                <br />
                {topupPrompt.message || `${topupPrompt.credits.toLocaleString()} SMS credits were added to your wallet.`}
              </p>

              <button
                onClick={() => { dismiss(); fetchAdminData(); }}
                style={{
                  width: '100%', height: 54, borderRadius: 16,
                  background: '#3D9970', color: 'white', fontWeight: 700,
                  border: 'none', cursor: 'pointer', fontSize: 16,
                  boxShadow: '0 6px 20px rgba(16,185,129,0.3)'
                }}
              >
                Back to SMS Dashboard
              </button>
            </>
          )}

          {topupPrompt.status === 'failed' && (
            <>
              <div style={{
                width: 90, height: 90, borderRadius: '50%',
                background: '#FEF2F2', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                border: '3px solid #EF4444', marginBottom: 24
              }}>
                <div style={{ fontSize: 44, color: '#EF4444', fontWeight: 'bold' }}>&times;</div>
              </div>

              <h3 style={{ fontSize: 24, fontWeight: 800, color: '#1C1917', margin: '0 0 12px 0' }}>
                Top-up Not Completed
              </h3>

              <p style={{ fontSize: 15, color: '#57534E', lineHeight: 1.6, margin: '0 0 28px' }}>
                {topupPrompt.message || 'The mobile money PIN request timed out or was rejected on your phone.'}
                <br />
                <span style={{ fontSize: 13, color: '#991B1B', marginTop: 8, display: 'block' }}>
                  Ensure your phone is near you, unlocked, has sufficient Mobile Money balance, and you entered the correct PIN.
                </span>
              </p>

              <div style={{ display: 'flex', gap: 12, width: '100%' }}>
                <button
                  onClick={dismiss}
                  style={{
                    flex: 1, height: 50, borderRadius: 14,
                    background: '#F5F5F4', color: '#57534E', fontWeight: 700,
                    border: 'none', cursor: 'pointer', fontSize: 14
                  }}
                >
                  Close
                </button>
                <button
                  onClick={() => {
                    const credits = topupPrompt.credits;
                    const phone = topupPrompt.phone;
                    dismiss();
                    setMomoNumber(phone);
                    openBuySheet(credits);
                  }}
                  style={{
                    flex: 1, height: 50, borderRadius: 14,
                    background: '#F97316', color: 'white', fontWeight: 700,
                    border: 'none', cursor: 'pointer', fontSize: 14,
                    boxShadow: '0 6px 18px rgba(249,115,22,0.3)'
                  }}
                >
                  Try Again
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
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

  const adminDisplayName = adminProfile?.full_name || sessionUser?.email?.split('@')[0] || 'Admin Officer';
  const adminInitials = adminDisplayName.split(/\s+/).slice(0, 2).map((part: string) => part[0]).join('').toUpperCase() || 'AD';
  const activeNavItem = ADMIN_NAV_ITEMS.find((item) => item.key === activeTab) || ADMIN_NAV_ITEMS[0];

  const navigateAdmin = (tab: AdminConsoleTab) => {
    const destination = ADMIN_NAV_ITEMS.find((item) => item.key === tab);
    if (!destination) return;
    setActiveTab(tab);
    if (window.location.pathname !== destination.href) router.push(destination.href);
  };

  const renderAdminNavItem = (item: AdminNavigationItem, mobile = false) => {
    const Icon = item.Icon;
    const isActive = activeTab === item.key;
    const badge = item.key === 'approvals' ? pendingMembersList.length
      : item.key === 'loans' ? pendingLoans.length
      : 0;

    return (
      <button
        key={`${mobile ? 'mobile-' : ''}${item.key}`}
        type="button"
        className={`${mobile ? styles.mobileNavButton : styles.navButton} ${isActive ? (mobile ? styles.mobileNavButtonActive : styles.navButtonActive) : ''}`}
        onClick={() => navigateAdmin(item.key)}
        aria-current={isActive ? 'page' : undefined}
      >
        <span className={styles.navIcon}><Icon size={16} strokeWidth={1.9} /></span>
        <span className={styles.navText}>{item.label}</span>
        {badge > 0 && <span className={styles.navBadge}>{badge}</span>}
      </button>
    );
  };

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
    <div className={styles.appShell}>
      <aside className={styles.sidebar} aria-label="Admin workspace navigation">
        <div className={styles.brand}>
          <span className={styles.brandMark}><Building2 size={18} strokeWidth={2.2} /></span>
          <span>Kunity</span>
          <span className={styles.brandTag}>ADMIN</span>
        </div>
        <div className={styles.navLabel}>WORKSPACE</div>
        <nav className={styles.nav}>
          {ADMIN_NAV_ITEMS.map((item) => renderAdminNavItem(item))}
        </nav>
        <div className={styles.sidebarOrg} title={`${saccoName} · ${tenantCode}`}>
          <span className={styles.orgMark}><Building2 size={15} /></span>
          <div className={styles.orgText}>
            <strong>{saccoName}</strong>
            <small><i className={styles.statusDot} /> Active workspace</small>
          </div>
        </div>
      </aside>

      <div className={styles.mainShell}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}>
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <strong>{activeNavItem.label}</strong>
          </div>
          <div className={styles.topbarActions}>
            {activeTab === 'overview' && (
              <label className={styles.searchBox}>
                <Search size={15} aria-hidden="true" />
                <input
                  aria-label="Search recent activity"
                  placeholder="Search activity..."
                  value={overviewSearchQuery}
                  onChange={(event) => setOverviewSearchQuery(event.target.value)}
                />
              </label>
            )}
            {activeTab === 'members' && (
              <label className={styles.searchBox}>
                <Search size={15} aria-hidden="true" />
                <input
                  aria-label="Search members"
                  placeholder="Search members..."
                  value={searchMemberQuery}
                  onChange={(event) => setSearchMemberQuery(event.target.value)}
                />
              </label>
            )}
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => fetchAdminData()}
              title="Refresh live tenant data"
              aria-label="Refresh dashboard data"
            >
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              className={`${styles.iconButton} ${styles.signOutButton}`}
              onClick={async () => {
                await supabase.auth.signOut();
                router.push('/auth');
              }}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={16} />
            </button>
            <span className={styles.profileAvatar} title={adminDisplayName} aria-label={`Signed in as ${adminDisplayName}`}>
              {adminInitials}
            </span>
          </div>
        </header>

        <nav className={styles.mobileNav} aria-label="Admin workspace navigation">
          {ADMIN_NAV_ITEMS.map((item) => renderAdminNavItem(item, true))}
        </nav>

        <main className={`${styles.pageContent} ${activeTab === 'sms' ? styles.pageContentSms : ''}`}>
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

        {activeTab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{
            background: T.card,
            borderRadius: 24,
            padding: '22px 24px',
            boxShadow: '0 4px 24px rgba(5,7,26,0.06), 0 1px 4px rgba(5,7,26,0.04)',
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16
          }}>
            <div>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800, color: T.cMid }}>
                Records &amp; Compliance
              </div>
              <h2 style={{ fontSize: 20, fontWeight: 900, margin: '4px 0 0', color: T.text }}>
                Download SACCO Books
              </h2>
              <p style={{ fontSize: 13, color: T.sub, margin: '4px 0 0', maxWidth: 520 }}>
                Full exports of this SACCO&apos;s records as CSV for Excel or Google Sheets — ledgers, deposits, members, loans, savings and the SMS log.
              </p>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {([
                { key: 'ledger', label: 'General Ledger' },
                { key: 'deposits', label: 'Deposits & Payments' },
                { key: 'members', label: 'Member Register' },
                { key: 'loans', label: 'Loans Book' },
                { key: 'savings', label: 'Savings Accounts' },
                { key: 'sms', label: 'SMS Log' },
              ] as const).map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => downloadReport(key)}
                  disabled={exportingReport !== null}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 7,
                    padding: '10px 14px', borderRadius: 12,
                    background: exportingReport === key ? T.blueLt : T.cardWarm,
                    color: T.cRich, fontWeight: 700, fontSize: 13,
                    border: '1px solid rgba(22,119,255,0.25)',
                    cursor: exportingReport !== null ? 'wait' : 'pointer',
                  }}
                >
                  {exportingReport === key
                    ? <Loader2 size={15} className="animate-spin" />
                    : <Download size={15} />}
                  {label}
                </button>
              ))}
            </div>
          </div>
          <AdminOverview
            saccoName={saccoName}
            greeting={greeting}
            stats={stats}
            pendingMemberCount={pendingMembersList.length}
            recentTransactions={recentTransactions}
            savingsProductCount={savingsProducts.length}
            smsBalance={smsBalance}
            smsLowBalance={smsLowBalance}
            activitySearch={overviewSearchQuery}
            hideBalances={hideBalances}
            onToggleBalances={() => setHideBalances((current) => !current)}
            onNavigate={navigateAdmin}
          />
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
                  New Members Awaiting Activation
                </h2>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', marginTop: 4, margin: 0, maxWidth: 540 }}>
New members become active automatically when they pay the activation fee. Decline blocks an applicant, so a later payment will not activate them.
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
                              backgroundColor: 'rgba(22,119,255,0.12)', color: T.cMid
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
                      </div>
                    </div>

                    {/* Member Details Breakdown Pill Grid */}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                      gap: 12,
                      backgroundColor: T.cardWarm,
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
                    All applicants for <strong>{saccoName}</strong> have been reviewed. When new members sign up, they will appear here.
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
                      border: `1px solid ${T.border}`, backgroundColor: T.cardWarm,
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

                      return (
                        <tr key={m.id} style={{ borderBottom: `1px solid ${T.border}`, backgroundColor: idx % 2 === 0 ? 'white' : T.cardWarm }}>
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
                              backgroundColor: isActive ? `${T.green}15` : isPending ? 'rgba(22,119,255,0.15)' : `${T.red}15`,
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
                        <span style={{ fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 6, backgroundColor: 'rgba(22,119,255,0.1)', color: T.cMid }}>
                          Pending
                        </span>
                      </div>

                      <div style={{ backgroundColor: T.cardWarm, borderRadius: 16, padding: '14px 16px', border: `1px solid ${T.border}`, marginTop: 14 }}>
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
          <AdminSmsWorkspace
            saccoName={saccoName}
            membersCount={members.length}
            smsBalance={smsBalance}
            smsLowBalance={smsLowBalance}
            smsRate={smsRate}
            smsHistory={smsHistory}
            smsRecipientType={smsRecipientType}
            onRecipientTypeChange={setSmsRecipientType}
            singleRecipientPhone={singleRecipientPhone}
            onSingleRecipientPhoneChange={setSingleRecipientPhone}
            customPhoneList={customPhoneList}
            onCustomPhoneListChange={setCustomPhoneList}
            smsMessageText={smsMessageText}
            onSmsMessageTextChange={setSmsMessageText}
            isSendingSms={isSendingSms}
            onSendBroadcast={handleSendBroadcast}
            onBuyAmount={openBuySheet}
          />
        )}

        {/* ───────────────────────────────────────────────────────────
            TAB 6: TENANT CONFIGURATION & MEMBER JOIN
        ─────────────────────────────────────────────────────────── */}
        {activeTab === 'tenant' && (
          <div style={{ backgroundColor: T.card, borderRadius: 24, padding: 32, border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div>
              <h3 style={{ fontFamily: 'var(--font-display), sans-serif', fontSize: 20, fontWeight: 900, color: T.text, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                <Shield size={24} color={T.cMid} />
                <span>Tenant Isolation & Cooperative Settings</span>
              </h3>
              <p style={{ fontSize: 13, color: T.sub, marginTop: 4, margin: 0 }}>
                Technical identifiers, database schema partitioning, and the member join link.
              </p>
            </div>

            <ProductsSettings orgId={orgId} onToast={setToastMessage} />

            <div style={{ backgroundColor: T.cardWarm, borderRadius: 16, padding: '20px 24px', border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 12 }}>
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
              
              <div style={{ backgroundColor: T.cardWarm, borderRadius: 16, padding: '16px 20px', border: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 800 }}>Tenant Name</span>
                <div style={{ fontSize: 16, fontWeight: 900, color: T.text, marginTop: 4 }}>{saccoName}</div>
                <span style={{ fontSize: 11, color: T.sub, marginTop: 2 }}>Organization ID: {orgId}</span>
              </div>

              <div style={{ backgroundColor: T.cardWarm, borderRadius: 16, padding: '16px 20px', border: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 800 }}>Tenant Code</span>
                <div style={{ fontSize: 16, fontWeight: 900, color: T.cDeep, marginTop: 4 }}>{tenantCode}</div>
                <span style={{ fontSize: 11, color: T.sub, marginTop: 2 }}>Scoped database prefix</span>
              </div>

              <div style={{ backgroundColor: T.cardWarm, borderRadius: 16, padding: '16px 20px', border: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 800 }}>Currency Standard</span>
                <div style={{ fontSize: 16, fontWeight: 900, color: T.text, marginTop: 4 }}>UGX (Ugandan Shillings)</div>
                <span style={{ fontSize: 11, color: T.green, marginTop: 2 }}>Mobile money integrated</span>
              </div>

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
                <div style={{ backgroundColor: T.cardWarm, borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>Phone</span>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>{selectedMemberModal.phone || 'N/A'}</div>
                </div>
                <div style={{ backgroundColor: T.cardWarm, borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>Email</span>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>{selectedMemberModal.email || 'N/A'}</div>
                </div>
                <div style={{ backgroundColor: T.cardWarm, borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>National ID (NIN)</span>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>{selectedMemberModal.national_id || 'Not specified'}</div>
                </div>
                <div style={{ backgroundColor: T.cardWarm, borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 10, color: T.ghost, textTransform: 'uppercase', fontWeight: 700 }}>Date of Birth</span>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginTop: 2 }}>{selectedMemberModal.date_of_birth || 'N/A'}</div>
                </div>
              </div>

              <div style={{ backgroundColor: T.cardWarm, borderRadius: 14, padding: 14, border: `1px solid ${T.border}` }}>
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
                    backgroundColor: selectedMemberModal.status === 'active' ? `${T.green}20` : 'rgba(22,119,255,0.2)',
                    color: selectedMemberModal.status === 'active' ? T.green : T.cMid
                  }}>
                    {selectedMemberModal.status || 'Pending'}
                  </span>
                </div>
              </div>

              {/* Action Buttons in Modal */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                {selectedMemberModal.status === 'active' && (
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
          SHEET: MOBILE MONEY SMS CHECKOUT
          Pixel-for-pixel copy of the member portal's deposit sheet
          (app/member/page.tsx, activeModal === 'deposit'): same cream
          surface, 36px top radius, tile + serif heading, phone field,
          2×2 amount grid, CONFIRM & PAY, CANCEL and info line.
          Only the labels and the bundle content differ.
      ───────────────────────────────────────────────────────────── */}
      {showBuyModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 100,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center'
        }}>
          <div style={{
            background: '#F3E8D5', width: '100%', maxWidth: 400,
            borderTopLeftRadius: 36, borderTopRightRadius: 36,
            padding: '36px 28px 24px', animation: 'kunitySmsSheetUp 0.3s ease-out',
            display: 'flex', flexDirection: 'column',
            boxShadow: '0 -10px 40px rgba(0,0,0,0.2)'
          }}>
            <div style={{ textAlign: 'center', marginBottom: 28, position: 'relative' }}>
              <button onClick={closeBuySheet} aria-label="Close" style={{ position: 'absolute', top: -16, right: -4, background: 'none', border: 'none', color: '#978673', fontSize: 24, cursor: 'pointer' }}>&times;</button>
              <div style={{
                width: 52, height: 42, background: '#EAE0CC', borderRadius: 12, margin: '0 auto 16px',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                <CreditCard size={22} color="#A76C47" />
              </div>
              <h3 style={{ fontSize: 22, fontWeight: 700, color: '#3A271C', margin: '0 0 6px 0', fontFamily: 'serif' }}>
                Buy SMS Credits
              </h3>
              <p style={{ fontSize: 13, color: '#887563', margin: 0 }}>
                Add SMS credits via Mobile Money
              </p>
            </div>

            <form
              onSubmit={(e) => { e.preventDefault(); handleBuySms(); }}
              style={{ display: 'flex', flexDirection: 'column', gap: 20 }}
            >
              <div>
                <label style={{ fontSize: 11, fontWeight: 800, color: '#A5927D', letterSpacing: '0.05em', marginBottom: 8, display: 'block', textTransform: 'uppercase' }}>
                  Mobile Money Number
                </label>
                <div style={{
                  display: 'flex', alignItems: 'center', background: '#FCFAEE', borderRadius: 14,
                  padding: '0 16px', height: 54, border: '1px solid #EAE0CC'
                }}>
                  <Phone size={18} color="#A5927D" />
                  <input
                    type="tel"
                    required
                    value={momoNumber}
                    onChange={e => setMomoNumber(e.target.value)}
                    placeholder="07..."
                    disabled={isProcessingBuy}
                    style={{
                      background: 'transparent', border: 'none', outline: 'none',
                      width: '100%', padding: '0 12px', fontSize: 16, color: '#3A271C', fontWeight: 600
                    }}
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="buy-sms-amount"
                  style={{ fontSize: 11, fontWeight: 800, color: '#A5927D', letterSpacing: '0.05em', marginBottom: 8, display: 'block', textTransform: 'uppercase' }}
                >
                  Amount (UGX)
                </label>
                <div style={{
                  display: 'flex', alignItems: 'center', background: '#FCFAEE', borderRadius: 14,
                  padding: '0 16px', height: 54, border: '1px solid #EAE0CC'
                }}>
                  <input
                    id="buy-sms-amount"
                    type="number"
                    inputMode="numeric"
                    min={buyBounds?.min}
                    max={buyBounds?.max}
                    step={1}
                    required
                    value={buyAmount}
                    onChange={e => setBuyAmount(e.target.value)}
                    disabled={isProcessingBuy}
                    aria-describedby="buy-sms-total"
                    style={{
                      background: 'transparent', border: 'none', outline: 'none',
                      width: '100%', padding: '4px 0', fontSize: 16, color: '#3A271C', fontWeight: 700
                    }}
                  />
                </div>
                <p id="buy-sms-total" style={{ margin: '8px 2px 0', fontSize: 12, fontWeight: 700, color: '#887563' }}>
                  {UGX(smsRate)} per SMS
                  {quotedBuyCredits !== null ? ` · You get ${quotedBuyCredits.toLocaleString('en-UG')} SMS` : ''}
                  {quotedBuyCharge !== null && quotedBuyCharge !== parsedBuyAmount
                    ? ` · Charged ${UGX(quotedBuyCharge)}`
                    : ''}
                </p>
              </div>

              <div style={{ marginTop: 8 }}>
                <button disabled={isProcessingBuy} type="submit" style={{
                  width: '100%', height: 56, borderRadius: 16, background: '#2B1A11', color: '#FCFAEE',
                  fontSize: 14, fontWeight: 800, border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  letterSpacing: '0.05em', opacity: isProcessingBuy ? 0.7 : 1,
                  boxShadow: '0 8px 16px rgba(43,26,17,0.2)'
                }}>
                  {isProcessingBuy ? 'PROCESSING...' : 'CONFIRM & PAY'} <CheckCircle2 size={16} />
                </button>
                <button type="button" onClick={closeBuySheet} style={{
                  width: '100%', padding: '16px 0', background: 'none', border: 'none',
                  fontSize: 12, fontWeight: 800, color: '#A5927D', cursor: 'pointer',
                  letterSpacing: '0.05em', marginTop: 4
                }}>
                  CANCEL
                </button>
              </div>

              <div style={{ textAlign: 'center', fontSize: 11, color: '#A5927D', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', border: '1px solid #A5927D', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9 }}>i</span>
                You will receive a PIN prompt on your phone.
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          OVERLAY: IMMERSIVE MOBILE MONEY PIN PROMPT
          Same pending → success → failed journey as the member portal.
      ───────────────────────────────────────────────────────────── */}
      {renderTopupOverlay()}

      <style>{`
        @keyframes kunitySmsSheetUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        @keyframes kunitySmsPulse {
          0% { transform: scale(0.9); opacity: 0.8; }
          50% { transform: scale(1.2); opacity: 0.2; }
          100% { transform: scale(0.9); opacity: 0.8; }
        }
      `}</style>

        </main>
      </div>
    </div>
  );
}
