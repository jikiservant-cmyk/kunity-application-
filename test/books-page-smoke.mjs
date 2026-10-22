/** Disposable smoke: /admin/books renders (200) for a signed-in admin. */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';

const stub = http.createServer((req, res) => {
  const json = (code, body) => { const p = JSON.stringify(body); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) }); res.end(p); };
  if (req.url === '/auth/v1/user') return json(200, { id: 'admin-a', email: 'admin@example.test', aud: 'authenticated' });
  if (req.url === '/auth/v1/health') return json(200, { version: 'stub' });
  if (req.url.startsWith('/rest/v1/admin_profiles')) return json(200, [{ role: 'sacco_admin', tenant_id: 'eeeeeee1-0000-4000-8000-000000000001' }]);
  return json(404, { message: 'no handler ' + req.url });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;

const logFd = openSync('/tmp/books-smoke-next.log', 'w');
const child = spawn('npx', ['next', 'dev', '--webpack', '-p', '3432', '-H', '127.0.0.1'], {
  cwd: process.cwd(),
  env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stubPort}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'stub-anon', SUPABASE_SERVICE_ROLE_KEY: 'stub-service', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', logFd, logFd],
  detached: true,
});
const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } stub.close(); try { stub.closeAllConnections(); } catch { /* older Node */ } };

const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  try { const r = await fetch('http://127.0.0.1:3432/api/health', { signal: AbortSignal.timeout(5000) }); if (r.status >= 200) break; } catch { /* wait */ }
  if (child.exitCode != null) { console.log('SERVER DIED:', readFileSync('/tmp/books-smoke-next.log', 'utf8').slice(-1000)); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1500));
}

const session = { access_token: 'valid-admin-token', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'admin-a' } };
const cookie = `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;

const res = await fetch('http://127.0.0.1:3432/admin/books', { headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(120_000) });
const html = await res.text();
console.log('STATUS:', res.status, '| SACCO Books in SSR shell:', /__next/.test(html));
console.log('server log tail:', readFileSync('/tmp/books-smoke-next.log', 'utf8').split('\n').filter((l) => l.includes('admin/books')).slice(-3).join('\n') || '(compiling)');
stop();
if (res.status !== 200) { console.log('SMOKE FAILED'); process.exit(1); }
console.log('SMOKE OK: /admin/books answered 200 for a signed-in session');
