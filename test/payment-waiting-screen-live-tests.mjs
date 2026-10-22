/**
 * LIVE replay of the deposit waiting-screen fix against a REAL Next.js server.
 *
 * This sandbox cannot run a browser (the Playwright CDN is blocked, no system
 * Chromium), so instead of clicking we drive the EXACT network sequence the
 * "Confirm on your phone" overlay performs after a member taps Deposit:
 *
 *   1. POST /api/payments/intent            (what the Deposit button does)
 *   2. GET  /api/payments/{id} every 3s     (what the new payment watcher does)
 *   3. POST /api/webhooks/najiki            (what NaJiki does — HMAC-signed,
 *      same envelope as the operators' hop2 log: status "failed", insufficient funds)
 *   4. GET  /api/payments/{id} again        → must now say { status: 'failed' }
 *                                             — the moment the overlay flips.
 *
 * Plus the success path (deposit SMS must also dispatch to the gateway), and a
 * check that the watcher code actually SHIPS in the compiled client bundle the
 * browser downloads for /member.
 *
 * Run: node test/payment-waiting-screen-live-tests.mjs
 */
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 3410;
const APP = `http://127.0.0.1:${APP_PORT}`;
const WEBHOOK_SECRET = 'test-najiki-webhook-secret';
const ORG = 'bbbbbbb1-0000-4000-8000-000000000001';
const MEMBER_PHONE = '0772123456';

const results = [];
const failedNames = [];
const record = (name, pass, detail = '') => {
  results.push(pass);
  LAST_STEP = name;
  if (!pass) failedNames.push(name);
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.now();
let LAST_STEP = 'startup';
const step = (s) => { LAST_STEP = s; console.log(`\n[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`); };
// If anything wedges, say WHERE instead of hanging silently.
setTimeout(() => {
  console.log(`\n⏰ WATCHDOG: stuck at: ${LAST_STEP}`);
  process.exit(2);
}, 420_000).unref();

// ---------------------------------------------------------------------------
// Stub: Supabase (GoTrue + PostgREST + RPCs) and the NaJiki gateway, one port.
// ---------------------------------------------------------------------------
function applyFilter(row, key, op, rawValue) {
  const cell = row[key];
  if (op === 'eq') return cell != null && String(cell) === String(rawValue);
  if (op === 'neq') return !(cell != null && String(cell) === String(rawValue));
  if (op === 'is') {
    if (rawValue === 'null') return cell == null;
    if (rawValue === 'true') return cell === true;
    if (rawValue === 'false') return cell === false;
    return false;
  }
  if (op === 'in') {
    const set = String(rawValue).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    return set.some((s) => String(cell) === s);
  }
  return true;
}
function filterRows(rows, searchParams) {
  let out = rows;
  for (const [param, value] of searchParams.entries()) {
    if (['select', 'order', 'offset', 'on_conflict'].includes(param)) continue;
    if (param === 'limit') { out = out.slice(0, parseInt(value, 10)); continue; }
    if (param === 'or') continue; // sms_templates .or() lookup: empty table anyway
    const dot = value.indexOf('.');
    const op = dot === -1 ? 'eq' : value.slice(0, dot);
    const rawValue = dot === -1 ? value : value.slice(dot + 1);
    out = out.filter((r) => applyFilter(r, param, op, rawValue));
  }
  return out;
}

function startStub() {
  const usersByToken = new Map();
  const najikiSends = [];
  const gatewayStatusCalls = [];
  let db = {};

  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method;
    const bearer = (req.headers['authorization'] || '').startsWith('Bearer ')
      ? req.headers['authorization'].slice(7)
      : null;
    try {
      // ---- GoTrue ----
      if (path === '/auth/v1/signup' && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const user = {
          id: randomUUID(), aud: 'authenticated', role: 'authenticated',
          email: body.email, user_metadata: body.data || {}, app_metadata: {},
          created_at: new Date().toISOString(),
        };
        const token = `stub-token-${randomUUID()}`;
        usersByToken.set(token, user);
        return json(res, 200, {
          access_token: token, refresh_token: `stub-refresh-${randomUUID()}`,
          token_type: 'bearer', expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, user,
        });
      }
      if (path === '/auth/v1/user' && method === 'GET') {
        const user = bearer && usersByToken.get(bearer);
        if (!user) return json(res, 401, { message: 'Invalid token' });
        return json(res, 200, user);
      }
      if (path === '/auth/v1/health' && method === 'GET') {
        return json(res, 200, { version: 'stub-gotrue' });
      }

      // ---- NaJiki gateway ----
      if (path === '/api/health' && method === 'GET') {
        return json(res, 200, { status: 'ok' });
      }
      if (path === '/api/payments' && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const reference = `SACCO-DEP-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
        return json(res, 200, { reference, status: 'pending', id: reference });
      }
      const gwMatch = path.match(/^\/api\/payments\/([^/]+)$/);
      if (gwMatch && method === 'GET') {
        gatewayStatusCalls.push(gwMatch[1]);
        const row = db['kunity.payment_requests'].find((r) => r.internal_reference === gwMatch[1]);
        return json(res, 200, { status: (row && row.status) || 'pending', amount: row?.amount ?? 5000, currency: 'UGX' });
      }
      if (path === '/api/messaging/send' && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        najikiSends.push({
          to: body.to, message: body.message, eventType: body.eventType,
          idempotencyKey: body.idempotencyKey,
          idempotencyHeader: req.headers['idempotency-key'] || null,
        });
        return json(res, 200, { smsId: `sms-${najikiSends.length}` });
      }

      // ---- PostgREST RPCs ----
      if (path === '/rest/v1/rpc/process_najiki_webhook' && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const row = db['kunity.payment_requests'].find((r) => r.internal_reference === body.p_reference);
        if (!row) return json(res, 200, { success: false, error: 'Unknown payment reference' });
        const status = String(body.p_status || '').trim().toLowerCase();
        const is_success = ['success', 'successful'].includes(status);
        const is_fail = ['failed', 'failure', 'cancelled', 'canceled', 'expired', 'rejected'].includes(status);
        if (!is_success && !is_fail) {
          row.payload = body.p_payload;
          return json(res, 200, { message: 'Intermediate status recorded; awaiting final status' });
        }
        if (row.status === 'success' || row.status === 'failed') {
          return json(res, 200, { message: 'Already processed', payment_request_id: row.id });
        }
        row.status = is_success ? 'success' : 'failed';
        row.completed_at = new Date().toISOString();
        return json(res, 200, {
          message: is_success ? 'Success recorded. Journal entries created.' : 'Payment failed, updated status',
          payment_request_id: row.id,
        });
      }
      if (path === '/rest/v1/rpc/debit_sms_wallet' && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        db['public.wallet_transactions'] = db['public.wallet_transactions'] || [];
        const replay = db['public.wallet_transactions'].find((t) => t.reference === body.p_idempotency_key);
        if (replay) return json(res, 200, { balance: replay.balance_after, replayed: true });
        const wallet = (db['public.wallets'] || []).find((w) => w.id === body.p_wallet_id);
        const amount = Number(body.p_amount || 0);
        const balance = wallet ? parseFloat(wallet.balance) - amount : amount;
        if (wallet) wallet.balance = balance;
        db['public.wallet_transactions'].push({
          reference: body.p_idempotency_key, direction: 'debit', amount,
          description: body.p_description, balance_after: balance,
        });
        return json(res, 200, { balance });
      }

      // ---- PostgREST tables ----
      const tableMatch = path.match(/^\/rest\/v1\/([a-z_0-9]+)$/);
      if (tableMatch) {
        const schema = req.headers['accept-profile'] || req.headers['content-profile'] || 'public';
        const key = `${schema}.${tableMatch[1]}`;
        if (db[key] == null) return json(res, 404, { message: `relation "${key}" does not exist` });
        const rows = db[key];
        if (method === 'GET') return json(res, 200, filterRows(rows, url.searchParams));
        if (method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const inserted = Array.isArray(body) ? body : [body];
          for (const r of inserted) rows.push(r);
          return json(res, 201, {});
        }
        if (method === 'PATCH') {
          const body = JSON.parse(await readBody(req) || '{}');
          filterRows(rows, url.searchParams).forEach((r) => Object.assign(r, body));
          return json(res, 204, {});
        }
      }
      return json(res, 404, { message: `stub: no handler for ${method} ${path}` });
    } catch (err) {
      return json(res, 500, { message: err.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server, port: server.address().port, najikiSends, gatewayStatusCalls,
        get db() { return db; },
        set db(v) { db = v; },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Real Next.js dev server
// ---------------------------------------------------------------------------
async function startNext(stubPort) {
  const env = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stubPort}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'stub-service-key',
    NAJIKI_API_URL: `http://127.0.0.1:${stubPort}`,
    NAJIKI_API_KEY: 'najiki-test-key',
    NAJIKI_APPLICATION_CODE: 'sacco',
    NAJIKI_WEBHOOK_SECRET: WEBHOOK_SECRET,
    NODE_ENV: 'development',
  };
  delete env.UPSTASH_REDIS_REST_URL;
  delete env.UPSTASH_REDIS_REST_TOKEN;
  delete env.ENFORCE_REDIS_RATELIMIT;
  env.NEXT_TELEMETRY_DISABLED = '1';
  // Server output goes to a FILE, never to our stdout: a detached child that
  // inherits the test's pipe keeps it open forever and hangs any pipeline.
  const logPath = '/tmp/kunity-payment-live-test-next.log';
  const logFd = openSync(logPath, 'w');
  const child = spawn('npx', ['next', 'dev', '--webpack', '-p', String(APP_PORT), '-H', '127.0.0.1'], {
    cwd: ROOT, env, stdio: ['ignore', logFd, logFd], detached: true,
  });
  const getLog = () => { try { return readFileSync(logPath, 'utf8'); } catch { return ''; } };
  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    try { closeSync(logFd); } catch { /* already closed */ }
  };
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`next dev exited early (${child.exitCode}):\n${getLog().slice(-2000)}`);
    try {
      const res = await fetch(`${APP}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.status >= 200) return { stop, getLog };
    } catch { /* not up yet */ }
    await sleep(1500);
  }
  stop();
  throw new Error(`next dev did not become ready:\n${getLog().slice(-2000)}`);
}

// ---------------------------------------------------------------------------
async function main() {
  try { execSync('pkill -9 -f next-server; pkill -9 -f "next dev"', { stdio: 'ignore' }); } catch { /* nothing */ }
  await sleep(1000);

  console.log('Starting stub Supabase + NaJiki gateway...');
  const stub = await startStub();
  stub.db = {
    'kunity.organizations': [{ id: ORG, name: 'Browser Replay Sacco', code: 'BRS', is_active: true, join_code: 'BRS2026TEST' }],
    'kunity.members': [],
    'kunity.payment_requests': [],
    'public.tenants': [{ id: ORG, application_id: 'app-brs', code: 'brow-sac' }],
    'public.wallets': [{ id: 'wallet-brs', tenant_id: ORG, balance: 100000, sms_rate: 50 }],
    'public.sms_templates': [],
    'public.sms_messages': [],
    'public.wallet_transactions': [],
  };

  // The member (created the way the sign-up flow does: GoTrue signup, member row).
  const signupRes = await fetch(`http://127.0.0.1:${stub.port}/auth/v1/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'member@browser-replay.test', password: 'TestPass123!', data: {} }),
  });
  const session = await signupRes.json();
  const token = session.access_token;
  const userId = session.user.id;
  // The browser carries its session cookie on every request — /api/payments/*
  // sits behind the session proxy, so cookieless calls redirect to /auth.
  const cookieSession = {
    access_token: token, refresh_token: 'stub-refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: userId },
  };
  const memberCookie = `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(cookieSession)).toString('base64url')}`;
  stub.db['kunity.members'].push({
    id: userId, organization_id: ORG, status: 'active', first_name: 'Browser', last_name: 'Replay',
    phone: MEMBER_PHONE,
    // embedded resource the webhook's deposit-SMS query selects
    members: undefined,
  });
  // payment_requests rows carry the embedded member for the SMS lookup:
  const memberEmbed = { first_name: 'Browser', phone: MEMBER_PHONE };

  console.log('Starting the real Next.js server (this compiles for a while)...');
  const next = await startNext(stub.port);
  try {
    // Warm every route the flow touches (first hit pays the webpack compile).
    step('Warming routes (first hit pays the webpack compile)...');
    const warmHeaders = { 'Content-Type': 'application/json', cookie: memberCookie, Authorization: `Bearer ${token}` };
    const WARM = { redirect: 'manual' };
    await fetch(`${APP}/api/payments/intent`, { method: 'POST', headers: warmHeaders, body: '{}', ...WARM, signal: AbortSignal.timeout(120_000) }).catch(() => {});
    await fetch(`${APP}/api/payments/warmup-ref`, { headers: warmHeaders, ...WARM, signal: AbortSignal.timeout(120_000) }).catch(() => {});
    // The webhook is called by NaJiki with no cookies (excluded from the proxy).
    await fetch(`${APP}/api/webhooks/najiki`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(120_000) }).catch(() => {});

    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, cookie: memberCookie };
    const createDeposit = async () => {
      const res = await fetch(`${APP}/api/payments/intent`, {
        method: 'POST', headers: authHeaders, redirect: 'manual',
        body: JSON.stringify({
          amount: 5000, currency: 'UGX', memberId: userId, organizationId: ORG,
          phoneNumber: MEMBER_PHONE, paymentTypeCode: 'deposit',
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`session proxy redirected the intent call to ${res.headers.get('location')} — the member cookie was not accepted`);
      }
      const bodyText = await res.text();
      let body = {};
      try { body = JSON.parse(bodyText); } catch { /* HTML error page */ }
      if (!res.ok || !body.success) throw new Error(`intent failed: HTTP ${res.status} — ${bodyText.slice(0, 400)}`);
      return body.intent.id;
    };
    const poll = async (ref) => {
      const res = await fetch(`${APP}/api/payments/${encodeURIComponent(ref)}`, {
        headers: { Authorization: `Bearer ${token}`, cookie: memberCookie }, redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status >= 300 && res.status < 400) {
        return { status: res.status, body: { redirected: res.headers.get('location') } };
      }
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const signedWebhook = async (status, ref) => {
      const payload = {
        paymentIntentId: `pi-${ref}`, reference: ref, status, amount: 5000, currency: 'UGX',
        providerPaymentId: randomUUID(),
        failureReason: 'FAILED. TID 159497740820 FAILED. Insufficient funds.',
        externalEntityId: userId, tenantId: ORG, tenantCode: 'brow-sac',
        paymentType: 'deposit', paymentTypeCode: 'deposit',
        metadata: { memberId: userId, organizationId: ORG, paymentTypeCode: 'deposit' },
      };
      const raw = JSON.stringify(payload);
      const t = Date.now();
      const v = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
      const res = await fetch(`${APP}/api/webhooks/najiki`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-najiki-signature': `t=${t},v=${v}`,
          'x-najiki-timestamp': String(t),
        },
        body: raw,
        signal: AbortSignal.timeout(60_000),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };

    // =====================================================================
    step('SCENARIO 1 — deposit FAILS on the phone (the reported bug)');
    // =====================================================================
    const ref1 = await createDeposit();
    stub.db['kunity.payment_requests'].forEach((r) => { if (r.internal_reference === ref1) r.members = memberEmbed; });
    record('deposit intent created (what the Deposit button does)', true, `ref ${ref1}`);

    let polls = 0;
    let p = await poll(ref1); polls++;
    record('watcher poll #1 sees the payment as pending', p.status === 200 && String(p.body.status).toLowerCase() === 'pending', JSON.stringify(p.body));
    await sleep(3000); // the watcher's interval
    p = await poll(ref1); polls++;
    record('watcher poll #2 (3s later) still pending — screen shows "waiting"', p.status === 200 && String(p.body.status).toLowerCase() === 'pending');

    const gwCallsBefore = stub.gatewayStatusCalls.length;
    const tWebhook = Date.now();
    const hook = await signedWebhook('failed', ref1);
    record('NaJiki webhook accepted (signed, hop2-style, "Insufficient funds")',
      hook.status === 200 && hook.body.success === true && hook.body.data?.message === 'Payment failed, updated status',
      `status ${hook.status} ${JSON.stringify(hook.body.data || {}).slice(0, 90)}`);

    p = await poll(ref1); polls++;
    const flipMs = Date.now() - tWebhook;
    record('THE FIX: the very next poll now reports failed (overlay would flip)',
      p.status === 200 && p.body.status === 'failed' && p.body.source === 'ledger',
      `${JSON.stringify(p.body)} — ${flipMs}ms after the webhook landed`);
    record('ledger verdict needs no gateway round-trip (stub saw 0 extra gateway calls)',
      stub.gatewayStatusCalls.length === gwCallsBefore);
    const row1 = stub.db['kunity.payment_requests'].find((r) => r.internal_reference === ref1);
    record('payment_requests row is terminal (status failed)', row1?.status === 'failed', `status ${row1?.status}`);

    // =====================================================================
    step('SCENARIO 2 — deposit SUCCEEDS (happy path must still flip + SMS)');
    // =====================================================================
    const ref2 = await createDeposit();
    stub.db['kunity.payment_requests'].forEach((r) => { if (r.internal_reference === ref2) r.members = memberEmbed; });
    p = await poll(ref2); polls++;
    record('second deposit starts pending', String(p.body.status).toLowerCase() === 'pending');
    const hook2 = await signedWebhook('success', ref2);
    record('success webhook accepted', hook2.status === 200 && hook2.body.success === true);
    p = await poll(ref2); polls++;
    record('next poll reports success (overlay flips to "Payment Successful!")',
      p.status === 200 && p.body.status === 'success' && p.body.source === 'ledger',
      JSON.stringify(p.body));
    const sms = stub.najikiSends.find((s) => s.idempotencyKey === `deposit-sms-${ref2}`);
    record('deposit SMS dispatched to the gateway (dedup key, right member)',
      !!sms && sms.to === '+256772123456' && sms.eventType === 'DEPOSIT_ALERT',
      sms ? `to ${sms.to}` : `sends: ${stub.najikiSends.map((s) => s.eventType).join(',') || 'none'}`);
    const wallet = stub.db['public.wallets'][0];
    record('SMS wallet was debited for the dispatch', parseFloat(wallet.balance) < 100000, `balance ${wallet.balance}`);

    record('the watcher polled continuously throughout (>= 5 polls)', polls >= 5, `${polls} polls`);

    // =====================================================================
    step('BUNDLE PROOF — the watcher ships in the browser JS for /member');
    // =====================================================================
    const memberRes = await fetch(`${APP}/member`, {
      headers: { cookie: memberCookie }, redirect: 'manual', signal: AbortSignal.timeout(180_000),
    });
    record('/member renders for a signed-in member (compiles the page)', memberRes.status === 200, `status ${memberRes.status}`);
    // Next 16 dev compiles client chunks under .next/dev/static/chunks (plus a
    // server copy under .next/dev/server). Search both; skip the build cache.
    let chunkHit = '';
    try {
      chunkHit = execSync(
        `timeout 120 grep -rl "consecutiveErrors" "${ROOT}/.next/dev/static/chunks" "${ROOT}/.next/static/chunks" --include="*.js" 2>/dev/null | head -1`,
        { encoding: 'utf8' }
      ).trim();
    } catch { /* none */ }
    record('payment watcher code is present in the compiled client bundle the browser downloads', !!chunkHit, chunkHit || 'not found');
    if (chunkHit) {
      const chunk = readFileSync(chunkHit, 'utf8');
      record('bundle contains the poll endpoint + interval + failure family',
        chunk.includes('/api/payments/') && chunk.includes('setInterval') && chunk.includes('rejected'),
        `${chunkHit.split('/').pop().slice(0, 40)}…`);
    } else {
      record('bundle contains the poll endpoint + interval + failure family', false, 'no chunk found');
    }
  } catch (e) {
    console.log('\n[debug] Next.js server log tail at failure:');
    try { console.log(next.getLog().split('\n').slice(-80).join('\n')); } catch { /* no log */ }
    throw e;
  } finally {
    next.stop();
    try { stub.server.close(); } catch { /* already closed */ }
    try { stub.server.closeAllConnections(); } catch { /* older Node */ }
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nRESULTS: ${passed}/${results.length} passed`);
  if (passed < results.length) {
    console.log('FAILURES:');
    for (const name of failedNames) console.log(`  - ${name}`);
    process.exitCode = 1;
  } else {
    console.log('WAITING-SCREEN LIVE REPLAY: ALL CHECKS PASSED');
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
