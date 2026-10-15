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
```

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
