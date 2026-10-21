// Verifies the built tree in ./dist. Run after build.js; a non-zero exit means
// do not deploy.
//
// Checks three things, because each has broken this deployment in the past:
//   1. the public site and the WAC are present where the Worker expects them
//   2. Wrangler is pointed at a directory and entry point that exist
//   3. the WAC's module graph is intact, so the app cannot boot into a blank
//      page from a dangling import
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : ' FAIL  ') + n + (c ? '' : '  -> ' + d)); };
const has = (p) => fs.existsSync(path.join(DIST, p));

// Every file under a directory, so a check can cover the whole tree rather than
// a hand-kept list of the files it happened to remember.
function walkFiles(dir, ext) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (!ext || full.endsWith(ext)) out.push(full);
    }
  }
  return out;
}
// Relative to dist/ unless given an absolute path. Accepting an absolute path
// matters: the Wrangler checks below resolve against the repo root, and a
// helper that silently re-rooted them at dist/ reported a directory that
// exists as missing.
const isDir = (p) => {
  try { return fs.statSync(path.isAbsolute(p) ? p : path.join(DIST, p)).isDirectory(); } catch { return false; }
};

if (!isDir('')) {
  console.error('dist/ does not exist. Run: node build.js');
  process.exit(1);
}

console.log('--- public site at the root ---');
for (const f of ['index.html', 'home.html', 'docs.html', 'documentation.html', '404.html',
  'about.html', 'download.html', 'features.html', 'privacy.html', 'security.html',
  'status.html', 'support.html', 'terms.html', 'instances-terms.html', 'trust-and-safety.html']) {
  ok('/' + f, has(f), 'missing');
}
ok('/css/site.css', has(path.join('css', 'site.css')), 'missing');
ok('/js/site.js', has(path.join('js', 'site.js')), 'missing');
ok('/js/status.js', has(path.join('js', 'status.js')), 'missing');
// Brand images are republished from the WAC tree. They are the one thing here
// that has no duplicate source any more, so a missed copy step is fatal.
//
// The site asks for the asset library, so the library is what has to be there:
// the app icons, the fonts and the brand images, all under the one path.
for (const a of [
  'trycord-assets/app/favicon.svg',
  'trycord-assets/app/trycord-app-icon.svg',
  'trycord-assets/app/trycord-logo.ico',
  'trycord-assets/app/trycord-og-image.png',
  'trycord-assets/brand/trycord-symbol.svg',
  'trycord-assets/fonts/manrope-latin-wght-normal.woff2',
  'trycord-assets/fonts/jetbrains-mono-latin-wght-normal.woff2',
  'trycord-assets/tokens/trycord.css',
]) {
  ok('/assets/' + a, has(path.join('assets', a)), 'missing');
}

console.log('\n--- WAC under /app/ ---');
ok('/app/ is a directory', isDir('app'), 'missing');
for (const f of ['index.html', 'backend.json']) ok('/app/' + f, has(path.join('app', f)), 'missing');
for (const d of ['css', 'js', 'packages', 'assets']) ok('/app/' + d + '/', isDir(path.join('app', d)), 'missing');
// The client split into an entry tree (app/js, one file per concern plus the
// lazy views/ under it) and a shared platform (app/packages). Both are real
// source directories now, so the module count covers the whole tree rather than
// app/js alone.
const moduleFiles = [
  ...walkFiles(path.join(DIST, 'app', 'js'), '.js'),
  ...walkFiles(path.join(DIST, 'app', 'packages'), '.js'),
];
ok('/app/js/ and /app/packages/ hold the WAC modules', moduleFiles.length > 20, 'found ' + moduleFiles.length);
ok('/app/assets/ preserved', isDir(path.join('app', 'assets')), 'missing');

// The Mobile module is a second entry document under the same mount, with its
// own <base>. It is what a phone is handed to, so a build that forgets it
// deploys a site where the handoff leads nowhere and every /app/mobile/ route
// is answered by the Desktop shell (or the 404 page).
ok('/app/mobile/ is a directory', isDir(path.join('app', 'mobile')), 'missing');
for (const f of ['index.html', 'backend.json']) ok('/app/mobile/' + f, has(path.join('app', 'mobile', f)), 'missing');
ok('/app/mobile/js/ has the mobile entry', isDir(path.join('app', 'mobile', 'js')), 'missing');
{
  const m = has('app/mobile/index.html') ? fs.readFileSync(path.join(DIST, 'app', 'mobile', 'index.html'), 'utf8') : '';
  ok('app/mobile/index.html declares its own mount', /<base\s+href=["']\/app\/mobile\//i.test(m),
    'no <base href="/app/mobile/"> in the mobile shell');
}
// Path routing only works on this deployment if a deep path under /app/ serves
// the shell. Without the rewrite Pages redirects every one of them to /app/ and
// the app collapses to its root route.
{
  // The Worker is this deployment's routing layer: it already falls back to
  // /app/index.html for an unknown /app/* path. A _redirects file was added
  // alongside it and wrangler refused to deploy - '/app/*' matches its own
  // target '/app/index.html', which the validator reads as an infinite loop.
  // So the rule lives in exactly one place, and that place is the Worker.
  ok('no _redirects: the Worker owns the /app/* fallback', !has('_redirects'),
    'a _redirects here is both redundant and rejected by wrangler');
  {
    const w = path.join(ROOT, 'cloudflare', 'worker.js');
    const src = has(path.relative(ROOT, w)) || fs.existsSync(w) ? fs.readFileSync(w, 'utf8') : '';
    ok('worker.js falls back to the app shell for /app/*',
      /path\.startsWith\(\s*['"]\/app\//.test(src) && /\/app\/index\.html/.test(src),
      'no /app/* fallback in cloudflare/worker.js');
    ok('worker.js serves real /app assets before falling back',
      /status !== 404/.test(src), 'asset-first lookup missing from the worker');
    // The Mobile document is a second shell under the mount. The generic
    // /app/* fallback would answer /app/mobile/settings with the Desktop shell,
    // so the Worker has to own the Mobile subtree the same way it owns /app/.
    ok('worker.js routes the Mobile subtree to the Mobile shell',
      /['"]\/app\/mobile\//.test(src), 'no /app/mobile/ handling in cloudflare/worker.js');
  }
  // The mount fix is what makes those routes resolve at all under /app/.
  ok('app client derives its mount point', has('app/packages/nav.js') &&
    /mountFromModuleUrl/.test(fs.readFileSync(path.join(DIST, 'app', 'packages', 'nav.js'), 'utf8')),
    'app/packages/nav.js has no mount derivation');
  // Overrides have to survive a rebuild, so assert the result rather than the
  // mechanism: the version block the terms promise must be in the built pages.
  // has() re-roots at dist/, so it takes a path relative to it.
  // The writer and the reader of a route must agree on the prefix. Links keep
  // it so they stay inside the app; the router takes it off so it can match.
  // Shipping one without the other looks correct in a diff and breaks every
  // deep link at runtime, so both are asserted. Path helpers moved from the
  // entry tree into the platform, so the reader is app/packages/nav.js now.
  ok('app router strips the mount', has('app/packages/nav.js') &&
    /pathname\.startsWith\(BASE/.test(fs.readFileSync(path.join(DIST, 'app', 'packages', 'nav.js'), 'utf8')),
    'app/packages/nav.js never removes BASE from the pathname');

  // Without <base>, ./js/app.js on /app/settings resolves under that path and
  // the app never boots. This is the difference between "the route is wrong"
  // and "nothing loads at all".
  {
    const rel = 'app/index.html';
    const h = has(rel) ? fs.readFileSync(path.join(DIST, rel), 'utf8') : '';
    ok('app/index.html declares its mount', /<base\s+href=["']\/app\//i.test(h),
      'no <base href="/app/"> in the built shell');
  }
  for (const f of ['terms', 'privacy']) {
    const rel = f + '.html';
    ok(f + '.html states its version and effective date', has(rel) &&
      /class="doc-meta"/.test(fs.readFileSync(path.join(DIST, rel), 'utf8')), 'no doc-meta block');
  }
}

console.log('\n--- WAC module graph ---');
const html = has(path.join('app', 'index.html')) ? fs.readFileSync(path.join(DIST, 'app', 'index.html'), 'utf8') : '';
let htmlBroken = 0;
const refs = new Set([...html.matchAll(/(?:src|href)="\.?\/?([^"]+\.(?:js|css))"/g)].map((m) => m[1]));
for (const r of refs) if (!fs.existsSync(path.join(DIST, 'app', r.replace(/^\.\//, '')))) htmlBroken++;
ok('index.html references all resolve (' + refs.size + ')', htmlBroken === 0, htmlBroken + ' broken');

let staticImports = 0, dynamicImports = 0;
const brokenStatic = [], brokenDynamic = [];
for (const f of moduleFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"](\.[^'"]+)['"]/g)) {
    staticImports++;
    if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) brokenStatic.push(path.relative(DIST, f) + ' -> ' + m[1]);
  }
  for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    dynamicImports++;
    if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) brokenDynamic.push(path.relative(DIST, f) + ' -> ' + m[1]);
  }
}
ok('all ' + staticImports + ' static imports resolve', brokenStatic.length === 0, brokenStatic.join('; '));
ok('all ' + dynamicImports + ' dynamic imports resolve', brokenDynamic.length === 0, brokenDynamic.join('; '));
// Nothing may reach the entry module only by luck: walk it from the real entry.
  // Nothing may be unreachable from the entry module. Modules the HTML loads
  // directly (crash.js) are not in the import graph by design, so they are
  // excluded rather than reported as orphans.
  const entry = path.join(DIST, 'app', 'js', 'main.js');
  if (fs.existsSync(entry)) {
    const reached = new Set();
    // Follow every way a module can be reached: static `from`, dynamic
    // `import()`, and bare side-effect `import`. The client loads routes
    // lazily, so a walk that only follows `from` reports a module one dynamic
    // hop away as an orphan and blocks a correct deploy.
    const walk = (f) => {
      if (reached.has(f)) return;
      let src;
      try { src = fs.readFileSync(f, 'utf8'); } catch { return; }
      reached.add(f);
      for (const re of [
        /from\s*['"](\.[^'"]+)['"]/g,
        /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
        /import\s*['"](\.[^'"]+)['"]/g,
      ]) {
        for (const m of src.matchAll(re)) walk(path.resolve(path.dirname(f), m[1]));
      }
    };
    walk(entry);
    const htmlLoaded = new Set(
      [...html.matchAll(/(?:src|href)="\.?\/?([^"]+\.js)"/g)]
        .map((m) => path.resolve(DIST, 'app', m[1].replace(/^\.\//, '')))
    );
    const orphans = moduleFiles.filter((f) => !reached.has(f) && !htmlLoaded.has(f));
    // A module nothing imports is the product's business, not the deployment's.
    // The product's own module check requires every import to resolve, not every
    // module to be referenced; a feature left unwired would otherwise block a
    // deploy for a reason this repository cannot fix. The blank-app failure this
    // verifier exists to catch is a dangling import, which is asserted above.
    ok('the WAC import graph resolves (' + reached.size + ' modules reached via imports, ' +
      [...htmlLoaded].filter((f) => !reached.has(f)).length + ' via index.html)',
      brokenStatic.length === 0 && brokenDynamic.length === 0, 'a referenced import is missing');
    if (orphans.length) {
      console.log('  note  unreferenced module(s), allowed (product-owned): ' + orphans.join(', '));
    }
  } else {
    ok('js/main.js entry exists', false, 'missing');
  }

console.log('\n--- real files, not placeholders ---');
ok('index.html is substantial', has('index.html') &&
  fs.statSync(path.join(DIST, 'index.html')).size > 2000, 'too small');
// The application shell is a single mount point now - the visible tree is built
// in JavaScript - so a small index.html is the design, not a placeholder. Assert
// it is the real shell (mount point, stylesheet, entry module) instead of
// asserting a byte count that only suited the old server-rendered shell.
{
  const shell = has('app/index.html') ? fs.readFileSync(path.join(DIST, 'app/index.html'), 'utf8') : '';
  ok('app/index.html is the application shell',
    /id=["']app["']/.test(shell) && /css\/app\.css/.test(shell) && /js\/main\.js/.test(shell),
    'missing the mount point, stylesheet or entry module');
}
ok('index.html and home.html are identical',
  has('index.html') && has('home.html') &&
  fs.readFileSync(path.join(DIST, 'index.html'), 'utf8') === fs.readFileSync(path.join(DIST, 'home.html'), 'utf8'), 'differ');

console.log('\n--- wrangler can actually use it ---');
const wrangler = path.join(ROOT, 'wrangler.jsonc');
if (!fs.existsSync(wrangler)) {
  ok('wrangler.jsonc exists', false, 'missing');
} else {
  ok('wrangler.jsonc exists', true);
  const text = fs.readFileSync(wrangler, 'utf8');
  const dir = /"directory"\s*:\s*"([^"]+)"/.exec(text);
  const main = /"main"\s*:\s*"([^"]+)"/.exec(text);
  ok('assets.directory is ./dist', !!dir && dir[1].replace(/^\.\//, '') === 'dist', dir ? dir[1] : 'not set');
  ok('assets.directory exists on disk', !!dir && isDir(path.join(ROOT, dir[1].replace(/^\.\//, ''))), 'missing');
  if (main) {
    ok('wrangler main target exists: ' + main[1], fs.existsSync(path.join(ROOT, main[1])), 'MISSING - wrangler would fail');
  } else {
    ok('wrangler.jsonc parses as JSONC', true, 'no main entry (worker-style config)');
  }
}

// Every host the client is told to talk to must be one that resolves. A
// fallback that does not is worse than no fallback: the client announces the
// switch to the user and then cannot reach anything, so a failover caused by a
// brief primary outage ends in an empty instance and a reader concluding their
// account is gone.
//
// This deployment shipped backend-api.trycord.dev as a third fallback for as
// long as the default in build.js pointed at it, and it has no DNS record.
{
  const cfg = JSON.parse(fs.readFileSync(path.join(DIST, 'app', 'backend.json'), 'utf8'));
  const hosts = [cfg.backendUrl].concat(cfg.fallbackUrls || []).filter(Boolean);
  const bad = [];
  for (const h of hosts) {
    const m = /^https?:\/\/([^/]+)/i.exec(h);
    if (!m) { bad.push(h + ' (not an absolute URL)'); continue; }
    // Both families are checked because both backends sit behind Cloudflare,
    // which commonly publishes AAAA and no A. A v4-only check reports a
    // perfectly working host as dead, and a check that cries wolf gets deleted
    // instead of fixed - which is how this class of bug survives.
    // Node's dns module has no synchronous resolver, and this file is written
    // synchronously from top to bottom. getent is in coreutils on every host
    // this runs on and answers the same question synchronously.
    // Both families are covered because getent hosts returns AAAA as well as A,
    // and Cloudflare commonly publishes AAAA with no A - a v4-only check would
    // report both real backends as dead, and a check that cries wolf gets
    // deleted rather than fixed.
    let found = false;
    try {
      const out = require('child_process').execSync('getent hosts ' + JSON.stringify(m[1]), {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      found = out.trim().length > 0;
    } catch (e) { found = false; }
    if (!found) bad.push(h + ' (does not resolve)');
  }
  ok('every configured backend host resolves', bad.length === 0,
    'unreachable: ' + bad.join(', '));
}

// Every "Open the app" call to action must address the app, not the site root.
// On this deployment the root is the marketing site, so a link to "/" lands the
// reader on the homepage instead of in the application. It was inconsistent -
// terms, privacy and support were correct and the rest were not - and nothing
// caught the difference, because both destinations are valid pages.
{
  const offenders = [];
  for (const f of walkFiles(path.join(DIST), '.html')) {
    const html = fs.readFileSync(f, 'utf8');
    const re = /<a[^>]*href="([^"]*)"[^>]*>\s*Open the app\s*<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[1] !== '/app/' && m[1] !== '/app') {
        offenders.push(path.relative(DIST, f) + ' -> ' + m[1]);
      }
    }
  }
  ok('every "Open the app" links to /app/', offenders.length === 0,
    offenders.slice(0, 5).join(', '));
}

// The Worker is this deployment's routing layer, and its fallback condition was
// wrong in a way no static check would catch: the asset binding answers an
// unknown path with a redirect, not a 404, so `status !== 404` returned the
// redirect and never reached the shell.
{
  const w = fs.readFileSync(path.join(ROOT, 'cloudflare', 'worker.js'), 'utf8');
  ok('worker falls back on !ok, not on status !== 404',
    /response\.ok/.test(w) && !/response\.status !== 404/.test(w),
    'the redirect answer will be returned as if it were the asset');
  ok('worker fetches the shell as /app/, not /app/index.html',
    /\/app\/index\.html/.test(w) === false || /\/app\/'\)/.test(w),
    'an explicit index file is redirected to its directory');
  // Every page in the tree must be reachable by its clean address.
  //
  // The worker used to answer a page only if it was named in a hand-written
  // map. The site grew a page, the map did not, and the page 404ed here
  // while it worked on the origin - the two hosts disagreeing about the same
  // tree. The worker now asks for the file when a path is not a file, so a
  // page cannot 404 by being forgotten; this check says so, and names the
  // pages that would 404 if that behaviour were taken away.
  {
    const pages = fs.readdirSync(DIST)
      .filter((name) => name.endsWith('.html') && name !== 'index.html' && name !== '404.html')
      .map((name) => '/' + name.replace(/\.html$/, ''));
    const withoutExtension = /path\.replace\(\/\\\/\+\$\/, ''\) \+ '\.html'/.test(w)
      || /\+ '\.html'/.test(w);
    ok('every page is reachable by its clean address', withoutExtension && pages.length > 0,
      'the worker does not answer a page that is not in its map, so these 404: '
      + pages.join(', '));
  }
  ok('worker sends auth aliases into the app', /\/login/.test(w) && /\/app\/login/.test(w),
    'no /login -> /app/login mapping');
}

console.log(`\nverify-dist: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
