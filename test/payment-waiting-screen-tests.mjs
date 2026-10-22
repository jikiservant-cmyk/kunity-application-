/**
 * The deposit/activation waiting screen ("Confirm on your phone") used to spin
 * forever: the page created the payment intent and rendered a 'pending' overlay,
 * but NOTHING ever polled the status endpoint — even after the NaJiki webhook
 * marked the payment failed (or successful) in the ledger, the browser never
 * found out. Reported by the NaJiki operators: webhook delivered, HTTP 200,
 * "Payment failed, updated status" — waiting screen never moved.
 *
 * Part A (static): the member page now polls /api/payments/[intentId] while the
 * overlay is pending, maps terminal statuses to the success/failed screens,
 * keeps waiting on 'processing', and can never spin forever.
 *
 * Part B (runtime): the status endpoint the overlay consumes returns exactly
 * the contract the UI depends on (ledger is the source of truth — FIN-35).
 *
 * Run: npx -y tsx test/payment-waiting-screen-tests.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name} — ${e.message}`);
  }
};

// ---------------------------------------------------------------------------
// Part A — the waiting screen actually watches the payment
// ---------------------------------------------------------------------------
console.log('Waiting-screen wiring (app/member/page.tsx)');
const page = read('app/member/page.tsx');
const watcherStart = page.indexOf('// Payment watcher:');
const watcherEnd = page.indexOf('}, [promptPayment?.id, promptPayment?.status]);', watcherStart);
assert.ok(watcherStart > 0 && watcherEnd > watcherStart, 'payment watcher effect not found');
const watcher = page.slice(watcherStart, watcherEnd);

await check('overlay polls the status endpoint while the payment is pending', async () => {
  assert.match(watcher, /promptPayment\.status !== 'pending'[\s\S]*return;/, 'effect must only run while pending');
  assert.match(watcher, /setInterval\(pollOnce, 3000\)/, 'must poll on an interval');
  assert.match(watcher, /\/api\/payments\/\$\{encodeURIComponent\(promptPayment\.id\)\}/, 'must call the status route');
});
await check('polls carry the member session token', async () => {
  assert.match(watcher, /Authorization: `Bearer \$\{session\.access_token\}`/);
});
await check('a failed/cancelled/expired payment settles the overlay on the failure screen', async () => {
  assert.ok(
    watcher.includes("['failed', 'failure', 'cancelled', 'canceled', 'expired', 'rejected']"),
    'failure status family must match the webhook RPC'
  );
  assert.match(watcher, /settle\('failed'\)/);
});
await check('only a ledger-confirmed success settles on the success screen', async () => {
  assert.match(watcher, /s === 'success' \|\| s === 'successful'/);
  assert.match(watcher, /settle\('success'\)/);
});
await check('gateway statuses are compared case-insensitively (NaJiki casing varies)', async () => {
  assert.match(watcher, /String\(json\?\.status \|\| ''\)\.toLowerCase\(\)/);
});
await check("'processing' (gateway success, webhook still in flight) keeps waiting", async () => {
  // The ONLY direct status equality check must be the success pair; everything
  // else settles exclusively via the failure family — so 'processing' and
  // 'pending' fall through and the overlay keeps waiting.
  const equalityChecks = watcher.match(/\bs === '[a-z']+'/g) || [];
  assert.deepEqual(equalityChecks, ["s === 'success'", "s === 'successful'"]);
  assert.match(watcher, /FAILURE_STATUSES\.includes\(s\)/);
});
await check('polling stops on terminal status and on overlay close (no leaked interval)', async () => {
  assert.match(watcher, /return \(\) => \{\s*cancelled = true;\s*clearInterval\(timer\);/, 'cleanup must clear the interval');
  assert.match(watcher, /clearInterval\(timer\);\s*setPromptPayment/, 'settling must clear the interval');
});
await check('a lost verdict cannot spin forever (absolute deadline)', async () => {
  assert.match(watcher, /Date\.now\(\) > deadline/, 'must check a deadline');
  assert.match(watcher, /5 \* 60 \* 1000/, 'deadline must be bounded');
});
await check('repeated poll errors give up instead of hammering forever', async () => {
  assert.match(watcher, /consecutiveErrors >= 10/);
});
await check('session loss mid-wait redirects to login instead of hanging', async () => {
  assert.match(watcher, /!session[\s\S]{0,200}router\.push\('\/auth'\)/);
});
await check('both deposit and activation payments feed the watched overlay', async () => {
  const entries = page.match(/status: 'pending',/g) || [];
  assert.ok(entries.length >= 2, 'deposit and account_activation both start a pending overlay');
});

// ---------------------------------------------------------------------------
// Part B — the status endpoint contract the overlay consumes
// ---------------------------------------------------------------------------
console.log('Status endpoint contract (app/api/payments/[intentId]/route.ts)');
const TOKEN = 'member-token';
const INTENT = 'SACCO-DEP-63294668-FC9D30AD26';

// Scenario state, mutated between checks.
const state = {
  prRow: null,          // kunity.payment_requests row (or null = unknown intent)
  gatewayStatus: null,  // what NaJiki's GET answers (null = fail the request)
  gatewayCalls: 0,
};

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(req.url, 'http://local.test');
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const wantsObject = String(req.headers.accept || '').includes('pgrst.object');

  if (url.pathname === '/auth/v1/user') {
    return req.headers.authorization === `Bearer ${TOKEN}`
      ? json(200, { id: 'member-a', email: 'member@example.test', aud: 'authenticated' })
      : json(401, { message: 'invalid token' });
  }
  // payment_requests lookup: the route filters by internal_reference.
  if (url.pathname === '/rest/v1/payment_requests') {
    const wanted = (url.searchParams.get('internal_reference') || '').replace(/^eq\./, '');
    if (!state.prRow || state.prRow.internal_reference !== wanted) return json(200, []);
    return json(200, wantsObject ? state.prRow : [state.prRow]);
  }
  if (url.pathname === '/rest/v1/tenants') {
    return json(200, wantsObject ? { code: 'sacco-a' } : [{ code: 'sacco-a' }]);
  }
  // NaJiki payment status API.
  if (req.method === 'GET' && url.pathname === `/api/payments/${INTENT}`) {
    state.gatewayCalls++;
    if (state.gatewayStatus === null) return json(500, { message: 'gateway down' });
    return json(200, { status: state.gatewayStatus, amount: 5000, currency: 'UGX' });
  }
  return json(404, { message: `No mock for ${req.method} ${url.pathname}` });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-service-role-test';
process.env.NAJIKI_API_URL = `http://127.0.0.1:${server.address().port}`;
process.env.NAJIKI_API_KEY = 'local-najiki-key';

const { GET } = await import('../app/api/payments/[intentId]/route.ts');
const call = async (intentId = INTENT) => {
  const request = new NextRequest(`http://localhost:3000/api/payments/${intentId}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const response = await GET(request, { params: Promise.resolve({ intentId }) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const memberRow = (status) => ({
  internal_reference: INTENT, member_id: 'member-a', organization_id: 'org-a', status,
});

await check('ledger says failed -> { status: failed } with no gateway call', async () => {
  state.prRow = memberRow('failed');
  state.gatewayStatus = 'failed';
  state.gatewayCalls = 0;
  const r = await call();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'failed', source: 'ledger' });
  assert.equal(state.gatewayCalls, 0, 'ledger verdict must not need the gateway');
});

await check('ledger says success -> { status: success } (wallet already credited)', async () => {
  state.prRow = memberRow('success');
  state.gatewayCalls = 0;
  const r = await call();
  assert.deepEqual(r.body, { status: 'success', source: 'ledger' });
  assert.equal(state.gatewayCalls, 0);
});

await check('gateway success before the webhook lands -> processing, not success (FIN-35)', async () => {
  state.prRow = memberRow('pending');
  state.gatewayStatus = 'success';
  state.gatewayCalls = 0;
  const r = await call();
  assert.equal(r.body.status, 'processing');
  assert.equal(r.body.source, 'gateway');
});

await check('gateway failure while our row is still pending -> failed reaches the overlay', async () => {
  state.prRow = memberRow('pending');
  state.gatewayStatus = 'failed';
  const r = await call();
  assert.equal(String(r.body.status).toLowerCase(), 'failed');
});

await check('gateway status casing is normalised by the overlay contract (raw passthrough)', async () => {
  state.prRow = memberRow('pending');
  state.gatewayStatus = 'Failed';
  const r = await call();
  assert.equal(String(r.body.status).toLowerCase(), 'failed');
});

await check('a member cannot poll someone else\'s payment intent (IDOR)', async () => {
  state.prRow = { internal_reference: INTENT, member_id: 'someone-else', organization_id: 'org-a', status: 'pending' };
  const r = await call();
  assert.equal(r.status, 403);
});

await check('an unknown intent is refused, not treated as pending forever', async () => {
  state.prRow = null;
  const r = await call('SACCO-DEP-DOES-NOT-EXIST');
  assert.equal(r.status, 403);
});

server.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
