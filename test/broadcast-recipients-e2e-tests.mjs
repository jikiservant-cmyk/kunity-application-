/**
 * End-to-end check of WHO receives an admin SMS broadcast.
 *
 * The real POST handler in app/api/admin/sms/send/route.ts runs against a local stand-in
 * for Supabase REST/Auth and the Inngest event API. The stand-in holds one SACCO with more
 * than 1000 members (the PostgREST row cap), duplicates, invalid numbers, empty phones, plus
 * another SACCO's members and loans that must never receive anything.
 *
 * Run: node_modules/.bin/tsx test/broadcast-recipients-e2e-tests.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { NextRequest } from 'next/server';

// ---------- fixture ----------
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const ADMIN_TOKEN = 'admin-token';

const members = [];
const phoneFor = (i) => `07${String(70000000 + i).padStart(8, '0')}`; // 0770000000 ...
for (let i = 0; i < 1250; i++) {
  members.push({ id: `a-${String(i).padStart(5, '0')}`, organization_id: TENANT_A, phone: phoneFor(i), first_name: `A${i}`, last_name: 'M' });
}
// 1) same person stored twice, once in +256 format (must be sent once)
members[21].phone = '+256' + phoneFor(20).slice(1);
// 2) invalid numbers (skipped, counted)
for (const i of [40, 41, 42, 43, 44]) members[i].phone = '12345';
// 3) empty phones (skipped)
for (const i of [60, 61, 62]) members[i].phone = null;
// 4) another SACCO's members: must never be targeted
for (let i = 0; i < 30; i++) {
  members.push({ id: `b-${i}`, organization_id: TENANT_B, phone: `07${String(81000000 + i)}`, first_name: 'B', last_name: 'M' });
}

const loans = [
  { id: 'l-1', organization_id: TENANT_A, status: 'pending', member: members[100] },
  { id: 'l-2', organization_id: TENANT_A, status: 'pending', member: members[100] }, // same borrower twice
  { id: 'l-3', organization_id: TENANT_A, status: 'pending', member: members[101] },
  { id: 'l-4', organization_id: TENANT_A, status: 'approved', member: members[102] }, // not pending
  { id: 'l-5', organization_id: TENANT_B, status: 'pending', member: members.find(m => m.organization_id === TENANT_B) }, // other SACCO
];

const state = { events: [], idemKeys: new Set(), audit: [] };

// ---------- stand-in server ----------
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(req.url, 'http://x');
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

  // Inngest event API
  if (req.method === 'POST' && url.pathname.startsWith('/e/')) {
    state.events.push(...(Array.isArray(body) ? body : [body]));
    return json(200, { ids: [], status: 200 });
  }
  // Supabase Auth
  if (url.pathname === '/auth/v1/user') {
    if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return json(401, { message: 'bad token' });
    return json(200, { id: 'admin-a', email: 'admin@a.test', aud: 'authenticated' });
  }
  if (!url.pathname.startsWith('/rest/v1/')) return json(404, { message: 'unknown path ' + url.pathname });

  const table = url.pathname.replace('/rest/v1/', '');
  const wantsObject = String(req.headers.accept || '').includes('pgrst.object');
  const filters = [...url.searchParams.entries()]
    .filter(([k]) => !['select', 'order', 'limit', 'offset'].includes(k))
    .map(([k, v]) => [k, v.replace(/^eq\./, '')]);
  const matches = (row) => filters.every(([k, v]) => {
    const val = k.includes('.') ? undefined : row[k];
    return String(val) === v;
  });

  if (table === 'admin_profiles') {
    const row = { id: 'admin-a', role: 'sacco_admin', tenant_id: TENANT_A };
    return json(200, wantsObject ? row : [row]);
  }
  if (table === 'wallets') {
    const row = { id: 'wallet-a', tenant_id: TENANT_A, balance: 10_000_000, sms_rate: 50 };
    return json(200, wantsObject ? row : [row]);
  }
  if (table === 'members') {
    const rows = members.filter(matches).sort((x, y) => x.id.localeCompare(y.id));
    return sliceRange(req, res, rows);
  }
  if (table === 'loans') {
    const rows = loans
      .filter(l => matches({ organization_id: l.organization_id, status: l.status }))
      .sort((x, y) => x.id.localeCompare(y.id))
      .map(l => ({ id: l.id, organization_id: l.organization_id, members: { phone: l.member.phone, first_name: l.member.first_name, last_name: l.member.last_name, organization_id: l.member.organization_id } }));
    return sliceRange(req, res, rows);
  }
  if (table === 'sms_idempotency_keys' && req.method === 'POST') {
    const key = `${body.scope}|${body.idem_key}`;
    if (state.idemKeys.has(key)) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
    state.idemKeys.add(key);
    return json(201, {});
  }
  if ((table === 'audit_logs' || table === 'audit_log') && req.method === 'POST') { state.audit.push(body); return json(201, {}); }
  return json(404, { message: `stand-in has no handler for ${req.method} ${table}` });
});

function sliceRange(req, res, rows) {
  // supabase-js sends .range(from, to) as offset/limit query parameters.
  const url = new URL(req.url, 'http://x');
  const offset = Number(url.searchParams.get('offset') || 0);
  const limit = url.searchParams.get('limit');
  const slice = rows.slice(offset, limit === null ? undefined : offset + Number(limit));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(slice));
}

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.NEXT_PUBLIC_SUPABASE_URL = base;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-test';
process.env.INNGEST_BASE_URL = base;
process.env.INNGEST_EVENT_KEY = 'test-event-key';
process.env.INNGEST_DEV = '1';

const { POST } = await import('../app/api/admin/sms/send/route.ts');

async function broadcast(payload) {
  const req = new NextRequest('http://localhost:3000/api/admin/sms/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: ADMIN_TOKEN, message: 'Hello members', ...payload }),
  });
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}

// Expected recipients, computed independently from the fixture.
const expectedMemberPhones = new Set();
for (const m of members.filter(x => x.organization_id === TENANT_A)) {
  if (!m.phone) continue;
  if (/^07\d{8}$/.test(m.phone)) expectedMemberPhones.add('+256' + m.phone.slice(1));
  else if (/^\+256\d{9}$/.test(m.phone)) expectedMemberPhones.add(m.phone);
}
const tenantBPhones = new Set(members.filter(x => x.organization_id === TENANT_B).map(m => '+256' + m.phone.slice(1)));

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

console.log('Whole-SACCO broadcast ("all members")');
{
  state.events = [];
  const r = await broadcast({ recipientType: 'all' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const phones = state.events.map(e => e.data.recipientPhone);
  assert.ok(expectedMemberPhones.size > 1000, 'fixture must exceed the 1000-row cap');
  ok(`reads past the 1000-row cap: ${expectedMemberPhones.size} unique numbers reached`);
  assert.equal(phones.length, expectedMemberPhones.size);
  assert.equal(new Set(phones).size, phones.length, 'no number is sent twice');
  ok('each recipient is sent exactly once, even when stored in two formats');
  assert.deepEqual(new Set(phones), expectedMemberPhones);
  ok('recipient set equals exactly the SACCO\'s valid member numbers');
  assert.ok(phones.every(p => /^\+256\d{9}$/.test(p)), 'all numbers are normalised to +256');
  ok('every number is normalised to E.164 (+256…)');
  assert.ok(phones.every(p => !tenantBPhones.has(p)), 'no other SACCO member was messaged');
  ok('no member of another SACCO was messaged');
  assert.equal(r.body.skippedInvalid, 5);
  ok('invalid member numbers are skipped and reported (5)');
  assert.equal(r.body.recipientsCount, expectedMemberPhones.size);
  ok('response reports the recipient count');
}

console.log('Loan audience (pending borrowers)');
{
  state.events = [];
  const r = await broadcast({ recipientType: 'loans' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const phones = state.events.map(e => e.data.recipientPhone).sort();
  assert.deepEqual(phones, [phoneFor(100), phoneFor(101)].map(p => '+256' + p.slice(1)).sort());
  ok('only pending loans of this SACCO; the borrower with two loans is sent once');
}

console.log('Typed numbers (explicit list)');
{
  state.events = [];
  const r = await broadcast({ recipients: [phoneFor(5), '+256' + phoneFor(6).slice(1), phoneFor(5)] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(state.events.map(e => e.data.recipientPhone).sort(), ['+256' + phoneFor(5).slice(1), '+256' + phoneFor(6).slice(1)].sort());
  ok('typed member numbers, mixed formats and repeats: each member once, in E.164');
}
{
  state.events = [];
  const r = await broadcast({ recipients: [phoneFor(5), '0799999999'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not members of this SACCO/);
  assert.equal(state.events.length, 0);
  ok('a non-member number refuses the whole broadcast; nothing is queued');
}
{
  state.events = [];
  const b = members.find(m => m.organization_id === TENANT_B);
  const r = await broadcast({ recipients: [b.phone] });
  assert.equal(r.status, 400);
  assert.equal(state.events.length, 0);
  ok('another SACCO\'s member number is refused');
}
{
  state.events = [];
  const r = await broadcast({ recipients: ['12345'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not valid Ugandan mobile numbers/);
  assert.equal(state.events.length, 0);
  ok('an invalid typed number is reported, not silently dropped');
}

console.log('Repeat submission');
{
  state.events = [];
  const first = await broadcast({ recipientType: 'loans', requestId: 'bc-test-0001' });
  assert.equal(first.status, 200);
  const again = await broadcast({ recipientType: 'loans', requestId: 'bc-test-0001' });
  assert.equal(again.status, 409);
  assert.equal(state.events.filter(e => e.name === 'sms/dispatch').length, 2, 'only the first submission queues events');
  ok('the same requestId queues once; the repeat is refused');
}

server.close();
console.log(`\n${passed} broadcast-recipient checks passed`);
