// -----------------------------------------------------------------------------
// PWA installability — static wiring checks + a live dev-server pass.
//
// Static: the manifest (app/manifest.ts) meets the install criteria (name,
// start_url, standalone display, 192+512 icons, maskable variants); every
// declared icon is a REAL PNG whose pixel dimensions match its declaration;
// the service worker (public/sw.js) never touches /api/* or /auth; the
// register component mounts it; the install prompt asks EVERY user on EVERY
// visit (per-session dismissal only), uses beforeinstallprompt when available,
// explains the manual Share -> Add to Home Screen path on iOS, and stops once
// the app is installed.
//
// Live: a real dev server must serve /manifest.webmanifest, /sw.js, the
// icons, and the <link rel="manifest"> + theme-color + apple-touch-icon tags
// on the rendered / page.
//
// Run: node test/pwa-install-tests.mjs
// -----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { openSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestTs = readFileSync(join(ROOT, 'app', 'manifest.ts'), 'utf8');
const sw = readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8');
const register = readFileSync(join(ROOT, 'app', 'pwa-register.tsx'), 'utf8');
const prompt = readFileSync(join(ROOT, 'app', 'install-prompt.tsx'), 'utf8');
const layout = readFileSync(join(ROOT, 'app', 'layout.tsx'), 'utf8');

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✅ PASS  ${name}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
};

const pngSize = (p) => {
  const b = readFileSync(join(ROOT, p));
  if (!(b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

console.log('Manifest (app/manifest.ts)');

check('app has a name and short_name', /name: '/.test(manifestTs) && /short_name: '/.test(manifestTs));
check('start_url is / with scope /', /start_url: '\/'/.test(manifestTs) && /scope: '\/'/.test(manifestTs));
check('display is standalone (installs like an app)', /display: 'standalone'/.test(manifestTs));
check('theme_color and background_color set', /#7C2D12/.test(manifestTs) && /#FEF6EE/.test(manifestTs));

const iconEntries = [
  ['public/icons/icon-192.png', 192, 'any'],
  ['public/icons/icon-512.png', 512, 'any'],
  ['public/icons/icon-maskable-192.png', 192, 'maskable'],
  ['public/icons/icon-maskable-512.png', 512, 'maskable'],
];
for (const [file, size, purpose] of iconEntries) {
  const declared = manifestTs.includes(file.replace('public/', '/'));
  const real = pngSize(file);
  check(
    `${file} is declared (${size}px, ${purpose}) and is a real PNG of exactly ${size}x${size}`,
    declared && !!real && real.w === size && real.h === size,
    declared ? (real ? `actual ${real.w}x${real.h}` : 'not a PNG') : 'not declared in manifest'
  );
}

console.log('Service worker (public/sw.js)');

check('has a fetch handler (installability requirement)', /addEventListener\('fetch'/.test(sw));
check('never intercepts /api/* requests', sw.includes("url.pathname.startsWith('/api/')"));
check('never intercepts /auth pages', sw.includes("url.pathname.startsWith('/auth')"));
check('caches only immutable statics (/_next/static/, /icons/, manifest)', sw.includes('/_next/static/') && !/cache\.put\((?!(request))/.test(sw));
check('same-origin GET only', /request\.method !== 'GET'/.test(sw) && /url\.origin !== self\.location\.origin/.test(sw));

console.log('Registration + install prompt');

check('register component registers /sw.js', register.includes("navigator.serviceWorker.register('/sw.js')"));
check('layout renders both PwaRegister and InstallPrompt', layout.includes('<PwaRegister />') && layout.includes('<InstallPrompt />'));
check('layout links the manifest', layout.includes("manifest: '/manifest.webmanifest'"));
check('layout exports themeColor viewport', /themeColor: '#7C2D12'/.test(layout));
check('apple web app meta configured', /appleWebApp/.test(layout) && /capable: true/.test(layout));

check(
  'prompt captures beforeinstallprompt and calls prompt() on Install',
  /beforeinstallprompt/.test(prompt) && /e\.preventDefault\(\)/.test(prompt) && /deferred\.prompt\(\)/.test(prompt)
);
check(
  'asks EVERY visit: dismissal is session-only, never persisted',
  prompt.includes('sessionStorage') && !/localStorage\.setItem\([^)]*DISMISSED/.test(prompt)
);
check(
  'stops asking once installed (appinstalled + standalone detection)',
  /appinstalled/.test(prompt) && /display-mode: standalone/.test(prompt)
);
check(
  'iOS users get the manual Share -> Add to Home Screen instructions',
  /iphone|ipad|ipod/i.test(prompt) && prompt.includes('Add to Home Screen')
);
check(
  'browsers without beforeinstallprompt still get install guidance',
  prompt.includes("'generic'")
);

// ---------------------------------------------------------------------------
// Live pass: real dev server
// ---------------------------------------------------------------------------
console.log('Live dev-server pass');

const PORT = 3436;
const logFd = openSync('/tmp/pwa-test-next.log', 'w');
const child = spawn('npx', ['next', 'dev', '--webpack', `-p`, String(PORT), '-H', '127.0.0.1'], {
  cwd: ROOT,
  env: {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'dummy',
    SUPABASE_SERVICE_ROLE_KEY: 'dummy-service',
    NEXT_TELEMETRY_DISABLED: '1',
  },
  stdio: ['ignore', logFd, logFd],
  detached: true,
});
const stop = () => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
};

try {
  const deadline = Date.now() + 180_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/manifest.webmanifest`, { signal: AbortSignal.timeout(5000) });
      if (r.status === 200) up = true;
    } catch { /* wait */ }
    if (child.exitCode != null) throw new Error('dev server exited early');
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!up) throw new Error('dev server never came up');

  const manifestRes = await fetch(`http://127.0.0.1:${PORT}/manifest.webmanifest`, { signal: AbortSignal.timeout(60_000) });
  const manifest = manifestRes.status === 200 ? await manifestRes.json() : null;
  check('/manifest.webmanifest serves 200 JSON', manifestRes.status === 200 && !!manifest);
  check(
    'served manifest is complete (name, standalone, 192+512, maskable)',
    !!manifest &&
      manifest.display === 'standalone' &&
      manifest.start_url === '/' &&
      manifest.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any') &&
      manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')
  );

  const swRes = await fetch(`http://127.0.0.1:${PORT}/sw.js`, { signal: AbortSignal.timeout(30_000) });
  const swBody = swRes.status === 200 ? await swRes.text() : '';
  check('/sw.js serves 200 with the fetch handler intact', swRes.status === 200 && swBody.includes("addEventListener('fetch'"));

  const iconRes = await fetch(`http://127.0.0.1:${PORT}/icons/icon-192.png`, { signal: AbortSignal.timeout(30_000) });
  const iconBuf = iconRes.status === 200 ? Buffer.from(await iconRes.arrayBuffer()) : Buffer.alloc(0);
  check(
    '/icons/icon-192.png serves 200 as a real 192px PNG',
    iconRes.status === 200 && iconBuf[0] === 0x89 && iconBuf[1] === 0x50 && iconBuf.readUInt32BE(16) === 192
  );

  const pageRes = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(120_000) });
  const html = pageRes.status === 200 ? await pageRes.text() : '';
  check('rendered / links the manifest', pageRes.status === 200 && /rel="manifest" href="\/manifest\.webmanifest"/.test(html));
  check('rendered / carries the theme-color meta', /name="theme-color" content="#7C2D12"/.test(html));

  const appleHref = html.match(/rel="apple-touch-icon"[^>]*href="([^"]+)"/)?.[1];
  const appleOk = appleHref
    ? (await fetch(`http://127.0.0.1:${PORT}${appleHref}`, { signal: AbortSignal.timeout(30_000) })).status === 200
    : false;
  check('rendered / links a working apple-touch-icon', appleOk, appleHref || 'no link found');
} catch (e) {
  check('live pass ran without errors', false, e.message);
} finally {
  stop();
}

console.log(`\nRESULTS: ${passed}/${passed + failed} passed`);
if (failed) {
  console.log('PWA INSTALL: FAILURES ABOVE');
  process.exit(1);
}
console.log('PWA INSTALL: ALL CHECKS PASSED');
