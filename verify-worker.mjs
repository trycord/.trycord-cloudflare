// TEMP: exercise the real cloudflare/worker.js against a simulation of the
// Cloudflare ASSETS binding, and check every route.
//
// The simulation reproduces the behaviour that caused this bug, taken from the
// live site rather than assumed:
//
//   /app/index.html      -> 307 to /app/     (asset binding strips the index)
//   /app/settings        -> 307 to /app/     (unknown under a directory)
//   /app/js/app.js       -> 200              (a real file)
//
// A fallback written as `status !== 404` therefore never fires.

import fs from 'fs';
import path from 'path';
import http from 'http';

const ROOT = '/tmp/cfw';
const DIST = path.join(ROOT, 'dist');
const PORT = 9988;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain',
};

// Serves dist/ with Cloudflare's directory semantics.
const files = new Map();
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(abs, r);
    else files.set('/' + r, abs);
  }
})(DIST, '');

const isDir = (p) => p.endsWith('/') && files.has(p + 'index.html');
const fileAt = (p) => files.get(p) || (isDir(p) ? files.get(p + 'index.html') : null);

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const send = (status, body, type) => {
    res.writeHead(status, { 'Content-Type': type || 'text/plain' });
    res.end(body || '');
  };
  // 1. A real file, or a directory's index.html.
  const hit = fileAt(p);
  if (hit) {
    if (p.endsWith('/index.html')) {
      // Cloudflare redirects an explicit index file to its directory.
      res.writeHead(307, { Location: p.replace(/index\.html$/, '') });
      return res.end();
    }
    const ext = path.extname(hit).toLowerCase();
    return send(200, fs.readFileSync(hit), MIME[ext] || 'application/octet-stream');
  }
  // 2. An index file that exists but was not the requested path.
  if (files.has(p + '/index.html')) {
    res.writeHead(307, { Location: p + '/' });
    return res.end();
  }
  // 3. Unknown under an existing directory -> redirect to that directory.
  //    This is the behaviour that broke the SPA fallback.
  const dir = p.slice(0, p.lastIndexOf('/') + 1);
  if (dir && files.has(dir + 'index.html')) {
    res.writeHead(307, { Location: dir });
    return res.end();
  }
  // 4. Genuinely absent.
  send(404, 'Not Found');
});
await new Promise((r) => server.listen(PORT, r));

// env.ASSETS.fetch, backed by the simulation above.
const env = {
  ASSETS: {
    async fetch(input) {
      const u = new URL(typeof input === 'string' ? input : input.url);
      // redirect: 'manual' is essential. The Cloudflare ASSETS binding does NOT
      // follow redirects - it returns the 307 Response - and that is the whole
      // bug. A simulation that followed them would pass while the live site
      // bounced every route to /app/, which is exactly what it did.
      const res = await fetch(`http://127.0.0.1:${PORT}${u.pathname}`, { redirect: 'manual' });
      return new Response(res.ok && res.status < 300 ? await res.arrayBuffer() : null, {
        status: res.status, headers: { Location: res.headers.get('location') || '' },
      });
    },
  },
};

const worker = (await import(path.join(ROOT, 'cloudflare', 'worker.js'))).default;

async function hit(pathname) {
  const req = new Request('https://trycord.dev' + pathname);
  const res = await worker.fetch(req, env);
  const body = res.status === 200 ? await res.text() : '';
  return {
    status: res.status,
    location: res.headers.get('location') || '',
    shell: body.includes('id="shell"'),
    base: (body.match(/<base href="[^"]*">/) || [''])[0],
  };
}

const ok = (c, m) => console.log((c ? '  PASS  ' : '  FAIL  ') + m);
let bad = 0;
const fail = (m) => { ok(false, m); bad++; };

console.log('\n--- public site must be untouched ---');
for (const [p, f] of Object.entries({ '/': 'index.html', '/features': 'features.html', '/docs': 'docs.html',
  '/download': 'download.html', '/about': 'about.html', '/support': 'support.html', '/security': 'security.html',
  '/status': 'status.html', '/privacy': 'privacy.html', '/terms': 'terms.html',
  '/trust-and-safety': 'trust-and-safety.html', '/instances-terms': 'instances-terms.html' })) {
  const r = await hit(p);
  if (r.status !== 200 || r.shell) fail(p.padEnd(20) + 'status=' + r.status + ' shell=' + r.shell);
}
ok(bad === 0, 'all 12 public routes return their own page and never the app shell');

console.log('\n--- public assets still served ---');
for (const p of ['/css/site.css', '/js/site.js', '/assets/trycord-logo.ico']) {
  const r = await hit(p);
  if (r.status !== 200) fail(p.padEnd(26) + 'status=' + r.status);
}
ok(true, 'public css/js/icons resolve');

console.log('\n--- the SPA fallback: every app route ---');
const APP = ['/app/', '/app/home', '/app/dms', '/app/dms/abc', '/app/friends', '/app/notifications',
  '/app/menu', '/app/discover', '/app/support', '/app/settings', '/app/settings/privacy',
  '/app/settings/security', '/app/settings/appearance', '/app/settings/notifications',
  '/app/settings/account', '/app/admin', '/app/admin/users', '/app/admin/reports', '/app/admin/audit',
  '/app/admin/pages', '/app/admin/gdpr', '/app/server/abc', '/app/server/abc/channel/xyz',
  '/app/server/abc/channel/xyz/pins', '/app/server/abc/members', '/app/server/abc/roles',
  '/app/server/abc/settings', '/app/c/slug', '/app/c/slug/channel/general',
  '/app/users/abc', '/app/invite/CODE', '/app/servers/new', '/app/login', '/app/register', '/app/forgot',
  '/app/account', '/app/support/appeals'];
let appBad = 0;
for (const p of APP) {
  const r = await hit(p);
  if (r.status !== 200 || !r.shell) { fail(p.padEnd(34) + 'status=' + r.status + ' shell=' + r.shell); appBad++; }
}
if (!appBad) ok(true, APP.length + ' app routes all return the shell with <base>');

console.log('\n--- app assets must NOT be swallowed by the fallback ---');
for (const p of ['/app/js/app.js', '/app/css/app.css', '/app/backend.json', '/app/js/nav.js']) {
  const r = await hit(p);
  const res2 = await worker.fetch(new Request('https://trycord.dev' + p), env);
  if (res2.status !== 200) fail(p.padEnd(26) + 'status=' + res2.status);
}
ok(true, 'real app assets are returned as themselves');

console.log('\n--- auth aliases ---');
for (const [from, to] of [['/login', '/app/login'], ['/register', '/app/register'], ['/forgot', '/app/forgot']]) {
  const r = await hit(from);
  const want = 'https://trycord.dev' + to;
  if (!(r.status === 302 && r.location === want)) fail(from + ' -> ' + r.status + ' ' + r.location + ' (want 302 ' + want + ')');
}
ok(true, '/login /register /forgot redirect into /app/*');

console.log('\n--- /app with no trailing slash ---');
{
  const r = await hit('/app');
  if (!(r.status === 302 && r.location === 'https://trycord.dev/app/')) fail('/app -> ' + r.status + ' ' + r.location);
}
ok(true, '/app redirects to /app/');

console.log('\n--- genuine 404s still 404 ---');
for (const p of ['/nothing-here', '/app/nope-not-real']) {
  const r = await hit(p);
  const isApp = p.startsWith('/app/');
  if (isApp) { if (!r.shell) fail(p + ' under /app should get the shell'); }
  else if (r.status !== 404) fail(p + ' returned ' + r.status + ' (want 404)');
}
ok(true, 'unknown root paths do not return the app');

console.log('\n--- /nothing-here must be 404 with the page ---');
{
  const r = await hit('/nothing-here');
  ok(r.status === 404, '/nothing-here status=' + r.status + ' (want 404)');
}

console.log('\n' + (bad ? bad + ' FAILURE(S)' : 'all checks passed'));
server.close();
process.exit(bad ? 1 : 0);