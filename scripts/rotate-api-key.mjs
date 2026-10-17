#!/usr/bin/env node
/**
 * Developer-only application API key provisioning.
 *
 * The tenant application API key is the bearer credential for
 * `POST /api/messaging/send` (SMS dispatch billed to the tenant). It is
 * deliberately NOT visible or rotatable from the SACCO admin portal — admins
 * never see it, never copy it and cannot rotate it.
 *
 * Only a SHA-256 digest is ever stored (migration 31). The plaintext key exists
 * exactly once: in this script's stdout, at the moment it is generated. It is
 * never written to disk, never logged, and cannot be recovered afterwards.
 *
 * Requires a service-role key, which is a developer/deployment secret:
 *
 *   SUPABASE_URL=https://<project>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service role key> \
 *   node scripts/rotate-api-key.mjs list
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/rotate-api-key.mjs rotate --tenant <org-uuid|tenant-code>
 *
 *   ... node scripts/rotate-api-key.mjs rotate --application <application-uuid>
 *
 * Options:
 *   --application <uuid>   rotate the key of this application directly
 *   --tenant <uuid|code>   resolve the application through a tenant/organization
 *   --yes                  skip the interactive confirmation
 *
 * Exit codes: 0 success, 1 error, 2 bad usage.
 */
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

// Must stay identical to lib/api-keys.ts. The parity test asserts this.
const KEY_PREFIX = 'kn_live_';
export function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}
export function generateApiKey() {
  return `${KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function usage(message) {
  if (message) console.error(`\n  ${message}\n`);
  console.error(`Usage:
  node scripts/rotate-api-key.mjs list
  node scripts/rotate-api-key.mjs rotate --tenant <org-uuid|tenant-code> [--yes]
  node scripts/rotate-api-key.mjs rotate --application <application-uuid> [--yes]

Environment:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY
`);
  process.exit(2);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) usage(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'yes') {
      flags.yes = true;
      continue;
    }
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for --${key}`);
    flags[key] = value;
    i++;
  }
  return { command, flags };
}

async function rest(url, key, path, init = {}) {
  const res = await fetch(`${url}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function resolveApplication(url, key, flags) {
  if (flags.application) {
    if (!UUID_RE.test(flags.application)) usage('--application must be a UUID');
    const rows = await rest(url, key, `/applications?select=id,name&id=eq.${flags.application}`);
    if (!rows?.length) throw new Error(`No application with id ${flags.application}`);
    return { application: rows[0], tenant: null };
  }

  if (!flags.tenant) usage('Provide --tenant <org-uuid|tenant-code> or --application <application-uuid>');

  const filter = UUID_RE.test(flags.tenant)
    ? `id=eq.${flags.tenant}`
    : `code=eq.${encodeURIComponent(flags.tenant)}`;
  const tenants = await rest(url, key, `/tenants?select=id,name,code,application_id&${filter}`);
  if (!tenants?.length) {
    throw new Error(`No tenant matched ${UUID_RE.test(flags.tenant) ? 'id' : 'code'} "${flags.tenant}"`);
  }
  const tenant = tenants[0];
  if (!tenant.application_id) {
    throw new Error(`Tenant "${tenant.name || tenant.code}" has no linked application; pass --application instead`);
  }
  const appRows = await rest(url, key, `/applications?select=id,name&id=eq.${tenant.application_id}`);
  if (!appRows?.length) throw new Error(`Linked application ${tenant.application_id} not found`);
  return { application: appRows[0], tenant };
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === 'yes' || answer === 'y';
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command) usage('A command is required.');
  if (command !== 'list' && command !== 'rotate') usage(`Unknown command: ${command}`);

  const url = env('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    usage('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (service-role is developer-only).');
  }

  if (command === 'list') {
    const apps = await rest(url, serviceKey, '/applications?select=id,name,api_key_hash&order=name');
    if (!apps?.length) {
      console.log('No applications found.');
      return;
    }
    console.log('\nApplication API keys (presence only — the key itself is never readable):\n');
    for (const app of apps) {
      console.log(`  ${app.name || '(unnamed)'}  ${app.id}`);
      console.log(`    key set: ${app.api_key_hash ? 'yes' : 'no — run rotate'}\n`);
    }
    return;
  }

  const { application, tenant } = await resolveApplication(url, serviceKey, flags);
  const label = application.name || application.id;
  const scope = tenant ? `tenant ${tenant.name || tenant.code}` : `application ${label}`;

  console.log(`\n  About to rotate the SMS gateway API key for ${scope}.`);
  console.log('  The current key stops working immediately. Integrators using it must be updated.');

  if (!flags.yes) {
    const ok = await confirm('\n  Type "yes" to continue: ');
    if (!ok) {
      console.error('  Aborted.');
      process.exit(1);
    }
  }

  const newKey = generateApiKey();
  await rest(url, serviceKey, `/applications?id=eq.${application.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ api_key_hash: hashApiKey(newKey), api_key: null }),
  });

  console.log(`
  ────────────────────────────────────────────────────────────────
   NEW API KEY — shown once. It is not stored anywhere and cannot
   be recovered. Copy it into the integrator's secret store now.
  ────────────────────────────────────────────────────────────────

   ${newKey}

  ────────────────────────────────────────────────────────────────
   ${label} · digest stored: ${hashApiKey(newKey).slice(0, 16)}…
  ────────────────────────────────────────────────────────────────
`);
}

// Only run when invoked directly, so tests can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  });
}
