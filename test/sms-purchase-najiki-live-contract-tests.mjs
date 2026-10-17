/**
 * SMS purchase — end-to-end against the REAL NaJiki contract.
 *
 * Unlike test/sms-topup-e2e-tests.mjs (which asserts the outbound body shape
 * against a permissive echo server), this suite runs the real
 *   POST /api/admin/sms/topup
 * and the real
 *   POST /api/webhooks/najiki
 * against a NaJiki simulator whose rules are transcribed from the
 * jikiservant-cmyk/najiki-finance2 source:
 *
 *   src/app/api/payments/route.ts        auth before idempotency, tenant 404,
 *                                        paymentType lookup, platform-fee
 *                                        detection, per-tenant credential
 *                                        enforcement, intent creation
 *   src/lib/constants.ts                 PLATFORM_FEE_TYPES,
 *                                        TENANT_CREDENTIALS_REQUIRED_APP_CODES
 *   src/lib/schemas.ts                   CreatePaymentRequestSchema
 *   src/lib/payments.ts                  notification payload shape
 *   src/lib/notification-signature.ts    t=..,v=.. HMAC headers
 *   scripts/seed.ts                      seeded payment types per application
 *
 * The database is a real Postgres (PGlite) with the repository's financial
 * migrations, bridged over a local Supabase REST/RPC stand-in. No production
 * credentials, provider endpoints, or real money are used.
 *
 * Run: node_modules/.bin/tsx test/sms-purchase-najiki-live-contract-tests.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── identities ────────────────────────────────────────────────────────────────
const APP_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const NJ_TENANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const PROVIDER_ID = 'cccccccc-0000-4000-8000-000000000001';
const TENANT_ID = '11111111-1111-4111-8111-111111111111'; // Kunity organization
const WALLET_ID = '55555555-5555-4555-8555-555555555555';
const ADMIN_ID = '99999999-9999-4999-8999-999999999999';
const TENANT_CODE = 'alpha-sacco';
const ADMIN_TOKEN = 'admin-access-token';
const NAJIKI_API_KEY = 'nk_live_contract_test_key';
const WEBHOOK_SECRET = 'njk_whsec_contract_test';

// ── Kunity's real database (PGlite + repository migrations) ───────────────────
const db = new PGlite();
await db.exec(`CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;`);
await db.exec(read('test/financial-base-schema.sql'));
for (const migration of [
  '21_financial_integrity.sql',
  '25_activation_fee_is_membership.sql',
  '27_atomic_payment_rpc.sql',
  '32_sms_idempotency_keys.sql',
  '34_debit_sms_wallet_tenant_match.sql',
  '35_debit_sms_wallet_replay_safe.sql',
  '36_money_engine_hardening.sql',
  '37_sms_topup_payment_request_member_nullable.sql',
]) await db.exec(read(`supabase/migrations/${migration}`));

await db.exec(`
  INSERT INTO kunity.organizations (id,name,code) VALUES ('${TENANT_ID}','Alpha SACCO','ALPHA');
  INSERT INTO public.wallets (id,tenant_id,balance,sms_rate,currency)
    VALUES ('${WALLET_ID}','${TENANT_ID}',0,50,'UGX');
`);

// ── Supabase REST/RPC stand-in over the real database ─────────────────────────
const rpcLog = [];
const TABLE_MAP = {
  wallets: 'public.wallets',
  wallet_transactions: 'public.wallet_transactions',
  payment_requests: 'kunity.payment_requests',
};
const SYNTHETIC = {
  admin_profiles: [{ id: ADMIN_ID, role: 'sacco_admin', tenant_id: TENANT_ID }],
  tenants: [{ id: TENANT_ID, code: TENANT_CODE, name: 'Alpha SACCO', application_id: APP_ID }],
};

function matches(row, filters) {
  return filters.every(([key, op, value]) => {
    const actual = row[key];
    if (op === 'is') return value === 'null' ? actual == null : String(actual) === value;
    if (op === 'neq') return String(actual) !== value;
    return String(actual) === value;
  });
}
function parseFilters(url) {
  return [...url.searchParams.entries()]
    .filter(([key]) => !['select', 'order', 'limit', 'offset'].includes(key))
    .map(([key, raw]) => {
      if (raw.startsWith('is.')) return [key, 'is', raw.slice(3)];
      if (raw.startsWith('neq.')) return [key, 'neq', raw.slice(4)];
      return [key, 'eq', raw.replace(/^eq\./, '')];
    });
}
function jsonColumn(table, key) {
  return table === 'kunity.payment_requests' && key === 'payload';
}
async function insertRows(table, body) {
  const rows = Array.isArray(body) ? body : [body];
  const inserted = [];
  for (const row of rows) {
    const keys = Object.keys(row);
    const placeholders = keys.map((k, i) => `$${i + 1}`);
    const values = keys.map((k) => (jsonColumn(table, k) && row[k] !== null && typeof row[k] === 'object'
      ? JSON.stringify(row[k]) : row[k]));
    const result = await db.query(
      `INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`,
      values,
    );
    inserted.push(result.rows[0]);
  }
  return inserted;
}
async function updateRows(table, body, filters) {
  const keys = Object.keys(body);
  if (keys.length === 0) return [];
  const all = (await db.query(`SELECT * FROM ${table}`)).rows.filter((row) => matches(row, filters));
  for (const row of all) {
    const sets = keys.map((k, i) => `${k}=$${i + 1}`);
    const values = keys.map((k) => (jsonColumn(table, k) && body[k] !== null && typeof body[k] === 'object'
      ? JSON.stringify(body[k]) : body[k]));
    values.push(row.id);
    await db.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id=$${values.length}`, values);
  }
  return (await db.query(`SELECT * FROM ${table}`)).rows.filter((row) => matches(row, filters));
}

// ── NaJiki simulator, transcribed from najiki-finance2 ────────────────────────
const PLATFORM_FEE_TYPES = [
  'SMS', 'BUY_SMS', 'SMS_TOPUP', 'ACTIVATION', 'ACCOUNT_ACTIVATION',
  'SUBSCRIPTION', 'MONTHLY_SUBSCRIPTION', 'PLATFORM_FEE',
];
const TENANT_CREDENTIALS_REQUIRED_APP_CODES = ['sacco'];
const SEEDED_SACCO_TYPES = ['deposit', 'loan_repayment', 'account_activation'];

const najiki = {
  application: {
    id: APP_ID,
    code: 'sacco',
    isActive: true,
    baseUrl: null, // set once the server is listening
    webhookPath: '/api/webhooks/najiki',
    webhookSecret: WEBHOOK_SECRET,
  },
  apiKey: NAJIKI_API_KEY,
  tenants: [{
    id: NJ_TENANT_ID, applicationId: APP_ID, code: TENANT_CODE,
    name: 'Alpha SACCO', isActive: true, defaultProviderId: null,
  }],
  paymentTypes: SEEDED_SACCO_TYPES.map((code, index) => ({ id: `pt-${index}`, applicationId: APP_ID, code })),
  providers: [{ id: PROVIDER_ID, code: 'livepay', isActive: true, implemented: true }],
  tenantCredentials: new Map(), // tenantId -> [{ providerId }]
  intents: new Map(),           // `${appId}:${idempotencyKey}` -> intent
  createCalls: [],
  createAuthorizations: [],
  deliveries: [],
  mode: 'normal',               // normal | callback_before_response
};

function najikiAddPaymentType(code) {
  if (!najiki.paymentTypes.some((t) => t.code === code)) {
    najiki.paymentTypes.push({ id: `pt-${code}`, applicationId: APP_ID, code });
  }
}

function validateCreatePayment(body) {
  const details = [];
  if (typeof body.applicationCode !== 'string' || body.applicationCode.length < 1) details.push('applicationCode: Required');
  if (typeof body.paymentTypeCode !== 'string' || body.paymentTypeCode.length < 1) details.push('paymentTypeCode: Required');
  if (typeof body.externalEntityId !== 'string' || body.externalEntityId.length < 1) details.push('externalEntityId: Required');
  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0 || body.amount > 999_999_999_999.99) {
    details.push('amount: must be a finite positive amount within range');
  }
  if (body.currency !== undefined && !/^[A-Za-z]{3}$/.test(String(body.currency))) {
    details.push('currency: must be a three-letter ISO 4217 currency code');
  }
  if (typeof body.phoneNumber !== 'string' || body.phoneNumber.length < 9 || body.phoneNumber.length > 15) {
    details.push('phoneNumber: must be 9-15 characters');
  }
  if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8) {
    details.push('idempotencyKey: must be at least 8 characters');
  }
  if (body.tenantCode !== undefined && (typeof body.tenantCode !== 'string' || body.tenantCode.length < 1)) {
    details.push('tenantCode: must not be empty');
  }
  return details;
}

function najikiGenerateReference(typeCode) {
  return `SACCO-${(typeCode || 'PAY').slice(0, 3).toUpperCase()}-${Date.now().toString(16).slice(-8).toUpperCase()}-${Math.random().toString(16).slice(2, 12).toUpperCase()}`;
}

async function createNajikiPayment(body) {
  // src/app/api/payments/route.ts — authenticate before idempotency/DB work.
  const details = validateCreatePayment(body);
  if (details.length) return { status: 400, body: { error: 'Validation failed', details } };

  // The API key resolves the application; its code must match the request.
  if (body.applicationCode !== najiki.application.code) {
    return { status: 401, body: { error: 'Invalid or inactive application, or invalid API key' } };
  }

  const scopedKey = `${najiki.application.id}:${body.idempotencyKey}`;
  const existing = najiki.intents.get(scopedKey);
  if (existing) {
    return { status: 200, body: { paymentId: existing.id, reference: existing.reference, status: existing.status } };
  }

  // Tenant is resolved only when tenantCode is supplied.
  const tenant = body.tenantCode
    ? najiki.tenants.find((t) => t.applicationId === najiki.application.id && t.code === body.tenantCode && t.isActive)
    : null;
  if (body.tenantCode && !tenant) {
    return { status: 404, body: { error: 'Invalid or inactive tenant' } };
  }

  // Payment types are resolved against the application, and silently yield
  // null when absent (no 404 — this is exactly the failure mode we test).
  const paymentType = najiki.paymentTypes.find(
    (t) => t.applicationId === najiki.application.id && t.code === body.paymentTypeCode,
  ) || null;

  const isPlatformPayment = Boolean(
    paymentType && PLATFORM_FEE_TYPES.includes(String(paymentType.code).toUpperCase()),
  );

  // Provider routing: tenant default provider unless it is a platform payment.
  let provider = najiki.providers.find((p) => p.isActive && p.implemented);
  if (tenant?.defaultProviderId && !isPlatformPayment) {
    const tenantProvider = najiki.providers.find((p) => p.id === tenant.defaultProviderId);
    if (tenantProvider) provider = tenantProvider;
  }

  // Per-tenant credential enforcement (sacco). Platform-fee payments are exempt.
  if (!isPlatformPayment && TENANT_CREDENTIALS_REQUIRED_APP_CODES.includes(najiki.application.code)) {
    if (!tenant) {
      return {
        status: 400,
        body: {
          error: `Application "${najiki.application.code}" requires a tenantCode for tenant collections. ` +
            'Tenant-less payments are not accepted — platform credentials are not used for tenant money.',
        },
      };
    }
    const credentials = najiki.tenantCredentials.get(tenant.id) || [];
    if (!credentials.some((c) => c.providerId === provider.id)) {
      return {
        status: 503,
        body: {
          error: `Tenant "${tenant.code}" has no active credentials configured for livepay. ` +
            'This application requires per-tenant credentials — configure them in Setup. ' +
            'Platform credentials are not used for tenant collections.',
        },
      };
    }
  }

  const intent = {
    id: `cuid_${Math.random().toString(36).slice(2, 12)}`,
    applicationId: najiki.application.id,
    tenantId: tenant?.id ?? null,
    tenantCode: tenant?.code ?? null,
    paymentTypeId: paymentType?.id ?? null,
    paymentTypeCode: body.paymentTypeCode,
    externalEntityId: body.externalEntityId,
    amount: Number(body.amount),
    currency: String(body.currency || 'UGX').toUpperCase(),
    phoneNumber: body.phoneNumber,
    providerId: provider.id,
    idempotencyKey: body.idempotencyKey,
    reference: najikiGenerateReference(body.paymentTypeCode),
    status: 'pending',
    metadata: JSON.stringify(body.metadata ?? {}),
    isPlatformPayment,
  };
  najiki.intents.set(scopedKey, intent);

  // Simulate a provider callback landing before the create response is read.
  if (najiki.mode === 'callback_before_response') {
    await deliverNajikiWebhook(intent, 'success');
  }

  return { status: 200, body: { paymentId: intent.id, reference: intent.reference, status: intent.status } };
}

/** src/lib/payments.ts — exact notification payload for a terminal status. */
function notificationPayload(intent, status, overrides = {}) {
  return {
    paymentIntentId: intent.id,
    reference: intent.reference,
    status,
    amount: intent.amount,
    currency: intent.currency,
    providerPaymentId: `provider-${intent.id}`,
    failureReason: status === 'failed' ? 'Declined by provider' : null,
    externalEntityId: intent.externalEntityId,
    tenantId: intent.tenantId,
    tenantCode: intent.tenantCode,
    metadata: JSON.parse(intent.metadata || '{}'),
    ...overrides,
  };
}

/** src/lib/notification-signature.ts — buildNotificationHeaders. */
function signedHeaders(raw, timestamp = Date.now()) {
  const signature = createHmac('sha256', najiki.application.webhookSecret)
    .update(`${timestamp}.${raw}`)
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-najiki-notification': 'true',
    'x-najiki-timestamp': String(timestamp),
    'x-najiki-signature': `t=${timestamp},v=${signature}`,
  };
}

// ── HTTP bridge (Supabase REST + NaJiki payment API) ──────────────────────────
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://local.test');
  const send = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(value === undefined ? '' : JSON.stringify(value));
  };

  // NaJiki create-payment endpoint (Kunity's provider calls this).
  // src/app/api/payments/route.ts authenticates BEFORE validation or DB work.
  if (req.method === 'POST' && url.pathname === '/api/payments') {
    najiki.createAuthorizations.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${najiki.apiKey}`) {
      return send(401, { error: 'Missing or invalid authorization header' });
    }
    const parsed = raw ? JSON.parse(raw) : {};
    najiki.createCalls.push(parsed);
    const result = await createNajikiPayment(parsed);
    return send(result.status, result.body);
  }

  // NaJiki payment status lookup, used by the dashboard's confirm poll.
  if (req.method === 'GET' && url.pathname.startsWith('/api/payments/')) {
    if (req.headers.authorization !== `Bearer ${najiki.apiKey}`) {
      return send(401, { error: 'Missing or invalid authorization header' });
    }
    const reference = decodeURIComponent(url.pathname.split('/').pop());
    const intent = [...najiki.intents.values()].find((i) => i.reference === reference);
    if (!intent) return send(404, { error: 'Payment not found' });
    // A tenant-scoped intent is only visible to a caller naming the same tenant.
    if (intent.tenantCode && url.searchParams.get('tenantCode') !== intent.tenantCode) {
      return send(404, { error: 'Payment not found (tenant mismatch)' });
    }
    return send(200, {
      id: intent.id,
      reference: intent.reference,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      phoneNumber: intent.phoneNumber,
      externalEntityId: intent.externalEntityId,
      provider: najiki.providers.find((p) => p.id === intent.providerId) || null,
      tenant: intent.tenantId ? { id: intent.tenantId, code: intent.tenantCode } : null,
      paymentType: najiki.paymentTypes.find((t) => t.id === intent.paymentTypeId) || null,
      failureReason: null,
    });
  }

  const body = raw ? JSON.parse(raw) : {};

  // Supabase Auth
  if (url.pathname === '/auth/v1/user') {
    return req.headers.authorization === `Bearer ${ADMIN_TOKEN}`
      ? send(200, { id: ADMIN_ID, email: 'admin@alpha.test', aud: 'authenticated' })
      : send(401, { message: 'invalid token' });
  }

  // Supabase REST RPC
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = url.pathname.slice('/rest/v1/rpc/'.length);
    rpcLog.push({ fn, body });
    try {
      if (fn === 'credit_sms_wallet_idempotent') {
        const result = await db.query(
          'SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,$3)',
          [body.p_wallet_id, body.p_transaction_id, body.p_amount],
        );
        return send(200, result.rows);
      }
      if (fn === 'process_najiki_webhook') {
        const result = await db.query(
          `SELECT kunity.process_najiki_webhook($1,$2,$3,$4,$5,$6::jsonb,$7) AS r`,
          [body.p_reference, body.p_status, body.p_amount, body.p_external_entity_id,
            body.p_payment_type, JSON.stringify(body.p_payload), body.p_fee],
        );
        return send(200, result.rows[0].r);
      }
      return send(404, { message: `unknown RPC ${fn}` });
    } catch (error) {
      return send(400, { message: error.message, code: error.code || 'P0001' });
    }
  }

  // Supabase REST tables
  if (url.pathname.startsWith('/rest/v1/')) {
    const resource = url.pathname.replace('/rest/v1/', '');
    if (resource === 'audit_log' || resource === 'sms_messages') return send(201, {});

    const wantsObject = String(req.headers.accept || '').includes('pgrst.object');
    const wantsRows = String(req.headers.prefer || '').includes('return=representation');
    const filters = parseFilters(url);
    const table = TABLE_MAP[resource];
    const known = table || Object.prototype.hasOwnProperty.call(SYNTHETIC, resource);
    if (!known) return send(404, { message: `stand-in has no table ${resource}` });

    const rows = table
      ? (await db.query(`SELECT * FROM ${table}`)).rows
      : SYNTHETIC[resource];

    if (req.method === 'GET' || req.method === 'HEAD') {
      const found = rows.filter((row) => matches(row, filters));
      if (wantsObject) {
        if (found.length === 0) return send(406, { code: 'PGRST116', message: 'no rows' });
        if (found.length > 1) return send(406, { code: 'PGRST116', message: 'multiple rows' });
        return send(200, found[0]);
      }
      return send(200, found);
    }

    if (req.method === 'POST') {
      if (!table) return send(201, {});
      try {
        const inserted = await insertRows(table, body);
        return send(201, wantsRows ? inserted : undefined);
      } catch (error) {
        return send(400, { message: error.message, code: error.code || 'P0001' });
      }
    }

    if (req.method === 'PATCH') {
      if (!table) return send(200, []);
      try {
        const updated = await updateRows(table, body, filters);
        return send(200, wantsRows ? updated : undefined);
      } catch (error) {
        return send(400, { message: error.message, code: error.code || 'P0001' });
      }
    }

    if (req.method === 'DELETE') return send(204);
  }

  return send(404, { message: `stand-in has no handler for ${req.method} ${url.pathname}` });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
najiki.application.baseUrl = ORIGIN;

process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGIN;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-service-role-test-key';
process.env.NAJIKI_API_URL = ORIGIN;
process.env.NAJIKI_API_KEY = NAJIKI_API_KEY;
process.env.NAJIKI_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.NAJIKI_APPLICATION_CODE = 'sacco';

const { POST: TOPUP } = await import('../app/api/admin/sms/topup/route.ts');
const { POST: WEBHOOK_POST } = await import('../app/api/webhooks/najiki/route.ts');
const { POST: CONFIRM } = await import('../app/api/admin/sms/topup/confirm/route.ts');

async function deliverNajikiWebhook(intent, status, overrides = {}, options = {}) {
  const payload = notificationPayload(intent, status, overrides);
  const raw = JSON.stringify(payload);
  const headers = options.headers || signedHeaders(raw, options.timestamp ?? Date.now());
  let response;
  let attempts = 0;
  for (attempts = 1; attempts <= 5; attempts += 1) {
    const request = new Request(`${najiki.application.baseUrl}${najiki.application.webhookPath}`, {
      method: 'POST', headers, body: raw,
    });
    const result = await WEBHOOK_POST(request);
    let parsed = null;
    try { parsed = await result.json(); } catch { parsed = null; }
    response = { status: result.status, body: parsed };
    // NaJiki retries 5xx up to maxAttempts; 4xx is permanent.
    if (result.status < 500) break;
  }
  najiki.deliveries.push({ payload, response, attempts });
  return { ...response, attempts };
}

const buy = (credits) => ({
  token: ADMIN_TOKEN,
  credits,
  momoNumber: '0772123456',
  organizationId: TENANT_ID,
});

async function callTopup(payload = buy(200)) {
  const response = await TOPUP(new NextRequest('http://localhost:3000/api/admin/sms/topup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }));
  return { status: response.status, body: await response.json() };
}

async function callConfirm(intentId) {
  const response = await CONFIRM(new NextRequest('http://localhost:3000/api/admin/sms/topup/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: ADMIN_TOKEN, intentId, momoNumber: '0772123456' }),
  }));
  return { status: response.status, body: await response.json() };
}

async function wallet() {
  return (await db.query('SELECT * FROM public.wallets WHERE tenant_id=$1', [TENANT_ID])).rows[0];
}
async function ledger() {
  return (await db.query('SELECT * FROM public.wallet_transactions ORDER BY created_at')).rows;
}
async function paymentRequests() {
  return (await db.query('SELECT * FROM kunity.payment_requests ORDER BY created_at')).rows;
}
async function resetDatabase() {
  await db.exec(`
    UPDATE public.wallets SET balance = 0 WHERE tenant_id = '${TENANT_ID}';
    DELETE FROM public.wallet_transactions;
    DELETE FROM kunity.payment_requests;
  `);
  najiki.intents.clear();
  najiki.createCalls = [];
  najiki.createAuthorizations = [];
  najiki.deliveries = [];
  najiki.mode = 'normal';
  rpcLog.length = 0;
}
async function latestIntent() {
  return [...najiki.intents.values()].at(-1);
}

let passed = 0;
let failed = 0;
async function check(name, test) {
  try {
    await test();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}: ${error.message}`);
  }
}

console.log('\nSMS purchase vs. live NaJiki contract\n');

// ── 1. NaJiki as seeded today: BUY_SMS is not a payment type ─────────────────
console.log('NaJiki seed state (scripts/seed.ts)');
await resetDatabase();
await check('BUY_SMS is absent from the seeded sacco payment types', async () => {
  assert.deepEqual(najiki.paymentTypes.map((t) => t.code).sort(),
    ['account_activation', 'deposit', 'loan_repayment']);
});
await check('a purchase with no BUY_SMS payment type is refused, and the wallet cannot be credited', async () => {
  const response = await callTopup();
  assert.equal(response.status, 502, JSON.stringify(response.body));
  assert.match(response.body.error, /has no active credentials configured/i);
  assert.match(response.body.error, /no BUY_SMS payment type/i, 'the operator must be told what to fix');
  assert.match(response.body.error, /No money was taken/i);
  assert.equal(Number((await wallet()).balance), 0);
  const rows = await ledger();
  assert.equal(rows.length, 1, 'the pending row is written before the provider call');
  assert.equal(rows[0].note, 'pending');
  assert.equal(rows[0].status, null, 'the pending row carries note=pending; status stays NULL until terminal');
  assert.equal(rows[0].direction, 'credit');
  assert.equal(rows[0].type, 'sms_topup');
  assert.equal(Number(rows[0].amount), 10000);
  assert.equal(najiki.createCalls.length, 1);
});
await check('Kunity sends the exact NaJiki create-payment contract', async () => {
  const sent = najiki.createCalls[0];
  assert.deepEqual(Object.keys(sent).sort(), [
    'amount', 'applicationCode', 'currency', 'externalEntityId', 'idempotencyKey',
    'metadata', 'paymentTypeCode', 'phoneNumber', 'tenantCode',
  ].sort());
  assert.equal(sent.applicationCode, 'sacco');
  assert.equal(sent.paymentTypeCode, 'BUY_SMS');
  assert.equal(sent.externalEntityId, TENANT_ID, 'externalEntityId must be the Kunity tenant id the webhook checks');
  assert.equal(sent.tenantCode, TENANT_CODE, 'NaJiki resolves tenants by code, not by uuid');
  assert.equal(sent.amount, 10000, 'the 200-credit pack is UGX 10,000 server-side');
  assert.equal(sent.currency, 'UGX');
  assert.equal(sent.phoneNumber, '+256772123456');
  assert.ok(sent.idempotencyKey.length >= 8);
  assert.equal(sent.metadata.paymentTypeCode, 'BUY_SMS', 'NaJiki echoes only metadata, never a top-level paymentType');
  assert.equal(sent.metadata.reference, sent.idempotencyKey);
});
await check('the NaJiki API key is presented as a Bearer token, never in the body', async () => {
  assert.equal(najiki.createAuthorizations[0], `Bearer ${NAJIKI_API_KEY}`);
  assert.equal(najiki.createCalls[0].apiKey, undefined);
});

// ── 1b. The dangerous variant: the SACCO has tenant credentials ─────────────
console.log('\nUnseeded BUY_SMS with tenant credentials configured');
najiki.tenantCredentials.set(NJ_TENANT_ID, [{ providerId: PROVIDER_ID }]);
await resetDatabase();
await check('the payment is accepted, but as a TENANT collection — not a platform fee', async () => {
  const response = await callTopup();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const intent = await latestIntent();
  assert.equal(intent.paymentTypeId, null, 'NaJiki cannot attach a payment type it does not have');
  assert.equal(intent.isPlatformPayment, false, 'an unknown code is treated as tenant money');
  assert.equal(intent.tenantId, NJ_TENANT_ID);
});
najiki.tenantCredentials.clear();
await resetDatabase();

// ── 2. With BUY_SMS configured: the full purchase works ──────────────────────
console.log('\nBuying SMS with the payment type configured');
najikiAddPaymentType('BUY_SMS');
await resetDatabase();
await check('the top-up is accepted end-to-end and returns NaJiki\'s reference', async () => {
  const purchase = await callTopup();
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
  const intent = await latestIntent();
  assert.ok(intent, 'NaJiki must have created an intent');
  assert.equal(intent.paymentTypeId, 'pt-BUY_SMS', 'the payment type must resolve, not be null');
  assert.equal(intent.isPlatformPayment, true, 'BUY_SMS must be classified as a platform fee');
  assert.equal(purchase.body.intentId, intent.reference);
});
await check('as a platform fee, no per-tenant credentials are required', async () => {
  assert.equal(najiki.tenantCredentials.size, 0);
  assert.equal((await latestIntent()).isPlatformPayment, true);
});
await check('the pending ledger row is relinked to NaJiki\'s reference and stays pending', async () => {
  const intent = await latestIntent();
  const rows = await ledger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reference, intent.reference);
  assert.notEqual(rows[0].reference, intent.idempotencyKey);
  assert.equal(rows[0].note, 'pending');
  assert.equal(rows[0].status, null);
});
await check('the purchase is recorded in payment_requests as BUY_SMS', async () => {
  const rows = await paymentRequests();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payment_type, 'BUY_SMS');
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].internal_reference, (await latestIntent()).reference);
  assert.equal(rows[0].member_id, null, 'an SMS top-up is an organization purchase, not a member payment');
});

await check('all four server packs are sent at their configured price', async () => {
  for (const pack of [
    { credits: 200, price: 10000 },
    { credits: 500, price: 25000 },
    { credits: 1200, price: 50000 },
    { credits: 3000, price: 100000 },
  ]) {
    await resetDatabase();
    const response = await callTopup(buy(pack.credits));
    assert.equal(response.status, 200, `${pack.credits} credits: ${JSON.stringify(response.body)}`);
    assert.equal((await latestIntent()).amount, pack.price, `${pack.credits} credits`);
  }
});
await resetDatabase();
await callTopup();

// ── 3. The real NaJiki notification credits the SACCO SMS wallet ─────────────
console.log('\nWebhook: NaJiki success notification');
await check('a correctly signed success notification credits exactly the pack price', async () => {
  const intent = await latestIntent();
  const before = Number((await wallet()).balance);
  const result = await deliverNajikiWebhook(intent, 'success');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.message, 'SMS Topup credited');
  assert.equal(Number((await wallet()).balance), before + 10000);
  const row = (await ledger())[0];
  assert.equal(row.note, 'success');
  assert.equal(row.status, 'success');
  assert.equal(result.attempts, 1, 'a successful delivery must not be retried');
  assert.equal(rpcLog.filter((c) => c.fn === 'credit_sms_wallet_idempotent').length, 1);
});
await check('the payment_requests row is moved to success by the real SQL RPC', async () => {
  const rows = await paymentRequests();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'success');
  assert.ok(rows[0].completed_at);
  assert.equal(rows[0].journal_entry_id, null, 'BUY_SMS never posts a SACCO journal entry');
  const journal = await db.query('SELECT COUNT(*)::int AS n FROM kunity.journal_entries');
  assert.equal(journal.rows[0].n, 0);
});
await check('NaJiki\'s retry of the same notification cannot double-credit', async () => {
  const intent = await latestIntent();
  const before = Number((await wallet()).balance);
  const result = await deliverNajikiWebhook(intent, 'success');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.body.message, /Already processed/i);
  assert.equal(Number((await wallet()).balance), before);
  assert.equal(rpcLog.filter((c) => c.fn === 'credit_sms_wallet_idempotent').length, 1);
});
await check('a replayed 200 is not retried by NaJiki (no 5xx)', async () => {
  assert.equal(najiki.deliveries.at(-1).attempts, 1);
});

// ── 4. Failed collection ─────────────────────────────────────────────────────
console.log('\nWebhook: NaJiki failure notification');
await resetDatabase();
await check('a failed payment marks the top-up failed and credits nothing', async () => {
  const response = await callTopup();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const intent = await latestIntent();
  const result = await deliverNajikiWebhook(intent, 'failed');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(Number((await wallet()).balance), 0);
  const row = (await ledger())[0];
  assert.equal(row.note, 'failed');
  assert.equal(row.status, 'failed');
  assert.equal((await paymentRequests())[0].status, 'failed');
});
await check('a late success callback cannot resurrect a failed top-up', async () => {
  const result = await deliverNajikiWebhook(await latestIntent(), 'success');
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(Number((await wallet()).balance), 0);
});

// ── 5. Signature / replay protections on the live header format ──────────────
console.log('\nWebhook authentication');
await resetDatabase();
await callTopup();
await check('an unsigned notification is rejected and credits nothing', async () => {
  const intent = await latestIntent();
  const payload = notificationPayload(intent, 'success');
  const result = await WEBHOOK_POST(new Request(`${ORIGIN}/api/webhooks/najiki`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }));
  assert.equal(result.status, 401);
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a tampered amount invalidates the signature', async () => {
  const intent = await latestIntent();
  const payload = notificationPayload(intent, 'success');
  const raw = JSON.stringify(payload);
  const headers = signedHeaders(raw);
  const tampered = JSON.stringify({ ...payload, amount: 1 });
  const result = await WEBHOOK_POST(new Request(`${ORIGIN}/api/webhooks/najiki`, {
    method: 'POST', headers, body: tampered,
  }));
  assert.equal(result.status, 401);
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a signature older than 5 minutes is rejected (replay window)', async () => {
  const intent = await latestIntent();
  const payload = notificationPayload(intent, 'success');
  const raw = JSON.stringify(payload);
  const stale = Date.now() - 6 * 60 * 1000;
  const result = await WEBHOOK_POST(new Request(`${ORIGIN}/api/webhooks/najiki`, {
    method: 'POST', headers: signedHeaders(raw, stale), body: raw,
  }));
  assert.equal(result.status, 401);
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a valid signature with a mismatched amount is refused', async () => {
  const result = await deliverNajikiWebhook(await latestIntent(), 'success', { amount: 5000 });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a valid signature with a mismatched currency is refused', async () => {
  const result = await deliverNajikiWebhook(await latestIntent(), 'success', { currency: 'USD' });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a valid signature attributed to another tenant is refused', async () => {
  const result = await deliverNajikiWebhook(await latestIntent(), 'success', {
    externalEntityId: '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.match(result.body.error, /tenant mismatch/i);
  assert.equal(Number((await wallet()).balance), 0);
});

// ── 6. Callback racing the create response ──────────────────────────────────
console.log('\nWebhook: callback arriving before the create response');
await resetDatabase();
najiki.mode = 'callback_before_response';
await check('the callback is credited via metadata.reference before the reference is linked', async () => {
  const response = await callTopup();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.intent.status, 'success', 'the route must reflect the terminal callback');
  assert.equal(Number((await wallet()).balance), 10000);
  const intent = await latestIntent();
  const rows = await ledger();
  assert.equal(rows[0].reference, intent.reference);
  assert.equal(rows[0].note, 'success');
  const pr = (await paymentRequests())[0];
  assert.equal(pr.status, 'success');
  assert.equal(pr.internal_reference, intent.reference);
});

// ── 6b. The dashboard's confirm poll ─────────────────────────────────────────
console.log('\nConfirm path (dashboard polling)');
await resetDatabase();
let confirmedIntent;
await check('the confirm poll credits the wallet from NaJiki\'s status endpoint', async () => {
  const response = await callTopup();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  confirmedIntent = await latestIntent();
  confirmedIntent.status = 'success'; // mobile money completed; no webhook yet
  const confirmed = await callConfirm(confirmedIntent.reference);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.success, true);
  assert.equal(Number((await wallet()).balance), 10000);
  assert.equal((await ledger())[0].note, 'success');
});
await check('a confirm-first success is reflected in payment_requests', async () => {
  assert.equal((await paymentRequests())[0].status, 'success');
});
await check('a late webhook after a confirm credit does not double-credit', async () => {
  const result = await deliverNajikiWebhook(confirmedIntent, 'success');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(Number((await wallet()).balance), 10000);
});

// ── 7. The SQL function is the only thing that moves the balance ─────────────
console.log('\ncredit_sms_wallet_idempotent');
await resetDatabase();
await callTopup();
await check('a mismatched amount is rejected at the database level', async () => {
  const row = (await ledger())[0];
  await assert.rejects(
    db.query('SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,$3)', [row.wallet_id, row.id, 999]),
    /Amount does not match/,
  );
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a debit row cannot be credited as a top-up', async () => {
  await db.query(`UPDATE public.wallet_transactions SET direction='debit', type='sms_debit' WHERE id=$1`, [(await ledger())[0].id]);
  const row = (await ledger())[0];
  await assert.rejects(
    db.query('SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,$3)', [row.wallet_id, row.id, 10000]),
    /not a tenant-bound SMS top-up credit/,
  );
  assert.equal(Number((await wallet()).balance), 0);
});
await check('replaying the credit returns the wallet without adding the amount twice', async () => {
  await db.query(`UPDATE public.wallet_transactions SET direction='credit', type='sms_topup' WHERE id=$1`, [(await ledger())[0].id]);
  const row = (await ledger())[0];
  await db.query('SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,$3)', [row.wallet_id, row.id, 10000]);
  const afterFirst = Number((await wallet()).balance);
  await db.query('SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,$3)', [row.wallet_id, row.id, 10000]);
  assert.equal(Number((await wallet()).balance), afterFirst);
  assert.equal(afterFirst, 10000);
});

// ── summary ──────────────────────────────────────────────────────────────────
await new Promise((resolve) => server.close(resolve));
await db.close();
console.log(`\n${passed} checks passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
