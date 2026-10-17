# Application API key — developer-only provisioning

**Status:** enforced since 2026-10-17
**Applies to:** the tenant application API key used by `POST /api/messaging/send`

## Rule

The tenant application API key is a **developer / deployment secret**. It is never
displayed, copied or rotated from the SACCO admin portal. Admins have no way to see it,
and no way to obtain a new one.

| Surface | Behaviour |
| --- | --- |
| Admin portal → Settings | No API-key box, no Copy, no Rotate/Issue button |
| `POST /api/admin/data` | Returns no key and **no "is a key set" flag**; never queries `applications` |
| `POST /api/admin/api-key` | **Route deleted.** Any call returns 404 |
| `POST /api/messaging/send` | Unchanged — authenticates by SHA-256 digest and bills the resolved tenant |
| `public.applications.api_key` | Always `NULL`; only `api_key_hash` is populated (migration 31) |

Removing only the button would not have been enough: the endpoint itself was the
credential-issuing surface, so it was removed. Nothing in the admin UI can mint a key.

## How a key is issued or rotated now

A developer runs the CLI with a service-role key. This requires access the app itself
never has in the browser.

```bash
# 1. See which applications have a key (presence only — never the key itself)
SUPABASE_URL=https://<project>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
npm run rotate-api-key -- list

# 2. Rotate the key for one SACCO, by organization id or tenant code
SUPABASE_URL=https://<project>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
npm run rotate-api-key -- rotate --tenant ALPHA

# ...or target the application directly
SUPABASE_URL=https://<project>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
npm run rotate-api-key -- rotate --application <application-uuid>
```

The script asks for confirmation unless `--yes` is passed.

The new key is printed **once, to stdout**. It is not written to disk, not logged, not
stored in plaintext, and cannot be recovered afterwards. If it is lost, rotate again.

## Rotating a key has consequences

- The previous key stops working immediately.
- Every integrator using that key must be updated before or at the same time.
- There is no grace period and no dual-key overlap.

Coordinate rotations with the integrator. For a launch-day cutover, rotate outside
business hours and confirm the integrator has the new key before revoking expectations.

## What to tell an admin who asks

Admins do not handle this credential. If an integration needs a key set up, rotated or
revoked, that request goes to the development team; the admin's job is only to say which
SACCO (tenant code) it is for.

## Verification

`test/api-key-developer-only-tests.mjs` (14 checks) enforces all of the above:

- the admin console renders no key UI and holds no key state,
- the admin data endpoint returns neither the key nor a presence flag,
- no route under `app/api/admin` references the application key at all,
- the SMS gateway still authenticates by digest (the engine is untouched),
- the developer script generates and hashes keys identically to `lib/api-keys.ts`,
- the script never persists a key and refuses to run without a service-role key.
