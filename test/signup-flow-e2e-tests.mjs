/**
 * END-TO-END test of the join-link sign-up flow.
 *
 *   Real pieces (nothing mocked):
 *     - TWO Next.js dev servers running REAL code:
 *         OLD (port 3311): the pre-fix commit (git worktree) — the deployment
 *                          as members actually experienced it (positive control)
 *         NEW (port 3310): this branch (migration 38 + alias preservation)
 *       Middleware/proxy, /auth page, /api/organizations/resolve,
 *       /api/auth/profile, lib/join-code-lookup.ts, rate limiters — all real.
 *     - @supabase/supabase-js client (the same calls app/auth/page.tsx makes)
 *     - World state produced by the REAL SQL migrations on PGlite:
 *         "before" world = base + migration 24          (the broken deployment)
 *         "after"  world = base + migrations 24 + 38    (this branch's fix)
 *
 *   Stubbed (this sandbox cannot reach *.supabase.co or the NaJiki origin):
 *     - GoTrue (/auth/v1/signup, /user, /token) and PostgREST (/rest/v1/*),
 *       wire-compatible with the supabase-js version in package.json
 *     - NaJiki SMS gateway (/api/messaging/send) + the wallet debit RPC, so the
 *       welcome-SMS dispatch is observable end to end (debit -> gateway -> log)
 *     - Inngest event API (/e/<key>) for the PRE-FIX server only — the old code
 *       still queues its welcome SMS through Inngest
 *
 * Run: node test/signup-flow-e2e-tests.mjs
 */
import { spawn, execFileSync, execSync } from 'node:child_process';
import http from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const NEW_PORT = 3310;
const OLD_PORT = 3311;
const NEW_APP = `http://127.0.0.1:${NEW_PORT}`;
const OLD_APP = `http://127.0.0.1:${OLD_PORT}`;
const OLD_TREE = join(ROOT, '..', 'kunity-pre-fix');
const ANON_KEY = 'stub-anon-key';
const SERVICE_KEY = 'stub-service-key';
const EVENT_KEY = 'stub-event-key';

// Codes that matter to the story (chosen so the two worlds are distinguishable):
const LEGACY_CODE = 'AB01CD23EF'; // exactly migration 24's hex generator: has 0 and 1
const LUCKY_CODE = 'ABCDEF2345'; // hex but no 0/1 — a link that worked before the fix
const BRAVO_CODE = 'BRAV234567'; // second SACCO (cross-tenant tests), clean alphabet
const INACTIVE_CODE = 'NACTVE2345'; // clean alphabet, is_active = false

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// Stub Supabase (GoTrue + PostgREST + NaJiki SMS gateway + Inngest events for the old server)
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
  return true;
}

function filterRows(rows, searchParams) {
  let out = rows;
  for (const [param, value] of searchParams.entries()) {
    if (['select', 'order', 'offset', 'on_conflict'].includes(param)) continue;
    if (param === 'limit') { out = out.slice(0, parseInt(value, 10)); continue; }
    const dot = value.indexOf('.');
    const op = dot === -1 ? 'eq' : value.slice(0, dot);
    const rawValue = dot === -1 ? value : value.slice(dot + 1);
    out = out.filter((r) => applyFilter(r, param, op, rawValue));
  }
  return out;
}

function startStub() {
  const usersByToken = new Map(); // access_token -> user
  const usersByRefresh = new Map(); // refresh_token -> user
  const events = [];
  const najikiSends = [];
  const requestLog = [];
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

  const mkSession = (user) => {
    const access = `stub-token-${randomUUID()}`;
    const refresh = `stub-refresh-${randomUUID()}`;
    usersByToken.set(access, user);
    usersByRefresh.set(refresh, user);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user,
    };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method;
    const bearer = (req.headers['authorization'] || '').startsWith('Bearer ')
      ? req.headers['authorization'].slice(7)
      : null;
    requestLog.push({ method, path: path + (url.search || '') });

    try {
      // ---- test control ----
      if (path === '/_test/seed' && method === 'POST') {
        db = JSON.parse(await readBody(req)).db;
        events.length = 0;
        najikiSends.length = 0;
        requestLog.length = 0;
        return json(res, 200, { ok: true });
      }
      if (path === '/_test/state' && method === 'GET') {
        return json(res, 200, { db, events, najikiSends, requestLog });
      }
      if (path === '/_test/mutate' && method === 'POST') {
        const { table, match, patch } = JSON.parse(await readBody(req));
        let touched = 0;
        for (const row of db[table] || []) {
          if (Object.entries(match).every(([k, v]) => String(row[k]) === String(v))) {
            Object.assign(row, patch);
            touched++;
          }
        }
        return json(res, 200, { touched });
      }

      // ---- GoTrue ----
      if (path === '/auth/v1/signup' && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const user = {
          id: randomUUID(),
          aud: 'authenticated',
          role: 'authenticated',
          email: body.email,
          user_metadata: body.data || {},
          app_metadata: {},
          created_at: new Date().toISOString(),
        };
        return json(res, 200, mkSession(user));
      }
      if (path === '/auth/v1/user' && method === 'GET') {
        const user = bearer && usersByToken.get(bearer);
        if (!user) return json(res, 401, { message: 'Invalid token' });
        return json(res, 200, user);
      }
      // supabase.auth.updateUser({ data }) — user_metadata is client-writable
      if (path === '/auth/v1/user' && (method === 'PUT' || method === 'PATCH')) {
        const user = bearer && usersByToken.get(bearer);
        if (!user) return json(res, 401, { message: 'Invalid token' });
        const body = JSON.parse(await readBody(req) || '{}');
        user.user_metadata = { ...user.user_metadata, ...(body.data || {}) };
        return json(res, 200, user);
      }
      if (path === '/auth/v1/token' && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const grant = url.searchParams.get('grant_type');
        const user = grant === 'refresh_token' ? usersByRefresh.get(body.refresh_token) : null;
        if (!user) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, mkSession(user));
      }
      if (path === '/auth/v1/health' && method === 'GET') {
        return json(res, 200, { version: 'stub-gotrue' });
      }
      if (path.startsWith('/auth/v1/')) return json(res, 404, { message: 'not implemented in stub' });

      // ---- Inngest event API: POST /e/<eventKey>, body = bare array of events,
      //      response must satisfy sendEventResponseSchema with status 200 ----
      if (path.startsWith('/e/') && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '[]');
        const evs = Array.isArray(body) ? body : body.events || [];
        for (const ev of evs) events.push(ev);
        return json(res, 200, { status: 200, ids: evs.map((e, i) => String(e.id ?? `evt-${i}`)) });
      }

      // ---- NaJiki SMS gateway: lib/sms.ts dispatches here (direct, no queue) ----
      if (path === '/api/messaging/send' && method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        najikiSends.push({
          to: body.to,
          message: body.message,
          eventType: body.eventType,
          idempotencyKey: body.idempotencyKey,
          idempotencyHeader: req.headers['idempotency-key'] || null,
          tenantCode: body.tenantCode,
          applicationCode: body.applicationCode,
        });
        return json(res, 200, { smsId: `sms-${najikiSends.length}` });
      }

      // ---- PostgREST RPC: debit_sms_wallet (idempotent wallet debit) ----
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
          reference: body.p_idempotency_key,
          direction: 'debit',
          amount,
          description: body.p_description,
          balance_after: balance,
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

        if (method === 'GET') {
          return json(res, 200, filterRows(rows, url.searchParams)); // arrays: maybeSingle coerces client-side
        }
        if (method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const inserted = Array.isArray(body) ? body : [body];
          for (const r of inserted) {
            if (r.id != null && rows.some((x) => x.id === r.id)) {
              return json(res, 409, {
                code: '23505',
                message: 'duplicate key value violates unique constraint',
                details: `Key (id)=(${r.id}) already exists.`,
                hint: null,
              });
            }
            rows.push(r);
          }
          return json(res, 201, {});
        }
        if (method === 'PATCH') {
          const body = JSON.parse(await readBody(req) || '{}');
          filterRows(rows, url.searchParams).forEach((r) => Object.assign(r, body));
          return json(res, 204, {});
        }
        if (method === 'DELETE') {
          db[key] = rows.filter((r) => !filterRows([r], url.searchParams).length);
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
        server,
        port: server.address().port,
        get events() { return events; },
        get najikiSends() { return najikiSends; },
        get db() { return db; },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// World builder: real SQL migrations on PGlite produce the org/alias rows
// ---------------------------------------------------------------------------
async function buildWorld(applyFixMigration) {
  const pglite = new PGlite();
  await pglite.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  `);
  await pglite.exec(read('test/financial-base-schema.sql'));
  await pglite.exec(read('supabase/migrations/24_sacco_join_codes.sql'));

  // The SACCOs as their admin would have created them back when migration 24
  // was live. LEGACY_CODE is what migration 24's generator produces; it went
  // out to members as a shared link.
  await pglite.exec(`
    INSERT INTO kunity.organizations (id, name, code, is_active, join_code) VALUES
      ('aaaaaaa1-0000-4000-8000-000000000001', 'Legacy Sacco', 'LS', true,  '${LEGACY_CODE}'),
      ('aaaaaaa1-0000-4000-8000-000000000002', 'Lucky Sacco',  'LU', true,  '${LUCKY_CODE}'),
      ('aaaaaaa1-0000-4000-8000-000000000003', 'Bravo Sacco',  'BR', true,  '${BRAVO_CODE}'),
      ('aaaaaaa1-0000-4000-8000-000000000004', 'Inactive Sacco','IN', false, '${INACTIVE_CODE}');
  `);

  if (applyFixMigration) {
    await pglite.exec(read('supabase/migrations/38_join_code_alphabet_fix.sql'));
  }

  const organizations = (await pglite.query('SELECT id, name, code, is_active, join_code FROM kunity.organizations ORDER BY name')).rows;
  const aliases = applyFixMigration
    ? (await pglite.query('SELECT legacy_code, organization_id FROM kunity.join_code_aliases')).rows
    : [];
  await pglite.close();

  return {
    db: {
      'kunity.organizations': organizations,
      'kunity.join_code_aliases': aliases,
      'kunity.members': [],
      // The SMS side of the house (lib/sms.ts works in the public schema):
      // tenants mirror the orgs, every SACCO has a funded wallet.
      'public.tenants': organizations.map((o) => ({ id: o.id, application_id: `app-${o.code}`, code: o.code })),
      'public.sms_templates': [],
      'public.wallets': organizations.map((o, i) => ({ id: `wallet-${i + 1}`, tenant_id: o.id, balance: 100000, sms_rate: 50 })),
      'public.sms_messages': [],
      'public.wallet_transactions': [],
    },
    organizations,
    aliases,
  };
}

// ---------------------------------------------------------------------------
// Next.js dev servers
// ---------------------------------------------------------------------------
async function startNext(port, cwd, label) {
  const env = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stubPortGlobal}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    // The fixed code dispatches SMS straight to the NaJiki gateway; the pre-fix
    // code still queues through Inngest. Both point at the stub.
    NAJIKI_API_URL: `http://127.0.0.1:${stubPortGlobal}`,
    NAJIKI_API_KEY: 'najiki-stub-key',
    NAJIKI_APPLICATION_CODE: 'sacco',
    INNGEST_EVENT_API_BASE_URL: `http://127.0.0.1:${stubPortGlobal}/`,
    INNGEST_EVENT_KEY: EVENT_KEY,
    NODE_ENV: 'development',
  };
  delete env.UPSTASH_REDIS_REST_URL;
  delete env.UPSTASH_REDIS_REST_TOKEN;
  delete env.ENFORCE_REDIS_RATELIMIT;
  // detached: the child leads its own process group, so stop() can kill the
  // whole tree (npx -> next dev -> next-server + webpack workers). A SIGTERM to
  // just the wrapper orphans next-server, which then haunts the port and makes
  // later runs look like they "hang".
  const child = spawn('npx', ['next', 'dev', '--webpack', '-p', String(port), '-H', '127.0.0.1'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  };

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`${label} next dev exited early (${child.exitCode}):\n${log.slice(-2000)}`);
    try {
      // Any HTTP answer means the server + route are up. (/api/health returns 503
      // "degraded" when optional payment/AI env is absent — a config report, not
      // a startup failure.)
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.status >= 200) {
        // Warm the routes this test drives so their first-request webpack
        // compile is not inside a timed assertion.
        await fetch(`${base}/api/organizations/resolve?code=WARMUP0000`, { signal: AbortSignal.timeout(120_000) }).catch(() => {});
        await fetch(`${base}/api/auth/profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(120_000),
        }).catch(() => {});
        return { child, base, getLog: () => log, stop };
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  stop();
  throw new Error(`${label} next dev did not become ready:\n${log.slice(-2000)}`);
}

// ---------------------------------------------------------------------------
// The journey — an exact replay of app/auth/page.tsx's requests
// ---------------------------------------------------------------------------
async function appFetch(base, path, opts = {}) {
  return fetch(base + path, { ...opts, signal: AbortSignal.timeout(180_000), redirect: 'manual' });
}

// page useEffect: fetch(`/api/organizations/resolve?code=${encodeURIComponent(code)}`)
async function resolveLink(base, rawCode, ip = '10.99.0.1') {
  const res = await appFetch(base, `/api/organizations/resolve?code=${encodeURIComponent(rawCode)}`, {
    headers: { 'x-forwarded-for': ip },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// page handleAuth (register mode, step 2 submit)
async function registerPerson({ stub, base, rawCode, fullName, email, password = 'S3cure-pass!', phone, gender = 'm', dateOfBirth = '1995-06-15', nationalId, address = '123 Main St, Kampala', nextOfKinName = 'Jane Doe', nextOfKinPhone = '0777000099', metadataTenantId = null, orgIdOverride = null, ip = '10.0.0.1' }) {
  // joinCode state: code.trim().toUpperCase().replace(/[\s-]/g, '')
  const joinCode = rawCode.trim().toUpperCase().replace(/[\s-]/g, '');

  // 1) the page's resolve fetch (locks the SACCO; required to proceed)
  const resolved = await resolveLink(base, rawCode, ip);
  let orgId = orgIdOverride;
  if (!orgId && resolved.status === 200 && resolved.json.organization) orgId = resolved.json.organization.id;

  // 2) supabase.auth.signUp — same client call, pointed at the stub
  const sb = createClient(`http://127.0.0.1:${stub.port}`, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error: signUpError } = await sb.auth.signUp({
    email,
    password,
    options: {
      data: {
        tenant_id: metadataTenantId ?? orgId,
        full_name: fullName,
        role: 'member',
        app_type: 'sacco',
      },
    },
  });
  if (signUpError) return { step: 'signup', signUpError, resolved };

  // 3) token exactly as the page resolves it
  let token = data.session?.access_token;
  if (!token) {
    const { data: sessionData } = await sb.auth.getSession();
    token = sessionData.session?.access_token;
  }

  // 4) POST /api/auth/profile — same headers and body shape as the page
  const setupResponse = await appFetch(base, '/api/auth/profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
      nextOfKinPhone,
    }),
  });
  const setupJson = await setupResponse.json().catch(() => ({}));

  // 5) the page refreshes the session before redirecting to /member
  await sb.auth.refreshSession().catch(() => {});

  return { step: 'done', userId: data.user.id, token, resolved, setupStatus: setupResponse.status, setupJson, orgId, joinCode };
}

function logExcerpt(getLog, re, n = 12) {
  if (!getLog) return '(no server log captured)';
  return getLog().split('\n').filter((l) => re.test(l)).slice(-n).join('\n') || '(no matching log lines)';
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
async function main() {
  // Clear any orphaned next servers from previous runs (a SIGTERMed wrapper can
  // leave `next-server` alive; it then haunts the port and fakes a hang).
  try { execSync('pkill -9 -f next-server; pkill -9 -f "next dev"', { stdio: 'ignore' }); } catch { /* nothing to kill */ }
  await new Promise((r) => setTimeout(r, 1000));

  console.log('Starting stub Supabase...');
  const stub = await startStub();
  stubPortGlobal = stub.port;

  // The pre-fix code, as members experienced it: a worktree of the branch point.
  // Pinned explicitly (PR #11's parent on main): merge-base HEAD origin/main is
  // only correct while this branch is UNMERGED — once the fix lands on main it
  // returns the fix itself and the BEFORE phase silently degrades (seen
  // 2026-10-22: 29/31 with two artifact failures). Prefer the pin; fall back
  // to merge-base only when the pinned commit is absent (shallow clones).
  const PRE_FIX_SHA = '15ac3305e92d5d0f376091656529ca9545d0e95d';
  let oldSha = '';
  try {
    execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${PRE_FIX_SHA}^{commit}`], { stdio: 'pipe' });
    oldSha = PRE_FIX_SHA;
  } catch {
    oldSha = execFileSync('git', ['-C', ROOT, 'merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' }).trim();
  }
  console.log(`Preparing pre-fix worktree at ${OLD_TREE} (${oldSha.slice(0, 8)})...`);
  execFileSync('git', ['-C', ROOT, 'worktree', 'prune'], { stdio: 'ignore' });
  rmSync(OLD_TREE, { recursive: true, force: true });
  execFileSync('git', ['-C', ROOT, 'worktree', 'add', '--detach', OLD_TREE, oldSha], { stdio: 'pipe' });
  // The pre-fix code still imports the Inngest SDK, which this branch no longer
  // depends on — so the worktree cannot share our node_modules. Give it its own
  // install from its own (old) package.json.
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: OLD_TREE, stdio: 'pipe' });

  let oldNext = null;
  let newNext = null;
  try {
    // ======================= PHASE 1: BEFORE =======================
    // OLD code + OLD data = the live bug, reproduced exactly.
    console.log('\nPHASE 1 — pre-fix server + migration-24 world (the bug as members saw it)');
    const before = await buildWorld(false);
    await fetch(`http://127.0.0.1:${stub.port}/_test/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: before.db }),
    });
    oldNext = await startNext(OLD_PORT, OLD_TREE, 'pre-fix');
    console.log(`Pre-fix app up at ${OLD_APP}`);

    const legacyOrgBefore = before.organizations.find((o) => o.join_code === LEGACY_CODE);
    record('world: migration-24 generator produced the legacy hex code', !!legacyOrgBefore);

    // THE bug, end to end: the real (old) server refuses the SACCO's real code.
    let r = await resolveLink(OLD_APP, LEGACY_CODE, '8.8.0.1');
    record('BEFORE: shared legacy link is rejected ("This join link is not valid")',
      r.status === 400 && /not valid/i.test(r.json.error || ''), `status ${r.status} ${JSON.stringify(r.json)}`);

    // Defense in depth (then and now): forcing the API directly does not help.
    const forced = await registerPerson({
      stub, base: OLD_APP, rawCode: LEGACY_CODE, fullName: 'Forced Before', email: 'forced-before@example.com',
      phone: '0772000001', nationalId: 'CM1101111111AA', ip: '8.8.0.2',
      orgIdOverride: legacyOrgBefore.id, metadataTenantId: legacyOrgBefore.id,
    });
    record('BEFORE: profile API refuses the legacy code too (no bypass around the UI)',
      forced.setupStatus === 400 && /join link is required/i.test(forced.setupJson.error || ''),
      `status ${forced.setupStatus} ${JSON.stringify(forced.setupJson)}`);
    record('BEFORE: no member row was created for the refused signup',
      !stub.db['kunity.members'].some((m) => m.email === 'forced-before@example.com'));

    // The lucky conforming link worked then and must keep working.
    r = await resolveLink(OLD_APP, LUCKY_CODE, '8.8.0.3');
    record('BEFORE: conforming link resolves', r.status === 200 && r.json.organization?.name === 'Lucky Sacco');

    const luckyReg = await registerPerson({
      stub, base: OLD_APP, rawCode: LUCKY_CODE, fullName: 'Lucky Member', email: 'lucky-before@example.com',
      phone: '0772000002', nationalId: 'CM2202222222BB', ip: '8.8.0.4',
    });
    record('BEFORE: full registration through a conforming link works end to end',
      luckyReg.setupStatus === 200 && luckyReg.setupJson.success === true,
      `status ${luckyReg.setupStatus} ${JSON.stringify(luckyReg.setupJson)}`);
    const memberBefore = stub.db['kunity.members'].find((m) => m.id === luckyReg.userId);
    record('BEFORE: member row created with status pending + derived member_number',
      !!memberBefore && memberBefore.status === 'pending' && memberBefore.organization_id === luckyReg.orgId &&
      memberBefore.member_number === luckyReg.userId.slice(0, 8).toUpperCase() && memberBefore.national_id === 'CM2202222222BB',
      memberBefore ? JSON.stringify({ status: memberBefore.status, member_number: memberBefore.member_number }) : 'no row');

    oldNext.stop();
    oldNext = null;

    // ======================= PHASE 2: AFTER =======================
    // NEW code + NEW data = the fix, end to end.
    console.log('\nPHASE 2 — this branch (migration 38 world: aliases + clean codes)');
    const after = await buildWorld(true);
    await fetch(`http://127.0.0.1:${stub.port}/_test/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: after.db }),
    });
    newNext = await startNext(NEW_PORT, ROOT, 'fixed');
    console.log(`Fixed app up at ${NEW_APP}`);

    const legacyOrg = after.organizations.find((o) => o.id === 'aaaaaaa1-0000-4000-8000-000000000001');
    const luckyOrg = after.organizations.find((o) => o.id === 'aaaaaaa1-0000-4000-8000-000000000002');
    const bravoOrg = after.organizations.find((o) => o.id === 'aaaaaaa1-0000-4000-8000-000000000003');
    const aliasRow = after.aliases.find((a) => a.legacy_code === LEGACY_CODE);
    record('world: migration 38 replaced the dead code and snapshotted the alias',
      !!aliasRow && legacyOrg.join_code !== LEGACY_CODE && !!legacyOrg.join_code && aliasRow.organization_id === legacyOrg.id,
      `code now ${legacyOrg.join_code}, alias ${LEGACY_CODE} -> ${aliasRow ? aliasRow.organization_id.slice(0, 8) : 'MISSING'}`);
    record('world: conforming code untouched by the fix', luckyOrg.join_code === LUCKY_CODE);

    // The same shared link that was dead in phase 1 now works.
    r = await resolveLink(NEW_APP, 'ab01 cd23-ef', '8.8.1.1'); // messy real-world input (case + spaces)
    record('AFTER: the SAME shared legacy link resolves (alias path, messy input ok)',
      r.status === 200 && r.json.organization?.id === legacyOrg.id && r.json.organization?.name === 'Legacy Sacco',
      `status ${r.status} ${JSON.stringify(r.json)}`);

    // ...and a full registration through that old link succeeds end to end.
    const legacyReg = await registerPerson({
      stub, base: NEW_APP, rawCode: LEGACY_CODE, fullName: 'Legacy Linker', email: 'legacy-after@example.com',
      phone: '0772000003', nationalId: 'CM3303333333CC', ip: '8.8.1.2',
    });
    record('AFTER: full registration through the old shared link works end to end',
      legacyReg.setupStatus === 200 && legacyReg.setupJson.success === true,
      `status ${legacyReg.setupStatus} ${JSON.stringify(legacyReg.setupJson)}`);
    const member = stub.db['kunity.members'].find((m) => m.id === legacyReg.userId);
    record('AFTER: member lands in the right SACCO with pending status',
      !!member && member.organization_id === legacyOrg.id && member.status === 'pending' &&
      member.first_name === 'Legacy' && member.last_name === 'Linker' && member.next_of_kin_name === 'Jane Doe',
      member ? JSON.stringify({ org: member.organization_id, status: member.status }) : 'no row');

    const sms = stub.najikiSends.find((s) => s.idempotencyKey === `welcome-${legacyReg.userId}`);
    record('AFTER: welcome SMS dispatched to the gateway (right member, dedup key)',
      !!sms && sms.to === '+256772000003' && sms.eventType === 'WELCOME' &&
      (sms.message || '').includes('Legacy') && (sms.message || '').includes(legacyReg.userId.slice(0, 8).toUpperCase()),
      sms ? `to ${sms.to}, key ${sms.idempotencyKey}` : `gateway sends seen: ${stub.najikiSends.map((s) => s.eventType).join(',') || 'none'}`);
    if (!sms) console.log('    [server log excerpt]\n' + logExcerpt(() => newNext.getLog(), /najiki|welcome|sms|dispatch/i).split('\n').map((l) => '    ' + l).join('\n'));

    // Conforming links keep working; bad links still die.
    r = await resolveLink(NEW_APP, LUCKY_CODE, '8.8.1.3');
    record('AFTER: conforming link still resolves', r.status === 200 && r.json.organization?.id === luckyOrg.id);
    r = await resolveLink(NEW_APP, BRAVO_CODE, '8.8.1.4');
    record('AFTER: second SACCO resolves to itself', r.status === 200 && r.json.organization?.name === 'Bravo Sacco');
    r = await resolveLink(NEW_APP, INACTIVE_CODE, '8.8.1.5');
    record('AFTER: inactive SACCO link refused', r.status === 404 && /no longer active|invalid/i.test(r.json.error || ''));
    r = await resolveLink(NEW_APP, 'ZZZZZZZZZZ', '8.8.1.6');
    record('AFTER: unknown-but-well-formed code -> 404', r.status === 404);
    r = await resolveLink(NEW_APP, 'short', '8.8.1.7');
    record('AFTER: garbage code -> 400 not valid', r.status === 400);

    // Page smoke: middleware lets the join-link page render.
    const pageRes = await appFetch(NEW_APP, `/auth?sacco=${LUCKY_CODE}`);
    const pageHtml = await pageRes.text();
    record('AFTER: /auth join-link page renders through the real middleware',
      pageRes.status === 200 && pageHtml.includes('<div'), `status ${pageRes.status}`);

    // ======================= PHASE 3: guards on the live flow =======================
    console.log('\nPHASE 3 — guard rails on the same live endpoints');

    // No token
    let res = await appFetch(NEW_APP, '/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '8.8.2.0' },
      body: JSON.stringify({ userId: randomUUID(), fullName: 'X', joinCode: LEGACY_CODE, email: 'x@x.com' }),
    });
    record('profile: no session token -> 401', res.status === 401);

    // userId mismatch (account tampering)
    const tamper = await registerPerson({
      stub, base: NEW_APP, rawCode: LEGACY_CODE, fullName: 'Tamper Test', email: 'tamper@example.com',
      phone: '0772000004', nationalId: 'CM4404444444DD', ip: '8.8.2.1',
    });
    res = await appFetch(NEW_APP, '/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '8.8.2.1', Authorization: `Bearer ${tamper.token}` },
      body: JSON.stringify({ userId: randomUUID(), fullName: 'Tamper Test', joinCode: LEGACY_CODE, orgId: legacyOrg.id, email: 'tamper@example.com', phone: '0772000004', nationalId: 'CM4404444444DD' }),
    });
    record('profile: userId does not match token -> 403 (account tampering)',
      res.status === 403, `status ${res.status}`);

    // orgId vs joinCode mismatch
    res = await appFetch(NEW_APP, '/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '8.8.2.1', Authorization: `Bearer ${tamper.token}` },
      body: JSON.stringify({ userId: tamper.userId, fullName: 'Tamper Test', joinCode: LEGACY_CODE, orgId: luckyOrg.id, email: 'tamper@example.com', phone: '0772000004', nationalId: 'CM4404444444DD' }),
    });
    record('profile: orgId disagrees with the join link -> 403',
      res.status === 403 && /join link/i.test((await res.json().catch(() => ({}))).error || ''), `status ${res.status}`);

    // signup metadata tenant mismatch
    const metaMismatch = await registerPerson({
      stub, base: NEW_APP, rawCode: LEGACY_CODE, fullName: 'Meta Mismatch', email: 'meta-mismatch@example.com',
      phone: '0772000005', nationalId: 'CM5505555555EE', ip: '8.8.2.2',
      metadataTenantId: luckyOrg.id, // signup claims Lucky, link says Legacy
    });
    record('profile: signup tenant metadata vs join link -> 403',
      metaMismatch.setupStatus === 403 && /tenant/i.test(metaMismatch.setupJson.error || ''),
      `status ${metaMismatch.setupStatus} ${JSON.stringify(metaMismatch.setupJson)}`);

    // duplicate National ID within the SACCO
    const dupNin = await registerPerson({
      stub, base: NEW_APP, rawCode: LEGACY_CODE, fullName: 'NIN Thief', email: 'nin-thief@example.com',
      phone: '0772000006', nationalId: 'CM3303333333CC', ip: '8.8.2.3', // same NIN as Legacy Linker
    });
    record('registration: duplicate National ID in same SACCO -> 403',
      dupNin.setupStatus === 403 && /National ID is already registered/i.test(dupNin.setupJson.error || ''),
      `status ${dupNin.setupStatus} ${JSON.stringify(dupNin.setupJson)}`);

    // declined applicant re-applying under a new email (same phone)
    await fetch(`http://127.0.0.1:${stub.port}/_test/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'kunity.members', match: { id: tamper.userId }, patch: { status: 'rejected' } }),
    });
    const reApply = await registerPerson({
      stub, base: NEW_APP, rawCode: LEGACY_CODE, fullName: 'Comeback Kid', email: 'comeback@example.com',
      phone: '0772000004', nationalId: 'CM6606666666FF', ip: '8.8.2.4', // same phone as the rejected member
    });
    record('registration: declined applicant re-applies with new email -> 403',
      reApply.setupStatus === 403 && /previously declined/i.test(reApply.setupJson.error || ''),
      `status ${reApply.setupStatus} ${JSON.stringify(reApply.setupJson)}`);

    // identity lock after approval
    await fetch(`http://127.0.0.1:${stub.port}/_test/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'kunity.members', match: { id: legacyReg.userId }, patch: { status: 'active' } }),
    });
    res = await appFetch(NEW_APP, '/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '8.8.2.5', Authorization: `Bearer ${legacyReg.token}` },
      body: JSON.stringify({ userId: legacyReg.userId, fullName: 'Legacy Linker', joinCode: LEGACY_CODE, orgId: legacyOrg.id, email: 'legacy-after@example.com', nationalId: 'CM7707777777GG' }),
    });
    record('profile: active member changing National ID -> 403 (identity locked)',
      res.status === 403 && /locked/i.test((await res.json().catch(() => ({}))).error || ''), `status ${res.status}`);

    res = await appFetch(NEW_APP, '/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '8.8.2.5', Authorization: `Bearer ${legacyReg.token}` },
      body: JSON.stringify({ userId: legacyReg.userId, fullName: 'Legacy Linker', joinCode: LEGACY_CODE, orgId: legacyOrg.id, email: 'legacy-after@example.com', address: '45 New Road, Kampala' }),
    });
    record('profile: active member updating address -> allowed',
      res.status === 200 && (await res.json()).success === true, `status ${res.status}`);

    // cross-tenant migration attempt (joinCode + orgId both say Bravo).
    // Honest metadata: refused by the signup-tenant guard (which runs first).
    res = await appFetch(NEW_APP, '/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '8.8.2.5', Authorization: `Bearer ${legacyReg.token}` },
      body: JSON.stringify({ userId: legacyReg.userId, fullName: 'Legacy Linker', joinCode: BRAVO_CODE, orgId: bravoOrg.id, email: 'legacy-after@example.com' }),
    });
    record('profile: member trying to move to another SACCO -> 403',
      res.status === 403 && /tenant|another SACCO|Cross-tenant/i.test((await res.json().catch(() => ({}))).error || ''), `status ${res.status}`);

    // ...and the classic attack: poison your own user_metadata tenant_id (it is
    // client-writable) to match the target SACCO, then attempt the migration.
    await fetch(`http://127.0.0.1:${stub.port}/auth/v1/user`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${legacyReg.token}` },
      body: JSON.stringify({ data: { tenant_id: bravoOrg.id, role: 'super_admin' } }),
    });
    res = await appFetch(NEW_APP, '/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '8.8.2.5', Authorization: `Bearer ${legacyReg.token}` },
      body: JSON.stringify({ userId: legacyReg.userId, fullName: 'Legacy Linker', joinCode: BRAVO_CODE, orgId: bravoOrg.id, email: 'legacy-after@example.com' }),
    });
    record('profile: poisoned user_metadata cannot migrate the member -> 403 (cross-tenant)',
      res.status === 403 && /another SACCO|Cross-tenant/i.test((await res.json().catch(() => ({}))).error || ''), `status ${res.status}`);

    // rate limit: 5 new registrations per IP per hour, then 429
    let first429 = 0;
    let lastStatus = 0;
    for (let i = 1; i <= 6; i++) {
      const attempt = await registerPerson({
        stub, base: NEW_APP, rawCode: LUCKY_CODE, fullName: `Flood ${i}`, email: `flood${i}@example.com`,
        phone: `077210000${i}`, nationalId: `CM880888888${i}HH`, ip: '9.9.9.9',
      });
      lastStatus = attempt.setupStatus;
      if (attempt.setupStatus === 429 && !first429) first429 = i;
    }
    record('registration: 6th new account from one IP -> 429 rate limited',
      first429 === 6, `first 429 on attempt ${first429}, last status ${lastStatus}`);

    const floodMembers = stub.db['kunity.members'].filter((m) => String(m.first_name).startsWith('Flood'));
    record('registration: rate limit prevented the extra account',
      floodMembers.length === 5, `${floodMembers.length} flood members`);
  } catch (e) {
    console.log('\n[debug] server log excerpts at failure:');
    if (oldNext) console.log('--- pre-fix server ---\n' + logExcerpt(() => oldNext.getLog(), /error|warn|najiki|welcome|sms|ECONN|timeout|Exception/i, 30));
    if (newNext) console.log('--- fixed server ---\n' + logExcerpt(() => newNext.getLog(), /error|warn|najiki|welcome|sms|ECONN|timeout|Exception/i, 30));
    throw e;
  } finally {
    if (oldNext) oldNext.stop();
    if (newNext) newNext.stop();
    stub.server.close();
    try { execFileSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', OLD_TREE], { stdio: 'ignore' }); } catch { rmSync(OLD_TREE, { recursive: true, force: true }); }
  }

  const failed = results.filter((x) => !x.pass).length;
  console.log(`\nRESULTS: ${results.length - failed}/${results.length} passed`);
  if (failed) {
    console.log('FAILURES:');
    for (const f of results.filter((x) => !x.pass)) console.log(`  - ${f.name} ${f.detail}`);
    process.exit(1);
  }
  console.log('SIGN-UP FLOW END-TO-END: ALL CHECKS PASSED');
  process.exit(0);
}

let stubPortGlobal = 0;

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
