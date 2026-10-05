/**
 * Mock Supabase + NaJiki backend for live security verification of the
 * Kunity API routes. Implements just enough of the PostgREST / GoTrue /
 * NaJiki wire protocol for the attack-replay test suite.
 *
 * Run: node test/mock-supabase.js   (listens on 127.0.0.1:54321)
 *
 * Test-control endpoint: GET /_test/state  -> full DB state + request log
 *                        POST /_test/reset -> restore fixtures, clear log
 */
const http = require('http');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Fixture identifiers
// ---------------------------------------------------------------------------
const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001'; // Sacco Alpha  (active)  - admin-a's org
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000002'; // Sacco Bravo  (active)  - VICTIM org
const ORG_X = 'cccccccc-0000-0000-0000-000000000003'; // Sacco Dead   (inactive)

const U_ADMIN_A      = '11111111-1111-1111-1111-111111111111'; // sacco_admin of ORG_A, tenant bound
const U_ADMIN_NULL   = '22222222-2222-2222-2222-222222222222'; // sacco_admin, tenant NULL, PENDING member of ORG_B
const U_ADMIN_FOUND  = '33333333-3333-3333-3333-333333333333'; // sacco_admin, tenant NULL, owns ORG_A, PENDING member of ORG_B
const U_ADMIN_ACT    = '44444444-4444-4444-4444-444444444444'; // sacco_admin, tenant NULL, ACTIVE member of ORG_B
const U_MEMBER_B     = '55555555-5555-5555-5555-555555555555'; // plain member of ORG_B
const U_SUPER        = '66666666-6666-6666-6666-666666666666'; // super_admin (global)
const U_VIEWER       = '77777777-7777-7777-7777-777777777777'; // admin_profiles row with role 'viewer' (low-priv)

// ---------------------------------------------------------------------------
// Auth users (token -> user). NOTE: token-admin-a's metadata is deliberately
// POISONED to simulate the KUN-01 attacker having run
// supabase.auth.updateUser({ data: { tenant_id: ORG_B, role: 'super_admin' } })
// from their browser.
// ---------------------------------------------------------------------------
const USERS = {
  'token-admin-a': {
    id: U_ADMIN_A, email: 'admin@alpha.sacco', aud: 'authenticated',
    user_metadata: { tenant_id: ORG_B, role: 'super_admin', full_name: 'Evil Alpha Admin' },
  },
  'token-admin-null': {
    id: U_ADMIN_NULL, email: 'nulltenant@alpha.sacco', aud: 'authenticated',
    user_metadata: { tenant_id: ORG_B, full_name: 'Null Tenant Attacker' },
  },
  'token-admin-founder': {
    id: U_ADMIN_FOUND, email: 'founder@alpha.sacco', aud: 'authenticated',
    user_metadata: { tenant_id: ORG_B, full_name: 'Founder Admin' },
  },
  'token-admin-active': {
    id: U_ADMIN_ACT, email: 'promoted@bravo.sacco', aud: 'authenticated',
    user_metadata: { full_name: 'Promoted Member' },
  },
  'token-member-b': {
    id: U_MEMBER_B, email: 'benny@bravo.sacco', aud: 'authenticated',
    user_metadata: { full_name: 'Benny Member', role: 'member' },
  },
  'token-super': {
    id: U_SUPER, email: 'root@kunity.platform', aud: 'authenticated',
    user_metadata: { full_name: 'Platform Super Admin' },
  },
  'token-viewer': {
    id: U_VIEWER, email: 'viewer@bravo.sacco', aud: 'authenticated',
    user_metadata: { full_name: 'Low Priv Viewer' },
  },
};

// ---------------------------------------------------------------------------
// Database fixtures (schema -> table -> rows)
// ---------------------------------------------------------------------------
function freshDb() {
  return {
    'public.admin_profiles': [
      { id: U_ADMIN_A, role: 'sacco_admin', tenant_id: ORG_A, full_name: 'Alpha Admin' },
      { id: U_ADMIN_NULL, role: 'sacco_admin', tenant_id: null, full_name: 'Null Tenant' },
      { id: U_ADMIN_FOUND, role: 'sacco_admin', tenant_id: null, full_name: 'Founder' },
      { id: U_ADMIN_ACT, role: 'sacco_admin', tenant_id: null, full_name: 'Promoted' },
      { id: U_SUPER, role: 'super_admin', tenant_id: null, full_name: 'Root' },
      { id: U_VIEWER, role: 'viewer', tenant_id: ORG_B, full_name: 'Viewer' },
    ],
    'kunity.members': [
      { id: U_ADMIN_NULL, organization_id: ORG_B, status: 'pending', first_name: 'NullTenant', last_name: 'Attacker', phone: '+256700000002', accounts: [] },
      { id: U_ADMIN_FOUND, organization_id: ORG_B, status: 'pending', first_name: 'Founder', last_name: 'Admin', phone: null, accounts: [] },
      { id: U_ADMIN_ACT, organization_id: ORG_B, status: 'active', first_name: 'Promoted', last_name: 'Member', phone: '+256700000004', accounts: [] },
      { id: U_MEMBER_B, organization_id: ORG_B, status: 'active', first_name: 'Benny', last_name: 'Member', phone: '+256700000005', accounts: [{ id: 'acc-b-1', cached_balance: '80000', is_active: true, code: 'WAL-B1', name: 'Benny Wallet' }] },
    ],
    'kunity.organizations': [
      { id: ORG_A, name: 'Sacco Alpha', code: 'ALPHA', is_active: true, created_by: U_ADMIN_FOUND, currency: 'UGX', primary_color: '#123456' },
      { id: ORG_B, name: 'Sacco Bravo', code: 'BRAVO', is_active: true, created_by: null, currency: 'UGX', primary_color: '#654321' },
      { id: ORG_X, name: 'Sacco Dead', code: 'DEAD', is_active: false, created_by: null, currency: 'UGX', primary_color: '#000000' },
    ],
    'public.tenants': [
      { id: ORG_A, code: 'ALPHA', name: 'Sacco Alpha', application_id: 'app-alpha' },
      { id: ORG_B, code: 'BRAVO', name: 'Sacco Bravo', application_id: 'app-bravo' },
    ],
    'public.applications': [
      { id: 'app-alpha', name: 'Alpha App', api_key: 'SECRET-API-KEY-ALPHA' },
      { id: 'app-bravo', name: 'Bravo App', api_key: 'SECRET-API-KEY-BRAVO' },
    ],
    'public.wallets': [
      { id: 'wallet-a', tenant_id: ORG_A, balance: '10000', sms_rate: '50' },
      { id: 'wallet-b', tenant_id: ORG_B, balance: '100000', sms_rate: '50' },
    ],
    'public.wallet_transactions': [
      { id: 'wt-b-1', wallet_id: 'wallet-b', tenant_id: ORG_B, amount: '50000', note: 'pending', status: null, reference: 'najiki_ref_success', direction: 'credit', currency: 'UGX', type: 'sms_topup', description: 'Pending SMS topup via Mobile Money' },
      { id: 'wt-a-1', wallet_id: 'wallet-a', tenant_id: ORG_A, amount: '20000', note: 'pending', status: null, reference: 'najiki_ref_a', direction: 'credit', currency: 'UGX', type: 'sms_topup', description: 'Pending SMS topup via Mobile Money' },
    ],
    'kunity.payment_requests': [
      { id: 'pr-1', internal_reference: 'najiki_ref_success', member_id: U_MEMBER_B, organization_id: ORG_B, amount: '20000', status: 'pending', currency: 'UGX', phone_number: '+256700000005', payment_type: 'deposit', provider: 'najiki' },
    ],
    'kunity.savings_products': [
      { id: 'prod-a-1', organization_id: ORG_A, is_active: true, name: 'Alpha Savings' },
      { id: 'prod-b-1', organization_id: ORG_B, is_active: true, name: 'Bravo Savings' },
      { id: 'prod-b-dead', organization_id: ORG_B, is_active: false, name: 'Bravo Retired Product' },
    ],
    'kunity.loans': [
      { id: 'loan-b-1', organization_id: ORG_B, member_id: U_MEMBER_B, principal: '1000000', status: 'pending' },
      { id: 'loan-a-1', organization_id: ORG_A, member_id: U_ADMIN_ACT, principal: '50000', status: 'pending' },
    ],
    'kunity.member_savings': [],
    'kunity.accounts': [],
    'kunity.journal_lines': [],
    'kunity.journal_entries': [],
    'kunity.sacco_wallets': [],
    'kunity.audit_log': [],
    'public.sms_messages': [],
  };
}

let db = freshDb();
let requestLog = [];
let idCounter = 1;

// ---------------------------------------------------------------------------
// PostgREST filter evaluation
// ---------------------------------------------------------------------------
function applyFilter(row, key, op, rawValue) {
  const cell = row[key];
  if (op === 'eq') {
    // loose compare so '50000' == 50000 style mismatches don't matter
    return cell != null && String(cell) === String(rawValue);
  }
  if (op === 'neq') return !(cell != null && String(cell) === String(rawValue));
  if (op === 'is') {
    if (rawValue === 'null') return cell == null;
    if (rawValue === 'true') return cell === true;
    if (rawValue === 'false') return cell === false;
    return false;
  }
  if (op === 'in') {
    const list = String(rawValue).replace(/[()]/g, '').split(',').map(s => s.trim());
    return list.some(v => String(cell) === v);
  }
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    const a = parseFloat(cell), b = parseFloat(rawValue);
    if (op === 'gt') return a > b;
    if (op === 'gte') return a >= b;
    if (op === 'lt') return a < b;
    if (op === 'lte') return a <= b;
  }
  return true; // unknown operator: be permissive
}

function filterRows(rows, searchParams) {
  let out = rows;
  for (const [param, value] of searchParams.entries()) {
    if (['select', 'order', 'offset', 'on_conflict'].includes(param)) continue;
    if (param === 'limit') {
      out = out.slice(0, parseInt(value, 10));
      continue;
    }
    // PostgREST filter syntax: <column>=<op>.<value>  (operator is in the VALUE)
    const dot = value.indexOf('.');
    const key = param;
    const op = dot === -1 ? 'eq' : value.slice(0, dot);
    const rawValue = dot === -1 ? value : value.slice(dot + 1);
    out = out.filter(r => applyFilter(r, key, op, rawValue));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:54321');
  const path = url.pathname;
  const method = req.method;
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const accept = req.headers['accept'] || '';
  const wantsObject = accept.includes('vnd.pgrst.object+json');

  requestLog.push({
    method, path: path + (url.search || ''),
    bearer: bearer ? bearer.slice(0, 24) : null,
    profile: req.headers['accept-profile'] || req.headers['content-profile'] || null,
  });

  try {
    // ------------------------- test-control endpoints ----------------------
    if (path === '/_test/state' && method === 'GET') {
      return json(res, 200, { db, requestLog });
    }
    if (path === '/_test/reset' && method === 'POST') {
      db = freshDb();
      requestLog = [];
      return json(res, 200, { ok: true });
    }

    // ------------------------- GoTrue (auth) ------------------------------
    if (path === '/auth/v1/user' && method === 'GET') {
      const user = bearer && USERS[bearer];
      if (!user) return json(res, 401, { message: 'Invalid token' });
      return json(res, 200, user);
    }
    if (path.startsWith('/auth/v1/admin/users/') && method === 'PATCH') {
      // supabaseAdmin.auth.admin.updateUserById — record the metadata write
      const body = JSON.parse((await readBody(req)) || '{}');
      requestLog.push({ method: 'AUTH_ADMIN_UPDATE_USER', path, body });
      return json(res, 200, { id: path.split('/').pop(), ...body });
    }
    if (path.startsWith('/auth/v1/')) {
      return json(res, 404, { message: 'not implemented in mock' });
    }

    // ------------------------- NaJiki gateway ------------------------------
    if (path === '/api/payments' && method === 'POST') {
      const ref = `najiki_live_${idCounter++}`;
      return json(res, 200, { reference: ref, id: ref, status: 'pending' });
    }
    if (path.startsWith('/api/payments/') && method === 'GET') {
      const id = path.split('/').pop();
      if (id === 'najiki_ref_success') return json(res, 200, { status: 'success', amount: 50000, reference: id });
      if (id === 'najiki_ref_a') return json(res, 200, { status: 'success', amount: 20000, reference: id });
      return json(res, 200, { status: 'pending', amount: 0, reference: id });
    }

    // ------------------------- PostgREST RPCs ------------------------------
    const rpcMatch = path.match(/^\/rest\/v1\/rpc\/([a-z_0-9]+)$/);
    if (rpcMatch && method === 'POST') {
      const fn = rpcMatch[1];
      const body = JSON.parse((await readBody(req)) || '{}');
      requestLog.push({ method: 'RPC', path, body });
      if (fn === 'credit_sms_wallet_idempotent') {
        // simulate the real RPC: idempotent credit + mark transaction processed
        const tx = db['public.wallet_transactions'].find(t => t.id === body.p_transaction_id);
        if (tx) { tx.note = 'success'; tx.status = 'success'; }
        const wallet = db['public.wallets'].find(w => w.id === body.p_wallet_id);
        if (wallet) {
          wallet.balance = String(parseFloat(wallet.balance) + Number(body.p_amount));
        }
        return json(res, 200, [{ balance: wallet ? parseFloat(wallet.balance) : 0, credited: true }]);
      }
      if (fn === 'credit_sms_wallet') {
        // legacy NON-idempotent RPC — used by the old vulnerable fallback.
        const wallet = db['public.wallets'].find(w => w.id === body.p_wallet_id);
        if (wallet) wallet.balance = String(parseFloat(wallet.balance) + Number(body.p_amount));
        return json(res, 200, { balance: wallet ? parseFloat(wallet.balance) : 0 });
      }
      if (fn === 'disburse_loan_atomic') {
        return json(res, 200, { message: 'Loan disbursed atomically', organization_id: body.p_organization_id });
      }
      return json(res, 200, { ok: true, fn });
    }

    // ------------------------- PostgREST tables ----------------------------
    const tableMatch = path.match(/^\/rest\/v1\/([a-z_0-9]+)$/);
    if (tableMatch) {
      const table = tableMatch[1];
      const schema = req.headers['accept-profile'] || req.headers['content-profile'] || 'public';
      const key = `${schema}.${table}`;
      const rows = db[key] != null ? db[key] : db[`public.${table}`] != null ? db[`public.${table}`] : db[`kunity.${table}`];

      if (rows == null) return json(res, 404, { message: `relation "${schema}.${table}" does not exist` });

      if (method === 'GET') {
        const filtered = filterRows(rows, url.searchParams);
        if (wantsObject) return json(res, 200, filtered[0] != null ? filtered[0] : null);
        return json(res, 200, filtered);
      }

      if (method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const inserted = Array.isArray(body) ? body : [body];
        inserted.forEach((r) => {
          if (!r.id) r.id = `auto-${idCounter++}`;
          rows.push(r);
        });
        requestLog.push({ method: 'INSERT', table: key, rows: inserted });
        if (accept.includes('json') || (req.headers['prefer'] || '').includes('representation')) {
          return json(res, 201, wantsObject ? inserted[0] : inserted);
        }
        return json(res, 201, {});
      }

      if (method === 'PATCH') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const filtered = filterRows(rows, url.searchParams);
        filtered.forEach((r) => Object.assign(r, body));
        requestLog.push({ method: 'UPDATE', table: key, filters: url.search, changes: body, matched: filtered.length });
        return json(res, 204, {});
      }

      if (method === 'DELETE') {
        return json(res, 204, {});
      }
    }

    return json(res, 404, { message: `mock: no handler for ${method} ${path}` });
  } catch (err) {
    console.error('[mock] error handling', method, path, err);
    return json(res, 500, { message: err.message });
  }
});

server.listen(54321, '127.0.0.1', () => {
  console.log('[mock-supabase] listening on http://127.0.0.1:54321');
});
