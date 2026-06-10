'use client';

import { useState, Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Wallet, Loader2 } from 'lucide-react';
import Link from 'next/link';

function AuthContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMode = searchParams.get('mode') === 'register' ? 'register' : 'login';
  
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [savingProducts, setSavingProducts] = useState<any[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [registeredUserId, setRegisteredUserId] = useState<string | null>(null);

  const [organizations, setOrganizations] = useState<any[]>([]);

  const loadOrgs = async () => {
    let { data: orgs } = await supabase.schema('kuntiy').from('organizations').select('id, name');
    
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
    }
  };

  useEffect(() => {
    if (step === 2) {
      loadOrgs();
    }
  }, [step]);


  useEffect(() => {
    async function loadProducts() {
      if (!orgId) {
        setSavingProducts([]);
        return;
      }
      
      const { data: products } = await supabase.schema('kuntiy').from('saving_products').select('*').eq('organization_id', orgId);
      
      if (products && products.length > 0) {
        setSavingProducts(products);
        setSelectedProductId(products[0].id);
      } else {
        const { data: newProduct } = await supabase.schema('kuntiy').from('saving_products').insert({
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
          const { data, error: signUpError } = await supabase.auth.signUp({
            email,
            password,
          });

          if (signUpError) throw signUpError;
          
          if (data.user) {
            setRegisteredUserId(data.user.id);
            const { error: profileError } = await supabase
              .schema('public')
              .from('admin_profiles')
              .upsert({ 
                id: data.user.id, 
                full_name: fullName, 
                email: email,
                role: 'member',
                app_type: 'sacco'
              }, { onConflict: 'id' });
              
            if (profileError) console.error("Profile creation error:", profileError);

            setStep(2);
          }
        } else if (step === 2 && registeredUserId) {
          if (orgId) {
            // Update the user's profile with the tenant_id
            const { error: updateProfileError } = await supabase
              .schema('public')
              .from('admin_profiles')
              .update({ tenant_id: orgId })
              .eq('id', registeredUserId);
              
            if (updateProfileError) console.error("Profile tenant update error:", updateProfileError);

            const { data: member, error: memberError } = await supabase.schema('kuntiy').from('members').insert({
              organization_id: orgId,
              profile_id: registeredUserId,
              member_number: `MEM-${Math.floor(Math.random()*10000)}`,
              first_name: fullName.split(' ')[0] || fullName,
              last_name: fullName.split(' ').slice(1).join(' ') || '',
              email: email
            }).select('id').single();

            if (memberError) console.error("Member creation error:", memberError);

            if (member && selectedProductId) {
              const selectedProduct = savingProducts.find(p => p.id === selectedProductId);
              const { error: accountError } = await supabase.schema('kuntiy').from('accounts').insert({
                organization_id: orgId,
                name: selectedProduct?.name || 'Main Wallet',
                account_category: 'asset',
                code: `WAL-${Math.floor(Math.random()*10000)}`,
                member_id: member.id,
                saving_product_id: selectedProductId,
                cached_balance: 0.00
              });
              
              if (accountError) console.error("Account creation error:", accountError);
            }
          }
          router.push('/member');
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
            
          if (profile?.role === 'sacco_admin' || profile?.role === 'super_admin') {
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
    <div style={{ minHeight: '100vh', backgroundColor: T.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif" }}>
      <div style={{ width: '100%', maxWidth: 440, backgroundColor: T.card, borderRadius: 28, boxShadow: '0 4px 28px rgba(5,7,26,0.08), 0 1px 6px rgba(5,7,26,0.04)', overflow: 'hidden' }}>
        <div style={{ 
          background: `linear-gradient(145deg, ${T.cDeep} 0%, ${T.cRich} 55%, ${T.cMid} 100%)`, 
          padding: '48px 32px', textAlign: 'center', position: 'relative' 
        }}>
          <div style={{ position:"absolute", top:-60, right:-40, width:180, height:180, borderRadius:"50%", background:"rgba(255,255,255,0.04)", pointerEvents:"none" }} />
          <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:`linear-gradient(90deg, transparent, ${T.gold}, transparent)`, opacity:0.6 }} />
          
          <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 64, height: 64, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20, marginBottom: 24 }}>
            <Wallet size={32} color={T.goldLt} />
          </Link>
          <h2 style={{ fontSize: 26, fontWeight: 800, color: 'white', letterSpacing: '-0.02em', marginBottom: 8 }}>
            {mode === 'login' ? 'Welcome Back' : (step === 1 ? 'Join SaccoConnect' : 'Select Sacco')}
          </h2>
          <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 15 }}>
            {mode === 'login' 
              ? 'Enter your credentials to access your wallet.' 
              : (step === 1 ? 'Create an account to start managing your cooperative finances.' : 'Choose a registered cooperative to join.')}
          </p>
        </div>

        <div style={{ padding: '32px' }}>
          <form onSubmit={handleAuth} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {error && (
              <div style={{ padding: 14, backgroundColor: '#FEF2F2', color: '#991B1B', fontSize: 14, borderRadius: 12, border: '1px solid #FEE2E2', fontWeight: 500 }}>
                {error}
              </div>
            )}
            
            {mode === 'register' && step === 1 && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Full Name</label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    style={{ width: '100%', padding: '14px 16px', borderRadius: 14, border: `1px solid ${T.border}`, outline: 'none', fontSize: 15, backgroundColor: '#F9FAFB' }}
                    placeholder="John Doe"
                  />
                </div>
              </>
            )}
            
            {mode === 'register' && step === 2 && (
              <>
                {organizations.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Select Cooperative / Sacco</label>
                    <select
                      value={orgId || ''}
                      onChange={(e) => setOrgId(e.target.value)}
                      required
                      style={{ width: '100%', padding: '14px 16px', borderRadius: 14, border: `1px solid ${T.border}`, outline: 'none', fontSize: 15, backgroundColor: '#F9FAFB', cursor: 'pointer' }}
                    >
                      {organizations.map(org => (
                        <option key={org.id} value={org.id}>
                          {org.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div style={{ padding: 14, backgroundColor: '#EFF6FF', color: '#1E40AF', fontSize: 14, borderRadius: 12, border: '1px solid #DBEAFE', fontWeight: 500 }}>
                    Loading cooperatives...
                  </div>
                )}

                {savingProducts.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Select Saving Plan</label>
                    <select
                      value={selectedProductId}
                      onChange={(e) => setSelectedProductId(e.target.value)}
                      required
                      style={{ width: '100%', padding: '14px 16px', borderRadius: 14, border: `1px solid ${T.border}`, outline: 'none', fontSize: 15, backgroundColor: '#F9FAFB', cursor: 'pointer' }}
                    >
                      {savingProducts.map(product => (
                        <option key={product.id} value={product.id}>
                          {product.name} ({product.interest_rate}% interest)
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}
            
            {((mode === 'register' && step === 1) || mode === 'login') && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Email Address</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={{ width: '100%', padding: '14px 16px', borderRadius: 14, border: `1px solid ${T.border}`, outline: 'none', fontSize: 15, backgroundColor: '#F9FAFB' }}
                    placeholder="john@example.com"
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Password</label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={{ width: '100%', padding: '14px 16px', borderRadius: 14, border: `1px solid ${T.border}`, outline: 'none', fontSize: 15, backgroundColor: '#F9FAFB' }}
                    placeholder="••••••••"
                  />
                </div>
              </>
            )}

            <div style={{ marginTop: 8 }}>
              <button
                type="submit"
                disabled={loading}
                style={{
                  width: '100%', backgroundColor: T.blue, color: 'white', fontWeight: 700, padding: '16px', 
                  borderRadius: 16, border: 'none', cursor: loading ? 'not-allowed' : 'pointer', transition: 'all 0.2s',
                  display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: 16,
                  boxShadow: `0 8px 24px rgba(34, 98, 240, 0.3)`
                }}
              >
                {loading && <Loader2 className="w-5 h-5 animate-spin mr-2" />}
                {mode === 'login' ? 'Sign In' : (step === 1 ? 'Next Step' : 'Finish Setup')}
              </button>
            </div>
          </form>

          <div style={{ marginTop: 24, textAlign: 'center', fontSize: 14, color: T.sub }}>
            {mode === 'login' ? (
              <p>
                Don&apos;t have an account?{' '}
                <button type="button" onClick={() => { setMode('register'); setStep(1); }} style={{ color: T.blue, fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer' }}>
                  Register here
                </button>
              </p>
            ) : (
              <p>
                Already have an account?{' '}
                <button type="button" onClick={() => { setMode('login'); setStep(1); }} style={{ color: T.blue, fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer' }}>
                  Sign in
                </button>
              </p>
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
