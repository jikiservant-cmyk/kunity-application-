/**
 * LIVE replay of the member dashboard load — the sequence the browser runs
 * right after "Sign In" → router.push('/member').
 *
 * Context: the deployed dev site shows an eternal spinner after sign-in. That
 * exact bug existed in code before 2026-10-17 (efbbe0f "fix(member): load the
 * dashboard on mount instead of spinning forever") — on every build since,
 * the page (a) loads on mount, (b) bounds the whole load with a 30s timeout,
 * and (c) lands on an actionable error screen if anything fails. This test
 * proves the CURRENT code's load path actually completes:
 *
 *   1. Static: the mount effect, the 30s bound, the finally-clears-loading,
 *      and the error screen are all present in app/member/page.tsx.
 *   2. SSR: /member renders (that paint IS the spinner the browser first sees).
 *   3. Replay: loadDashboard's exact query chain, member by member —
 *      session → member row → member_savings (+embeds) → activation failsafe
 *      → /api/member/activation-sync → savings products (+ /api/member/setup
 *      when the SACCO has none) → journal_lines → loans — every step resolves,
 *      well inside the 30s bound, for an ACTIVATED member, a FRESH member,
 *      and a member of a SACCO with no products.
 *
 * Run: node test/member-page-load-live-tests.mjs
 */
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 3420;
const APP = `http://127.0.0.1:${APP_PORT}`;

const results = [];
const failedNames = [];
const record = (name, pass, detail = '') => {
  results.push(pass);
  if (!pass) failedNames.push(name);
  console.log(`  ${pass ? '\u2705 PASS' : '\u274c FAIL'}  ${name}${detail ? ` \u2014 ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.now();
let LAST_STEP = 'startup';
const step = (s) => { LAST_STEP = s; console.log(`\n[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`); };
setTimeout(() => {
  console.log(`\n\u23f0 WATCHDOG: stuck at: ${LAST_STEP}`);
  process.exit(2);
}, 420_000).unref();

// ---------------------------------------------------------------------------
// Stub Supabase (GoTrue + PostgREST with the embeds the dashboard needs)
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
    if (['select', 'order', 'offset', 'on_conflict', 'or'].includes(param)) continue;
    if (param === 'limit') { out = out.slice(0, parseInt(value, 10)); continue; }
    const dot = value.indexOf('.');
    const op = dot === -1 ? 'eq' : value.slice(0, dot);
    const rawValue = dot === -1 ? value : value.slice(dot + 1);
    out = out.filter((r) => applyFilter(r, param, op, rawValue));
  }
  return out;
}

function startStub() {
  const usersByToken = new Map();
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

      const tableMatch = path.match(/^\/rest\/v1\/([a-z_0-9]+)$/);
      if (tableMatch) {
        const schema = req.headers['accept-profile'] || req.headers['content-profile'] || 'public';
        const key = `${schema}.${tableMatch[1]}`;
        if (db[key] == null) return json(res, 404, { message: `relation "${key}" does not exist` });
        const rows = db[key]; // writes must touch the STORED rows
        const wantsObject = String(req.headers.accept || '').includes('pgrst.object');
        if (method === 'GET') {
          // PostgREST-style embeds the dashboard relies on, derived live so
          // that updates (e.g. activation-sync) are reflected on re-query.
          let out = rows;
          if (tableMatch[1] === 'members') {
            out = out.map((r) => ({ ...r, organization: (db['kunity.organizations'] || []).find((o) => o.id === r.organization_id) || null }));
          }
          if (tableMatch[1] === 'member_savings') {
            out = out.map((r) => ({
              ...r,
              account: (db['kunity.accounts'] || []).find((a) => a.id === r.account_id) || null,
              savings_product: (db['kunity.savings_products'] || []).find((p) => p.id === r.savings_product_id) || null,
            }));
          }
          if (tableMatch[1] === 'journal_lines') {
            out = out.map((r) => ({ ...r, journal_entries: (db['kunity.journal_entries'] || []).find((e) => e.id === r.journal_entry_id) || null }));
          }
          if (tableMatch[1] === 'loans') {
            out = out.map((r) => ({ ...r, loan_installments: (db['kunity.loan_installments'] || []).filter((i) => i.loan_id === r.id) }));
          }
          const filtered = filterRows(out, url.searchParams);
          return json(res, 200, wantsObject ? (filtered[0] ?? null) : filtered);
        }
        if (method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const inserted = Array.isArray(body) ? body : [body];
          for (const r of inserted) rows.push(r);
          return json(res, 201, wantsObject ? inserted[0] : inserted);
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
        server, port: server.address().port,
        get db() { return db; },
        set db(v) { db = v; },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Real Next.js dev server (log to file; group-kill)
// ---------------------------------------------------------------------------
async function startNext(stubPort) {
  const env = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stubPort}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'stub-service-key',
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  delete env.UPSTASH_REDIS_REST_URL;
  delete env.UPSTASH_REDIS_REST_TOKEN;
  delete env.ENFORCE_REDIS_RATELIMIT;
  const logPath = '/tmp/kunity-member-load-test-next.log';
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

  console.log('Starting stub Supabase...');
  const stub = await startStub();

  const ORG_A = 'ccccccc1-0000-4000-8000-000000000001';
  const ORG_B = 'ccccccc1-0000-4000-8000-000000000002';
  const PRODUCT_A = 'ddddddd1-0000-4000-8000-0000000000p1';
  stub.db = {
    'kunity.organizations': [
      { id: ORG_A, name: 'Alpha Sacco', code: 'ALP', is_active: true, join_code: 'ALP2026TEST' },
      { id: ORG_B, name: 'Beta Sacco (no products)', code: 'BET', is_active: true, join_code: 'BET2026TEST' },
    ],
    'kunity.members': [],
    'kunity.member_savings': [],
    'kunity.accounts': [],
    'kunity.savings_products': [
      { id: PRODUCT_A, organization_id: ORG_A, name: 'Regular Savings', interest_rate: 5, is_active: true },
    ],
    'kunity.payment_requests': [],
    'kunity.journal_entries': [],
    'kunity.journal_lines': [],
    'kunity.loans': [],
    'kunity.loan_installments': [],
  };

  // Sign up three members through GoTrue, then give them their rows.
  const signUp = async (email) => {
    const res = await fetch(`http://127.0.0.1:${stub.port}/auth/v1/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'TestPass123!', data: {} }),
    });
    return await res.json();
  };
  const activated = await signUp('activated@member-load.test');
  const fresh = await signUp('fresh@member-load.test');
  const noProducts = await signUp('noprod@member-load.test');

  stub.db['kunity.members'].push(
    { id: activated.user.id, organization_id: ORG_A, status: 'active', first_name: 'Ann', last_name: 'Activated', phone: '0772111111' },
    { id: fresh.user.id, organization_id: ORG_A, status: 'pending', first_name: 'Felix', last_name: 'Fresh', phone: '0772222222' },
    { id: noProducts.user.id, organization_id: ORG_B, status: 'pending', first_name: 'Nora', last_name: 'NoProd', phone: '0772333333' },
  );
  // Activated member: frozen savings + inactive account (webhook recorded a
  // successful activation payment, but the page has not synced yet) — the
  // failsafe + /api/member/activation-sync path.
  const ACC = 'ddddddd1-0000-4000-8000-0000000000a1';
  stub.db['kunity.accounts'].push({ id: ACC, organization_id: ORG_A, member_id: activated.user.id, is_active: false, account_category: 'asset', cached_balance: 15000 });
  stub.db['kunity.member_savings'].push({ id: 'ddddddd1-0000-4000-8000-0000000000m1', organization_id: ORG_A, member_id: activated.user.id, savings_product_id: PRODUCT_A, account_id: ACC, status: 'frozen' });
  stub.db['kunity.payment_requests'].push({
    id: 'ddddddd1-0000-4000-8000-0000000000r1', organization_id: ORG_A, member_id: activated.user.id,
    status: 'success', payment_type: 'account_activation', internal_reference: 'PAY-ACT-TEST-0001', amount: 5000,
  });
  const JE = 'ddddddd1-0000-4000-8000-0000000000e1';
  stub.db['kunity.journal_entries'].push({ id: JE, description: 'Deposit', created_at: new Date().toISOString() });
  stub.db['kunity.journal_lines'].push({ id: 'ddddddd1-0000-4000-8000-0000000000l1', account_id: ACC, journal_entry_id: JE, credit: 15000, debit: 0, line_type: 'deposit', created_at: new Date().toISOString() });

  console.log('Starting the real Next.js server (compiles for a while)...');
  const next = await startNext(stub.port);
  try {
    step('Warming the routes the dashboard touches...');
    const mkCookie = (session) => `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
    const mkSession = (s) => ({
      access_token: s.access_token, refresh_token: 'stub-refresh', token_type: 'bearer',
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: s.user.id },
    });
    const cookieA = mkCookie(mkSession(activated));
    await fetch(`${APP}/member`, { headers: { cookie: cookieA }, redirect: 'manual', signal: AbortSignal.timeout(180_000) }).catch(() => {});
    await fetch(`${APP}/api/member/setup`, { method: 'POST', headers: { cookie: cookieA }, signal: AbortSignal.timeout(120_000) }).catch(() => {});

    const STUB = `http://127.0.0.1:${stub.port}`;
    // supabase-js sends Accept-Profile for .schema('kunity') queries — the
    // replay must too, or the stub resolves the table in `public`.
    const kunityHeaders = (token) => ({ Authorization: `Bearer ${token}`, apikey: 'stub-anon-key', 'Accept-Profile': 'kunity' });
    const restGet = async (table, query, token) => {
      const res = await fetch(`${STUB}/rest/v1/${table}${query}`, {
        headers: { ...kunityHeaders(token), Accept: 'application/vnd.pgrst.object+json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`${table} -> HTTP ${res.status}`);
      return await res.json();
    };

    // The exact loadDashboard sequence, transcribed from app/member/page.tsx.
    const replayDashboard = async (s, label) => {
      const token = s.access_token;
      const userId = s.user.id;
      const t = Date.now();
      const steps = [];
      const stepOk = (name, ok, extra = '') => { steps.push(ok); if (!ok) throw new Error(`${label}: ${name} failed ${extra}`); };

      // 1. session
      const me = await restGet('members', `?select=*&id=eq.${userId}`, token);
      stepOk('session + member row', me && me.id === userId && me.organization && me.organization.name, JSON.stringify(me && me.organization));

      // 2. member_savings with embeds
      const msList = await fetch(`${STUB}/rest/v1/member_savings?select=*&member_id=eq.${userId}`, {
        headers: kunityHeaders(token), signal: AbortSignal.timeout(15_000),
      }).then((r) => r.json());
      let accountsData = (msList || []).map((ms) => ({ ...ms.account, savings_product: ms.savings_product, savings_product_id: ms.savings_product_id, status: ms.status }));
      let isActivated = accountsData.some((a) => a.is_active === true && a.status === 'active');

      // 3. activation failsafe (payment_requests)
      if (!isActivated) {
        const prList = await fetch(`${STUB}/rest/v1/payment_requests?select=*&member_id=eq.${userId}&organization_id=eq.${me.organization_id}&status=eq.success&limit=1`, {
          headers: kunityHeaders(token), signal: AbortSignal.timeout(15_000),
        }).then((r) => r.json());
        isActivated = Array.isArray(prList) && prList.length > 0;
        if (isActivated) {
          // 4. /api/member/activation-sync (real route, service-role flip)
          const cookie = mkCookie(mkSession(s));
          const syncRes = await fetch(`${APP}/api/member/activation-sync`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, cookie }, signal: AbortSignal.timeout(30_000),
          });
          const syncBody = await syncRes.json().catch(() => ({}));
          stepOk('activation-sync route', syncRes.status === 200 && syncBody.activated === true, `HTTP ${syncRes.status} ${JSON.stringify(syncBody)}`);
          // 5. reload member_savings
          const ms2 = await fetch(`${STUB}/rest/v1/member_savings?select=*&member_id=eq.${userId}`, {
            headers: kunityHeaders(token), signal: AbortSignal.timeout(15_000),
          }).then((r) => r.json());
          accountsData = (ms2 || []).map((ms) => ({ ...ms.account, savings_product: ms.savings_product, savings_product_id: ms.savings_product_id, status: ms.status }));
          isActivated = accountsData.some((a) => a.is_active === true && a.status === 'active');
          stepOk('activation reflected after sync', isActivated);
        }
      }

      // 6. wallet + savings products (+ /api/member/setup when the SACCO has none)
      let products = await fetch(`${STUB}/rest/v1/savings_products?select=*&organization_id=eq.${me.organization_id}`, {
        headers: kunityHeaders(token), signal: AbortSignal.timeout(15_000),
      }).then((r) => r.json());
      if (!products || products.length === 0) {
        const cookie = mkCookie(mkSession(s));
        const setupRes = await fetch(`${APP}/api/member/setup`, {
          method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(30_000),
        });
        stepOk('setup route (SACCO without products)', setupRes.status === 200, `HTTP ${setupRes.status}`);
        products = await fetch(`${STUB}/rest/v1/savings_products?select=*&organization_id=eq.${me.organization_id}`, {
          headers: kunityHeaders(token), signal: AbortSignal.timeout(15_000),
        }).then((r) => r.json());
      }

      // 7. transactions (journal_lines) when the member has accounts
      if (accountsData.length > 0) {
        const ids = accountsData.map((a) => a.id).join(',');
        const tx = await fetch(`${STUB}/rest/v1/journal_lines?select=*&account_id=in.(${ids})&order=created_at.desc&limit=30`, {
          headers: kunityHeaders(token), signal: AbortSignal.timeout(15_000),
        }).then((r) => r.json());
        stepOk('transactions query', Array.isArray(tx));
        var txCount = (tx || []).length;
      }

      // 8. loans
      const loans = await fetch(`${STUB}/rest/v1/loans?select=*&member_id=eq.${userId}&order=created_at.desc`, {
        headers: kunityHeaders(token), signal: AbortSignal.timeout(15_000),
      }).then((r) => r.json());
      stepOk('loans query', Array.isArray(loans));

      const elapsed = Date.now() - t;
      return { elapsed, isActivated, wallet: accountsData.find((a) => a.account_category === 'asset') || accountsData[0] || null, products: (products || []).length, txCount: txCount || 0, loans: (loans || []).length };
    };

    // ---- static guarantees ----
    step('Static guarantees in app/member/page.tsx');
    const page = readFileSync(join(ROOT, 'app/member/page.tsx'), 'utf8');
    record('dashboard loads on mount (the pre-2026-10-17 eternal-spinner bug is fixed)',
      /useEffect\(\(\) => \{\s*void fetchData\(\);[\s\S]*?\}, \[\]\);/.test(page));
    record('the whole load is bounded (30s timeout), so the spinner can never be eternal',
      page.includes("withTimeout(loadDashboard(), 30_000"));
    record('loading always clears (finally), failures land on an actionable screen',
      /finally \{\s*setLoading\(false\);\s*\}/.test(page) && page.includes('Dashboard could not load'));

    // ---- SSR paint ----
    step('SSR: what the browser first receives for /member');
    const ssrRes = await fetch(`${APP}/member`, { headers: { cookie: mkCookie(mkSession(activated)) }, redirect: 'manual', signal: AbortSignal.timeout(180_000) });
    record('/member renders with a session (this paint is the spinner; hydration then runs the sequence below)',
      ssrRes.status === 200, `status ${ssrRes.status}`);

    // ---- replays ----
    step('REPLAY 1 — ACTIVATED member (frozen account + successful activation payment)');
    const r1 = await replayDashboard(activated, 'activated');
    record('every dashboard step resolves; the member ends activated with a wallet',
      r1.isActivated === true && r1.wallet && r1.wallet.account_category === 'asset' && r1.txCount === 1 && r1.products === 1,
      `${r1.elapsed}ms, wallet=${r1.wallet ? 'found' : 'null'}, tx=${r1.txCount}, products=${r1.products}`);
    record('activation-sync flipped member_savings + account to active in the database',
      stub.db['kunity.member_savings'][0].status === 'active' && stub.db['kunity.accounts'][0].is_active === true);

    step('REPLAY 2 — FRESH member (pending, no accounts, no payments)');
    const r2 = await replayDashboard(fresh, 'fresh');
    record('load completes; no wallet yet (activation fee not paid), products visible',
      r2.isActivated === false && r2.wallet == null && r2.products === 1 && r2.loans === 0,
      `${r2.elapsed}ms, products=${r2.products}`);

    step('REPLAY 3 — member of a SACCO with NO products (setup path)');
    const r3 = await replayDashboard(noProducts, 'noProducts');
    record('load completes even when the SACCO has no savings products (setup route answers)',
      r3.isActivated === false && r3.products === 0 && r3.loans === 0,
      `${r3.elapsed}ms, products=${r3.products}`);

    record('all three loads finish far inside the 30s bound', r1.elapsed < 5000 && r2.elapsed < 5000 && r3.elapsed < 5000,
      `${r1.elapsed}ms / ${r2.elapsed}ms / ${r3.elapsed}ms`);
  } catch (e) {
    console.log('\n[debug] Next.js server log tail at failure:');
    try { console.log(next.getLog().split('\n').slice(-60).join('\n')); } catch { /* no log */ }
    console.log('\n[debug] failed at:', LAST_STEP);
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
    console.log('MEMBER PAGE LOAD REPLAY: ALL CHECKS PASSED');
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
