# NaJiki integration contract

This document records the Kunity integration checked against
[`jikiservant-cmyk/najiki-finance2`](https://github.com/jikiservant-cmyk/najiki-finance2),
source revision `6d55d75369af05d9bd1fa529205e4d51eb213c8c`.
It covers the current API and notification behavior in that source revision. It
cannot verify the settings or secrets in a deployed NaJiki instance.

## Required NaJiki application settings

The NaJiki application record used by Kunity must be active and configured as
follows:

| Setting | Required value |
| --- | --- |
| Application code | `sacco` (or the exact value configured as `NAJIKI_APPLICATION_CODE`) |
| Base URL | Kunity's public HTTPS origin, with no trailing slash |
| Webhook path | `/api/webhooks/najiki` |
| API key | The plaintext application API key configured as `NAJIKI_API_KEY` in Kunity |
| Webhook secret | The dedicated application webhook secret configured as `NAJIKI_WEBHOOK_SECRET` in Kunity |

The current NaJiki setup and seed code create a **separate** webhook secret and
store it encrypted. Kunity must receive the matching plaintext secret; the API
key is not interchangeable when that separate secret exists. Save the returned
secret when the application is created or rotated. If it was lost, use NaJiki's
rotation flow and update every affected Kunity environment with the returned
credentials. The API-key fallback in Kunity is retained only for legacy NaJiki
application rows that have no dedicated webhook secret.

The current NaJiki seed uses the placeholder webhook path
`/api/internal/payment-completed`; it is **not** Kunity's route. Set the
application's real base URL and webhook path in NaJiki before expecting any
callbacks to arrive.

## Deployment origin

`NAJIKI_API_URL` must be the origin of the deployment that actually serves the
API, with no trailing slash and no `/api` suffix — Kunity appends `/api/payments`
itself. **It is read from the environment at runtime and is never hardcoded in
the source.** NaJiki moves hosts (Netlify and Vercel have both served as the live
deployment), so the only durable answer is to change the variable, not the code.

There is no fallback. If the variable is missing or malformed, Kunity's money
paths throw a configuration error before contacting anyone rather than guessing
an origin — a hardcoded default previously sent production deposits to a
deployment that answered with an HTML error page.

A configured URL is not proof of health. Before creating a payment intent,
`lib/najiki-health.ts` probes `{NAJIKI_API_URL}/api/health` (cached 30 s on
success, 5 s on failure) and refuses with a member-friendly message when the
provider is unusable. `GET /api/health` reports the same result as
`najikiReachable` / `najikiVersion` and degrades to HTTP 503. A provider that
answers JSON `503` — its own rate limiter failing closed when Redis is missing —
is caught here rather than after a PIN prompt.

## Payment API calls

Kunity sends:

- `POST {NAJIKI_API_URL}/api/payments` with a Bearer API key and
  `applicationCode`, `tenantCode`, `paymentTypeCode`, `externalEntityId`,
  numeric `amount`, three-letter `currency`, `phoneNumber`, `idempotencyKey`,
  and `metadata`.
- `GET {NAJIKI_API_URL}/api/payments/{reference}?tenantCode={tenantCode}` with
  the same Bearer API key. NaJiki scopes a tenant payment lookup by the exact
  tenant code.
- `POST {NAJIKI_API_URL}/api/messaging/send` with a Bearer API key, `to`,
  `message`, `applicationCode`, and an `Idempotency-Key` header.

Kunity uses UGX for its money ledger. Its SMS top-up path sends `BUY_SMS`,
keeps a local wallet row before calling NaJiki, and echoes that row's local
reference in signed notification metadata so a callback that beats the create
response can still be reconciled. For these callbacks, Kunity also checks that
`externalEntityId` matches the tenant owning the wallet row. A terminal failed
payment marks the top-up failed without crediting the wallet; a success credits
it once, including on replay.

**NaJiki-side setup requirement:** the current NaJiki `scripts/seed.ts` creates
`deposit`, `loan_repayment`, and `account_activation` payment-type rows for the
`sacco` application, but does not create a `BUY_SMS` row. The provider's
`PLATFORM_FEE_TYPES` includes `BUY_SMS`, but the row must also exist for the
application so NaJiki classifies and routes SMS purchases as platform fees.
Create/configure that row in NaJiki before enabling top-ups. Without it, the
provider may not classify the top-up as a platform payment.

## Payment notification format

The current NaJiki notification sender posts a bare JSON object (not necessarily
a `{ "data": ... }` wrapper) to the configured `baseUrl + webhookPath`. A
success notification has this shape:

```json
{
  "paymentIntentId": "provider-payment-uuid",
  "reference": "NAJIKI-REFERENCE",
  "status": "success",
  "amount": 10000,
  "currency": "UGX",
  "providerPaymentId": "gateway-payment-id",
  "failureReason": null,
  "externalEntityId": "member-or-tenant-id",
  "tenantId": "tenant-id",
  "tenantCode": "sacco-a",
  "metadata": {
    "paymentTypeCode": "deposit"
  }
}
```

Current code emits `success` and `failed` terminal notifications. The payment
type is echoed in `metadata.paymentTypeCode` (not as a top-level field), so
Kunity resolves it from there. The current internal notification schema has no
`fee` field; Kunity therefore treats an omitted fee as zero. The handler also
accepts the older nested `data` wrapper for compatibility.

## Signature contract

NaJiki signs the exact raw request body with the application's webhook secret:

```text
X-Najiki-Timestamp: <Unix timestamp in milliseconds>
X-Najiki-Signature: t=<timestamp>,v=<lowercase hex HMAC-SHA256>

HMAC key:    application webhook secret
Signed text: <timestamp>.<exact raw body>
Replay age:  at most 5 minutes (past or future)
```

NaJiki also sends `X-Najiki-Notification: true`; the signature and timestamp
are the authenticity checks. Kunity verifies the raw body before parsing it.

## SMS delivery notifications

NaJiki sends SMS delivery updates to the same configured webhook URL, signed
with the same application webhook secret. The current payloads use
`eventType: "SMS_DELIVERY_UPDATE"`, `smsId`, `reference`, `status` (`delivered`
or `failed`), and provider/recipient details. Kunity acknowledges delivery
updates and source-binds refunds for failed messages to the original wallet
debit. The current NaJiki SMS worker does not retry delivery-update callbacks;
refund lookup/RPC failures are logged for manual review and must be monitored.

## Retry and response behavior

NaJiki classifies most 4xx notification responses as permanent (408 and 429 are
exceptions). Kunity returns retryable 5xx responses for transient database
failures and for a payment/top-up reference that has not appeared yet; signed
amount, currency, and ledger-type mismatches remain 4xx rejections. A matching
replay of an already-processed payment is acknowledged successfully and does
not credit a second time. A contradictory terminal callback (for example, a
late failure after a successful top-up) is rejected without changing the final
payment or wallet state.

## Local contract checks

These use synthetic requests and local database stand-ins; they do not use live
credentials, production systems, or real funds:

```bash
node_modules/.bin/tsx test/najiki-contract-tests.mjs
node_modules/.bin/tsx test/money-engine-webhook-adversarial-tests.mjs
node_modules/.bin/tsx test/sms-topup-e2e-tests.mjs
```

Before production rollout, verify migration 36 is applied in the target Kunity
database, then in staging verify one ordinary deposit, one failed payment, one
`BUY_SMS` top-up, a replay, and a failed SMS delivery/refund. Confirm the
provider's configured base URL, webhook path, payment-type row, and dedicated
webhook secret first.
