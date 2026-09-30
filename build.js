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
//   node build.js                       # build PRODUCT_REF (default: main)
//   TRYCORD_REF=<sha> node build.js     # pin an exact commit
//   TRYCORD_REPO=<path-or-url> node build.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = process.env.TRYCORD_REPO || 'https://github.com/trycord/.trycord.git';
const REF = process.env.TRYCORD_REF || 'main';
const ROOT = __dirname;
const SRC = path.join(ROOT, '.build', 'src');
const DIST = path.join(ROOT, 'dist');

const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function fetchSource() {
  const isLocal = !/^(https?:|git@|ssh:)/.test(REPO);
  if (!fs.existsSync(path.join(SRC, '.git'))) {
    fs.rmSync(SRC, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(SRC), { recursive: true });
    process.stdout.write(`cloning ${REPO} @ ${REF}\n`);
    // A local path is the offline/dev case and cannot do a shallow branch
    // fetch, so it is cloned whole and then checked out.
    if (isLocal) {
      git('clone', '--quiet', REPO, SRC);
    } else {
      git('clone', '--quiet', '--depth', '1', '--branch', REF, REPO, SRC);
    }
  } else {
    process.stdout.write(`updating source to ${REF}\n`);
    if (isLocal) {
      git('-C', SRC, 'fetch', '--quiet', 'origin');
    } else {
      git('-C', SRC, 'fetch', '--quiet', '--depth', '1', 'origin', REF);
      git('-C', SRC, 'checkout', '--quiet', 'FETCH_HEAD');
    }
  }
  git('-C', SRC, 'checkout', '--quiet', '--force', REF);
  const head = git('-C', SRC, 'rev-parse', 'HEAD');
  process.stdout.write(`source at ${head}\n`);
  return head;
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

function build() {
  const publicSrc = path.join(SRC, 'public');
  const clientSrc = path.join(SRC, 'trycord-client');
  if (!fs.existsSync(publicSrc)) throw new Error('public/ missing from source at ' + publicSrc);
  if (!fs.existsSync(path.join(clientSrc, 'index.html'))) {
    throw new Error('trycord-client/index.html missing from source at ' + clientSrc);
  }
  if (fs.existsSync(path.join(clientSrc, 'app'))) {
    throw new Error('trycord-client/app exists; copying the client into dist/app/ would nest it');
  }

  // Clean rebuild: a stale file left behind by an older build is served
  // forever, which is how a removed page keeps answering requests.
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

  writeBackendConfig(path.join(app, 'backend.json'));
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
const BACKUP_URL = (process.env.TRYCORD_BACKEND_URL || 'https://backend-api.trycord.dev').replace(/\/+$/, '');

function writeBackendConfig(dest) {
  let cfg = {};
  const existing = path.join(SRC, 'trycord-client', 'backend.json');
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

const head = fetchSource();
build();
const n = fs.readdirSync(DIST, { recursive: true }).filter((f) => fs.statSync(path.join(DIST, f)).isFile()).length;
process.stdout.write(`\ndist/: ${n} files (source ${head})\n`);
process.stdout.write('now run: node verify-dist.js\n');
