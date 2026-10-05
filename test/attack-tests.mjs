/**
 * Live attack-replay suite for the Kunity auth pentest.
 *
 *   - NEW server (http://localhost:3000)  : the FIXED code (this branch)
 *   - OLD server (http://localhost:3001)  : original commit 10be16e (positive controls)
 *   - Mock Supabase/NaJiki               : http://127.0.0.1:54321 (test/mock-supabase.js)
 *
 * Run: node test/attack-tests.mjs
 */
const MOCK = 'http://127.0.0.1:54321';
const NEW = 'http://localhost:3000';
const OLD = 'http://localhost:3001';

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ORG_X = 'cccccccc-0000-0000-0000-000000000003';
const U_ADMIN_A = '11111111-1111-1111-1111-111111111111';
const U_MEMBER_B = '55555555-5555-5555-5555-555555555555';

// --- build a session cookie exactly like @supabase/ssr expects ------------
function sessionCookie(token) {
  const session = {
    access_token: token,
    refresh_token: `refresh-${token}`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'irrelevant' },
  };
  const value = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
  return `sb-127-auth-token=${value}`;
}

async function call(base, { method = 'POST', path, token, body, headers = {}, raw = false }) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) {
    h['Authorization'] = `Bearer ${token}`;
    h['Cookie'] = sessionCookie(token);
  }
  const res = await fetch(base + path, {
    method, headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function mockState() {
  const res = await fetch(MOCK + '/_test/state');
  return res.json();
}
async function mockReset() {
  await fetch(MOCK + '/_test/reset', { method: 'POST' });
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitReady(url, label) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(url, { redirect: 'manual' });
      console.log(`[${label}] server ready`);
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(`${label} never became ready`);
}

// ===========================================================================
async function runPositiveControls() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('POSITIVE CONTROLS — original (unfixed) code @ :3001');
  console.log('These prove the attacks were REAL before the fixes.');
  console.log('══════════════════════════════════════════════════════');
  await mockReset();

  // P1: KUN-01 — poisoned user_metadata hijacks tenant
  let r = await call(OLD, { path: '/api/admin/data', token: 'token-admin-a', body: { token: 'token-admin-a' } });
  const hijacked = r.json && r.json.orgId === ORG_B;
  record('P1 KUN-01: poisoned metadata hijacks tenant (orgId === VICTIM org)', r.status === 200 && hijacked,
    `status=${r.status} orgId=${r.json && r.json.orgId}`);

  // P1b: victim org's secret API key leaked to foreign admin
  const leakedKey = r.json && r.json.apiKey === 'SECRET-API-KEY-BRAVO';
  record('P1b KUN-02: foreign admin receives VICTIM tenant API key', leakedKey,
    `apiKey=${r.json && r.json.apiKey}`);

  // P1c: full org directory (incl. inactive) leaked
  const leakedOrgs = r.json && Array.isArray(r.json.allOrganizations) &&
    r.json.allOrganizations.some(o => o.id === ORG_X);
  record('P1c KUN-02: full platform org directory leaked (incl. inactive)', leakedOrgs,
    `count=${r.json && r.json.allOrganizations && r.json.allOrganizations.length}`);

  // P2: the hijacked binding was persisted to admin_profiles
  let st = await mockState();
  const adminA = st.db['public.admin_profiles'].find(p => p.id === U_ADMIN_A);
  record('P2 KUN-01: hijacked tenant persisted into admin_profiles (authoritative)',
    adminA && adminA.tenant_id === ORG_B, `tenant_id=${adminA && adminA.tenant_id}`);

  // P3: KILL CHAIN — foreign admin approves victim org's loan (money movement)
  r = await call(OLD, {
    path: '/api/admin/loans', token: 'token-admin-a',
    body: { token: 'token-admin-a', loanId: 'loan-b-1', status: 'approved' },
  });
  record('P3 KILL CHAIN: foreign admin disburses VICTIM org loan', r.status === 200 && r.json && r.json.success,
    `status=${r.status} ${(r.json && (r.json.message || r.json.error)) || ''}`);

  // P4: KUN-03 — 'viewer' role (non-admin) credits SMS wallet
  r = await call(OLD, {
    path: '/api/admin/sms/topup/confirm', token: 'token-viewer',
    body: { token: 'token-viewer', intentId: 'najiki_ref_success', credits: 1000 },
  });
  record('P4 KUN-03: non-admin role credits SMS wallet', r.status === 200 && r.json && r.json.success,
    `status=${r.status} ${(r.json && (r.json.newBalanceUGX !== undefined ? 'newBalance=' + r.json.newBalanceUGX : r.json.error)) || ''}`);

  // P5: KUN-04 — cross-tenant payment attribution
  r = await call(OLD, {
    path: '/api/payments/intent', token: 'token-member-b',
    body: { amount: 5000, currency: 'UGX', memberId: U_MEMBER_B, organizationId: ORG_A, phoneNumber: '0772123456', paymentTypeCode: 'deposit' },
  });
  st = await mockState();
  const badInsert = st.requestLog.find(e => e.method === 'INSERT' && e.table === 'kunity.payment_requests' && e.rows[0] && e.rows[0].organization_id === ORG_A);
  record('P5 KUN-04: member attributes payment to FOREIGN org', r.status === 200 && !!badInsert,
    `status=${r.status} foreignInsert=${!!badInsert}`);

  // P6: KUN-04 — CORS origin reflection (send a session so the middleware
  // lets the preflight reach the route handler)
  r = await call(OLD, { method: 'OPTIONS', path: '/api/payments/intent', token: 'token-member-b', headers: { Origin: 'https://evil.example' } });
  const acao = r.headers.get('access-control-allow-origin');
  record('P6 KUN-04: arbitrary Origin reflected in CORS', acao === 'https://evil.example', `ACAO=${acao}`);

  // P7: KUN-06 — inactive orgs listed. NOTE: called WITH a session because the
  // ORIGINAL middleware 307-redirects cookieless requests to this path — which
  // is itself a pre-existing bug (it breaks the pre-login signup dropdown).
  // With a session, the old route leaks inactive organizations.
  r = await call(OLD, { method: 'GET', path: '/api/organizations', token: 'token-member-b' });
  const hasX = r.json && r.json.organizations && r.json.organizations.some(o => o.id === ORG_X);
  record('P7 KUN-06: inactive organizations exposed (with session)', hasX,
    `count=${r.json && r.json.organizations && r.json.organizations.length}`);

  // P8: KUN-07 — foreign savings product linkage
  r = await call(OLD, {
    path: '/api/member/open-account', token: 'token-member-b',
    body: { productId: 'prod-a-1', productName: 'Hax' },
  });
  record('P8 KUN-07: member opens account on FOREIGN org product', r.status === 200 && r.json && r.json.success,
    `status=${r.status}`);
}

// ===========================================================================
async function runFixedVerification() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('FIXED CODE VERIFICATION — this branch @ :3000');
  console.log('Every attack must now FAIL CLOSED.');
  console.log('══════════════════════════════════════════════════════');
  await mockReset();

  // T1: KUN-01 — poisoned metadata must be ignored
  let r = await call(NEW, { path: '/api/admin/data', token: 'token-admin-a', body: { token: 'token-admin-a' } });
  record('T1 KUN-01: poisoned metadata IGNORED (orgId stays OWN org)',
    r.status === 200 && r.json && r.json.orgId === ORG_A,
    `status=${r.status} orgId=${r.json && r.json.orgId} err=${r.json && r.json.error}`);

  // T1b: response must not leak the victim's API key anywhere
  const bodyStr = JSON.stringify(r.json || {});
  record('T1b KUN-02: VICTIM API key absent from response', !bodyStr.includes('SECRET-API-KEY-BRAVO'),
    `apiKey=${r.json && r.json.apiKey}`);

  // T1c: no org directory for tenant admins
  record('T1c KUN-02: org directory empty for tenant admin',
    r.status === 200 && Array.isArray(r.json.allOrganizations) && r.json.allOrganizations.length === 0,
    `count=${r.json && r.json.allOrganizations && r.json.allOrganizations.length}`);

  // T2: cross-tenant probe via selectedOrgId
  r = await call(NEW, {
    path: '/api/admin/data', token: 'token-admin-a',
    body: { token: 'token-admin-a', selectedOrgId: ORG_B },
  });
  record('T2 KUN-01: selectedOrgId probe for foreign org rejected', r.status === 403, `status=${r.status}`);

  // T3: pending self-registered membership must NOT bind an admin's tenant
  r = await call(NEW, { path: '/api/admin/data', token: 'token-admin-null', body: { token: 'token-admin-null' } });
  record('T3 KUN-01: PENDING self-registered membership does not bind tenant', r.status === 403,
    `status=${r.status} err=${r.json && r.json.error}`);

  // T4: founder (created_by) binding wins over foreign pending membership
  r = await call(NEW, { path: '/api/admin/data', token: 'token-admin-founder', body: { token: 'token-admin-founder' } });
  record('T4 KUN-01: founder binds to OWN org (owned org beats foreign pending membership)',
    r.status === 200 && r.json && r.json.orgId === ORG_A,
    `status=${r.status} orgId=${r.json && r.json.orgId}`);

  // T5: legit onboarding — ACTIVE membership binds
  r = await call(NEW, { path: '/api/admin/data', token: 'token-admin-active', body: { token: 'token-admin-active' } });
  record('T5 no-regression: ACTIVE membership still binds (legit onboarding intact)',
    r.status === 200 && r.json && r.json.orgId === ORG_B,
    `status=${r.status} orgId=${r.json && r.json.orgId}`);

  // T6: non-admin rejected
  r = await call(NEW, { path: '/api/admin/data', token: 'token-member-b', body: { token: 'token-member-b' } });
  record('T6: plain member rejected from admin data', r.status === 403, `status=${r.status}`);

  // T7: global admin may scope to any org (by design)
  r = await call(NEW, {
    path: '/api/admin/data', token: 'token-super',
    body: { token: 'token-super', selectedOrgId: ORG_B },
  });
  record('T7 no-regression: global admin can scope to any active org',
    r.status === 200 && r.json && r.json.orgId === ORG_B && r.json.allOrganizations.length === 3,
    `status=${r.status} orgId=${r.json && r.json.orgId}`);

  // T8: bad token — 307 = rejected by middleware (redirect to /auth), 401 = rejected by route
  r = await call(NEW, { path: '/api/admin/data', token: 'token-bogus', body: { token: 'token-bogus' } });
  record('T8: invalid token rejected (by middleware redirect or route 401)',
    r.status === 401 || r.status === 307, `status=${r.status}`);

  // T9-T11: topup confirm authorization
  r = await call(NEW, { path: '/api/admin/sms/topup/confirm', token: 'token-member-b', body: { token: 'token-member-b', intentId: 'najiki_ref_success' } });
  record('T9 KUN-03: member rejected from topup confirm', r.status === 403, `status=${r.status}`);
  r = await call(NEW, { path: '/api/admin/sms/topup/confirm', token: 'token-admin-a', body: { token: 'token-admin-a', intentId: 'najiki_ref_success' } });
  record('T10 KUN-03: foreign-tenant topup rejected', r.status === 403, `status=${r.status}`);
  r = await call(NEW, { path: '/api/admin/sms/topup/confirm', token: 'token-viewer', body: { token: 'token-viewer', intentId: 'najiki_ref_success' } });
  record('T11 KUN-03: low-priv admin role rejected', r.status === 403, `status=${r.status}`);

  // T12: legit own-tenant topup confirm still works
  r = await call(NEW, { path: '/api/admin/sms/topup/confirm', token: 'token-admin-a', body: { token: 'token-admin-a', intentId: 'najiki_ref_a', credits: 400 } });
  record('T12 no-regression: own-tenant topup confirm works',
    r.status === 200 && r.json && r.json.success, `status=${r.status} ${r.json && r.json.error || ''}`);

  // T13: idempotency — same confirm again must not double-credit
  r = await call(NEW, { path: '/api/admin/sms/topup/confirm', token: 'token-admin-a', body: { token: 'token-admin-a', intentId: 'najiki_ref_a', credits: 400 } });
  record('T13 no-double-credit: repeat confirm reports already processed',
    r.status === 200 && r.json && r.json.message === 'Already processed',
    `status=${r.status} msg=${r.json && r.json.message}`);

  // T14-T16: payment intent hardening
  r = await call(NEW, {
    path: '/api/payments/intent', token: 'token-member-b',
    body: { amount: 5000, currency: 'UGX', memberId: U_MEMBER_B, organizationId: ORG_A, phoneNumber: '0772123456', paymentTypeCode: 'deposit' },
  });
  record('T14 KUN-04: foreign organizationId rejected', r.status === 403, `status=${r.status}`);

  r = await call(NEW, {
    path: '/api/payments/intent', token: 'token-member-b',
    body: { amount: -5000, currency: 'UGX', memberId: U_MEMBER_B, organizationId: ORG_B, phoneNumber: '0772123456', paymentTypeCode: 'deposit' },
  });
  record('T15 KUN-04: negative amount rejected', r.status === 400, `status=${r.status}`);

  r = await call(NEW, {
    path: '/api/payments/intent', token: 'token-member-b',
    body: { amount: 5000, currency: 'UGX', memberId: U_MEMBER_B, organizationId: ORG_B, phoneNumber: '0772123456', paymentTypeCode: 'deposit' },
  });
  let st = await mockState();
  const goodInsert = st.requestLog.find(e => e.method === 'INSERT' && e.table === 'kunity.payment_requests' && e.rows[0] && e.rows[0].organization_id === ORG_B);
  record('T16 no-regression: legit deposit intent works with server-resolved org',
    r.status === 200 && r.json && r.json.success && !!goodInsert,
    `status=${r.status} insertOrgOk=${!!goodInsert}`);

  // T17-T18: CORS allowlist (send a session so the middleware lets the
  // preflight through to the route handler)
  r = await call(NEW, { method: 'OPTIONS', path: '/api/payments/intent', token: 'token-member-b', headers: { Origin: 'https://evil.example' } });
  const evilAcao = r.headers.get('access-control-allow-origin');
  record('T17 KUN-04: arbitrary Origin NOT reflected', evilAcao === null, `ACAO=${evilAcao}`);
  r = await call(NEW, { method: 'OPTIONS', path: '/api/payments/intent', token: 'token-member-b', headers: { Origin: 'http://localhost:3000' } });
  const okAcao = r.headers.get('access-control-allow-origin');
  record('T18 no-regression: configured origin allowed', okAcao === 'http://localhost:3000', `ACAO=${okAcao}`);

  // T19: organizations active-only — cookieless (proves the pre-login signup
  // dropdown endpoint is reachable without a session and only lists ACTIVE orgs)
  r = await call(NEW, { method: 'GET', path: '/api/organizations' });
  const orgs = (r.json && r.json.organizations) || [];
  record('T19 KUN-06: only ACTIVE organizations listed (and reachable pre-login)',
    r.status === 200 && orgs.length === 2 && !orgs.some(o => o.id === ORG_X),
    `status=${r.status} count=${orgs.length}`);

  // T20-T22: open-account product validation
  r = await call(NEW, { path: '/api/member/open-account', token: 'token-member-b', body: { productId: 'prod-a-1' } });
  record('T20 KUN-07: FOREIGN org product rejected', r.status === 403, `status=${r.status}`);
  r = await call(NEW, { path: '/api/member/open-account', token: 'token-member-b', body: { productId: 'prod-b-dead' } });
  record('T21 KUN-07: INACTIVE product rejected', r.status === 403, `status=${r.status}`);
  r = await call(NEW, { path: '/api/member/open-account', token: 'token-member-b', body: { productId: 'prod-b-1', productName: 'Bravo Savings' } });
  record('T22 no-regression: own org active product works',
    r.status === 200 && r.json && r.json.success, `status=${r.status} ${r.json && r.json.error || ''}`);

  // T23: KILL CHAIN blocked — foreign admin cannot approve victim loan
  r = await call(NEW, {
    path: '/api/admin/loans', token: 'token-admin-a',
    body: { token: 'token-admin-a', loanId: 'loan-b-1', status: 'approved' },
  });
  record('T23 KILL CHAIN BLOCKED: foreign admin cannot disburse VICTIM loan', r.status === 403,
    `status=${r.status} err=${r.json && r.json.error}`);

  // T24: authoritative tenant binding untouched
  st = await mockState();
  const adminA = st.db['public.admin_profiles'].find(p => p.id === U_ADMIN_A);
  record('T24 KUN-01: authoritative tenant binding never overwritten',
    adminA && adminA.tenant_id === ORG_A, `tenant_id=${adminA && adminA.tenant_id}`);

  // T25: no auth-admin metadata writes at all
  const metaWrites = st.requestLog.filter(e => e.method === 'AUTH_ADMIN_UPDATE_USER');
  record('T25 KUN-01: zero auth-metadata writes from API', metaWrites.length === 0, `count=${metaWrites.length}`);
}

// ===========================================================================
async function runFinancialAttacks() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('FINANCIAL ATTACKS — member money movement + topup @ :3000');
  console.log('══════════════════════════════════════════════════════');
  await mockReset();
  let r;
  let st;

  const ACC_BENNY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  // T26: spoofed memberId in the body must be IGNORED — identity comes from
  //     the session and is resolved server-side before the RPC runs
  r = await call(NEW, {
    path: '/api/member/transactions', token: 'token-member-b',
    body: { action: 'withdraw', amount: 1000, accountId: ACC_BENNY, memberId: '11111111-1111-1111-1111-111111111111' },
  });
  st = await mockState();
  const wdRpc = st.requestLog.filter(e => e.method === 'RPC' && e.path.includes('member_withdraw_atomic')).pop();
  record('T26 identity: withdraw uses SESSION identity, spoofed memberId ignored',
    r.status === 200 && wdRpc && wdRpc.body.p_member_id === '55555555-5555-5555-5555-555555555555' &&
    wdRpc.body.p_organization_id === ORG_B && wdRpc.body.p_account_id === ACC_BENNY,
    `status=${r.status} rpcMember=${wdRpc && wdRpc.body.p_member_id}`);

  // T27: amount validation — string, negative, zero, boolean all rejected
  r = await call(NEW, { path: '/api/member/transactions', token: 'token-member-b', body: { action: 'withdraw', amount: '1000', accountId: ACC_BENNY } });
  const r2 = await call(NEW, { path: '/api/member/transactions', token: 'token-member-b', body: { action: 'withdraw', amount: -5, accountId: ACC_BENNY } });
  const r3 = await call(NEW, { path: '/api/member/transactions', token: 'token-member-b', body: { action: 'withdraw', amount: 0, accountId: ACC_BENNY } });
  const r4 = await call(NEW, { path: '/api/member/transactions', token: 'token-member-b', body: { action: 'loan', amount: '1e9' } });
  record('T27 validation: string/negative/zero amounts rejected with 400',
    r.status === 400 && r2.status === 400 && r3.status === 400 && r4.status === 400,
    `str=${r.status} neg=${r2.status} zero=${r3.status} exp=${r4.status}`);

  // T28: malformed accountId (injection string) rejected before any DB call
  await mockReset();
  r = await call(NEW, { path: '/api/member/transactions', token: 'token-member-b', body: { action: 'withdraw', amount: 1000, accountId: "../../etc/passwd" } });
  st = await mockState();
  const dbCalls = st.requestLog.filter(e => e.method === 'RPC' || (e.method === 'GET' && e.path.includes('/rest/v1/members'))).length;
  record('T28 validation: injection-style accountId rejected, no RPC fired',
    r.status === 400 && dbCalls === 0, `status=${r.status} dbCalls=${dbCalls}`);

  // T29: repay a FOREIGN org's loan -> ownership enforced (emulated RPC contract)
  r = await call(NEW, {
    path: '/api/member/transactions', token: 'token-member-b',
    body: { action: 'repay', amount: 5000, accountId: ACC_BENNY, loanId: 'aaaaaa1a-0000-4000-8000-000000000002' },
  });
  record('T29 ownership: repaying a FOREIGN member\'s loan rejected (400, not 500)',
    r.status === 400 && /Loan not found/i.test(r.json?.error || ''),
    `status=${r.status} err=${r.json && r.json.error}`);

  // T29b: repay own loan that is still PENDING (not disbursed) -> rejected
  r = await call(NEW, {
    path: '/api/member/transactions', token: 'token-member-b',
    body: { action: 'repay', amount: 5000, accountId: ACC_BENNY, loanId: 'bbbbbb1b-0000-4000-8000-000000000001' },
  });
  record('T29b FIN-26: repaying a not-yet-disbursed loan rejected (400)',
    r.status === 400 && /not in a repayable state/i.test(r.json?.error || ''),
    `status=${r.status} err=${r.json && r.json.error}`);

  // T30: rate limit — 31 rapid money-movement requests, the 31st is throttled
  let lastStatus = null;
  for (let i = 0; i < 31; i++) {
    const rr = await call(NEW, {
      path: '/api/member/transactions', token: 'token-member-rate',
      body: { action: 'withdraw', amount: 1, accountId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    });
    lastStatus = rr.status;
  }
  record('T30 FIN-16: member transaction rate limit fires (429 after 30/min)',
    lastStatus === 429, `31stStatus=${lastStatus}`);

  // T31: FIN-25 — gateway returns success with a MISSING amount field;
  //     confirm must not credit (NaN used to slip past the tolerance check)
  await mockReset();
  r = await call(NEW, { path: '/api/admin/sms/topup/confirm', token: 'token-admin-a', body: { token: 'token-admin-a', intentId: 'najiki_ref_nan', credits: 1000 } });
  st = await mockState();
  const nanWallet = st.db['public.wallets'].find(w => w.id === 'wallet-a');
  const nanCreditCalls = st.requestLog.filter(e => e.method === 'RPC' && e.path.includes('credit_sms_wallet')).length;
  record('T31 FIN-25: NaN/missing gateway amount rejected, wallet NOT credited',
    r.status === 400 && nanCreditCalls === 0 && parseFloat(nanWallet.balance) === 10000,
    `status=${r.status} wallet=${nanWallet.balance} creditCalls=${nanCreditCalls}`);

  // T32: FIN-12 no-regression — gateway amount as STRING still confirms fine
  r = await call(NEW, { path: '/api/admin/sms/topup/confirm', token: 'token-admin-a', body: { token: 'token-admin-a', intentId: 'najiki_ref_str', credits: 1000 } });
  st = await mockState();
  const strWallet = st.db['public.wallets'].find(w => w.id === 'wallet-a');
  record('T32 no-regression: string amount "50000.00" still credited',
    r.status === 200 && parseFloat(strWallet.balance) === 60000,
    `status=${r.status} wallet=${strWallet.balance}`);
}

// ===========================================================================
(async () => {
  await waitReady(MOCK, 'mock');
  await waitReady(NEW, 'fixed-server');
  await waitReady(OLD, 'original-server');

  await runPositiveControls();
  await runFixedVerification();
  await runFinancialAttacks();

  const failed = results.filter(r => !r.pass);
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`RESULTS: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILURES:');
    failed.forEach(f => console.log(`  ❌ ${f.name} — ${f.detail}`));
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED — attacks reproduce on original code and are blocked on fixed code.');
})();
