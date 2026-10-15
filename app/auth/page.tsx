'use client';

import { useState, Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Wallet, Loader2 } from 'lucide-react';
import Link from 'next/link';

function AuthContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<'login' | 'register'>('login');

  useEffect(() => {
    if (searchParams.get('mode') === 'register' || searchParams.get('sacco')) {
      queueMicrotask(() => setMode('register'));
    }
  }, [searchParams]);
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState('m');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [address, setAddress] = useState('');
  const [nextOfKinName, setNextOfKinName] = useState('');
  const [nextOfKinPhone, setNextOfKinPhone] = useState('');
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [registeredUserId, setRegisteredUserId] = useState<string | null>(null);

  // Join-link registration: /auth?sacco=<code>. The code is resolved by the
  // server to one SACCO, which is then locked for the member. The old public
  // list of all SACCOs has been removed.
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [orgName, setOrgName] = useState('');

  useEffect(() => {
    const code = searchParams.get('sacco');
    if (!code) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/organizations/resolve?code=${encodeURIComponent(code)}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !data.organization) {
          setError(data.error || 'This join link is not valid. Ask your SACCO for a new link.');
          setOrgId(null);
          setOrgName('');
          setJoinCode(null);
        } else {
          setOrgId(data.organization.id);
          setOrgName(data.organization.name);
          setJoinCode(code.trim().toUpperCase().replace(/[\s-]/g, ''));
          setError('');
        }
      } catch {
        if (!cancelled) setError('Could not check this join link. Please try again.');
      }
    })();
    return () => { cancelled = true; };
  }, [searchParams]);




  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (mode === 'register') {
        if (!orgId || !joinCode) {
          setError("You need your SACCO's join link to register. Ask your SACCO admin to send it to you.");
          setLoading(false);
          return;
        }
        const phoneRegex = /^0[0-9]{9}$/;
        const nationalIdRegex = /^(CM|CF|RM|RF)[A-Z0-9]{12}$/i;

        if (step === 1) {
          // Validate phone number to be 10 digits starting with 0
          if (!phoneRegex.test(phone.trim())) {
            setError("Phone Number must be exactly 10 digits starting with 0 (e.g., 0772123456) for Ugandan networks.");
            setLoading(false);
            return;
          }
          // Proceed to step 2 to collect more information including Sacco
          setStep(2);
          setLoading(false);
          return;
        } else if (step === 2) {
          if (!orgId || !joinCode) {
            setError("You need your SACCO's join link to register.");
            setLoading(false);
            return;
          }

          // Validate National ID is mandatory and in Ugandan format (14 characters)
          if (!nationalId.trim()) {
            setError("National ID is required.");
            setLoading(false);
            return;
          }

          if (!nationalIdRegex.test(nationalId.trim())) {
            setError("National ID must be in the Ugandan format (14 characters starting with CM, CF, RM, or RF, e.g., CM850123456XYZ).");
            setLoading(false);
            return;
          }

          // Validate next of kin phone if provided
          if (nextOfKinPhone && !phoneRegex.test(nextOfKinPhone.trim())) {
            setError("Next of Kin Phone Number must be exactly 10 digits starting with 0 (e.g., 0772123456).");
            setLoading(false);
            return;
          }

          // Step 1 & 2 complete, perform signup and database insertion
          const { data, error: signUpError } = await supabase.auth.signUp({
            email,
            password,
            options: {
              data: {
                tenant_id: orgId,
                full_name: fullName,
                role: 'member',
                app_type: 'sacco'
              }
            }
          });

          if (signUpError) throw signUpError;
          
          if (data.user) {
            setRegisteredUserId(data.user.id);
            
            // Resolve active session access token
            let token = data.session?.access_token;
            if (!token) {
              const { data: sessionData } = await supabase.auth.getSession();
              token = sessionData.session?.access_token;
            }

            // Delegate profile and member creation to the backend
            // with authenticated Bearer token and tenant validation
            const setupResponse = await fetch('/api/auth/profile', {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {})
              },
              body: JSON.stringify({
                token,
                userId: data.user.id,
                fullName,
                orgId,
                joinCode,
                email,
                phone,
                gender,
                dateOfBirth,
                nationalId,
                address,
                nextOfKinName,
                nextOfKinPhone
              })
            });

            if (!setupResponse.ok) {
              let errMessage = "Failed to finalize account setup";
              try {
                const errData = await setupResponse.json();
                console.error("Profile setup API error:", errData);
                errMessage = errData?.error || errMessage;
              } catch (e) {
                console.error("Profile setup API error (non-JSON response):", await setupResponse.text());
              }
              throw new Error(errMessage);
            }
            
            // Wait for session to be fully confirmed before redirect
            await supabase.auth.refreshSession();
            router.refresh();
            
            setTimeout(() => {
              router.push('/member');
            }, 500);
          }
        }
      } else {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (signInError) throw signInError;
        
        if (data.user) {
          // Fetch the actual role to redirect cleanly.
          // SECURITY: query the authoritative admin_profiles table first.
          // user_metadata is client-writable and must never be trusted for
          // authorization decisions (the middleware re-checks authoritatively
          // on every page navigation, so this only affects the redirect target).
          let isSaccoAdmin = false;
          let role: string | undefined;

          try {
            const { data: profile } = await supabase
              .schema('public')
              .from('admin_profiles')
              .select('role')
              .eq('id', data.user.id)
              .maybeSingle();

            role = profile?.role;
          } catch (profileErr) {
            console.warn("⚠️ Failed to fetch profile role on login:", profileErr);
          }

          // Fallback to metadata for redirect UX only — never a security decision.
          if (!role) {
            role = data.user.user_metadata?.role;
          }

          role = role || 'member';
          isSaccoAdmin = ['sacco_admin', 'system_admin', 'super_admin'].includes(role);

          await supabase.auth.refreshSession();
          router.refresh();

          setTimeout(() => {
            if (isSaccoAdmin) {
              router.push('/admin');
            } else {
              router.push('/member');
            }
          }, 500);
        }
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred during authentication.');
    } finally {
      setLoading(false);
    }
  };

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
    <div className="min-h-screen flex items-center justify-center p-4 md:p-8 font-sans" style={{ backgroundColor: T.bg }}>
      <div className="w-full max-w-[440px] rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.04)] border" style={{ backgroundColor: T.bg, borderColor: T.border, overflow: 'hidden' }}>
        <div className="relative p-10 text-center overflow-hidden" style={{ background: `linear-gradient(145deg, ${T.cDeep} 0%, ${T.cRich} 55%, ${T.cMid} 100%)` }}>
          <div className="absolute -top-16 -right-12 w-48 h-48 bg-white/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-amber-500 to-transparent opacity-80" />
          
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/10 border border-white/20 rounded-2xl mb-6">
            <Wallet className="w-8 h-8" style={{ color: T.goldLt }} />
          </div>
          <h2 className="text-2xl font-bold text-white tracking-tight mb-2">
            {mode === 'login' ? 'Welcome Back' : (step === 1 ? 'Create Account' : 'Select Sacco')}
          </h2>
          <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.7)' }}>
            {mode === 'login' 
              ? 'Sign in to access your wallet and cooperative finances.' 
              : (step === 1 ? 'Start managing your cooperative finances today.' : 'Choose a registered cooperative to join.')}
          </p>
        </div>

        <div className="p-8">
          <form onSubmit={handleAuth} className="flex flex-col gap-5">
            {error && (
              <div className="p-4 bg-red-50 text-red-600 text-sm rounded-2xl border border-red-100 font-medium">
                {error}
              </div>
            )}
            
            {mode === 'register' && step === 1 && (
              <>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-semibold" style={{ color: T.text }}>Full Name</label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all focus:ring-4"
                    style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                    placeholder="John Doe"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-semibold" style={{ color: T.text }}>Phone Number</label>
                  <input
                    type="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all focus:ring-4"
                    style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                    placeholder="+256 700 000 000"
                  />
                </div>
              </>
            )}
            
            {mode === 'register' && step === 2 && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-semibold" style={{ color: T.text }}>Gender</label>
                    <select
                      value={gender}
                      onChange={(e) => setGender(e.target.value)}
                      className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all focus:ring-4"
                      style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                    >
                      <option value="m">Male</option>
                      <option value="f">Female</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-semibold" style={{ color: T.text }}>Date of Birth</label>
                    <input
                      type="date"
                      value={dateOfBirth}
                      onChange={(e) => setDateOfBirth(e.target.value)}
                      className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all focus:ring-4"
                      style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-sm font-semibold" style={{ color: T.text }}>National ID (NIN)</label>
                  <input
                    type="text"
                    required
                    value={nationalId}
                    onChange={(e) => setNationalId(e.target.value)}
                    className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all focus:ring-4"
                    style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                    placeholder="e.g. CM850123456XYZ"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-sm font-semibold" style={{ color: T.text }}>Physical Address (Optional)</label>
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all focus:ring-4"
                    style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                    placeholder="123 Main St, Kampala"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-semibold" style={{ color: T.text }}>Next of Kin Name</label>
                    <input
                      type="text"
                      value={nextOfKinName}
                      onChange={(e) => setNextOfKinName(e.target.value)}
                      className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all focus:ring-4"
                      style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                      placeholder="Jane Doe"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-semibold" style={{ color: T.text }}>Next of Kin Phone</label>
                    <input
                      type="tel"
                      value={nextOfKinPhone}
                      onChange={(e) => setNextOfKinPhone(e.target.value)}
                      className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all focus:ring-4"
                      style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                      placeholder="+256..."
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-sm font-semibold" style={{ color: T.text }}>Cooperative / Sacco</label>
                  <div className="px-4 py-3.5 rounded-2xl font-bold" style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text }}>
                    {orgName || 'Your SACCO'}
                  </div>
                  <span className="text-xs" style={{ color: T.sub }}>You are joining this SACCO through its invite link.</span>
                </div>
              </>
            )}
            
            {((mode === 'register' && step === 1) || mode === 'login') && (
              <>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-semibold" style={{ color: T.text }}>Email Address</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all focus:ring-4"
                    style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                    placeholder="john@example.com"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-sm font-semibold" style={{ color: T.text }}>Password</label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all focus:ring-4"
                    style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                    placeholder="••••••••"
                  />
                </div>
              </>
            )}

            <div className="pt-2">
              <button
                type="submit"
                disabled={loading}
                className="w-full text-white font-semibold py-4 px-4 rounded-2xl disabled:opacity-70 flex justify-center items-center gap-2 transition-all active:scale-[0.98]"
                style={{ backgroundColor: T.blue, boxShadow: `0 8px 24px rgba(34, 98, 240, 0.3)` }}
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {mode === 'login' ? 'Sign In' : (step === 1 ? 'Next Step' : 'Finish Setup')}
              </button>
            </div>
          </form>

          <div className="pt-8 text-center text-sm font-medium" style={{ color: T.sub }}>
            {mode === 'login' ? (
              <div>
                Don&apos;t have an account?{' '}
                <button type="button" onClick={() => { setMode('register'); setStep(1); }} className="hover:opacity-80 transition-opacity font-semibold" style={{ color: T.blue }}>
                  Create one now
                </button>
              </div>
            ) : (
              <div>
                Already have an account?{' '}
                <button type="button" onClick={() => { setMode('login'); setStep(1); }} className="hover:opacity-80 transition-opacity font-semibold" style={{ color: T.blue }}>
                  Sign in instead
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-indigo-600" /></div>}>
      <AuthContent />
    </Suspense>
  );
}
