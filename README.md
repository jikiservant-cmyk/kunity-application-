# Kunity SACCO Operating System

A multi-tenant Savings and Credit Cooperative (SACCO) management platform built with Next.js 14/15, Tailwind CSS, Supabase (PostgreSQL), and integrated with the NaJiki mobile money and SMS gateway.

## Architecture & Multi-Tenancy

Kunity is designed from the ground up for multi-tenant isolation:
- **Tenant Isolation**: Each SACCO is an organization entity (`kunity.organizations`). Admin actions (loan approvals, member verifications, SMS broadcasts) are strictly scoped and verified against the caller's authorized tenant organization.
- **Double-Entry Ledger**: Member account deposits, withdrawals, and loan disbursements are recorded in `kunity.journal_entries` and `kunity.journal_lines`.
- **Atomic Balance Updates & OCC**: Financial balance mutations leverage optimistic concurrency control (OCC) and conditional SQL updates to prevent lost updates, double-spending, and replay attacks.
- **Rate Limiting**: Critical money-moving and administrative endpoints are protected by distributed rate limiters (backed by Upstash Redis with in-memory LRU fallback).
- **Fail-Closed Webhook Signatures**: Payment webhooks enforce HMAC-SHA256 signature verification with fail-closed security in production.

---

## Getting Started

### Prerequisites

- Node.js (v18 or v20+)
- npm or yarn
- A Supabase project with the Kunity schema migrations applied

### 1. Installation

```bash
npm install
```

### 2. Environment Variables Configuration

Copy `.env.example` to `.env.local` and configure the required credentials:

```bash
cp .env.example .env.local
```

#### Required Environment Variables

| Variable | Description |
| :--- | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL (`https://xyz.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable anonymous key for client auth |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role secret key (server-side only, bypasses RLS for trusted admin operations) |
| `GEMINI_API_KEY` | Google Gemini AI API key for intelligence and assistant features |
| `LIVEPAY_API_KEY` | LivePay payment gateway public API key |
| `LIVEPAY_SECRET_KEY` | LivePay HMAC webhook signing secret (required for webhook validation) |
| `LIVEPAY_ACCOUNT_NUMBER` | LivePay merchant / collector account number |
| `NAJIKI_API_URL` | Origin of your running NaJiki deployment (no trailing slash, no `/api` suffix). Read from the environment at runtime — never hardcoded. No built-in default: a missing value fails closed before any payment is attempted. |
| `NAJIKI_API_KEY` | Bearer API key for NaJiki payment/status and SMS dispatch requests |
| `NAJIKI_APPLICATION_CODE` | Exact registered application code; the current NaJiki seed uses `sacco` |
| `NAJIKI_WEBHOOK_SECRET` | Dedicated webhook secret returned once by current NaJiki setup/rotation; required for matching signed callbacks. Only legacy NaJiki application rows without a separate secret use the API-key fallback. |

#### Optional / Recommended Integrations

| Variable | Description |
| :--- | :--- |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL for distributed multi-instance rate limiting |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `ALLOW_INSECURE_WEBHOOKS` | Set to `"false"` in production. Set to `"true"` only for isolated local testing without HMAC signatures. |

For the exact NaJiki API/webhook contract, callback URL configuration, dedicated signing secret, `BUY_SMS` payment-type requirement, and staging checklist, see [`docs/integrations/najiki-webhooks.md`](docs/integrations/najiki-webhooks.md).

### 3. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Security Best Practices

1. **Never expose provider or database secrets on the client.** This includes `SUPABASE_SERVICE_ROLE_KEY`, `NAJIKI_API_KEY`, `NAJIKI_WEBHOOK_SECRET`, and any legacy LivePay secret. Financial actions and webhook handlers run server-side in `app/api/*`.
2. **Strict RBAC**: Admin actions require roles in `sacco_admin`, `super_admin`, `system_admin`, or `admin`.
3. **Cross-Tenant Guard**: Admins cannot approve loans or members outside their assigned tenant unless possessing global `super_admin` privileges.
4. **Idempotency & Replay Protection**: Loan disbursements check for `pending` status and perform atomic check-and-set updates before crediting balances.
