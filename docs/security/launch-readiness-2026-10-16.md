# Kunity SACCO — Launch Readiness Review

**Date:** 2026-10-16
**Reviewed revision:** `6297a58` (branch `arena/016d07ac-kunity-application`) plus the working-tree fixes listed below
**Question asked:** is the application ready for operations (go-live with real member funds)?

---

## Verdict

**The application code is ready. The production deployment is not yet verified — that is the only thing standing between you and go-live.**

Everything that can be proven from a checkout has been run today and is green: 24 automated
suites (372 checks), lint, type-check, a production build, a production server boot, and a live
attack probe against the running app. Three defects were found during this review and fixed; all
three are in the deployment path, not the product surface.

What has **not** been proven is the live environment itself: no one has confirmed (from inside this
workspace) that the production Supabase project has the migrations applied, that the NaJiki
application record points at Kunity, or that a real payment round-trips. Those are the gates in the
last section and they take about 15 minutes to close.

---

## 1. What was verified today

| Evidence | Command | Result |
| --- | --- | --- |
| Financial integrity (real PostgreSQL via PGlite) | `node test/financial-tests.mjs` | 42/42 — original bugs still reproduce, all fixes hold |
| Money-engine pentest | `node test/money-engine-pentest-tests.mjs` | 27/27 |
| Money-engine adversarial (amount drift, unbacked refunds, NaN) | `node test/money-engine-adversarial-tests.mjs` | 6/6 |
| NaJiki webhook adversarial (signed-request replay, currency, debit-as-topup) | `tsx test/money-engine-webhook-adversarial-tests.mjs` | 12/12 |
| Payment RPC | `node test/payment-rpc-tests.mjs` | 36/36 |
| NaJiki API/webhook contract | `tsx test/najiki-contract-tests.mjs` | 18/18 |
| SMS top-up e2e + recording | `tsx test/sms-topup-e2e-tests.mjs`, `tsx test/sms-recording-e2e-tests.mjs` | 15/15, 6/6 |
| Messaging pentest | `node test/messaging-pentest-tests.mjs` | 26/26 |
| Payment-intent currency boundary | `tsx test/payment-intent-currency-tests.mjs` | 3/3 |
| Broadcast recipients e2e | `tsx test/broadcast-recipients-e2e-tests.mjs` | 13/13 |
| Tenant isolation / RLS / join codes / activation / products / registration guards | `node test/{rls,join-code,member-activation,products,product-rules,registration-guard,activation-guard,unlock-trigger,migrations-30-31}-tests.mjs` | 20/20, 13/13, 12/12, 23/23, 17/17, 10/10, 8/8, 10/10, 3/3 |
| 2026-10-13 pentest regressions | `tsx test/pentest-2026-10-13-tests.mjs` | 24/24 |
| Migration re-apply safety (**new today**) | `node test/migrations-reapply-tests.mjs` | 8/8 |
| Deployment health probe (**new today**) | `tsx test/health-probe-tests.mjs` | 11/11 — no secret ever appears in the response |
| Live surface attack probe (real server, mock backend) | `BASE_URL=http://127.0.0.1:3000 node test/live-surface-pentest-tests.mjs` | 10/10 — unsigned NaJiki callbacks, forged SMS-failure refunds, cookieless admin/member calls, retired routes all refused |
| Lint | `npm run lint` | clean |
| Type check | `npx tsc --noEmit` | clean |
| Production build | `npm run build` | compiled, 34/34 static pages, 28 routes (incl. `/api/health`) + proxy middleware |
| Production server | `PORT=3005 npm start` | boots, `/auth` 200, `/admin` + `/member` 307 → `/auth`, security headers present, live surface probe 10/10 |

**Total: 373 checks across 24 suites, all passing.**

Two suites could not be run in this environment and their earlier results are **repo-reported, not
reproduced today**:

- `test/attack-tests.mjs` (45 auth/financial attack replays) needs the *old* worktree at commit
  `10be16e` to run its positive controls. That commit is not present in this clone, so the suite
  cannot start here. Run it on a clone with full history before accepting money movement.
- `npm run build` fails in **this sandbox only** because `next/font` cannot reach
  `fonts.googleapis.com` (no outbound internet except GitHub/npm). A normal networked CI does not
  have this problem.

---

## 2. Defects found and fixed in this review

### R-01 — Migrations 33 and 36 could not be re-applied (deploy-path blocker)

**Severity:** operationally significant — it hits during a deploy, not in normal use.

Re-running the migration folder (a retried pipeline, a fresh environment, an operator re-running the
SQL, or a "apply everything" step) failed on both files:

```
33_payment_request_member_org_fk.sql → relation "members_org_id_id_key" already exists
36_money_engine_hardening.sql        → function process_najiki_webhook_pre_currency_hardening(...) already exists
```

Migration 33 added its unique and composite foreign keys with bare `ADD CONSTRAINT`; migration 36
renamed `kunity.process_najiki_webhook` with a bare `ALTER FUNCTION ... RENAME`. Both are correct on
a first run and both error on a second one. Because each file is wrapped in `BEGIN … COMMIT` the
failure rolls back cleanly — no partial or corrupt state — but a pipeline that treats a migration
error as fatal would stop mid-deployment, and an operator seeing red SQL would reasonably conclude
the schema is broken.

**Fix:** migration 33 now guards both constraint additions with `pg_constraint` existence checks;
migration 36 guards the rename with a `pg_proc` check and creates the wrapper with
`CREATE OR REPLACE`. The resulting schema is byte-for-byte the same on a first application.

**Regression test added:** `test/migrations-reapply-tests.mjs` applies migrations 21+ twice against a
real PostgreSQL engine and asserts that the second pass breaks nothing and leaves the hardened
objects (4-arg + 3-arg `refund_sms_wallet`, `sms_refund_debit_id`, the currency wrapper, the
migration-33 FK) in place. Verified as a positive control: with the original migrations restored the
suite fails and names both files (exit 1); with the fix it passes (exit 0).

### R-02 — Stale low-SMS-balance regression check, and no announced alert

`test/sms-notifications-tests.mjs` asserted the low-balance warning lived in `app/admin/AdminConsole.tsx`
with `role="alert"`. The notice had since moved to `app/admin/AdminOverview.tsx` (the console only
forwards an `smsLowBalance` prop), so the suite was red — the one red suite in the repository — and
the admin warning was no longer announced to assistive technology.

**Fix:** the notice in `AdminOverview.tsx` now carries `type="button"`, `role="alert"` and an
`aria-label`, and the test checks the flag's path from the API through the console into the overview
panel. Suite is green (10/10).

### R-03 — Build rewrites tracked config on every run

`next build` rewrites `tsconfig.json` (`jsx: react-jsx`, adds `.next/dev/types/**/*.ts`) and
`next-env.d.ts`. The rewritten files are committed now so a build leaves a clean working tree — this
matters on a read-only or dirty-tree-sensitive deploy pipeline. Verified `npx tsc --noEmit` still
passes with `.next/` absent.

---

### R-04 — Nothing told you whether the deployment was actually configured

**Severity:** highest operational risk found; it is the difference between a quiet
successful launch and a launch morning spent debugging a login screen.

Every Supabase client in the app falls back to a placeholder when its environment
variables are missing:

- `lib/supabase.ts`, `lib/supabase-server.ts`, `lib/supabase-middleware.ts` →
  `https://demo-placeholder.supabase.co` / `placeholder-key`
- `app/api/webhooks/najiki/route.ts` → `http://localhost:54321` / `dummy-key`

Consequence: a production deployment missing `NEXT_PUBLIC_SUPABASE_URL` (or with the
`.env.example` stubs left in place — `YOUR_SUPABASE_URL_HERE`) **boots normally, serves
the login page, returns HTTP 200 everywhere, and then fails obscurely at the moment a
real person tries to sign in.** There was no health endpoint, no startup check, and the
one component that showed setup instructions (`components/SetupRequired.tsx`) is dead
code — it is never imported or rendered anywhere.

Demonstrated during this review: with `.env.local` absent the app came up and served
`/auth` normally; nothing indicated the environment was empty except the eventual login
failure.

**Fix:** new `GET /api/health` route (`app/api/health/route.ts`).

- Reports presence **booleans only** — never a secret value, prefix, length or hash.
- Distinguishes `ok` (200) / `degraded` (503, Supabase unreachable) / `not_ready` (503,
  critical config missing), so an uptime monitor can alert on the status code directly.
- Names the specific misconfigurations that matter at launch: placeholder in use,
  missing service-role key, missing `NAJIKI_WEBHOOK_SECRET`, **webhook secret equal to the
  API key** (the legacy fallback), a webhook secret that is really an `nk_` API key,
  non-NaJiki provider, in-memory rate limiting, `ENFORCE_REDIS_RATELIMIT` off, missing
  Inngest key, missing `APP_URL`.
- Treats the `.env.example` stub values as *not configured*.
- Reaches Supabase with a single shallow `GET /auth/v1/health` (4 s timeout).
- Excluded from the proxy middleware matcher in `proxy.ts` so it answers without a
  session and without spending a Supabase `getUser()` round trip per uptime check.
- `test/mock-supabase.js` now answers `/auth/v1/health` like real Supabase, so the mock
  stops reporting a false outage.

**Regression test added:** `test/health-probe-tests.mjs` (11 checks) asserts the
not-ready path, the stub-value path, the healthy path, the degraded path, each warning,
and — explicitly — that no sentinel secret leaks into the response body under any state.

**Still open (deliberate, not changed today):** `components/SetupRequired.tsx` remains
dead code. Wiring it into the root layout would turn a misconfigured deployment into a
self-explaining screen instead of a broken login. That is a product decision and a
user-visible change, so it was left alone the day before launch — the health endpoint
covers the operational need.

---

## 3. Go-live gates — verify these before taking real money

These are environment facts, not code facts. Most can now be checked from one URL —
**`GET https://<your-origin>/api/health`** — instead of the Supabase/NaJiki dashboards.
`status: "ok"` with an empty `warnings` array means gates 1–7 below are satisfied.

| # | Gate | How to verify |
| --- | --- | --- |
| 1 | Migrations `21`, `27`, `30`–`36` (at minimum `36`) are applied in the production Supabase project | `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='kunity' and p.proname='process_najiki_webhook_pre_currency_hardening';` and check `public.refund_sms_wallet` has both a 3-arg and a 4-arg signature |
| 2 | `NAJIKI_WEBHOOK_SECRET` is the dedicated secret from NaJiki setup/rotation, **not** the API key | NaJiki application record vs. the deployed environment. The app logs an error and falls back to the API key if the dedicated secret is missing |
| 3 | NaJiki application record: active code `sacco`, base URL = Kunity's HTTPS origin (no trailing slash), webhook path `/api/webhooks/najiki` | NaJiki admin. The seed default `/api/internal/payment-completed` is **not** Kunity's route |
| 4 | `BUY_SMS` payment-type row exists for the application | NaJiki admin — the upstream seed does **not** create it; top-ups will not classify without it |
| 5 | `ENFORCE_REDIS_RATELIMIT=true` with working Upstash credentials | Deployed env; without it, rate limiting silently degrades to per-instance memory |
| 6 | `APP_URL` / `NEXT_PUBLIC_SITE_URL` set to the real origin | `/api/payments/intent` CORS allowlist; a wrong value blocks the member payment flow |
| 7 | Supabase Auth: email confirmation on, strong password policy on | Supabase dashboard |
| 8 | `sacco_wallets` seeded to each org's real mobile-money float | Withdrawals deliberately do not check float sufficiency; an unseeded float makes the books read insolvent |
| 9 | Tenant `api_key`s and any Supabase service/JWT secrets rotated if this codebase was ever public | Supabase + tenant settings |

Then, in staging, run the payment lifecycle once end to end: one ordinary deposit, one failed
payment, one `BUY_SMS` top-up, a replay of each, and one failed SMS delivery (refund). That is the
sequence the code is hardened against and the one thing automated tests cannot certify.

---

## 4. Residual risk, stated plainly

- No live payment was made and no production database was read during this review. Gates 1–9 above are the gap.
- The 45-check attack replay (`test/attack-tests.mjs`) was not reproduced here (missing old commit); its result remains as reported on 2026-10-05.
- Inngest background jobs and Upstash rate limiting were not exercised end to end — the app's SMS dispatch and reconciliation paths rely on them in production.
- NaJiki does not retry SMS delivery-update callbacks; refund lookup failures are logged for manual review only. Someone must watch that log after launch.
- No load test, no backup/PITR restore drill, no monitoring/alerting is configured in this repository.
- Withdrawals do not check float sufficiency by design (see the financial pentest notes); the operator signal is the float going negative.

## 5. Recommended in the first 24 hours

1. Take a Supabase backup/snapshot before the first real transaction, and confirm PITR is enabled.
2. Put an external uptime check on `GET https://<origin>/api/health` (it returns 200 when healthy and 503 when not), and alert on `status != "ok"` or a non-empty `warnings` array. That single check covers Supabase reachability, the service-role key, the NaJiki credentials and the rate-limit backend.
3. Add a CI job running `npm run lint`, `npx tsc --noEmit` and the PGlite suites on every push; today the only workflow is secret scanning, so a bad hotfix tomorrow would reach production unverified.
4. Reconcile once after go-live: per org, `sacco_wallets.balance` against the net cash movement in `journal_lines`, to catch any pre-migration-21 imbalance.
5. Keep `test/migrations-reapply-tests.mjs` in the deploy checklist — it is the guard against a re-applied migration folder breaking a late-night deploy.
