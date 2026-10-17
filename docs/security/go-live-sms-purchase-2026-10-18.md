# Go-live runbook — SMS purchase with real money (2026-10-18)

**Verdict from the verification + pentest work (this branch, tip `6502c26`):**
the code path is ready. Every failure mode that used to lose or mis-route money
silently now fails loudly and before money moves. What is NOT yet proven is the
live provider leg (PIN prompt → real callback timing), so the final step of this
runbook is a small controlled live test before general availability.

## Order matters — do not skip steps

### 1. Database first (code depends on it)
- Apply Supabase migrations through **`37_sms_topup_payment_request_member_nullable.sql`**.
- Without 37, every successful purchase throws silently on the reporting row
  (`payment_requests.member_id NOT NULL`) — credits still work, payment history
  is empty. Not fatal, but ship it.
- Confirm: `select count(*) from kunity.payment_requests;` runs without error
  and `member_id` is nullable.

### 2. NaJiki configuration (the only thing that can mis-bill)
Pick ONE:
- **(Preferred)** Apply `docs/security/najiki-buy-sms-hardening.patch` to
  `najiki-finance2`, deploy it, re-seed. Fresh install then needs nothing else:
  `BUY_SMS` is registered and the sacco webhook path is correct.
- **(Manual, unpatched NaJiki)** In NaJiki as super-admin:
  1. `POST /api/setup` `{type:"paymentType", data:{applicationId:<sacco app id>, code:"BUY_SMS", description:"SMS credits top-up"}}`
  2. `POST /api/setup` `{type:"updateApplication", data:{id:<sacco app id>, baseUrl:"https://<kunity-origin>", webhookPath:"/api/webhooks/najiki"}}`
- Create/confirm the NaJiki tenant whose `code` matches Kunity's
  `public.tenants.code` for the live SACCO.
- The sacco application's `webhookSecret` must equal Kunity's
  `NAJIKI_WEBHOOK_SECRET` exactly (one-time value, shown at creation).

**Reality check on an unpatched NaJiki:** even if step 1 is forgotten, Kunity
now refuses the purchase loudly (502 explaining to register `BUY_SMS`) — no
silent mis-billing. If an admin already approved a prompt, the webhook still
credits the wallet. Verified by the live-contract suite (31/31).

### 3. Kunity production environment
| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✓ | |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | server-only |
| `NAJIKI_API_URL` | ✓ | real NaJiki origin (no trailing path games — `normalizeNajikiBaseUrl` handles slashes) |
| `NAJIKI_API_KEY` | ✓ | the sacco application's API key |
| `NAJIKI_WEBHOOK_SECRET` | ✓ | must equal the NaJiki application's webhook secret |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | strongly advised | without it rate limits are per-instance memory |
| `ENFORCE_REDIS_RATELIMIT` | `true` in prod | fail-closed limiter mode already implemented |

### 4. Deploy code, then health-check
- `GET /api/health` → `{ "status": "ok" }`.
- Watch webhook logs on boot: any `NAJIKI_WEBHOOK_SECRET is not configured`
  error line = fix env before continuing.

### 5. Controlled live smoke test (one real purchase)
1. As the live SACCO admin, top up **UGX 10,000** to a phone you control. The sheet
   converts the amount to SMS at the SACCO's DB-stored `public.wallets.sms_rate`
   (200 SMS at the default UGX 50/SMS; always read the count and charge shown by the
   app before approving).
2. Approve the PIN prompt.
3. Within ~30 s the dashboard confirm poll should show success. Verify:
   - SMS wallet balance +10,000 (200 credits),
   - `kunity.payment_requests` row `status='success'`, `payment_type='BUY_SMS'`,
   - audit log has `create_sms_topup_intent` and `sms_topup_confirm`,
   - NaJiki dashboard shows the payment **as a platform fee** (platform
     provider, not a tenant collection).
4. Decline (or let expire) a second prompt: verify balance unchanged and the
   row marked `failed` (or still pending until NaJiki reports).
5. If anything in 1–4 deviates: **stop**, the pentest/contract suites and the
   two dated reports in `docs/security/` identify the layer that lies.

### 6. Day-1 monitoring
- Grep logs for: `SMS top-up tenant mismatch`, `Amount mismatch`,
  `Could not record SMS payment status`, `was not accepted as an SMS purchase`.
- Reconciliation move: pending ledger rows older than ~15 min with no matching
  NaJiki intent = investigate (usually a declined prompt — normal — anything
  else is not).
- The NaJiki application webhook deliveries should be ≤ a handful of retries;
  permanent 4xx storms = signature/secret mismatch.

## Known residual risks (do not block go-live; queue for hardening)
- Signed-but-invalid `fee` (> amount) is permanently rejected; NaJiki never
  sends this today. Reconciles manually if it ever appears.
- Webhook SMS routing relies on NaJiki echoing `metadata.paymentTypeCode`
  (verified @6d55d75). If NaJiki ever stops echoing metadata, SMS callbacks
  route down the deposit path (no credit). A ledger-type fallback is the next
  defensive patch.
- Rate limits are per-instance without Upstash — step 3 closes that.

## Confidence record (all green at `6502c26`)
31/31 live NaJiki contract · 55/55 pentest · 15/15 e2e · 17/17 parity ·
18/18 contract · 12/12 webhook adversarial · 6/6 money-engine adversarial ·
36/36 payment-RPC · 42 financial · 26 messaging pentest · `tsc`/`eslint` clean.
