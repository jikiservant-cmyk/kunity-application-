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
    if (searchParams.get('mode') === 'register') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMode('register');
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
  const [selectedProductId, setSelectedProductId] = useState('');
  const [savingProducts, setSavingProducts] = useState<any[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [registeredUserId, setRegisteredUserId] = useState<string | null>(null);

  const [organizations, setOrganizations] = useState<any[]>([]);

  const loadOrgs = async () => {
    let { data: orgs, error } = await supabase.schema('kuntiy').from('organizations').select('id, name');
    
    if (!orgs || orgs.length === 0) {
      const { data: newOrg } = await supabase.schema('kuntiy').from('organizations').insert({
        name: 'Default Sacco',
        code: 'DEF',
        email: 'hello@def.com'
      }).select('id, name').single();
      if (newOrg) {
        orgs = [newOrg];
      }
    }
    
    if (orgs && orgs.length > 0) {
      setOrganizations(orgs);
      setOrgId(orgs[0].id);
    } else {
      setOrganizations([]);
      setError("Could not load cooperatives. " + (error?.message || ""));
    }
  };

  useEffect(() => {
    if (step === 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadOrgs();
    }
  }, [step]);


  useEffect(() => {
    async function loadProducts() {
      if (!orgId) {
        setSavingProducts([]);
        return;
      }
      
      const { data: products } = await supabase.schema('kuntiy').from('savings_products').select('*').eq('organization_id', orgId);
      
      if (products && products.length > 0) {
        setSavingProducts(products);
        setSelectedProductId(products[0].id);
      } else {
        const { data: newProduct } = await supabase.schema('kuntiy').from('savings_products').insert({
          organization_id: orgId,
          name: 'Standard Savings',
          code: 'STD',
          interest_rate: 5.0,
          minimum_balance: 0,
          allow_deposits: true,
          allow_withdrawals: true
        }).select('*').single();
        if (newProduct) {
          setSavingProducts([newProduct]);
          setSelectedProductId(newProduct.id);
        }
      }
    }
    loadProducts();
  }, [orgId]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (mode === 'register') {
        if (step === 1) {
          // Proceed to step 2 to collect more information including Sacco
          setStep(2);
          setLoading(false);
          return;
        } else if (step === 2) {
          if (!orgId) {
            setError("Please select a Cooperative / Sacco to join.");
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
            
            // Insert into public.admin_profiles (this triggers sync_member_to_kuntiy_members)
            const { error: profileError } = await supabase
              .schema('public')
              .from('admin_profiles')
              .upsert({ 
                id: data.user.id,
                full_name: fullName,
                role: 'member',
                app_type: 'sacco',
                tenant_id: orgId
              }, { onConflict: 'id' });
              
            if (profileError) console.error("Profile creation error:", profileError);

            // Update kuntiy.members (initially created by public.admin_profiles trigger)
            const { data: member, error: memberError } = await supabase.schema('kuntiy').from('members').update({
              profile_id: data.user.id,
              first_name: fullName.split(' ')[0] || fullName,
              last_name: fullName.split(' ').slice(1).join(' ') || '',
              email: email,
              phone: phone,
              gender: gender,
              date_of_birth: dateOfBirth || null,
              national_id: nationalId,
              address: address,
              next_of_kin_name: nextOfKinName,
              next_of_kin_phone: nextOfKinPhone
            }).eq('id', data.user.id).select('id').single();

            if (memberError) console.error("Member creation error:", memberError);

            if (member && selectedProductId) {
              const selectedProduct = savingProducts.find(p => p.id === selectedProductId);
              const productName = selectedProduct?.name || 'Main Wallet';
              
              // 1. Try to find existing active member_savings linked to an active account
              const { data: existingMs } = await supabase.schema('kuntiy')
                .from('member_savings')
                .select('id, account_id, accounts!inner(is_active, deleted_at)')
                .eq('organization_id', orgId)
                .eq('member_id', member.id)
                .eq('savings_product_id', selectedProductId)
                .eq('status', 'active')
                .is('deleted_at', null)
                .eq('accounts.is_active', true)
                .is('accounts.deleted_at', null)
                .limit(1)
                .maybeSingle();

              if (!existingMs) {
                // 2. Insert new account (inactive initially)
                const { data: newAccount, error: accountError } = await supabase.schema('kuntiy').from('accounts').insert({
                  organization_id: orgId,
                  member_id: member.id,
                  name: productName,
                  account_category: 'asset',
                  code: `WAL-${Math.floor(Math.random()*10000)}`,
                  is_active: false,
                  cached_balance: 0.00
                }).select('id').single();
                
                if (accountError) {
                  console.error("Account creation error:", accountError);
                } else if (newAccount) {
                  // 3. Create member_savings connection (inactive initially)
                  const { error: msError } = await supabase.schema('kuntiy').from('member_savings').insert({
                    organization_id: orgId,
                    member_id: member.id,
                    savings_product_id: selectedProductId,
                    account_id: newAccount.id,
                    status: 'inactive'
                  });
                  if (msError) console.error("Member savings creation error:", msError);
                }
              }
            }
            router.push('/member');
          }
        }
      } else {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (signInError) throw signInError;
        
        if (data.user) {
          const { data: profile } = await supabase
            .schema('public')
            .from('admin_profiles')
            .select('role')
            .eq('id', data.user.id)
            .single();
            
          if (profile?.role === 'sacco_admin' || profile?.role === 'super_admin' || profile?.role === 'system_admin') {
            router.push('/admin');
          } else {
            router.push('/member');
          }
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
                  <label className="text-sm font-semibold" style={{ color: T.text }}>National ID (Optional)</label>
                  <input
                    type="text"
                    value={nationalId}
                    onChange={(e) => setNationalId(e.target.value)}
                    className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all focus:ring-4"
                    style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                    placeholder="CMXXXXXXXXXXXX"
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

                {organizations.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-semibold" style={{ color: T.text }}>Select Cooperative / Sacco</label>
                    <div className="relative">
                      <select
                        value={orgId || ''}
                        onChange={(e) => setOrgId(e.target.value)}
                        required
                        className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all appearance-none cursor-pointer focus:ring-4"
                        style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                      >
                        {organizations.map(org => (
                          <option key={org.id} value={org.id}>
                            {org.name}
                          </option>
                        ))}
                      </select>
                      <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none" style={{ color: T.sub }}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 bg-blue-50 text-blue-600 text-sm rounded-2xl border border-blue-100 font-medium">
                    Loading cooperatives...
                  </div>
                )}

                {savingProducts.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-semibold" style={{ color: T.text }}>Select Saving Plan</label>
                    <div className="relative">
                      <select
                        value={selectedProductId}
                        onChange={(e) => setSelectedProductId(e.target.value)}
                        required
                        className="w-full px-4 py-3.5 rounded-2xl outline-none transition-all appearance-none cursor-pointer focus:ring-4"
                        style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, color: T.text, outline: 'none' }}
                      >
                        {savingProducts.map(product => (
                          <option key={product.id} value={product.id}>
                            {product.name} ({product.interest_rate}% interest)
                          </option>
                        ))}
                      </select>
                      <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none" style={{ color: T.sub }}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                      </div>
                    </div>
                  </div>
                )}
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
