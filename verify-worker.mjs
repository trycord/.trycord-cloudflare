// Exercises the real cloudflare/worker.js against a simulation of the
// Cloudflare ASSETS binding, and checks every route.
//
// The simulation reproduces the behaviour that caused the original bug, taken
// from the live site rather than assumed:
//
//   /app/index.html      -> 307 to /app/     (asset binding strips the index)
//   /app/settings        -> 307 to /app/     (unknown under a directory)
//   /app/js/main.js      -> 200              (a real file)
//
// A fallback written as `status !== 404` therefore never fires.
//
// It also covers the two surfaces that share this origin: the public website at
// the root, the Desktop app under /app/, and the Mobile app under /app/mobile/.
// The asset/route boundary is asserted on both app surfaces, because the origin
// (backend/src/serve-client.js) draws it and the static host has to agree: a
// missing .js must be a 404, never the shell.

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

// The tree this repository holds, wherever the repository is.
//
// It used to be a fixed path on one machine, so the check could only run
// there - and the build failed everywhere else with a missing directory.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
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
// The instance the worker proxies the application to, for the check.
//
// The application is served by the instance, not by this deployment, so the
// check runs a second server that plays the instance: it answers /app/ with
// the application's own document and its own assets, so the worker has
// something to proxy to.
const INSTANCE_PORT = 9989;
const instanceServer = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  // The instance serves the application at its own mount. The check needs it
  // to behave like the real thing - the same files, the same directory
  // semantics - so the tree it serves is the one this deployment built, and
  // one file is marked so the check can tell where the answer came from.
  const instancePath = p.startsWith('/app') ? p : '/app' + p;
  const hit = fileAt(instancePath);
  if (hit) {
    if (instancePath.endsWith('/index.html')) {
      res.writeHead(307, { Location: instancePath.replace(/index\.html$/, '') });
      return res.end();
    }
    const ext = path.extname(hit).toLowerCase();
    let body = fs.readFileSync(hit);
    if (instancePath === '/app/js/features/auth.js') {
      // A marker, so the check can prove the answer came from the instance
      // rather than from the deployment's own copy.
      body = Buffer.from("// the instance's copy of the client\n" + body.toString('utf8'));
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    return res.end(body);
  }
  // The instance serves the application as a single-page application: a path
  // that is not a file is a client route, and the instance answers it with
  // the shell and lets the client's router take it from there.
  if (!/\.[a-z0-9]+$/i.test(instancePath)) {
    // The Mobile module has its own document, and a path under it gets that
    // one - not the desktop shell.
    const mobile = instancePath.startsWith('/app/mobile/');
    const document = mobile ? '/app/mobile/index.html' : '/app/index.html';
    if (files.has(document)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(fileAt(document)));
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});
await new Promise((r) => instanceServer.listen(INSTANCE_PORT, '127.0.0.1', r));

const env = {
  BACKEND_ORIGIN: `http://127.0.0.1:${INSTANCE_PORT}`,
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
    body,
    location: res.headers.get('location') || '',
    // The Desktop entry carries `id="app"` on its mount node and no platform
    // attribute; the Mobile entry declares `data-platform="mobile"`. They are
    // two documents, so the checks below tell them apart the way a reader does.
    desktop: body.includes('id="app"') && !body.includes('data-platform="mobile"'),
    mobile: body.includes('data-platform="mobile"'),
    base: (body.match(/<base href="[^"]*">/) || [''])[0],
    type: res.headers.get('content-type') || '',
  };
}

const ok = (c, m) => console.log((c ? '  PASS  ' : '  FAIL  ') + m);
let bad = 0;
const fail = (m) => { ok(false, m); bad++; };

console.log('\n--- public site must be untouched ---');
{
  let n = 0;
  const PAGES = { '/': 'index.html', '/features': 'features.html', '/docs': 'docs.html',
    '/download': 'download.html', '/about': 'about.html', '/support': 'support.html',
    '/security': 'security.html', '/status': 'status.html', '/privacy': 'privacy.html',
    '/terms': 'terms.html', '/trust-and-safety': 'trust-and-safety.html',
    '/instances-terms': 'instances-terms.html' };
  for (const p of Object.keys(PAGES)) {
    const r = await hit(p);
    if (r.status !== 200 || r.desktop || r.mobile) fail(p.padEnd(20) + 'status=' + r.status);
    else n++;
  }
  ok(n === Object.keys(PAGES).length, n + ' public routes return their own page and never an app document');
}

// Every page in the tree, by its clean address.
//
// The worker used to answer a page only if it was named in a hand-written
// map, and a page that was not in the map 404ed here while it worked on the
// origin. The list here is read from the tree rather than written out, so a
// page the tree holds is a page this checks.
console.log('\n--- every page in the tree, by its clean address ---');
{
  // The addresses that belong to the application rather than to the public
  // site. `/login`, `/register` and `/forgot` are the application's own, and
  // so is `/home`: the application's home route, with the public homepage at
  // `/`. Each is redirected into /app/ rather than answered with a second
  // copy, and each is checked above.
  const APPLICATION_ADDRESSES = ['/login', '/register', '/forgot', '/home'];
  const pages = [...files.keys()]
    .filter((p) => /^\/[^/]+\.html$/.test(p) && p !== '/index.html' && p !== '/404.html')
    .map((p) => p.replace(/\.html$/, ''))
    .filter((p) => APPLICATION_ADDRESSES.indexOf(p) === -1);
  let n = 0;
  for (const p of pages) {
    const r = await hit(p);
    if (r.status !== 200 || r.desktop || r.mobile) fail(p.padEnd(26) + 'status=' + r.status);
    else n++;
  }
  ok(n === pages.length, n + '/' + pages.length
    + ' pages are reachable by their clean address (a page cannot 404 by being forgotten)');
}

console.log('\n--- public assets still served ---');
{
  let n = 0;
  for (const p of ['/css/site.css', '/js/site.js', '/assets/trycord-logo.ico']) {
    const r = await hit(p);
    if (r.status === 200) n++; else fail(p.padEnd(26) + 'status=' + r.status);
  }
  ok(n === 3, 'public css/js/icons resolve');
}

console.log('\n--- the application comes from the instance ---');
{
  // The client must be the instance's, not the deployment's copy. A copy goes
  // stale: for as long as the site was published from a tree that had not
  // been rebuilt, a reader on trycord.dev was given the client of an older
  // release while the same reader on api.trycord.dev was given the current
  // one. Two addresses, two products.
  const r = await hit('/app/js/features/auth.js');
  if (r.status !== 200) fail('/app/js/features/auth.js status=' + r.status);
  else if (!r.body.includes("the instance's copy of the client")) {
    fail('the application was served from the deployment, not from the instance');
  } else ok(true, 'the application is the instance\'s');

  const shell = await hit('/app/');
  if (shell.status !== 200 || !shell.body.includes('id="app"')) {
    fail('the application shell did not come from the instance: status=' + shell.status);
  } else ok(true, 'the application shell is the instance\'s');

  const mobile = await hit('/app/mobile/');
  if (mobile.status !== 200 || !mobile.mobile) {
    fail('the Mobile document did not come from the instance: status=' + mobile.status);
  } else ok(true, 'the Mobile document is the instance\'s');
}

console.log('\n--- the Desktop SPA fallback: every app route ---');
const APP = ['/app/', '/app/home', '/app/dms', '/app/dms/abc', '/app/friends', '/app/notifications',
  '/app/menu', '/app/discover', '/app/support', '/app/settings', '/app/settings/privacy',
  '/app/settings/security', '/app/settings/appearance', '/app/settings/notifications',
  '/app/settings/account', '/app/admin', '/app/admin/users', '/app/admin/reports', '/app/admin/audit',
  '/app/admin/pages', '/app/admin/gdpr', '/app/server/abc', '/app/server/abc/channel/xyz',
  '/app/server/abc/channel/xyz/pins', '/app/server/abc/members', '/app/server/abc/roles',
  '/app/server/abc/settings', '/app/c/slug', '/app/c/slug/channel/general',
  '/app/users/abc', '/app/invite/CODE', '/app/servers/new', '/app/login', '/app/register', '/app/forgot',
  '/app/account', '/app/support/appeals'];
{
  let n = 0;
  for (const p of APP) {
    const r = await hit(p);
    if (r.status === 200 && r.desktop && r.base === '<base href="/app/">') n++;
    else fail(p.padEnd(34) + 'status=' + r.status + ' desktop=' + r.desktop + ' base=' + r.base);
  }
  ok(n === APP.length, n + '/' + APP.length + ' Desktop routes return the shell with <base href="/app/">');
}

console.log('\n--- the Mobile module: its own document, its own base ---');
const MOBILE = ['/app/mobile/', '/app/mobile/settings', '/app/mobile/settings/security',
  '/app/mobile/home', '/app/mobile/dms', '/app/mobile/menu', '/app/mobile/discover',
  '/app/mobile/notifications', '/app/mobile/admin', '/app/mobile/login',
  '/app/mobile/register', '/app/mobile/forgot', '/app/mobile/support'];
{
  let n = 0;
  for (const p of MOBILE) {
    const r = await hit(p);
    if (r.status === 200 && r.mobile && r.base === '<base href="/app/mobile/">') n++;
    else fail(p.padEnd(34) + 'status=' + r.status + ' mobile=' + r.mobile + ' base=' + r.base);
  }
  ok(n === MOBILE.length, n + '/' + MOBILE.length + ' Mobile routes return the Mobile doc with <base href="/app/mobile/">');
}

console.log('\n--- /app/mobile with no trailing slash ---');
{
  const r = await hit('/app/mobile');
  if (!(r.status === 302 && r.location === 'https://trycord.dev/app/mobile/')) {
    fail('/app/mobile -> ' + r.status + ' ' + r.location);
  }
  ok(r.status === 302, '/app/mobile redirects to /app/mobile/');
}

console.log('\n--- the origin-root /mobile alias ---');
{
  const want = {
    '/mobile': 'https://trycord.dev/app/mobile/',
    '/mobile/': 'https://trycord.dev/app/mobile/',
    '/mobile/settings': 'https://trycord.dev/app/mobile/settings',
    '/mobile/settings/security': 'https://trycord.dev/app/mobile/settings/security',
  };
  let n = 0;
  for (const from of Object.keys(want)) {
    const r = await hit(from);
    if (r.status === 302 && r.location === want[from]) n++;
    else fail(from.padEnd(28) + '-> ' + r.status + ' ' + r.location + ' (want 302 ' + want[from] + ')');
  }
  ok(n === Object.keys(want).length, '/mobile/* redirects onto the mounted Mobile location');
}

console.log('\n--- real assets must be returned as themselves ---');
{
  const DESKTOP_ASSETS = ['/app/js/main.js', '/app/css/app.css', '/app/backend.json',
    '/app/packages/nav.js', '/app/assets/trycord-assets/brand/trycord-symbol.svg'];
  const MOBILE_ASSETS = ['/app/mobile/js/main.js', '/app/mobile/css/app.css', '/app/mobile/backend.json',
    // packages/ is shared at the client root, one directory up: the Mobile entry
    // reaches it as ../../packages/..., so there is no /app/mobile/packages.
    '/app/packages/brand.js', '/app/packages/nav.js'];
  let n = 0;
  for (const p of DESKTOP_ASSETS.concat(MOBILE_ASSETS)) {
    const r = await hit(p);
    if (r.status === 200 && !r.desktop && !r.mobile) n++;
    else fail(p.padEnd(52) + 'status=' + r.status + ' (served as a document?)');
  }
  ok(n === DESKTOP_ASSETS.length + MOBILE_ASSETS.length, n + ' real assets are returned as themselves');
}

console.log('\n--- a missing asset is a 404, never the shell ---');
{
  const MISSES = ['/app/js/nope.js', '/app/js/app/missing.mjs', '/app/css/nope.css',
    '/app/packages/nope.js', '/app/assets/nope.svg',
    '/app/mobile/js/nope.js', '/app/mobile/css/nope.css', '/app/mobile/packages/nope.js'];
  let n = 0;
  for (const p of MISSES) {
    const r = await hit(p);
    if (r.status === 404 && !r.desktop && !r.mobile) n++;
    else fail(p.padEnd(34) + 'status=' + r.status + ' desktop=' + r.desktop + ' mobile=' + r.mobile);
  }
  ok(n === MISSES.length, n + '/' + MISSES.length + ' missing assets under /app and /app/mobile return 404');
}

console.log('\n--- an extensionless app route still falls back to its own document ---');
{
  const r = await hit('/app/nope-not-real');
  ok(r.status === 200 && r.desktop, '/app/nope-not-real -> the Desktop shell (route, not asset)');
  const m = await hit('/app/mobile/nope-not-real');
  ok(m.status === 200 && m.mobile, '/app/mobile/nope-not-real -> the Mobile document (route, not asset)');
}

console.log('\n--- auth aliases ---');
{
  let n = 0;
  for (const [from, to] of [['/login', '/app/login'], ['/register', '/app/register'], ['/forgot', '/app/forgot']]) {
    const r = await hit(from);
    const want = 'https://trycord.dev' + to;
    if (r.status === 302 && r.location === want) n++;
    else fail(from + ' -> ' + r.status + ' ' + r.location + ' (want 302 ' + want + ')');
  }
  ok(n === 3, '/login /register /forgot redirect into /app/*');
}

console.log('\n--- the application\'s home is reachable from the root ---');
{
  // `/home` is the application's home route. The public site keeps its
  // homepage in a file called home.html, so the catch-all answered `/home`
  // with a second copy of the marketing page - the same page as `/`, at a
  // URL that belongs to the application.
  let n = 0;
  for (const from of ['/home', '/home/']) {
    const r = await hit(from);
    const want = 'https://trycord.dev/app/home';
    if (r.status === 302 && r.location === want) n++;
    else fail(from + ' -> ' + r.status + ' ' + r.location + ' (want 302 ' + want + ')');
  }
  ok(n === 2, '/home and /home/ redirect into /app/home');
}

console.log('\n--- the public homepage is still at the root ---');
{
  const r = await hit('/');
  ok(r.status === 200, '/ status=' + r.status + ' (want 200)');
}

console.log('\n--- /app with no trailing slash ---');
{
  const r = await hit('/app');
  ok(r.status === 302 && r.location === 'https://trycord.dev/app/', '/app redirects to /app/');
}

console.log('\n--- unknown root paths 404 with the page ---');
{
  const r = await hit('/nothing-here');
  ok(r.status === 404, '/nothing-here status=' + r.status + ' (want 404)');
}

console.log('\n' + (bad ? bad + ' FAILURE(S)' : 'all checks passed'));
server.close();
process.exit(bad ? 1 : 0);
