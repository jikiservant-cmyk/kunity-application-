# Security and financial integrity suites

## Security regression suite — live attack replay

Verifies the authentication/tenant-isolation fixes from the pre-launch pentest
(`../SECURITY_PENTEST_REPORT.md`) against the **real running app** — not mocks of the
route handlers. A fake Supabase/NaJiki backend emulates the PostgREST + GoTrue wire
protocol, and two app instances run side by side:

- `:3000` — the fixed code (attacks must fail closed, legit flows must work)
- `:3001` — the original commit `10be16e` (attacks must reproduce — positive controls)

### Running

```bash
# 0. env (both app instances must point at the mock)
cat > .env.local <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=test-anon-key
SUPABASE_SERVICE_ROLE_KEY=test-service-key
APP_URL=http://localhost:3000
NAJIKI_API_URL=http://127.0.0.1:54321
PAYMENT_PROVIDER_TYPE=najiki
EOF

# 1. mock backend
node test/mock-supabase.js &

# 2. fixed code
npx next dev -p 3000 -H 0.0.0.0 &

# 3. original code (positive controls)
git worktree add ../kunity-orig 10be16e
ln -s "$PWD/node_modules" ../kunity-orig/node_modules
cp .env.local ../kunity-orig/.env.local
(cd ../kunity-orig && npx next dev -p 3001 -H 0.0.0.0) &

# 4. run the suite (45 checks: 37 auth + 8 financial attacks)
node test/attack-tests.mjs
```

### Fixtures (see `mock-supabase.js`)

| Token | Simulates |
|---|---|
| `token-admin-a` | sacco_admin of Sacco Alpha whose `user_metadata` is **poisoned** client-side (`tenant_id` = victim org, `role` = `super_admin`) — the KUN-01 attacker |
| `token-admin-null` | sacco_admin with NULL tenant binding who **pre-registered as a PENDING member** of the victim org |
| `token-admin-founder` | sacco_admin with NULL tenant who owns Sacco Alpha AND pre-registered in the victim org (tests fallback ordering) |
| `token-admin-active` | sacco_admin with NULL tenant whose membership in the victim org was **approved** (legit onboarding) |
| `token-member-b` | plain member of Sacco Bravo (the victim org) |
| `token-super` | platform `super_admin` (global admin) |
| `token-viewer` | user with an `admin_profiles` row of role `viewer` (low privilege) |

The mock exposes `GET /_test/state` and `POST /_test/reset` for assertions on database
side effects (e.g. whether the authoritative `admin_profiles.tenant_id` was rewritten,
which RPCs ran, what was inserted).

---

## Financial integrity suite — real PostgreSQL

`financial-tests.mjs` runs the **actual SQL migrations** against a real
PostgreSQL 17 engine ([PGlite](https://pglite.dev) — Postgres compiled to WASM,
no Docker needed) and proves both halves of the financial-integrity work:

- **Phase 1 (16 checks)** — applies the ORIGINAL financial RPC migrations
  (`02, 03, 09_credit, 10_debit, 15, 16, 18`) and reproduces every bug
  FIN-01 … FIN-19 live: broken repayment SQL, amount-drift acceptance, vanishing
  activation money, unbalanced journals, negative SMS wallets, dead wallet RPCs,
  cross-wallet credits, …
- **Phase 3 (4 checks)** — applies `supabase/migrations/22_repayment_paid_to_date_fix.sql`
  and verifies loan repayments count interest toward the loan total (an
  interest-only tail completes the loan; over-payment is rejected).
- **Phase 2 (22 checks)** — applies `supabase/migrations/21_financial_integrity.sql`
  and verifies every fix: balanced double-entry journals, float maintained on
  EXTERNAL cash movements only (loans are internal transfers via the receivable
  account), member balances credited, drift/currency fail-closed, unknown payment
  types held, idempotent replays, eligibility + funds checks, org accounts never
  resolving to member wallets, and schema-type agnosticism (enum/text status
  columns, uuid/text wallet ids).

### Running

```bash
npm install --no-save @electric-sql/pglite   # once; not a runtime dependency
node test/financial-tests.mjs
```

No `.env.local`, mock, or app server needed — everything is in-database.
`financial-base-schema.sql` is a minimal reconstruction of the tables the RPCs
touch (kunity + public schemas); it is deliberately missing `kunity.loan_repayments`
so the original repayment bug reproduces exactly as it would on a fresh environment.

Exit code is non-zero if any check fails, so it can be wired into CI.

---

## Migration re-apply (idempotency) suite

Answers an operational question rather than a product one: *can the migration folder be applied
twice?* Applies migrations `21`+ to a real PostgreSQL engine (PGlite) two times and fails if the
second pass breaks anything the first pass survived — the class of bug that fires when a deploy
pipeline retries, an operator re-runs the SQL, or a fresh environment is provisioned from the same
folder.

```bash
node test/migrations-reapply-tests.mjs   # expected: 8/8 checks passed
```

It also asserts the hardened objects survive the double apply: the 4-arg and rolling 3-arg
`refund_sms_wallet` signatures, `wallet_transactions.sms_refund_debit_id`, the currency-normalizing
`kunity.process_najiki_webhook` wrapper delegating to
`process_najiki_webhook_pre_currency_hardening`, and the migration-33 payment-request/member
composite foreign key.

Migrations `23`, `29` and `31` cannot run on the minimal pentest harness because it deliberately
omits `public.admin_profiles`, the `auth` schema and `public.applications`. They are listed in
`HARNESS_BASELINE` inside the suite and are checked for *unchanged* failures across both passes,
not for success; judge them against a real Supabase project.

---

## Application API key — developer-only

The tenant application API key is the bearer credential for `POST /api/messaging/send`.
It is never shown or rotatable in the admin portal; the admin route was removed and the
data endpoint no longer returns the key or even a presence flag. Provisioning is out of
band with `npm run rotate-api-key -- ...` (see `docs/security/api-key-provisioning.md`).

```bash
node test/api-key-developer-only-tests.mjs   # expected: 14/14 checks passed
```

The suite covers the whole surface (UI state, admin routes, data payload, gateway digest
auth) and asserts the developer CLI hashes identically to `lib/api-keys.ts` and never
persists a key.

## SMS purchase parity (admin ↔ member)

The admin SMS checkout is a value-for-value copy of the member portal's **deposit**
sheet (`app/member/page.tsx`, `activeModal === 'deposit'`): same cream surface, 36px
top radius, 52×42 tile with serif heading, phone field with icon, 2×2 selectable grid,
dark CONFIRM & PAY, CANCEL and the circle-i info line — followed by the same immersive
pending → success → failed PIN overlay. Only the labels and the bundle content differ.
These checks assert the shared colours and metrics against the member sheet itself, so
the two flows cannot drift apart, and assert the displayed bundle prices against the
server list in `lib/sms-packs.ts` (the API re-derives the price from the credit count,
so a mismatch would show one price and charge another).

```bash
node test/sms-purchase-parity-tests.mjs   # expected: 15/15 checks passed
```

## Deployment health probe

`app/api/health/route.ts` answers "is this deployment actually wired up?" in one request.
It exists because every Supabase client in the app falls back to
`https://demo-placeholder.supabase.co` when its env vars are missing, so a half-configured
production deployment boots normally, serves the login page, and only fails when someone
tries to sign in.

```bash
node_modules/.bin/tsx test/health-probe-tests.mjs   # expected: 11 passed
curl -s https://<your-origin>/api/health            # 200 ok / 503 degraded / 503 not_ready
```

The probe returns presence **booleans only** — never a secret value, prefix or hash — and
names the misconfigurations that matter at launch (placeholder credentials, missing
service-role key, missing `NAJIKI_WEBHOOK_SECRET`, webhook secret equal to the API key,
in-memory rate limiting, missing Inngest key, missing `APP_URL`). The suite asserts that no
sentinel secret leaks into the body in any state.

---

## Money-engine security checks

These target the SMS wallet and NaJiki money paths and complement the broader
financial regression suite. They run locally and do not use a production database,
provider credentials, or live funds.

```bash
# Positive/security regression checks. Expected: 27 passed.
node test/money-engine-pentest-tests.mjs

# Integration and currency-boundary checks. Requires tsx as a dev/test tool.
node_modules/.bin/tsx test/najiki-contract-tests.mjs
node_modules/.bin/tsx test/sms-topup-e2e-tests.mjs
node_modules/.bin/tsx test/sms-recording-e2e-tests.mjs
node_modules/.bin/tsx test/payment-intent-currency-tests.mjs

# Adversarial regression checks; former exploit cases must now be refused.
node test/money-engine-adversarial-tests.mjs
node_modules/.bin/tsx test/money-engine-webhook-adversarial-tests.mjs

# Admin SMS purchase against a simulator transcribed from the real NaJiki
# source (create-payment rules, webhook envelope, status endpoint).
# Expected: 29 checks passed.
node_modules/.bin/tsx test/sms-purchase-najiki-live-contract-tests.mjs

# Penetration test of the SMS purchase path: forged/replayed webhooks,
# cross-tenant confirm attacks, rogue-gateway payloads, races, SQL depth,
# and purchase rate limiting. Expected: 55 checks passed.
node_modules/.bin/tsx test/sms-purchase-pentest-tests.mjs
```

Both SMS purchase suites share `lib/sms-purchase-harness.mjs` (PGlite +
migrations 21–37, NaJiki simulator, Supabase REST/RPC stand-in). See
`../docs/security/sms-purchase-najiki-verification-2026-10-17.md` and
`../docs/security/sms-purchase-pentest-2026-10-17.md`.

The NaJiki contract suite runs the real top-up, confirm and webhook handlers
against PGlite with migrations 21–37. It reproduces the two consequences of a
NaJiki deployment without a `BUY_SMS` payment type (refused when the SACCO has no
tenant credentials; silently booked as a tenant collection when it does), then
verifies the full purchase, signed success, retry, failure, signature/replay
rejections, amount/currency/tenant guards, the create-response race, and the
dashboard's confirm poll. See
`../docs/security/sms-purchase-najiki-verification-2026-10-17.md`.

The SQL adversarial suite applies the actual migrations in PGlite and verifies
amount drift, wrong transaction direction, unbacked/duplicate refunds, nested
currency mismatch, and `numeric NaN` are rejected without changing balances or
ledger state. The webhook suite calls the real Next.js handler with synthetic
valid HMACs and routes Supabase REST/RPC calls to a local PGlite-backed stand-in.
It checks that foreign-currency deposits/top-ups, debit rows masquerading as
SMS top-ups, malformed amounts, and missing top-up ledger rows are rejected,
while a valid UGX top-up credits exactly once.

These are post-remediation regression tests: exit code 0 means unsafe behavior
was blocked and the positive control worked. They do not certify production
configuration or replace a staging payment-provider test.
