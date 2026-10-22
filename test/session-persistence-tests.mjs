// -----------------------------------------------------------------------------
// Session persistence — login must survive refreshes until the member logs out.
//
// Root cause of the logout-on-every-refresh bug (fixed 2026-10-22): the
// browser client wrote a SECOND copy of every sb-* cookie (Partitioned,
// 1-year) on each auth change and "self-healed" duplicates by deleting every
// copy on load; the middleware then read a stale copy, Supabase reported the
// refresh token as already used, and the middleware wiped the login.
//
// Static: both hacks are gone from lib/supabase.ts; the middleware wipes
// cookies ONLY on a definitive refresh-token rejection (or access-token 401),
// and both cookie writers pin the same 30-day life.
//
// Live (real dev server + a GoTrue stub with real rotation semantics):
//   - a signed-in member hard-refreshes /member three times -> 200 every
//     time, never a redirect, never a cookie wipe;
//   - an expired access token forces a refresh-token ROTATION through the
//     stub -> still 200, new session cookie issued and usable;
//   - a genuinely dead session (already-used refresh token) -> redirected to
//     /auth with the cookies wiped (security preserved);
//   - an anonymous visit -> redirected to /auth.
//
// Run: node test/session-persistence-tests.mjs
// -----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { openSync } from 'node:fs';
import http from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientTs = readFileSync(join(ROOT, 'lib', 'supabase.ts'), 'utf8');
const middlewareTs = readFileSync(join(ROOT, 'lib', 'supabase-middleware.ts'), 'utf8');

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✅ PASS  ${name}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
};

console.log('Static wiring');

check(
  'browser client no longer writes/deletes sb-* cookies by hand (both hacks removed)',
  !clientTs.includes('document.cookie') && !clientTs.includes('onAuthStateChange')
);
check(
  'browser client pins the 30-day cookie life and keeps the kunity schema',
  clientTs.includes('60 * 60 * 24 * 30') && clientTs.includes("schema: 'kunity'")
);
check(
  'middleware wipes cookies only on a definitive refresh-token rejection / 401 (plain 400 no longer nukes the login)',
  middlewareTs.includes('/refresh token/i.test(authError.message') &&
  middlewareTs.includes('authError.status === 401') &&
  !middlewareTs.includes("authError.message?.includes('Refresh Token') || authError.status === 400 || authError.status === 401")
);
check(
  'middleware cookie writer pins the same 30-day life as the browser client',
  /maxAge: 60 \* 60 \* 24 \* 30/.test(middlewareTs)
);

// ---------------------------------------------------------------------------
// GoTrue stub with rotation semantics
// ---------------------------------------------------------------------------
const sessions = new Map(); // access token -> session
let currentSession = null; // { access, refresh, user, previousRefresh: [] }
const usedRefreshTokens = new Set();

const mintSession = (userId) => {
  const access = 'access-' + crypto.randomUUID();
  const refresh = 'refresh-' + crypto.randomUUID();
  const session = {
    access,
    refresh,
    user: { id: userId, email: 'member@example.test', aud: 'authenticated' },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
  sessions.set(access, session);
  currentSession = session;
  return session;
};

const stub = http.createServer((req, res) => {
  const json = (code, body) => {
    const p = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) });
    res.end(p);
  };
  const url = new URL(req.url, 'http://stub');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = body ? JSON.parse(body) : {};

    if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const s = sessions.get(bearer);
      if (s && bearer === s.access) return json(200, { ...s.user, app_metadata: { provider: 'email' } });
      return json(401, { message: 'Invalid JWT' });
    }

    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token' && req.method === 'POST') {
      const rt = payload.refresh_token;
      if (currentSession && rt === currentSession.refresh) {
        // Rotate: old access token dies, old refresh token is spent.
        sessions.delete(currentSession.access);
        usedRefreshTokens.add(rt);
        const access = 'access-' + crypto.randomUUID();
        const refresh = 'refresh-' + crypto.randomUUID();
        currentSession = { ...currentSession, access, refresh, expires_at: Math.floor(Date.now() / 1000) + 3600 };
        sessions.set(access, currentSession);
        return json(200, {
          access_token: access,
          refresh_token: refresh,
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: currentSession.expires_at,
          user: currentSession.user,
        });
      }
      return json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' });
    }

    if (url.pathname === '/rest/v1/admin_profiles') return json(200, []);
    if (url.pathname === '/auth/v1/health') return json(200, { version: 'stub' });
    return json(404, { message: 'no stub handler ' + req.url });
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;

// ---------------------------------------------------------------------------
// Real dev server
// ---------------------------------------------------------------------------
const PORT = 3438;
const logFd = openSync('/tmp/session-test-next.log', 'w');
const child = spawn('npx', ['next', 'dev', '--webpack', '-p', String(PORT), '-H', '127.0.0.1'], {
  cwd: ROOT,
  env: {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stubPort}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'stub-service',
    NEXT_TELEMETRY_DISABLED: '1',
  },
  stdio: ['ignore', logFd, logFd],
  detached: true,
});
const stop = () => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  stub.close();
  try { stub.closeAllConnections(); } catch { /* older Node */ }
};
const logTail = () => {
  try { return readFileSync('/tmp/session-test-next.log', 'utf8').split('\n').slice(-30).join('\n'); }
  catch { return '(no log)'; }
};

const sessionCookie = (s, { expiredAccess = false } = {}) => {
  const payload = {
    access_token: s.access,
    refresh_token: s.refresh,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiredAccess ? Math.floor(Date.now() / 1000) - 120 : s.expires_at,
    user: { id: s.user.id },
  };
  return `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
};

const getMember = async (cookie) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/member`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const html = res.status === 200 ? await res.text() : '';
  return { status: res.status, location: res.headers.get('location'), setCookies, html };
};

try {
  const deadline = Date.now() + 180_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(5000) });
      // Any HTTP answer (even a config 503 from the stub backend) proves the
      // dev server is up and routing; the page requests below tolerate the
      // first-hit compile with their own long timeouts.
      up = true;
    } catch { /* wait */ }
    if (child.exitCode != null) throw new Error('dev server exited early');
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!up) throw new Error('dev server never came up');

  console.log('Live: hard refresh keeps the member logged in');

  const s1 = mintSession('member-persist-1');
  const c1 = sessionCookie(s1);

  const first = await getMember(c1);
  check('signed-in member loads /member (200)', first.status === 200, `status ${first.status} -> ${first.location}`);

  let refreshesOk = true;
  let wiped = false;
  for (let i = 1; i <= 3; i++) {
    const r = await getMember(c1);
    if (r.status !== 200) refreshesOk = false;
    if (r.setCookies.some((sc) => /max-age=0/i.test(sc))) wiped = true;
  }
  check('three hard refreshes: 200 every time, never redirected', refreshesOk);
  check('no cookie was ever wiped during the refreshes', !wiped);

  console.log('Live: token rotation (expired access token)');

  // Cookie carries an already-expired access token but a VALID refresh token:
  // the middleware must refresh through the stub (which rotates the pair),
  // still render 200, and hand back the new session cookie.
  const c2 = sessionCookie(s1, { expiredAccess: true });
  const rotated = await getMember(c2);
  const newCookie = rotated.setCookies.filter((sc) => sc.startsWith('sb-127-auth-token=')).pop();
  check(
    'expired access token -> refreshed via the stub, still 200 (no logout)',
    rotated.status === 200,
    `status ${rotated.status} -> ${rotated.location}`
  );
  check('a fresh session cookie was issued by the rotation', !!newCookie && !/max-age=0/i.test(newCookie));

  if (newCookie) {
    const cookieValue = newCookie.split(';')[0];
    const after = await getMember(cookieValue);
    check('the rotated session works on the next request (200)', after.status === 200, `status ${after.status}`);
  }

  console.log('Live: dead session and anonymous still behave correctly');

  // s1.refresh was spent by the rotation above. A cookie still presenting it
  // (with an expired access token) is a genuinely dead session: the stub
  // rejects the refresh as already-used, and the middleware must clean up.
  const deadCookie = sessionCookie({ ...s1, refresh: [...usedRefreshTokens].pop() }, { expiredAccess: true });
  const dead = await getMember(deadCookie);
  check(
    'already-used refresh token -> redirected to /auth and cookies wiped (security preserved)',
    dead.status === 307 && /\/auth/.test(dead.location || '') &&
    dead.setCookies.some((sc) => sc.startsWith('sb-127-auth-token=') && /max-age=0/i.test(sc)),
    `status ${dead.status} -> ${dead.location}`
  );

  const anon = await getMember(null);
  check('anonymous visit -> redirected to /auth', anon.status === 307 && /\/auth/.test(anon.location || ''), `status ${anon.status}`);
} catch (e) {
  check('live pass ran without errors', false, e.message);
  console.log('    [server log tail]\n' + logTail().split('\n').map((l) => '    ' + l).join('\n'));
} finally {
  stop();
}

console.log(`\nRESULTS: ${passed}/${passed + failed} passed`);
if (failed) {
  console.log('SESSION PERSISTENCE: FAILURES ABOVE');
  process.exit(1);
}
console.log('SESSION PERSISTENCE: ALL CHECKS PASSED');
