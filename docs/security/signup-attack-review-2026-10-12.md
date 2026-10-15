# Sign-up and activation: attacker walkthrough (2026-10-12)

Scope: code review of the join-link sign-up, `/api/auth/profile`, `/api/organizations/resolve`,
`/api/payments/intent`, `/api/member/open-account`, `/api/member/setup`, and the activation trigger.
Method: read the code and the migrations for grants and RLS, then tested the pure rules locally
(`test/registration-guard-tests.mjs`, 10/10). No live system was tested.

## How an attacker would approach it

| # | Attack | Result | Status |
|---|--------|--------|--------|
| 1 | Write member, payment or account rows directly through the REST API with the anon/user key | Blocked. Migration 17 revokes INSERT/UPDATE/DELETE on every `kunity` table from `anon` and `authenticated`. Migration 14 added deny policies. | Closed (verify grants are live) |
| 2 | Pay the activation fee for another member, or into another SACCO | Blocked. Intent route takes the member id from the session and the SACCO from the member row. Client-supplied `organizationId` must match. | Closed |
| 3 | Pay UGX 1 to activate | Blocked. Server enforces the 5,000 minimum; trigger and RPC recheck the stored amount. | Closed |
| 4 | Forge a payment webhook to mark the fee paid | Blocked. HMAC verified, fails closed. | Closed |
| 5 | Declined applicant re-registers with a new email, pays the fee and is activated | **Was open.** Registration only checked the new user's id. | **Fixed:** refuses if National ID or phone matches a declined member of the same SACCO |
| 6 | Register with someone else's National ID so the real person is locked out, or so two members share one NIN | **Was open.** No duplicate check. | **Fixed:** refuses a National ID already used in the same SACCO |
| 7 | Active member edits National ID, DOB or gender after approval to change identity | **Was open.** Profile update accepted any change. | **Fixed:** locked unless status is `pending` |
| 8 | Mass-create accounts (and welcome SMS to arbitrary phones) from one network | **Was open.** The only limit was per user id, 20/min. | **Fixed:** 5 new registrations per IP per hour |
| 9 | Use the join code to join a different SACCO | Blocked. SACCO comes from the code alone; mismatched ids are refused. | Closed |
| 10 | Brute-force join codes | Not practical. 10 characters from a 32-character alphabet, resolve endpoint rate-limited per IP. | Closed |
| 11 | Sign up with an email you do not own, or with someone else's email | **Open, outside the repo.** Depends on Supabase "Confirm email" setting. | Needs owner action |
| 12 | Any member creates the default savings product | Low impact. It is created only when none exists. | Open, low |

## Open items and caveats

- **Email confirmation (item 11).** Check the Supabase dashboard: Authentication > Providers > Email > "Confirm email" should be ON before launch.
- **Rate limits need Redis in production.** Without `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, limits are kept per server instance and can be bypassed by hitting different instances. The registration limit depends on this.
- **Two-step sign-up.** The login is created before the member row. If the profile step fails, the person has a login with no member row. This is a reliability issue, not a security hole, but test the recovery path.
- **Shared phone numbers.** The declined-phone check will also block a new applicant who shares a phone with a declined member. Accepted trade-off; the SACCO can clear it.
- **Join link = open registration.** Anyone holding the link can apply. Regenerating the link (admin join-code route) stops new use of the old one; it does not remove applications already made.

## Tests

- `test/registration-guard-tests.mjs`: 10/10 (new).
- Regression: activation-guard 7/7, member-activation 11/11, join-code 12/12, rls 19/19, unlock-trigger 9/9, payment-rpc 36/36.
