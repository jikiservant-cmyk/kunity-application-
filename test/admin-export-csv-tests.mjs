/**
 * Admin "Download SACCO Books" export checks.
 *
 * The real GET handler in app/api/admin/export/route.ts runs against a local
 * stand-in Supabase (GoTrue + PostgREST, embeds + range pagination). Verifies:
 *   - every report returns Excel-safe CSV (BOM, CRLF, right columns, right rows)
 *   - tenant isolation: an admin of SACCO A never receives SACCO B's books
 *   - CSV-injection payloads (member names starting with = + - @) are defused
 *   - big ledgers paginate past PostgREST's 1000-row cap (no silent truncation)
 *   - every download is audit-logged
 *   - auth: 401 without a token, 403 for non-admins, 400 for unknown reports
 *
 * Run: npx -y tsx test/admin-export-csv-tests.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { NextRequest } from 'next/server';

const ADMIN_TOKEN = 'admin-token-a';
const TENANT_A = 'eeeeeee1-0000-4000-8000-000000000001';
const TENANT_B = 'eeeeeee1-0000-4000-8000-000000000002';
const ORG_CODE_A = 'KUN';

// ---------------------------------------------------------------------------
// Stand-in Supabase
// ---------------------------------------------------------------------------
function applyFilter(row, key, op, rawValue) {
  let cell;
  if (key.includes('.')) {
    // Embedded-resource filter, e.g. journal_entries.organization_id
    cell = key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), row);
  } else {
    cell = row[key];
  }
  if (op === 'eq') return cell != null && String(cell) === String(rawValue);
  if (op === 'neq') return !(cell != null && String(cell) === String(rawValue));
  if (op === 'is') {
    if (rawValue === 'null') return cell == null;
    if (rawValue === 'true') return cell === true;
    if (rawValue === 'false') return cell === false;
    return false;
  }
  if (op === 'in') {
    const set = String(rawValue).replace(/^\(|\)$/g, '').split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
    return set.some((x) => String(cell) === x);
  }
  return true;
}
function filterRows(rows, searchParams) {
  let out = rows;
  for (const [param, value] of searchParams.entries()) {
    // offset/limit are .range() pagination — applied by the GET branch AFTER
    // filtering, so each page sees the full filtered set.
    if (['select', 'order', 'on_conflict', 'offset', 'limit'].includes(param)) continue;
    const dot = value.indexOf('.');
    const op = dot === -1 ? 'eq' : value.slice(0, dot);
    const rawValue = dot === -1 ? value : value.slice(dot + 1);
    out = out.filter((r) => applyFilter(r, param, op, rawValue));
  }
  return out;
}

const db = {
  'public.admin_profiles': [
    { id: 'admin-a', role: 'sacco_admin', tenant_id: TENANT_A },
    { id: 'plain-user', role: 'member', tenant_id: TENANT_A },
  ],
  'kunity.organizations': [
    { id: TENANT_A, code: ORG_CODE_A, name: 'Alpha Sacco' },
    { id: TENANT_B, code: 'BET', name: 'Beta Sacco' },
  ],
  'kunity.members': [
    { id: 'm-1', organization_id: TENANT_A, first_name: 'Grace', last_name: 'Nakato', phone: '0772111111', email: 'grace@example.test', status: 'active', member_number: 'AAAABBBB', created_at: '2026-10-01T10:00:00Z' },
    // CSV-injection payload as a member name — must be defused in every export.
    { id: 'm-2', organization_id: TENANT_A, first_name: '=HYPERLINK("http://evil.example","click")', last_name: 'Mukasa', phone: '+256772222222', status: 'pending', created_at: '2026-10-02T10:00:00Z' },
    { id: 'm-b', organization_id: TENANT_B, first_name: 'BetaOnly', last_name: 'Member', status: 'active', created_at: '2026-10-03T10:00:00Z' },
  ],
  'kunity.accounts': [
    { id: 'acc-1', organization_id: TENANT_A, member_id: 'm-1', code: 'ACC-1001', name: 'Grace Wallet', account_category: 'asset', cached_balance: 150000 },
    { id: 'acc-b', organization_id: TENANT_B, member_id: 'm-b', code: 'ACC-B001', name: 'Beta Wallet', cached_balance: 999 },
  ],
  'kunity.journal_entries': [
    { id: 'je-1', organization_id: TENANT_A, reference: 'DEP-1', description: 'Mobile money deposit', entry_date: '2026-10-05', source_module: 'payments' },
    { id: 'je-2', organization_id: TENANT_A, reference: 'FEE-1', description: 'Activation fee', entry_date: '2026-10-06', source_module: 'payments' },
    { id: 'je-b', organization_id: TENANT_B, reference: 'BET-1', description: 'Beta only entry', entry_date: '2026-10-07', source_module: 'payments' },
  ],
  'kunity.journal_lines': [
    { id: 'jl-1', journal_entry_id: 'je-1', account_id: 'acc-1', member_id: 'm-1', line_type: 'deposit', debit: 0, credit: 50000, created_at: '2026-10-05T09:00:00Z' },
    { id: 'jl-2', journal_entry_id: 'je-1', account_id: 'acc-1', member_id: 'm-1', line_type: 'deposit', debit: 50000, credit: 0, created_at: '2026-10-05T09:00:01Z' },
    { id: 'jl-3', journal_entry_id: 'je-2', account_id: 'acc-1', member_id: null, line_type: 'activation_fee', debit: 0, credit: 5000, created_at: '2026-10-06T09:00:00Z' },
    { id: 'jl-b', journal_entry_id: 'je-b', account_id: 'acc-b', member_id: 'm-b', line_type: 'deposit', debit: 0, credit: 777, created_at: '2026-10-07T09:00:00Z' },
  ],
  'kunity.payment_requests': [
    { id: 'pr-1', organization_id: TENANT_A, member_id: 'm-1', amount: 50000, currency: 'UGX', phone_number: '0772111111', status: 'success', payment_type: 'deposit', provider: 'najiki', fee: 0, internal_reference: 'SACCO-DEP-1', created_at: '2026-10-05T09:00:00Z', completed_at: '2026-10-05T09:01:00Z' },
    { id: 'pr-2', organization_id: TENANT_A, member_id: 'm-2', amount: 5000, currency: 'UGX', phone_number: '+256772222222', status: 'failed', payment_type: 'account_activation', provider: 'najiki', fee: 0, internal_reference: 'PAY-ACT-2', created_at: '2026-10-06T09:00:00Z' },
    { id: 'pr-b', organization_id: TENANT_B, member_id: 'm-b', amount: 999, status: 'success', payment_type: 'deposit', created_at: '2026-10-07T09:00:00Z' },
  ],
  'kunity.loans': [
    { id: 'ln-1', organization_id: TENANT_A, member_id: 'm-1', principal: 200000, interest_rate: 12, status: 'approved', created_at: '2026-10-08T09:00:00Z' },
    { id: 'ln-b', organization_id: TENANT_B, member_id: 'm-b', principal: 100, status: 'pending', created_at: '2026-10-08T09:00:00Z' },
  ],
  'kunity.loan_installments': [
    { loan_id: 'ln-1', paid_principal: 50000, paid_interest: 1000 },
    { loan_id: 'ln-1', paid_principal: 25000, paid_interest: 500 },
  ],
  'kunity.savings_products': [
    { id: 'sp-1', organization_id: TENANT_A, name: 'Regular Savings', interest_rate: 5, is_active: true },
  ],
  'kunity.member_savings': [
    { id: 'ms-1', organization_id: TENANT_A, member_id: 'm-1', savings_product_id: 'sp-1', account_id: 'acc-1', status: 'active', opened_date: '2026-10-01' },
    { id: 'ms-b', organization_id: TENANT_B, member_id: 'm-b', savings_product_id: null, account_id: 'acc-b', status: 'active' },
  ],
  'public.sms_messages': [
    { id: 'sm-1', tenant_id: TENANT_A, phone_number: '+256772111111', event_code: 'WELCOME', status: 'sent', cost: 50, compiled_message: 'Hello Grace, welcome!', created_at: '2026-10-01T11:00:00Z' },
    { id: 'sm-b', tenant_id: TENANT_B, phone_number: '+256999999999', event_code: 'BROADCAST', status: 'sent', cost: 50, compiled_message: 'Beta only' },
  ],
  'kunity.audit_log': [],
};

const auditInserts = [];

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(req.url, 'http://local.test');
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  if (url.pathname === '/auth/v1/user') {
    if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return json(401, { message: 'invalid token' });
    return json(200, { id: 'admin-a', email: 'admin@example.test', aud: 'authenticated' });
  }

  const tableMatch = url.pathname.match(/^\/rest\/v1\/([a-z_0-9]+)$/);
  if (!tableMatch) return json(404, { message: `No mock for ${req.method} ${url.pathname}` });
  const table = tableMatch[1];
  const schema = req.headers['accept-profile'] || req.headers['content-profile'] || 'public';
  const key = `${schema}.${table}`;
  if (db[key] == null) return json(404, { message: `relation "${key}" does not exist` });

  // POSTgREST-style embeds, derived on GET (writes touch the stored rows).
  let rows = db[key];
  if (req.method === 'GET') {
    rows = rows.map((r) => ({
      ...r,
      ...(table === 'journal_lines' ? {
        journal_entries: (db['kunity.journal_entries'] || []).find((e) => e.id === r.journal_entry_id) || null,
        members: (db['kunity.members'] || []).find((m) => m.id === r.member_id) || null,
        accounts: (db['kunity.accounts'] || []).find((a) => a.id === r.account_id) || null,
      } : {}),
      ...(table === 'payment_requests' ? {
        members: (db['kunity.members'] || []).find((m) => m.id === r.member_id) || null,
      } : {}),
      ...(table === 'loans' ? {
        members: (db['kunity.members'] || []).find((m) => m.id === r.member_id) || null,
        loan_installments: (db['kunity.loan_installments'] || []).filter((i) => i.loan_id === r.id),
      } : {}),
      ...(table === 'member_savings' ? {
        members: (db['kunity.members'] || []).find((m) => m.id === r.member_id) || null,
        savings_products: (db['kunity.savings_products'] || []).find((p) => p.id === r.savings_product_id) || null,
        accounts: (db['kunity.accounts'] || []).find((a) => a.id === r.account_id) || null,
      } : {}),
    }));
    // .range(from, to) arrives as offset/limit
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = url.searchParams.get('limit');
    const filtered = filterRows(rows, url.searchParams).slice(offset, limit === null ? undefined : offset + Number(limit));
    return json(200, filtered);
  }
  if (req.method === 'POST') {
    if (table === 'audit_log') auditInserts.push(body);
    const inserted = Array.isArray(body) ? body : [body];
    for (const r of inserted) rows.push(r);
    return json(201, {});
  }
  return json(404, { message: `stand-in has no handler for ${req.method} ${table}` });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-service-role-test';

const { GET } = await import('../app/api/admin/export/route.ts');
const call = async (report, token = ADMIN_TOKEN) => {
  const request = new NextRequest(`http://localhost:3000/api/admin/export?report=${report}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const response = await GET(request);
  // Decode from raw bytes: undici's .text() strips the UTF-8 BOM we assert on.
  const buf = Buffer.from(await response.arrayBuffer());
  const text = response.headers.get('content-type')?.includes('text/csv') ? buf.toString('utf8') : '';
  return { status: response.status, headers: response.headers, text };
};
const csvRows = (text) => text.replace(/^\uFEFF/, '').split(/\r\n/).filter(Boolean);
const csvCells = (row) => {
  // minimal CSV parse honouring quotes
  const cells = [];
  let cur = '', inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQ) {
      if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
};

let passed = 0, failed = 0;
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

console.log('Admin export: auth');
await check('no token -> 401', async () => {
  const r = await call('ledger', null);
  assert.equal(r.status, 401);
});
await check('unknown report -> 400 with the list of reports', async () => {
  const request = new NextRequest('http://localhost:3000/api/admin/export?report=secrets', {
    method: 'GET', headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const response = await GET(request);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /ledger, deposits, members, loans, savings, sms/);
});
await check('non-admin role -> 403', async () => {
  db['public.admin_profiles'][0].role = 'member';
  try {
    const r = await call('members', 'token-of-non-admin'); // invalid token -> 401 first
    assert.equal(r.status, 401); // unknown token is rejected before the role check
    const request = new NextRequest('http://localhost:3000/api/admin/export?report=members', {
      method: 'GET', headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const response = await GET(request);
    assert.equal(response.status, 403); // known token, but the profile is not an admin now
  } finally {
    db['public.admin_profiles'][0].role = 'sacco_admin';
  }
});

console.log('Admin export: general ledger');
let ledger;
await check('ledger returns Excel-safe CSV with the double-entry columns', async () => {
  ledger = await call('ledger');
  assert.equal(ledger.status, 200);
  assert.ok(ledger.headers.get('content-type')?.includes('text/csv'));
  assert.ok(ledger.text.startsWith('\uFEFF'), 'UTF-8 BOM for Excel');
  const rows = csvRows(ledger.text);
  assert.deepEqual(csvCells(rows[0]), ['Date', 'Reference', 'Description', 'Source Module', 'Account Code', 'Account Name', 'Member', 'Line Type', 'Debit (UGX)', 'Credit (UGX)']);
  assert.equal(rows.length, 4); // header + 3 tenant-A lines
  const dep = csvCells(rows[1]);
  assert.equal(dep[1], 'DEP-1');
  assert.equal(dep[6], 'Grace Nakato');
  assert.equal(dep[9], '50000');
  const fee = csvCells(rows[3]);
  assert.equal(fee[6], 'Cooperative Vault'); // no member on that line
});
await check('tenant isolation: Beta Sacco rows never appear', async () => {
  assert.ok(!ledger.text.includes('BetaOnly'));
  assert.ok(!ledger.text.includes('BET-1'));
  assert.ok(!ledger.text.includes('777'));
});
await check('every download is audit-logged', async () => {
  assert.ok(auditInserts.some((a) => a.action === 'data_export' && a.new_data?.report === 'ledger'));
});
await check('filename identifies the SACCO and report', async () => {
  const cd = ledger.headers.get('content-disposition') || '';
  assert.match(cd, /^attachment; filename="ledger-KUN-\d{4}-\d{2}-\d{2}\.csv"$/);
});

console.log('Admin export: other reports');
await check('deposits: payments with member, type, status, reference', async () => {
  const r = await call('deposits');
  assert.equal(r.status, 200);
  const rows = csvRows(r.text);
  assert.equal(rows.length, 3); // header + 2 tenant-A payments
  assert.ok(r.text.includes('SACCO-DEP-1') && r.text.includes('PAY-ACT-2') && r.text.includes('account_activation'));
  assert.ok(!r.text.includes('pr-b') && !r.text.includes('BetaOnly'));
});
await check('members: register rows with member number fallback', async () => {
  const r = await call('members');
  assert.equal(r.status, 200);
  const rows = csvRows(r.text);
  assert.equal(rows.length, 3); // header + 2 tenant-A members
  assert.ok(r.text.includes('AAAABBBB'));
  assert.ok(!r.text.includes('BetaOnly'));
});
await check('loans: repaid and outstanding computed from installments', async () => {
  const r = await call('loans');
  assert.equal(r.status, 200);
  const rows = csvRows(r.text);
  assert.equal(rows.length, 2); // header + 1 tenant-A loan
  const cells = csvCells(rows[1]);
  assert.equal(cells[0], 'Grace Nakato');
  assert.equal(cells[1], '200000');
  assert.equal(cells[5], '75000');  // 50000 + 25000 repaid
  assert.equal(cells[6], '125000'); // outstanding
});
await check('savings: product, balance and status per member', async () => {
  const r = await call('savings');
  assert.equal(r.status, 200);
  const rows = csvRows(r.text);
  assert.equal(rows.length, 2);
  const cells = csvCells(rows[1]);
  assert.equal(cells[0], 'Grace Nakato');
  assert.equal(cells[1], 'Regular Savings');
  assert.equal(cells[4], '150000');
});
await check('sms: message log from the public schema, tenant-scoped', async () => {
  const r = await call('sms');
  assert.equal(r.status, 200);
  const rows = csvRows(r.text);
  assert.equal(rows.length, 2); // header + 1 tenant-A message
  assert.ok(r.text.includes('Hello Grace, welcome!'));
  assert.ok(!r.text.includes('Beta only'));
});

console.log('Admin export: hardening');
await check('CSV-injection payloads are defused (= + - @ cells)', async () => {
  const r = await call('members');
  // The raw CSV must NOT contain an executable formula cell, and the defused
  // form must carry the leading apostrophe.
  assert.ok(!/(^|,|")=HYPERLINK/.test(r.text.replace(/^\uFEFF/, '')), 'formula cell must not survive raw');
  assert.ok(r.text.includes(`'=HYPERLINK`));
  // A phone starting with + is also a formula risk in some spreadsheet apps.
  assert.ok(r.text.includes(`'+256772222222`) || r.text.includes(`"'+256772222222`));
});
await check('big ledgers paginate past the 1000-row cap (no truncation)', async () => {
  // Seed 1245 extra tenant-A lines across one new entry.
  const bigEntry = { id: 'je-big', organization_id: TENANT_A, reference: 'BIG-1', description: 'bulk', entry_date: '2026-10-09', source_module: 'payments' };
  db['kunity.journal_entries'].push(bigEntry);
  for (let i = 0; i < 1245; i++) {
    db['kunity.journal_lines'].push({ id: `jl-big-${i}`, journal_entry_id: 'je-big', account_id: 'acc-1', member_id: 'm-1', line_type: 'deposit', debit: 0, credit: 1, created_at: '2026-10-09T09:00:00Z' });
  }
  const r = await call('ledger');
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers.get('x-rows-count')), 1248); // 3 original + 1245 new
  const rows = csvRows(r.text);
  assert.equal(rows.length, 1249); // + header
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
