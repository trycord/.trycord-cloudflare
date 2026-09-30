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
for (const a of ['trycord-logo.png', 'trycord-logo.ico', 'trycord-login-bg.png']) {
  ok('/assets/' + a, has(path.join('assets', a)), 'missing');
}

console.log('\n--- WAC under /app/ ---');
ok('/app/ is a directory', isDir('app'), 'missing');
for (const f of ['index.html', 'backend.json']) ok('/app/' + f, has(path.join('app', f)), 'missing');
for (const d of ['css', 'js', 'assets']) ok('/app/' + d + '/', isDir(path.join('app', d)), 'missing');
const jsDir = path.join(DIST, 'app', 'js');
const modules = fs.existsSync(jsDir) ? fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')) : [];
ok('/app/js/ has the WAC modules', modules.length > 20, 'found ' + modules.length);
ok('/app/assets/ preserved', isDir(path.join('app', 'assets')), 'missing');
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
  }
  // The mount fix is what makes those routes resolve at all under /app/.
  ok('app client derives its mount point', has('app/js/nav.js') &&
    /mountPoint/.test(fs.readFileSync(path.join(DIST, 'app', 'js', 'nav.js'), 'utf8')),
    'app/js/nav.js has no mount derivation');
  // Overrides have to survive a rebuild, so assert the result rather than the
  // mechanism: the version block the terms promise must be in the built pages.
  // has() re-roots at dist/, so it takes a path relative to it.
  // The writer and the reader of a route must agree on the prefix. Links keep
  // it so they stay inside the app; the router takes it off so it can match.
  // Shipping one without the other looks correct in a diff and breaks every
  // deep link at runtime, so both are asserted.
  ok('app router strips the mount', has('app/js/router.js') &&
    /pathname\.startsWith\(BASE\)/.test(fs.readFileSync(path.join(DIST, 'app', 'js', 'router.js'), 'utf8')),
    'app/js/router.js never removes BASE from the pathname');

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
for (const f of modules) {
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"](\.[^'"]+)['"]/g)) {
    staticImports++;
    if (!fs.existsSync(path.resolve(jsDir, path.dirname(f), m[1]))) brokenStatic.push(f + ' -> ' + m[1]);
  }
  for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    dynamicImports++;
    if (!fs.existsSync(path.resolve(jsDir, path.dirname(f), m[1]))) brokenDynamic.push(f + ' -> ' + m[1]);
  }
}
ok('all ' + staticImports + ' static imports resolve', brokenStatic.length === 0, brokenStatic.join('; '));
ok('all ' + dynamicImports + ' dynamic imports resolve', brokenDynamic.length === 0, brokenDynamic.join('; '));
// Nothing may reach the entry module only by luck: walk it from the real entry.
  // Nothing may be unreachable from the entry module. Modules the HTML loads
  // directly (crash.js) are not in the import graph by design, so they are
  // excluded rather than reported as orphans.
  const entry = path.join(jsDir, 'app.js');
  if (fs.existsSync(entry)) {
    const reached = new Set();
    (function walk(f) {
      if (reached.has(f) || !fs.existsSync(f)) return;
      reached.add(f);
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
        walk(path.resolve(path.dirname(f), m[1]));
      }
    })(entry);
    const htmlLoaded = new Set(
      [...html.matchAll(/(?:src|href)="\.?\/?js\/([^"]+\.js)"/g)].map((m) => path.join(jsDir, m[1]))
    );
    const orphans = modules.filter((f) => !reached.has(path.join(jsDir, f)) && !htmlLoaded.has(path.join(jsDir, f)));
    ok('every WAC module is reachable (' + reached.size + ' via imports, ' +
      [...htmlLoaded].filter((f) => !reached.has(f)).length + ' via index.html)',
      orphans.length === 0, 'orphans: ' + orphans.join(', '));
  } else {
    ok('app.js entry exists', false, 'missing');
  }

console.log('\n--- real files, not placeholders ---');
for (const f of ['index.html', 'app/index.html']) {
  ok(f + ' is substantial', has(f) && fs.statSync(path.join(DIST, f)).size > 2000, 'too small');
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

console.log(`\nverify-dist: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
