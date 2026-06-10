'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import SetupRequired from '@/components/SetupRequired';
import { Loader2, ArrowRight, ShieldCheck, Wallet } from 'lucide-react';
import Link from 'next/link';

export default function LandingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }

    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        // Fetch role to redirect to correct dashboard
        const { data: profile } = await supabase
          .schema('public')
          .from('admin_profiles')
          .select('role')
          .eq('id', session.user.id)
          .single();
          
        if (profile?.role === 'sacco_admin' || profile?.role === 'super_admin') {
          router.replace('/admin');
        } else {
          router.replace('/member');
        }
      } else {
        setLoading(false);
      }
    };

    checkSession();
  }, [router]);

  if (!isSupabaseConfigured()) {
    return <SetupRequired />;
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

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
    sub:     "#6B7280",
    ghost:   "#9CA3AF",
    border:  "#E4E9F4",
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: T.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif" }}>
      
      <div style={{ position: 'relative', zIndex: 10, maxWidth: 1000, width: '100%', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <div style={{ width: 80, height: 80, background: `linear-gradient(135deg, ${T.cDeep}, ${T.cRich})`, borderRadius: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 12px 32px rgba(12,26,104,0.25)` }}>
            <Wallet size={40} color={T.goldLt} />
          </div>
        </div>
        
        <h1 style={{ fontSize: 'clamp(48px, 6vw, 72px)', fontWeight: 800, color: T.cDeep, letterSpacing: '-0.04em', lineHeight: 1.1 }}>
          SaccoConnect
        </h1>
        
        <p style={{ fontSize: 'clamp(18px, 2vw, 22px)', color: T.sub, maxWidth: 640, margin: '0 auto', lineHeight: 1.5 }}>
          The modern platform for savings and credit cooperative organizations. Manage wallets, track loans, and monitor transactions in real-time.
        </p>
        
        <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Link 
              href="/auth?mode=login" 
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 32px', backgroundColor: T.blue, color: 'white', fontWeight: 700, borderRadius: 16, transition: 'all 0.2s', boxShadow: `0 8px 24px rgba(34, 98, 240, 0.3)`, textDecoration: 'none' }}
            >
              Sign In to Dashboard
              <ArrowRight size={20} />
            </Link>
            <Link 
              href="/auth?mode=register" 
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 32px', backgroundColor: 'white', color: T.blue, fontWeight: 700, borderRadius: 16, border: `1px solid ${T.border}`, transition: 'all 0.2s', boxShadow: `0 4px 12px rgba(5,7,26,0.05)`, textDecoration: 'none' }}
            >
              Register as Member
            </Link>
          </div>
        </div>

        <div style={{ marginTop: 64, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24, textAlign: 'left' }}>
          <div style={{ backgroundColor: T.card, padding: 32, borderRadius: 28, border: `1px solid ${T.border}`, boxShadow: `0 8px 32px rgba(5,7,26,0.04)` }}>
            <Wallet size={32} color={T.blue} style={{ marginBottom: 20 }} />
            <h3 style={{ fontWeight: 700, color: T.text, marginBottom: 8, fontSize: 18 }}>Digital Wallets</h3>
            <p style={{ fontSize: 15, color: T.sub, lineHeight: 1.5 }}>Instant deposits and withdrawals tracked securely.</p>
          </div>
          <div style={{ backgroundColor: T.card, padding: 32, borderRadius: 28, border: `1px solid ${T.border}`, boxShadow: `0 8px 32px rgba(5,7,26,0.04)` }}>
            <ShieldCheck size={32} color={T.green} style={{ marginBottom: 20 }} />
            <h3 style={{ fontWeight: 700, color: T.text, marginBottom: 8, fontSize: 18 }}>Loan Management</h3>
            <p style={{ fontSize: 15, color: T.sub, lineHeight: 1.5 }}>Apply for loans and track approvals in real-time.</p>
          </div>
          <div style={{ backgroundColor: T.card, padding: 32, borderRadius: 28, border: `1px solid ${T.border}`, boxShadow: `0 8px 32px rgba(5,7,26,0.04)` }}>
            <svg style={{ width: 32, height: 32, color: T.amber, marginBottom: 20 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
            <h3 style={{ fontWeight: 700, color: T.text, marginBottom: 8, fontSize: 18 }}>Live Transactions</h3>
            <p style={{ fontSize: 15, color: T.sub, lineHeight: 1.5 }}>Complete monitoring of all cooperative activities.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
