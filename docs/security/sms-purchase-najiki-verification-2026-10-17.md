# SMS purchase ↔ NaJiki verification — 2026-10-17

## Verdict

The Kunity code path is **correct**: with `BUY_SMS` configured as a NaJiki payment
type, an admin purchase creates the intent, the signed notification credits the
SACCO SMS wallet exactly once, and both the webhook and the dashboard's confirm
poll converge on the same idempotent SQL credit.

It does **not** work end-to-end on a NaJiki deployment built from
`jikiservant-cmyk/najiki-finance2@6d55d75` out of the box. `scripts/seed.ts`
creates only `deposit`, `loan_repayment` and `account_activation` for the
`sacco` application, and the seeded `sacco` application points its webhook at
`https://sacco.yourdomain.com/api/internal/payment-completed`, a route that does
not exist in Kunity. Both must be configured before the first purchase.

Two Kunity defects were found and fixed, and the operator-facing error for the
gateway misconfiguration was made actionable:

| # | Defect | Fix |
|---|---|---|
| 1 | `kunity.payment_requests.member_id` is `NOT NULL`, but an SMS top-up is an organization purchase (`member_id: null`). The reporting row was silently dropped. | `supabase/migrations/37_sms_topup_payment_request_member_nullable.sql` |
| 2 | When the dashboard's confirm poll wins the race against NaJiki's outbound webhook, the wallet was credited but `kunity.payment_requests` stayed `pending` forever. | `app/api/admin/sms/topup/confirm/route.ts` records the terminal success through `process_najiki_webhook` after the credit. |
| 3 | A missing `BUY_SMS` type surfaced as "Tenant has no active credentials", sending operators after the wrong problem. | `app/api/admin/sms/topup/route.ts` appends the actual cause and the fix. |

## How this was verified

No production credentials, provider endpoints, or real money were used.

* The NaJiki contract was read from the real source at
  `jikiservant-cmyk/najiki-finance2@6d55d75`: `app/api/payments/route.ts`,
  `app/api/payments/[reference]/route.ts`, `lib/schemas.ts`, `lib/constants.ts`,
  `lib/payments.ts`, `lib/notification-signature.ts`, `lib/json.ts`,
  `scripts/seed.ts`, `app/api/setup/route.ts`.
* `test/sms-purchase-najiki-live-contract-tests.mjs` runs the **real**
  `POST /api/admin/sms/topup`, `POST /api/admin/sms/topup/confirm` and
  `POST /api/webhooks/najiki` handlers.
* The database is a real Postgres (PGlite) with migrations 21–37, reached through
  a local Supabase REST/RPC stand-in.
* The NaJiki side is a simulator whose rules are transcribed from the source
  above: auth before idempotency, tenant 404, silent `paymentType` null, platform
  fee detection, per-tenant credential enforcement, intent metadata storage,
  notification payload, `t=..,v=..` HMAC headers, 5 retries on 5xx, and the
  `GET /api/payments/:reference?tenantCode=` status shape.

```bash
npm ci && npm i --no-save tsx
node_modules/.bin/tsx test/sms-purchase-najiki-live-contract-tests.mjs
# 29 checks passed, 0 failed
```

## What happens today on an unconfigured NaJiki

Both behaviours were reproduced in the suite.

**No `BUY_SMS` type, SACCO has no NaJiki credentials** — `paymentType` resolves
to null, so `isPlatformPayment` is false and the `sacco` per-tenant credential
rule fires. NaJiki returns `503 Tenant "…" has no active credentials configured
for livepay…`; Kunity returns 502 and leaves the pending ledger row uncredited.
No money moves.

**No `BUY_SMS` type, but the SACCO has credentials** — this is the dangerous
one. NaJiki accepts the payment (200) with `paymentTypeId = null` and
`isPlatformPayment = false`: the top-up is booked as **tenant money** and settles
through the SACCO's provider account, while Kunity still credits the SMS wallet
when the callback arrives. The platform gives away credits and the collection is
attributed to the SACCO.

With `BUY_SMS` present, `PLATFORM_FEE_TYPES` classifies it as a platform fee:
platform provider, no tenant credentials, and the wallet is credited on the
signed callback.

## Contract details confirmed

| Direction | Detail |
|---|---|
| Create | `POST {NAJIKI_API_URL}/api/payments`, `Authorization: Bearer <api key>`, 20 s timeout |
| Body | `applicationCode`, `tenantCode`, `paymentTypeCode`, `externalEntityId`, `amount`, `currency`, `phoneNumber`, `idempotencyKey`, `metadata` |
| Kunity values | `applicationCode` = `NAJIKI_APPLICATION_CODE` (`sacco`), `tenantCode` = `public.tenants.code`, `externalEntityId` = Kunity tenant id, `idempotencyKey` = `metadata.reference` = `PAY-SMS-<uuid>` |
| Response | `{ paymentId, reference, status }`; Kunity stores `reference` on the ledger row |
| Notification | `POST {baseUrl}{webhookPath}` with `X-Najiki-Notification: true`, `X-Najiki-Timestamp`, `X-Najiki-Signature: t=<ms>,v=HMAC-SHA256(secret,"<ms>.<body>")`; no `Authorization`; max 5 attempts; 4xx permanent except 408/429 |
| Payload | `paymentIntentId`, `reference`, `status`, `amount`, `currency`, `providerPaymentId`, `failureReason`, `externalEntityId`, `tenantId`, `tenantCode`, `metadata` — **no top-level `paymentType`** |
| Type signal | NaJiki echoes the create request's `metadata`; Kunity's provider puts `paymentTypeCode: "BUY_SMS"` and `reference` there, and the webhook reads `metadata.paymentTypeCode`. |
| Status API | `GET /api/payments/:reference?tenantCode=<code>`; 404 when the tenant does not match; returns `amount`, `currency`, `status`, `paymentType`, `externalEntityId` |
| Idempotency | unique `(applicationId, idempotencyKey)`; a replayed create returns the same reference |

The suite proves: a signed success credits exactly the pack price; a retry and a
duplicate delivery do not double-credit; a failure marks the row failed and
credits nothing; a late success cannot resurrect a failed top-up; unsigned,
tampered, stale (> 5 min), wrong-amount, wrong-currency and wrong-tenant
notifications are rejected; a callback that races the create response is
credited through `metadata.reference`; and the SQL function rejects amount
mismatches and debit rows while staying idempotent.

Two additional guards are proven (suite now 31 checks):

* On a **pre-hardening** NaJiki that accepts `BUY_SMS` as a tenant collection
  (tenant credentials configured, no `BUY_SMS` type), the top-up route queries
  the status endpoint, sees `paymentType: null`, and refuses with 502 — the
  operator is told to register `BUY_SMS`, and that an approved prompt still
  credits via the webhook. The paid-money-can't-strand property is tested.
* Against the **hardened** NaJiki contract (strict payment types), an
  unregistered `BUY_SMS` is rejected by NaJiki itself with 400 before any money
  moves, and Kunity relays the operator-actionable error.

All four server-priced packs are sent at their configured price:
200 → 10,000, 500 → 25,000, 1,200 → 50,000, 3,000 → 100,000 UGX.

## Required NaJiki setup (blocking)

**Preferred path:** apply the NaJiki hardening patch shipped in this repository
at `docs/security/najiki-buy-sms-hardening.patch`
(`najiki-finance2` branch content of `arena/016d07ac-buy-sms-hardening`, commit
`d89c531`). It makes NaJiki fail closed on unregistered payment-type codes,
registers `BUY_SMS` in `scripts/seed.ts`, and points the seeded sacco
application's webhook path at `/api/webhooks/najiki`. Its test suite passes
153/153. After a re-seed, fresh installations need **no** manual steps 1–2
below; existing deployments still need them (or the equivalent SQL/admin
update).

```bash
cd najiki-finance2 && git am < ../kunity-application-/docs/security/najiki-buy-sms-hardening.patch
```

**Manual steps on an unpatched NaJiki deployment:**

1. **Add the payment type** for the `sacco` application (super-admin):

   ```http
   POST /api/setup
   { "type": "paymentType",
     "data": { "applicationId": "<sacco app id>", "code": "BUY_SMS",
               "description": "SMS credits top-up" } }
   ```

   Add the same row to `scripts/seed.ts` so a fresh install is not broken.

2. **Point the application's webhook at Kunity**:

   ```http
   POST /api/setup
   { "type": "updateApplication",
     "data": { "id": "<sacco app id>",
               "baseUrl": "https://<kunity-origin>",
               "webhookPath": "/api/webhooks/najiki" } }
   ```

3. **Create the NaJiki tenant** whose `code` equals the Kunity row in
   `public.tenants.code` for that SACCO. Kunity sends that code as `tenantCode`;
   an unknown or inactive code is a 404 and the purchase fails.

4. **Align the webhook secret**: the NaJiki application's `webhookSecret` must be
   the value in Kunity's `NAJIKI_WEBHOOK_SECRET`. If it was rotated or never
   copied, every notification is rejected with 401 and no credits are added.

5. Confirm `NAJIKI_API_URL` and `NAJIKI_API_KEY` in Kunity point at that
   deployment, and run migrations **37** before deploying the code.

## Residual risks

* **Metadata dependency.** NaJiki's payment notification has no top-level
  `paymentType`; the SMS branch relies on `metadata.paymentTypeCode` being
  echoed. This is verified against the current source, but a future NaJiki change
  to stop echoing metadata would route SMS callbacks down the deposit path
  (`process_najiki_webhook` would still record the purchase, but the wallet
  would not be credited). A defensive ledger-type fallback in the webhook is the
  next hardening step if that contract ever changes.
* **Tenant-code drift.** Kunity falls back to sending the tenant *id* when
  `public.tenants.code` is missing; NaJiki only matches tenant codes, so that
  fallback always 404s. Keep the two tenant tables in sync.
* **Webhook URL drift.** NaJiki retries to whatever `baseUrl`+`webhookPath` says.
  If it points anywhere other than Kunity's `/api/webhooks/najiki`, payments
  succeed at the provider and are never credited (the confirm poll still
  recovers a purchase while the admin keeps the dashboard open, but not later).
* This is a contract/regression test, not a live mobile-money test: the provider
  leg (PIN prompt, real callback timing) still needs a staging run.
