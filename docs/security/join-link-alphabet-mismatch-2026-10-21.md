# Join links were dead on arrival: DB/validator alphabet mismatch (2026-10-21)

Scope: the join-link sign-up path end to end — `supabase/migrations/24_sacco_join_codes.sql`,
`lib/join-code.ts`, `/api/organizations/resolve`, `/api/auth/profile`, `/api/admin/join-code`,
and the join-code test suites. Method: code review plus a simulation of the SQL generator
against the app validator (10,000 draws). No live system was tested.
Revised after DB dev review the same day (strict alphabet kept; alias preservation added;
migration ordering/NOT NULL/uniformity corrected).

## What was broken

Every SACCO's `join_code` is minted in SQL (migration 24 backfill + column DEFAULT):

```sql
upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))   -- alphabet 0-9A-F (UUID hex)
```

The app resolves links only through `normalizeJoinCode()` (`lib/join-code.ts`), which accepts
`^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$` — a 31-char alphabet that deliberately excludes
`0`, `1`, `I`, `L`, `O` (look-alike protection). Any code containing `0` or `1` returns `null`
and the resolve endpoint answers **"This join link is not valid"**, killing registration —
even though the code was the SACCO's real `join_code` in the database.

- **~74% of DB-minted links were dead** (simulated: 7,358/10,000 rejected; live draws in the
  regression test: 138–154/200 rejected).
- The admin console "Get" button surfaces the raw DB code, so admins routinely copied and
  shared broken links. Only "Regenerate" (`generateJoinCode()`, the clean alphabet) produced
  working codes.
- `test/join-code-tests.mjs` passed 12/12 while links were broken: it queried codes with raw
  SQL and never fed a DB-generated code through `normalizeJoinCode`. No test imported
  `normalizeJoinCode` at all. The signup review of 2026-10-12 (item 10) therefore called the
  join-link path closed; it was not.

## Design decision: keep the strict alphabet, preserve shared links via aliases

Review confirmed the strict alphabet stays: loosening the resolver to accept hex codes would
preserve the mismatch and the look-alike risk. But replacing invalid codes alone would leave
already-shared links dead forever. Migration 38 therefore snapshots every code it replaces
into `kunity.join_code_aliases` (legacy code -> organization) BEFORE replacing it. The alias
table is a **closed mapping**, not a widened alphabet: a look-alike variant of a legacy code
is not in the table and resolves to nothing. Both `/api/organizations/resolve` and
`/api/auth/profile` resolve through one shared helper (`lib/join-code-lookup.ts`) — strict
code first, legacy alias only as fallback — so the two routes can never drift apart again.

## Fix (this change set)

| Layer | Change |
|---|---|
| Generator | Migration 38: `kunity.generate_join_code()` — uniformly random bytes (the v4 UUID's fixed version/variant bytes 6 and 8 are skipped; rejection sampling `248 = 8*31` removes modulo bias), same 31-char alphabet/length as the TS generator. Installed as the `join_code` DEFAULT **before** the backfill so no concurrent insert can receive an old-format code. |
| Preservation | `kunity.join_code_aliases` snapshot taken **before** any replacement; service-role only (explicit `REVOKE` — migration 05's default privileges would otherwise grant it to clients; verified in tests). Admin "regenerate" deletes a SACCO's aliases (the UI's "old link stops working" promise, now for every older link); silent self-heal preserves/creates the alias instead. |
| Backfill | Non-conforming codes replaced with conforming ones. Codes that already conform are left untouched — links that worked keep working. |
| Invariants | `CHECK (join_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$')` plus `NOT NULL` re-asserted after the backfill (a CHECK treats NULL as satisfied). Whole migration runs in one transaction (house style, cf. migration 20) and is idempotent — a straggler row can never survive a completed run, and a failed CHECK on an interrupted run heals on re-apply. |
| Self-heal | `/api/admin/join-code` `get` regenerates any non-conforming stored code on read (audit: `join_code_regenerated`, reason `auto_heal_non_conforming_code`), covering rows created outside migrations. |
| Shared lookup | `lib/join-code-lookup.ts` `resolveJoinCodeToOrg()` used by both resolve and profile routes; `legacyJoinCodeCandidate()` (pure, in `lib/join-code.ts`) accepts exactly migration-24's format (10 chars of `0-9A-F`) and is consulted only when the strict check fails. |
| Regression test | `test/join-code-conformance-tests.mjs` (21 checks): reproduces the mismatch against the real SQL generator, then asserts DB codes × TS codes × column DEFAULT all pass `normalizeJoinCode`, NOT NULL and CHECK hold, replaced codes are aliased and resolve end to end, the alias table is invisible to client roles, and migration 38 re-applies cleanly without touching aliases. |

## Operational note

Links shared before deploy that used dead codes **start working** through the alias mapping —
no re-share needed. Links shared with conforming codes are unaffected. Only an explicit
"Regenerate" in the admin console kills older links.

## Tests

- `test/join-code-conformance-tests.mjs`: 21/21 (new).
- `test/signup-flow-e2e-tests.mjs`: 31/31 (new) — full end-to-end run of the
  sign-up flow against TWO real Next.js servers: the pre-fix commit (worktree)
  reproduces the live bug exactly (`"This join link is not valid."` for the
  shared link, and the profile API refusing it too), then this branch registers
  a member through the SAME old link via the alias mapping, dispatches the
  welcome SMS to the gateway (wallet debit included), and holds every guard
  (tenant binding, poisoned-metadata cross-tenant attempt, duplicate NIN,
  declined re-apply, identity lock, 5/IP rate limit).
  World state comes from the real migrations on PGlite; only the Supabase
  backend (GoTrue/PostgREST) and the NaJiki SMS gateway are stubbed (no network
  to supabase.co or the NaJiki origin from the test sandbox).
- Regression: join-code 12/12, migrations-reapply 8/8 (migration 38 idempotent),
  registration-guard 10/10, `tsc --noEmit` clean.
