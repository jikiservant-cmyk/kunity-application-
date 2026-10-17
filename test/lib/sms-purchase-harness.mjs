/**
 * Shared harness for the SMS purchase suites.
 *
 * Runs the REAL route handlers
 *   POST /api/admin/sms/topup
 *   POST /api/admin/sms/topup/confirm
 *   POST /api/webhooks/najiki
 * against a real Postgres (PGlite) migrated with the repository's financial
 * migrations, and a NaJiki simulator whose rules are transcribed from the
 * jikiservant-cmyk/najiki-finance2 source (@6d55d75):
 *
 *   src/app/api/payments/route.ts        auth before idempotency, tenant 404,
 *                                        silent paymentType null, platform-fee
 *                                        detection, per-tenant credentials
 *   src/app/api/payments/[reference]     Bearer + tenant-scoped 404
 *   src/lib/constants.ts                 PLATFORM_FEE_TYPES,
 *                                        TENANT_CREDENTIALS_REQUIRED_APP_CODES
 *   src/lib/schemas.ts                   CreatePaymentRequestSchema
 *   src/lib/payments.ts                  notification payload shape
 *   src/lib/notification-signature.ts    t=..,v=.. HMAC headers
 *   scripts/seed.ts                      seeded payment types per application
 *
 * createHarness() is parameterised so hostile suites can add extra tenants,
 * roles and auth tokens. No production credentials, provider endpoints, or
 * real money are used.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

export const IDS = {
  APP_ID: 'aaaaaaaa-0000-4000-8000-000000000001',
  NJ_TENANT_ID: 'bbbbbbbb-0000-4000-8000-000000000001',
  PROVIDER_ID: 'cccccccc-0000-4000-8000-000000000001',
  TENANT_ID: '11111111-1111-4111-8111-111111111111', // Kunity organization (tenant A)
  TENANT_B_ID: '22222222-2222-4222-8222-222222222222', // second Kunity organization
  WALLET_ID: '55555555-5555-4555-8555-555555555555',
  WALLET_B_ID: '66666666-6666-4666-8666-666666666666',
  ADMIN_ID: '99999999-9999-4999-8999-999999999999',
  ADMIN_B_ID: '88888888-8888-4888-8888-888888888888',
  MEMBER_ID: '77777777-7777-4777-8777-777777777777',
  GLOBAL_ID: '33333333-3333-4333-8333-333333333333',
  TENANT_CODE: 'alpha-sacco',
  TENANT_B_CODE: 'beta-sacco',
  ADMIN_TOKEN: 'admin-access-token',
  ADMIN_B_TOKEN: 'admin-b-access-token',
  MEMBER_TOKEN: 'member-access-token',
  GLOBAL_TOKEN: 'global-access-token',
  NAJIKI_API_KEY: 'nk_live_contract_test_key',
  WEBHOOK_SECRET: 'njk_whsec_contract_test',
};

const DEFAULT_PROFILES = [
  { id: IDS.ADMIN_ID, role: 'sacco_admin', tenant_id: IDS.TENANT_ID },
];
const DEFAULT_TENANTS = [
  { id: IDS.TENANT_ID, code: IDS.TENANT_CODE, name: 'Alpha SACCO', application_id: IDS.APP_ID },
];
const DEFAULT_WALLETS = [
  { id: IDS.WALLET_ID, tenant_id: IDS.TENANT_ID, balance: 0, sms_rate: 50, currency: 'UGX' },
];
const DEFAULT_TOKENS = {
  [IDS.ADMIN_TOKEN]: { id: IDS.ADMIN_ID, email: 'admin@alpha.test' },
};

const SECOND_TENANT_IDS = new Set([IDS.TENANT_B_ID]);

export async function createHarness(options = {}) {
  const profiles = options.profiles || DEFAULT_PROFILES;
  const tenants = options.tenants || DEFAULT_TENANTS;
  const wallets = options.wallets || DEFAULT_WALLETS;
  const tokens = options.tokens || DEFAULT_TOKENS;
  const primaryTenantId = tenants[0].id;

  // ── NaJiki simulator, transcribed from najiki-finance2 ──────────────────────
  const PLATFORM_FEE_TYPES = [
    'SMS', 'BUY_SMS', 'SMS_TOPUP', 'ACTIVATION', 'ACCOUNT_ACTIVATION',
    'SUBSCRIPTION', 'MONTHLY_SUBSCRIPTION', 'PLATFORM_FEE',
  ];
  const TENANT_CREDENTIALS_REQUIRED_APP_CODES = ['sacco'];
  const SEEDED_SACCO_TYPES = ['deposit', 'loan_repayment', 'account_activation'];

  const najiki = {
    application: {
      id: IDS.APP_ID,
      code: 'sacco',
      isActive: true,
      baseUrl: null, // set once the bridge server is listening
      webhookPath: '/api/webhooks/najiki',
      webhookSecret: IDS.WEBHOOK_SECRET,
    },
    apiKey: IDS.NAJIKI_API_KEY,
    tenants: tenants.map((t, i) => ({
      id: SECOND_TENANT_IDS.has(t.id) ? `bbbbbbbb-0000-4000-8000-00000000000${i}` : IDS.NJ_TENANT_ID,
      applicationId: IDS.APP_ID, code: t.code, name: t.name, isActive: true,
      defaultProviderId: null,
    })),
    paymentTypes: SEEDED_SACCO_TYPES.map((code, index) => ({ id: `pt-${index}`, applicationId: IDS.APP_ID, code })),
    providers: [{ id: IDS.PROVIDER_ID, code: 'livepay', isActive: true, implemented: true }],
    tenantCredentials: new Map(), // tenantId -> [{ providerId }]
    intents: new Map(),           // `${appId}:${idempotencyKey}` -> intent
    createCalls: [],
    createAuthorizations: [],
    statusCalls: [],              // GET /api/payments/:ref calls { reference, tenantCode }
    statusOverrides: new Map(),   // reference -> fields merged into the GET response
    deliveries: [],
    mode: 'normal',               // normal | callback_before_response
  };

  function najikiAddPaymentType(code) {
    if (!najiki.paymentTypes.some((t) => t.code === code)) {
      najiki.paymentTypes.push({ id: `pt-${code}`, applicationId: IDS.APP_ID, code });
    }
  }
  if (options.seedBuySms) najikiAddPaymentType('BUY_SMS');
  if (options.tenantCredentials) {
    for (const njTenant of najiki.tenants) {
      najiki.tenantCredentials.set(njTenant.id, [{ providerId: IDS.PROVIDER_ID }]);
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

    if (body.applicationCode !== najiki.application.code) {
      return { status: 401, body: { error: 'Invalid or inactive application, or invalid API key' } };
    }

    const scopedKey = `${najiki.application.id}:${body.idempotencyKey}`;
    const existing = najiki.intents.get(scopedKey);
    if (existing) {
      return { status: 200, body: { paymentId: existing.id, reference: existing.reference, status: existing.status } };
    }

    const tenant = body.tenantCode
      ? najiki.tenants.find((t) => t.applicationId === najiki.application.id && t.code === body.tenantCode && t.isActive)
      : null;
    if (body.tenantCode && !tenant) {
      return { status: 404, body: { error: 'Invalid or inactive tenant' } };
    }

    // Payment types silently resolve to null when absent (the tested failure mode).
    const paymentType = najiki.paymentTypes.find(
      (t) => t.applicationId === najiki.application.id && t.code === body.paymentTypeCode,
    ) || null;

    const isPlatformPayment = Boolean(
      paymentType && PLATFORM_FEE_TYPES.includes(String(paymentType.code).toUpperCase()),
    );

    let provider = najiki.providers.find((p) => p.isActive && p.implemented);
    if (tenant?.defaultProviderId && !isPlatformPayment) {
      const tenantProvider = najiki.providers.find((p) => p.id === tenant.defaultProviderId);
      if (tenantProvider) provider = tenantProvider;
    }

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

  // ── Kunity's real database (PGlite + repository migrations) ─────────────────
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

  for (const t of tenants) {
    await db.query(
      'INSERT INTO kunity.organizations (id,name,code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [t.id, t.name, t.code.toUpperCase()],
    );
  }
  for (const w of wallets) {
    await db.query(
      'INSERT INTO public.wallets (id,tenant_id,balance,sms_rate,currency) VALUES ($1,$2,$3,$4,$5)',
      [w.id, w.tenant_id, w.balance, w.sms_rate, w.currency],
    );
  }

  // ── Supabase REST/RPC stand-in over the real database ───────────────────────
  const rpcLog = [];
  const TABLE_MAP = {
    wallets: 'public.wallets',
    wallet_transactions: 'public.wallet_transactions',
    payment_requests: 'kunity.payment_requests',
  };
  const SYNTHETIC = {
    admin_profiles: profiles,
    tenants,
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

  // ── HTTP bridge (Supabase REST + NaJiki payment API) ────────────────────────
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://local.test');
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(value === undefined ? '' : JSON.stringify(value));
    };

    // NaJiki create-payment endpoint. Authenticates BEFORE validation or DB work.
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
      najiki.statusCalls.push({ reference, tenantCode: url.searchParams.get('tenantCode') });
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
        ...(najiki.statusOverrides.get(reference) || {}),
      });
    }

    const body = raw ? JSON.parse(raw) : {};

    // Supabase Auth
    if (url.pathname === '/auth/v1/user') {
      const authHeader = String(req.headers.authorization || '');
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const user = tokens[token];
      return user ? send(200, { ...user, aud: 'authenticated' }) : send(401, { message: 'invalid token' });
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
  process.env.NAJIKI_API_KEY = IDS.NAJIKI_API_KEY;
  process.env.NAJIKI_WEBHOOK_SECRET = IDS.WEBHOOK_SECRET;
  process.env.NAJIKI_APPLICATION_CODE = 'sacco';

  const { POST: TOPUP } = await import('../../app/api/admin/sms/topup/route.ts');
  const { POST: WEBHOOK_POST } = await import('../../app/api/webhooks/najiki/route.ts');
  const { POST: CONFIRM } = await import('../../app/api/admin/sms/topup/confirm/route.ts');

  async function deliverNajikiWebhook(intent, status, overrides = {}, webhookOptions = {}) {
    const payload = notificationPayload(intent, status, overrides);
    const raw = JSON.stringify(payload);
    const headers = webhookOptions.headers || signedHeaders(raw, webhookOptions.timestamp ?? Date.now());
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

  /** Hostile caller: deliver arbitrary raw body + headers, no signing, no retries. */
  async function rawWebhook(rawBody, headers) {
    const request = new Request(`${najiki.application.baseUrl}${najiki.application.webhookPath}`, {
      method: 'POST', headers, body: rawBody,
    });
    const result = await WEBHOOK_POST(request);
    let parsed = null;
    try { parsed = await result.json(); } catch { parsed = null; }
    return { status: result.status, body: parsed };
  }

  const buy = (credits, token = IDS.ADMIN_TOKEN) => ({
    token,
    credits,
    momoNumber: '0772123456',
    organizationId: primaryTenantId,
  });

  async function callTopup(payload = buy(200)) {
    const response = await TOPUP(new NextRequest('http://localhost:3000/api/admin/sms/topup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }));
    return { status: response.status, body: await response.json() };
  }

  async function callConfirm(intentId, options = {}) {
    const response = await CONFIRM(new NextRequest('http://localhost:3000/api/admin/sms/topup/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: options.token || IDS.ADMIN_TOKEN,
        intentId,
        momoNumber: options.momoNumber || '0772123456',
      }),
    }));
    return { status: response.status, body: await response.json() };
  }

  async function wallet(tenantId = primaryTenantId) {
    return (await db.query('SELECT * FROM public.wallets WHERE tenant_id=$1', [tenantId])).rows[0];
  }
  async function ledger(tenantId = null) {
    return tenantId
      ? (await db.query('SELECT * FROM public.wallet_transactions WHERE tenant_id=$1 ORDER BY created_at', [tenantId])).rows
      : (await db.query('SELECT * FROM public.wallet_transactions ORDER BY created_at')).rows;
  }
  async function paymentRequests() {
    return (await db.query('SELECT * FROM kunity.payment_requests ORDER BY created_at')).rows;
  }
  async function resetDatabase() {
    await db.exec(`
      UPDATE public.wallets SET balance = 0;
      DELETE FROM public.wallet_transactions;
      DELETE FROM kunity.payment_requests;
    `);
    najiki.intents.clear();
    najiki.createCalls = [];
    najiki.createAuthorizations = [];
    najiki.statusCalls = [];
    najiki.statusOverrides.clear();
    najiki.deliveries = [];
    najiki.mode = 'normal';
    rpcLog.length = 0;
  }
  async function latestIntent() {
    return [...najiki.intents.values()].at(-1);
  }

  // ── per-suite check bookkeeping ─────────────────────────────────────────────
  const tally = { passed: 0, failed: 0 };
  async function check(name, test) {
    try {
      await test();
      tally.passed += 1;
      console.log(`  ok  ${name}`);
    } catch (error) {
      tally.failed += 1;
      console.error(`FAIL  ${name}: ${error.message}`);
    }
  }

  return {
    db, najiki, rpcLog, server, ORIGIN,
    TOPUP, WEBHOOK_POST, CONFIRM,
    callTopup, callConfirm, buy,
    deliverNajikiWebhook, rawWebhook, signedHeaders, notificationPayload,
    najikiAddPaymentType,
    wallet, ledger, paymentRequests, resetDatabase, latestIntent,
    check, tally,
  };
}
