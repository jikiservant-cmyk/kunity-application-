# Kunity SACCO — Authentication & Authorization Penetration Test Report

**Date:** 2026-10-05
**Scope:** Authentication integrity, session handling, authorization (RBAC + multi-tenant isolation), CSRF, rate limiting, and webhook integrity across the Next.js application and Supabase database layer.
**Context:** Pre-launch review — application goes live with real customer funds.

---

## Executive Summary

The review identified **3 CRITICAL, 3 HIGH, and 6 MEDIUM** findings. The most severe was a **complete cross-tenant takeover chain** available to any tenant-scoped administrator (V1), plus the ability of **suspended members to keep moving money** (V2) and a **working CSRF attack against member wallets** (V3). All findings have been remediated in this branch. One database migration (`21_auth_integrity_hardening.sql`) **must be applied to the live Supabase project before launch**, and the operational checklist at the bottom must be completed in the Supabase dashboard (those settings cannot be changed in code).

---

## Findings & Remediations

### 🔴 V1 (CRITICAL) — Cross-tenant admin escalation via client-writable `user_metadata`
**Where:** `app/api/admin/data/route.ts`
**Attack chain:**
1. Supabase lets any authenticated user overwrite their own `user_metadata` via `supabase.auth.updateUser()`.
2. The old tenant-resolution logic consulted `user.user_metadata.tenant_id` as a tenant source — *after* the `members` table but *before* `admin_profiles`.
3. A tenant admin with no `members` row could therefore re-bind their console session to **any SACCO tenant**.
4. Worse: the route then **persisted the forged tenant into `admin_profiles.tenant_id`** (and user metadata). Since every other admin endpoint (`/api/admin/loans`, `/api/admin/members`, `/api/admin/sms/send`) authorizes against `admin_profiles.tenant_id` via `verifyAdminAndTenant()`, this single call escalated a rogue tenant admin to **full operational control of a foreign SACCO's members, loans, and SMS broadcasts** — with the audit trail attributing it to the legitimate tenant.

**Fix applied:**
- Tenant resolution now uses **server-authoritative sources only**: `admin_profiles.tenant_id` → `members.organization_id` → `organizations.created_by`; `user_metadata` is never consulted.
- The auto-persist of tenant bindings was **removed entirely** from this read endpoint.
- Added per-admin rate limiting (60/min) and Bearer-header-only auth.

### 🔴 V2 (CRITICAL) — Suspended/pending members can move money
**Where:** `app/api/member/transactions/route.ts` + `kunity.member_withdraw_atomic / member_repay_loan_atomic / member_apply_loan` (migration 16)
**Attack:** A member whose status is `pending`, `rejected`, or `suspended` (the admin's only fraud-control lever) could withdraw wallet funds, apply for loans, and repay loans without restriction — neither the route nor the RPCs checked `members.status`. Withdrawals also worked against **frozen/inactive accounts**.

**Fix applied:**
- Route now requires `member.status === 'active'` (403 otherwise) and validates UUID formats.
- **New migration `supabase/migrations/21_auth_integrity_hardening.sql`** replaces the three RPCs with hardened versions enforcing member status (and `accounts.is_active` for withdraw/repay) inside the database — defense in depth that holds even if an app-layer guard is bypassed. **Run it on the live database before launch.**

### 🔴 V3 (CRITICAL) — CSRF against member money endpoints
**Where:** `app/api/member/transactions`, `/api/member/setup`, `/api/member/open-account`
**Attack:** Session cookies are `SameSite=None` (required for iframe embedding), so browsers attach them to cross-site requests. Combined with `req.json()` parsing bodies regardless of `Content-Type`, a malicious webpage could fire `fetch('https://app/api/member/transactions', { method:'POST', mode:'no-cors', credentials:'include', headers:{'Content-Type':'text/plain'}, body: JSON.stringify({action:'loan', amount:5000000}) })` while a member is logged in — no CORS preflight is triggered, cookies ride along, and the JSON parses fine. Loan applications, repayments, and (with a known `accountId`) withdrawals were all reachable.

**Fix applied:**
- New `lib/request-guard.ts` `isSameOriginRequest()` enforces `Origin`/`Sec-Fetch-Site` verification on every cookie-authenticated state-changing endpoint (fail-closed when both headers are absent).
- Verified live: cross-site origins, missing headers, and `Sec-Fetch-Site: cross-site` are all rejected; same-origin traffic passes.

### 🟠 V4 (HIGH) — Missing role check on SMS wallet crediting
**Where:** `app/api/admin/sms/topup/confirm/route.ts`
**Attack:** The endpoint only checked that *any* `admin_profiles` row existed for the caller — no role check. Any authenticated user with a profile row (any role, including `member`) could drive the wallet-credit confirmation flow for a tenant. There was also no rate limit and the token was accepted from the request body.

**Fix applied:** Full `verifyAdminAndTenant()` (role + tenant binding), rate limit (15/min), Bearer-header-only auth.

### 🟠 V5 (HIGH) — Cross-tenant savings-product injection
**Where:** `app/api/member/open-account/route.ts`
**Attack:** `productId` was never validated against the caller's organization — a member could attach a savings account to a product belonging to a **different SACCO**, polluting foreign-tenant data.

**Fix applied:** Product must exist **and** belong to the caller's organization (and be active); UUID format validation; rejected/suspended members blocked; CSRF guard + rate limit added.

### 🟠 V6 (HIGH) — Missing rate limits on money/account endpoints
**Where:** `/api/member/transactions`, `/api/member/setup`, `/api/member/open-account`, `/api/admin/data`, `/api/admin/sms/topup/confirm`
**Fix applied:** New limiters — member transactions 10/min, member account ops 20/min, admin console 60/min, topup confirm 15/min. Existing limiters were retained. (Production note: configure Upstash Redis so limits are enforced cluster-wide; set `ENFORCE_REDIS_RATELIMIT=true` to fail closed if Redis is down.)

### 🟡 V7 (MEDIUM) — Public org enumeration exposes inactive SACCOs
**Where:** `app/api/organizations/route.ts` (unauthenticated)
**Fix applied:** Only `is_active = true` organizations are returned.

### 🟡 V8 (MEDIUM) — Session tokens transmitted in request bodies
**Where:** All admin routes + `AdminConsole.tsx`
**Risk:** Live Supabase access tokens were posted as JSON body fields (`token`), which routinely leak into request logs, APM traces, and proxy logs.
**Fix applied:** Tokens now travel **only** in the `Authorization: Bearer` header; every admin route rejects body-borne tokens; `AdminConsole` updated to send the header. (`/api/auth/profile` retains its body-token fallback only because signup runs before cookies are reliably set — the token is still cryptographically verified server-side.)

### 🟡 V9 (MEDIUM) — CORS preflight reflected arbitrary origins
**Where:** `app/api/payments/intent/route.ts`
**Fix applied:** CORS is now restricted to the configured `NEXT_PUBLIC_SITE_URL` only (no Origin reflection). Also added strict amount validation (`validateAmount`) for payment intents.

### 🟡 V10 (MEDIUM) — Client-trusted role metadata + inconsistent role lists
**Where:** `app/auth/page.tsx`, `app/admin/*`, middleware
**Risk:** The login page redirected based on `user_metadata.role` (client-writable at signup), and the string `'admin'` was treated as elevated in some checks but not others (middleware/server rejected it while the client accepted it).
**Fix applied:** New single source of truth `lib/roles.ts` (`ELEVATED_ADMIN_ROLES = ['sacco_admin','system_admin','super_admin']`, `GLOBAL_ADMIN_ROLES = ['system_admin','super_admin']`) used by middleware, the login page, and every API route. The login page now resolves the role **only** from `admin_profiles` (failing safe to member), and signup no longer writes a `role` claim into user metadata at all.

### 🟡 V11 (MEDIUM) — No password strength policy
**Where:** `app/auth/page.tsx`
**Fix applied:** Client-side policy: minimum 8 characters with letters and digits. **Action required (dashboard):** Supabase Auth → set minimum password length ≥ 8 and enable CAPTCHA + built-in rate limits (see checklist).

### 🟡 V12 (MEDIUM) — Misc hardening
- `app/api/payments/[intentId]/route.ts`: replaced a fragile CommonJS `require()` with a proper import (route now type-checks strictly).
- `next.config.mjs`: added `Strict-Transport-Security` and `Permissions-Policy` headers (nosniff/referrer policy already present). `X-Frame-Options` deliberately not set — the app is designed for iframe embedding.

### 🟠 V13 (HIGH) — Middleware redirected API calls to the HTML login page
**Where:** `lib/supabase-middleware.ts`, `middleware.ts`
**Impact:** `supabase-js` reports a missing session as HTTP status **400**, which matched the middleware's "redirect to /auth" condition. Consequently every cookieless request to a non-excluded path received a **307 redirect to the HTML login page** instead of reaching its handler:
- The **public `/api/organizations` registration dropdown** (used by logged-out visitors signing up) followed the redirect and received HTML instead of JSON.
- The **`/api/inngest` background-job endpoint** (called by Inngest Cloud with signed payloads and no cookies) was redirected, breaking SMS dispatch/reconciliation jobs whenever Inngest is configured.
- Cookie-authenticated member APIs returned HTML-followed redirects instead of proper 401s on expired sessions, degrading the client's error handling.

**Fix applied:**
- Middleware is now API-aware: API requests carrying an `Authorization` header are passed through untouched (routes cryptographically verify Bearer sessions / gateway API keys themselves); anonymous/expired API requests receive a **401 JSON** (with stale `sb-*` cookies cleared) instead of a login-page redirect. Page routes keep the redirect behavior.
- `api/organizations` and `api/inngest` added to the middleware matcher exclusions (public/callback-style endpoints that must never depend on a session).

### 🟠 V14 (HIGH) — Admin console regression: two calls still sent tokens in request bodies
**Where:** `app/admin/AdminConsole.tsx`
**Impact:** During the V8 remediation, the `/api/admin/data` and `/api/admin/loans` fetch calls were not actually converted (a silent edit failure) while their server routes had already switched to Bearer-header-only auth. The admin console would have failed to load tenant data and loan approvals would have been rejected with 401 at launch. All five admin fetch calls have been re-verified to send `Authorization: Bearer` headers with no token in the JSON body.

### 🟡 V15 (MEDIUM) — Dead demo route & misleading webhook docs
- Removed the leftover demo endpoint `/api/example-transaction` (unauthenticated stub in a production money app).
- Cleaned the unreachable "skip signature verification (DEV ONLY)" branch from the LivePay webhook verifier — signature enforcement is now unconditionally fail-closed — and removed the misleading `ALLOW_INSECURE_WEBHOOKS` entry from the README (no code ever read it; there is no insecure mode).

---

## What was verified and found SOLID ✅

- **Webhook signature verification** (LivePay & NaJiki): HMAC-SHA256 with `crypto.timingSafeEqual`, fail-closed when secrets are unconfigured. No replay window found (RPCs are idempotent/status-gated).
- **Inngest endpoint**: served via the official SDK, which enforces the signing key in production mode.
- **RLS lockdown** (`00_EMERGENCY_LOCKDOWN_FINAL.sql` + migrations): deny-by-default table grants, self-read-only policies for `members`/`payment_requests`/`admin_profiles`, `SECURITY DEFINER` functions pinned to a safe `search_path`, sensitive RPCs restricted to `service_role`.
- **Money-movement RPC integrity**: `FOR UPDATE` row locks, balance checks, atomic loan disbursement (`disburse_loan_atomic`), and idempotent SMS wallet crediting.
- **IDOR protections**: payment-intent status route verifies `member_id` ownership; `/api/auth/profile` binds all writes to the cryptographically verified caller and forbids cross-tenant migration.
- **Admin tenant isolation** in `/api/admin/loans`, `/api/admin/members`, `/api/admin/sms/send` (via `verifyAdminAndTenant` + `assertTenantMatch`) — sound once V1's tenant-binding poisoning was fixed.
- **Middleware route protection**: authoritative role from `admin_profiles` via service role, fail-closed to `member` on lookup failure.

---

## ⚠️ PRE-LAUNCH CHECKLIST (cannot be done in code — do these in the Supabase dashboard)

1. **Apply migration** `supabase/migrations/21_auth_integrity_hardening.sql` to the live database.
2. **Supabase Auth settings:**
   - Minimum password length: **≥ 8** (confirm "Leaked password protection" is ON).
   - Enable **CAPTCHA** (e.g. hCaptcha) on sign-in/sign-up — blocks credential stuffing at scale.
   - Confirm **email confirmation** is required for new signups.
   - Review auth rate limits (Supabase leaky-bucket defaults are usually adequate).
3. **Secrets rotation:** confirm `SUPABASE_SERVICE_ROLE_KEY`, `LIVEPAY_SECRET_KEY`, `NAJIKI_API_KEY`, `INNGEST_SIGNING_KEY`, `AFRICASTALKING_API_KEY` exist only as server env vars and were never committed.
4. **Rate limiting:** configure `UPSTASH_REDIS_REST_URL/TOKEN` and set `ENFORCE_REDIS_RATELIMIT=true` in production so limits fail closed.
5. **Admin inventory:** review `public.admin_profiles` — every row with an elevated role should be a person you know; verify `tenant_id` bindings are correct (V1 may have poisoned bindings before this fix — **re-verify each admin's tenant_id manually**).
6. **Blast-radius test before go-live:** from a throwaway member account, attempt (a) a POST to `/api/member/transactions` from an off-origin page/console (expect 403), (b) `supabase.auth.updateUser({data:{tenant_id: otherOrg}})` then load the admin console (expect no tenant change), (c) a suspended-member withdrawal (expect 403 / RPC exception).

---

## Changed files

| File | Change |
|---|---|
| `lib/roles.ts` *(new)* | Single source of truth for RBAC role constants |
| `lib/request-guard.ts` *(new)* | CSRF/origin guard, Bearer extraction, UUID validation |
| `supabase/migrations/21_auth_integrity_hardening.sql` *(new)* | DB-side member-status enforcement in money RPCs |
| `app/api/admin/data/route.ts` | V1 fix: authoritative tenant resolution, no metadata writes, rate limit, Bearer-only |
| `app/api/admin/sms/topup/confirm/route.ts` | V4 fix: full admin verification + rate limit |
| `app/api/admin/{loans,members,sms/send,sms/topup,sms/templates}/route.ts` | Bearer-only auth, shared role constants |
| `app/api/member/transactions/route.ts` | V2+V3+V6 fix: active-status gate, CSRF guard, rate limit, amount/UUID validation |
| `app/api/member/{setup,open-account}/route.ts` | V3+V5+V6 fix: CSRF guard, status gate, product-tenant validation, rate limits |
| `app/api/organizations/route.ts` | V7 fix: active orgs only |
| `app/api/payments/intent/route.ts` | V9 fix: fixed-origin CORS, amount validation |
| `app/api/payments/[intentId]/route.ts` | V12 fix: proper import, strict types |
| `app/api/example-transaction/` *(removed)* | V15 fix: dead unauthenticated demo route deleted |
| `app/api/webhooks/livepay/route.ts` | V15 fix: dead insecure-bypass branch removed (always fail-closed) |
| `app/auth/page.tsx` | V10+V11 fix: DB-authoritative role, password policy, no role claim in metadata |
| `app/admin/AdminConsole.tsx` | V8+V14 fix: Bearer-header auth for all 5 admin API calls (re-verified) |
| `lib/admin-auth.ts`, `lib/supabase-middleware.ts`, `middleware.ts` | Shared role constants; V13 fix: API-aware 401 JSON instead of login redirects; matcher excludes public endpoints |
| `lib/rate-limit.ts` | 4 new limiters |
| `next.config.mjs` | HSTS + Permissions-Policy headers |
