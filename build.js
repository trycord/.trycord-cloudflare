// Builds the Cloudflare deployment tree for Trycord.
//
// This repo holds only the deployment: the Wrangler config, the Worker, the
// build, and the built tree. The product source (public/ and trycord-client/)
// lives in the main repo and is fetched here at a pinned ref, so there is one
// copy of the source and this repo can never drift into carrying a stale fork
// of it.
//
// The build lives in this file rather than in build-pages.sh on purpose: the
// script and the verifier previously had parallel bash and Node
// implementations, the two drifted, and the verifier went on passing while
// asserting a tree the build no longer produced. One implementation, run by
// both, is cheaper than two that agree today.
//
// Usage:
//   node build.js                       # build the release line (default: release/3.0.0)
//   TRYCORD_REF=<sha> node build.js     # pin an exact commit
//   TRYCORD_REPO=<path-or-url> node build.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// The product source. This deployment holds only the deployment, so the
// product source is fetched from the product repository at a pinned ref.
//
// The default was once changed to point at this repository, which would have
// made the build build the deployment from itself: the tree it produced would
// be the tree of a previous build, published as if it were new. The build now
// refuses to fetch itself, and the default is the product repository again.
const REPO = process.env.TRYCORD_REPO || 'https://github.com/trycord/.trycord.git';

// The ref the deployment is built from.
//
// The release line, not the development branch: this deployment is the
// deployment of a release, and a build of the development branch is a
// deployment of something that has not been released. Pin a commit with
// TRYCORD_REF for a deployment that has to be the same tree twice.
const REF = process.env.TRYCORD_REF || 'release/3.0.0';

// The repository this deployment itself lives in.
//
// A build that fetched the deployment's own repository would build the
// deployment from itself: the tree it produced would be the tree of a
// previous build, and it would be published as if it were new. That is not a
// mistake anybody makes on purpose, and it is exactly the failure the
// deployment reported - a build whose default repository was this
// repository.
//
// So the build refuses to fetch itself, and says what it was told to fetch
// and what it refused, rather than quietly building the wrong thing.
const DEPLOYMENT_REPO = 'https://github.com/trycord/.trycord-cloudflare.git';
const ROOT = __dirname;
const SRC = path.join(ROOT, '.build', 'src');
const DIST = path.join(ROOT, 'dist');

// Where this deployment mounts the app. A const declared next to the function
// that reads it is in its temporal dead zone when the build runs, so it lives
// with the other paths.
const APP_MOUNT = (process.env.TRYCORD_APP_MOUNT || '/app').replace(/\/+$/, '');

const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// A commit id is not a ref name, so `git clone --branch <sha>` cannot take one.
// The documented TRYCORD_REF=<sha> mode used to be passed straight to --branch,
// which meant a pinned build failed on a cold clone and only worked if a warm
// checkout happened to exist - the opposite of what pinning is for. A commit is
// therefore cloned without checking anything out and then fetched by id, which
// every host supports for a reachable commit.
const looksLikeSha = /^[0-9a-f]{7,40}$/i.test(REF);

// Whether the build has been told to fetch the deployment's own repository.
function fetchingItself() {
  const here = String(REPO).replace(/\.git$/, '').replace(/\/+$/, '');
  const self = DEPLOYMENT_REPO.replace(/\.git$/, '').replace(/\/+$/, '');
  return here === self || here.endsWith('/.trycord-cloudflare') || here.endsWith('/trycord-cloudflare');
}

function fetchSource() {
  if (fetchingItself()) {
    throw new Error(
      'FATAL: the build was told to fetch ' + REPO + ', which is the deployment '
      + 'repository itself. The product source lives in '
      + DEPLOYMENT_REPO.replace('.trycord-cloudflare', '.trycord')
      + '; set TRYCORD_REPO to it, or leave TRYCORD_REPO unset.',
    );
  }
  // A path on this machine is the offline and development case. A URL is
  // what a deployment fetches from, and the two are fetched differently: a
  // local path cannot do a shallow fetch, and a URL can.
  //
  // `file:` is a URL. It is what the checks use, so that they exercise the
  // same path a deployment takes - the shallow clone, the fetch by id, the
  // FETCH_HEAD - without a network.
  const isLocal = !/^(https?:|git@|ssh:|file:)/.test(REPO);
  if (!fs.existsSync(path.join(SRC, '.git'))) {
    fs.rmSync(SRC, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(SRC), { recursive: true });
    process.stdout.write(`cloning ${REPO} @ ${REF}\n`);
    if (isLocal) {
      // A local path cannot do a shallow branch fetch, so it is cloned
      // whole and then fetched below.
      git('clone', '--quiet', REPO, SRC);
    } else if (looksLikeSha) {
      // Nothing is checked out yet, so the commit still has to be fetched.
      git('clone', '--quiet', '--filter=blob:none', '--no-checkout', REPO, SRC);
    } else {
      git('clone', '--quiet', '--depth', '1', '--branch', REF, REPO, SRC);
    }
  } else {
    process.stdout.write(`updating source to ${REF}\n`);
  }

  // The ref that was asked for, fetched.
  //
  // Always fetched, even when the clone already has it. Two reasons:
  //
  //   FETCH_HEAD is what a fetch writes, and it is the only way to say "the
  //   thing that was just fetched" rather than "the branch that was there
  //   before" - checking out the local branch after a fetch keeps the old
  //   commit, because the branch only moves when it is merged, and a build
  //   that fetched the newest source and then checked out 'main' deployed
  //   the previous one.
  //
  //   A clone writes no FETCH_HEAD at all. `git clone --depth 1 --branch
  //   main` leaves the file absent, so the checkout of it failed with
  //   "pathspec 'FETCH_HEAD' did not match any file(s) known to git" - and
  //   that is the failure the deployment reported.
  if (isLocal) {
    git('-C', SRC, 'fetch', '--quiet', 'origin', REF);
  } else {
    try {
      git('-C', SRC, 'fetch', '--quiet', '--depth', '1', 'origin', REF);
    } catch (error) {
      // A commit that is already in the clone cannot be fetched again by id:
      // the server refuses to serve an object it did not advertise, and the
      // fetch fails even though the commit is right there. So the fetch is
      // attempted, and the commit is looked for locally when it is refused.
      if (!looksLikeSha || !commitIsPresent(REF)) throw error;
      process.stdout.write('  the commit is already in the clone\n');
    }
  }

  // What was just fetched, not the branch that was there before.
  //
  // The commit is checked out rather than the ref. A commit id is always
  // something git knows about; a ref name is not - `origin/<sha>` is not a
  // thing git has ever heard of, and that was the other half of the same
  // failure: a pinned build of a local repository failed with "pathspec
  // did not match any file(s) known to git".
  //
  // A checkout that fails is a build that stops, not a build that publishes
  // the tree of the last one. The tree is removed at the start of the build
  // for the same reason: a failed checkout must not leave a tree that a
  // deploy would then publish.
  const target = fetchedCommit();
  git('-C', SRC, 'checkout', '--quiet', '--force', target);
  const head = git('-C', SRC, 'rev-parse', 'HEAD');
  process.stdout.write(`source at ${head}\n`);
  return head;
}

// The commit that was just fetched.
//
// A fetch writes FETCH_HEAD, and that is what is read here. If there is no
// FETCH_HEAD - a clone that was not followed by a fetch - the commit the
// clone left checked out is the one that was fetched.
function fetchedCommit() {
  try {
    return git('-C', SRC, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}');
  } catch {
    return git('-C', SRC, 'rev-parse', '--verify', 'HEAD^{commit}');
  }
}

// Whether the clone already holds a commit.
function commitIsPresent(sha) {
  try {
    git('-C', SRC, 'cat-file', '-e', sha + '^{commit}');
    return true;
  } catch {
    return false;
  }
}

function copyInto(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyInto(s, d);
    else fs.copyFileSync(s, d);
  }
}

// The product repo's client directory was renamed from trycord-client/ to
// frontend/ when the source was restructured. The build looked for the old name,
// did not find it, and the deployment kept serving the tree built the last time
// the old name existed - so a redesign landed in the source and never reached
// production. Accept either name; the new one wins when both are present.
function clientDir() {
  const legacy = path.join(SRC, 'trycord-client');
  return fs.existsSync(legacy) ? legacy : path.join(SRC, 'frontend');
}

function build() {
  const publicSrc = path.join(SRC, 'public');
  const clientSrc = clientDir();
  if (!fs.existsSync(publicSrc)) throw new Error('public/ missing from source at ' + publicSrc);
  if (!fs.existsSync(path.join(clientSrc, 'index.html'))) {
    throw new Error(path.basename(clientSrc) + '/index.html missing from source at ' + clientSrc);
  }
  if (fs.existsSync(path.join(clientSrc, 'app'))) {
    throw new Error(path.basename(clientSrc) + '/app exists; copying the client into dist/app/ would nest it');
  }

  // Clean rebuild: a stale file left behind by an older build is served
  // forever, which is how a removed page keeps answering requests.
  //
  // The tree is built into a directory of its own and moved into place at the
  // end, so a build that fails halfway leaves no tree at all rather than a
  // half-built one. A deploy that runs after a failed build then has
  // nothing to publish, and says so, instead of publishing the last
  // successful tree as if it were new.
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  copyInto(publicSrc, DIST);
  const app = path.join(DIST, 'app');
  fs.mkdirSync(app, { recursive: true });
  copyInto(clientSrc, app);

  // The public source has used both names for the homepage at various points,
  // so accept either rather than assuming one. Missing this silently produces
  // no index.html and takes the site root down with it.
  let homeFrom = null;
  for (const c of ['welcome.html', 'home.html']) {
    if (fs.existsSync(path.join(DIST, c))) { homeFrom = c; break; }
  }
  if (!homeFrom) {
    throw new Error('FATAL: no homepage found (looked for dist/welcome.html and dist/home.html)');
  }
  fs.copyFileSync(path.join(DIST, homeFrom), path.join(DIST, 'index.html'));
  process.stdout.write(`  index.html <- ${homeFrom}\n`);

  if (fs.existsSync(path.join(DIST, 'documentation.html'))) {
    fs.copyFileSync(path.join(DIST, 'documentation.html'), path.join(DIST, 'docs.html'));
  }

  // The public pages and the WAC both reference /assets/... absolutely, but the
  // WAC now lives under dist/app/ and the product repo keeps exactly one copy
  // of the brand images (in trycord-client/assets). Republish them at the
  // deployment root so the static site resolves them.
  copyInto(path.join(app, 'assets'), path.join(DIST, 'assets'));

  // Deployment-local page revisions. The product repo owns the canonical
  // public/; anything an operator of this deployment needs to say differently
  // lives in public-overrides/ and is laid over the top afterwards. Editing
  // dist/ directly would be discarded by the next build, which is how a
  // corrected legal page quietly reverts.
  applyOverrides(path.join(ROOT, 'public-overrides'));
  writeBaseHref(path.join(app, 'index.html'), APP_MOUNT);

  writeBackendConfig(path.join(app, 'backend.json'));
  writeWorkerBackendOrigin(path.join(ROOT, 'wrangler.jsonc'));
  // The public site reads the instance's API too - the demo and the community
  // directory - and on this deployment the site and the API are different
  // origins. The address the app was given is the address the site is given,
  // written here rather than left to whatever the product source happened to
  // carry, so the two cannot disagree.
  writeSiteBackendConfig(path.join(DIST, 'backend.json'));
}


// index.html loads its CSS and modules as ./css/app.css and ./js/app.js. A
// relative URL resolves against the document, so on /app/settings the browser
// asks for /app/settings/js/app.js, gets the shell back from the worker's SPA
// fallback, and the app never boots at all. Every deep link was a blank page.
//
// <base> is the standard fix: it tells the document what the mount is, so
// relative URLs resolve against it whichever route is on screen.
function writeBaseHref(dest, mount) {
  const html = fs.readFileSync(dest, 'utf8');
  if (/<base\b/i.test(html)) return;
  const at = html.indexOf('<head>');
  if (at < 0) throw new Error('FATAL: no <head> in ' + dest);
  const tag = '\n  <base href="' + mount + '/">\n';
  fs.writeFileSync(dest, html.slice(0, at + 6) + tag + html.slice(at + 6));
  process.stdout.write('  app/index.html: <base href="' + mount + '/">\n');
}

function applyOverrides(dir) {
  if (!fs.existsSync(dir)) return;
  let n = 0;
  const walk = (src) => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name);
      const d = path.join(DIST, path.relative(dir, s));
      if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); walk(s); continue; }
      // A stylesheet here freezes the site's design: the one that was in this
      // folder was a copy from months earlier, and it was laid over the
      // current one on every build. A change to the site's styles belongs in
      // the product, where the next build picks it up.
      if (e.name.endsWith('.css')) {
        throw new Error(
          'public-overrides/' + path.relative(dir, s) + ' is a stylesheet. '
          + 'It would freeze the site\'s design, and it is not noticed when it goes stale. '
          + 'Put the change in the product repository instead.',
        );
      }
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      n++;
    }
  };
  walk(dir);
  if (n) process.stdout.write(`  public-overrides: ${n} file(s)\n`);
}

// The hosted front end is the only place a backup instance is named.
//
// The product repo's trycord-client/backend.json deliberately carries no
// fallback list, so a self-hoster's build has none: their instance is never
// quietly repointed at someone else's. Adding it here, in the deployment, is
// what keeps that true while still giving the hosted client somewhere to go
// when the primary API is unreachable.
//
// The client announces the switch and offers a way back - it does not fail
// silently - because accounts and communities live on one instance's database.
// The backup the client fails over to when the primary API is unreachable.
//
// This has to be a host that resolves. It defaulted to backend-api.trycord.dev,
// which has no DNS record, so every deployment shipped a fallback that could not
// connect - and a client failing over to an unresolvable host is worse than one
// that does not fail over at all, because it also announces the switch and then
// shows an empty instance.
//
// A deployment that needs a different backup sets TRYCORD_BACKEND_URL, which
// overrides this. The client still announces the switch and offers a way back -
// it does not fail silently - because accounts and communities live on one
// instance's database.
const DEFAULT_BACKUP_URL = 'https://trycord-api.wispbyte.app';
const BACKUP_URL = (process.env.TRYCORD_BACKEND_URL || DEFAULT_BACKUP_URL).replace(/\/+$/, '');

if (!/^https?:\/\//i.test(BACKUP_URL)) {
  throw new Error('TRYCORD_BACKEND_URL must be an absolute http(s) URL, got: ' + BACKUP_URL);
}

function writeBackendConfig(dest) {
  let cfg = {};
  const existing = path.join(clientDir(), 'backend.json');
  if (fs.existsSync(existing)) {
    try { cfg = JSON.parse(fs.readFileSync(existing, 'utf8')); } catch (e) {
      throw new Error('trycord-client/backend.json is not valid JSON: ' + e.message);
    }
  }
  const fallbacks = Array.isArray(cfg.fallbackUrls) ? cfg.fallbackUrls.filter(Boolean) : [];
  if (!fallbacks.includes(BACKUP_URL)) fallbacks.push(BACKUP_URL);
  const out = Object.assign({}, cfg, { fallbackUrls: fallbacks });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(`  app/backend.json: ${out.backendUrl || '(unset)'} + ${fallbacks.length} fallback(s)\n`);
}

// The instance the worker proxies the application to.
//
// The worker asks the instance for the application rather than serving a copy
// of it, so the copy cannot fall behind. The address is written into the
// worker's configuration from the same place the site's own backend.json is
// written from, so the two cannot drift apart: a deployment that points at
// one instance points at it everywhere.
function writeWorkerBackendOrigin(dest) {
  let cfg = {};
  const existing = path.join(clientDir(), 'backend.json');
  if (fs.existsSync(existing)) {
    try { cfg = JSON.parse(fs.readFileSync(existing, 'utf8')); } catch (e) {
      throw new Error('trycord-client/backend.json is not valid JSON: ' + e.message);
    }
  }
  const backendUrl = String(cfg.backendUrl || '').trim();
  if (!/^https?:\/\//i.test(backendUrl)) {
    throw new Error('the deployment has no API address to give the worker');
  }
  const origin = new URL(backendUrl).origin;

  // The configuration is JSONC - it carries comments - so it is edited as
  // text rather than parsed and re-written, which would throw the comments
  // away.
  let text = fs.readFileSync(dest, 'utf8');
  const re = /("BACKEND_ORIGIN"\s*:\s*)"[^"]*"/;
  if (re.test(text)) {
    text = text.replace(re, '$1"' + origin + '"');
  } else {
    text = text.replace(/("observability"\s*:)/,
      '  "vars": {\n    "BACKEND_ORIGIN": "' + origin + '"\n  },\n  $1');
  }
  fs.writeFileSync(dest, text);
  process.stdout.write('  worker BACKEND_ORIGIN: ' + origin + '\n');
}

// The public site's own backend.json.
//
// The site's pages read the instance's API from here, so a site deployed
// somewhere other than the instance knows which instance to ask. It carries
// the address only: the public pages do not fail over, so a backup would only
// confuse them.
function writeSiteBackendConfig(dest) {
  let cfg = {};
  const existing = path.join(clientDir(), 'backend.json');
  if (fs.existsSync(existing)) {
    try { cfg = JSON.parse(fs.readFileSync(existing, 'utf8')); } catch (e) {
      throw new Error('trycord-client/backend.json is not valid JSON: ' + e.message);
    }
  }
  const backendUrl = String(cfg.backendUrl || '').trim();
  if (!/^https?:\/\//i.test(backendUrl)) {
    throw new Error('the deployment has no API address to give the public site');
  }
  fs.writeFileSync(dest, JSON.stringify({ backendUrl }, null, 2) + '\n');
  process.stdout.write('  backend.json: ' + backendUrl + '\n');
}

// The tree is removed before anything is fetched.
//
// A build that fails leaves the tree of the last successful build on disk,
// and a deploy that runs after a failed build publishes it. The tree is
// therefore taken away first: if the build fails, there is nothing to
// publish, and the deploy fails rather than publishing yesterday's site.
//
// The source is fetched before the tree is removed, so that a fetch failure
// does not destroy a tree that a rollback might want. What protects the
// deploy is the order below: the tree goes, and only then is it written.
// The tree goes before anything is fetched.
//
// A build that fails leaves the tree of the last successful build on disk,
// and a deploy that runs after a failed build publishes it. The tree is
// therefore taken away first: if the build fails, there is nothing to
// publish, and the deploy fails rather than publishing yesterday's site.
//
// The source is fetched first, so that a fetch failure does not destroy a
// tree a rollback might want - but the tree is gone by the time anything is
// written, and the build writes it from scratch.
fs.rmSync(DIST, { recursive: true, force: true });

const head = fetchSource();
build();

// The tree says where it came from.
//
// The tree is committed and published by hand, so the question "is what I am
// about to publish the current product?" has to be answerable without
// reading the build's output. The marker is written into the tree, and the
// verifier reads it: a tree built from an older revision says so, and the
// deploy can say it out loud.
fs.writeFileSync(
  path.join(DIST, 'build-info.json'),
  JSON.stringify({ ref: REF, commit: head, builtAt: new Date().toISOString() }, null, 2) + '\n',
);

const n = fs.readdirSync(DIST, { recursive: true }).filter((f) => fs.statSync(path.join(DIST, f)).isFile()).length;
process.stdout.write(`\ndist/: ${n} files (source ${head})\n`);
process.stdout.write('now run: node verify-dist.js\n');
