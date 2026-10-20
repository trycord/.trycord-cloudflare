#!/usr/bin/env node
'use strict';

// The build's source fetching, checked.
//
// The deployment reported a build that cloned the wrong repository and then
// failed checking out FETCH_HEAD. The build in this repository has always
// named the product repository, so the failure was in a copy of the build
// somewhere else - which is exactly the kind of thing the build itself can
// defend against.
//
// The checks are about the behaviour that must hold whatever copy is running:
//
//   - the build refuses to fetch the deployment's own repository, and says
//     what it was told to fetch;
//   - a cold build of a branch works;
//   - a warm build of a branch picks up the new commit, not the old one;
//   - a build pinned to a commit works, cold and warm;
//   - a ref that does not exist fails the build rather than publishing the
//     tree of the last one;
//   - a fetch that fails leaves no tree, so a deploy cannot publish it.
//
// Every one of them is checked twice: once with a path on this machine,
// which is the offline case, and once with a URL, which is what a deployment
// fetches from.
//
// The URL case is the one that matters, and it is the one that was missing.
//
// The checks ran against a local path, and a local path is fetched by a
// different line of the build: it is cloned whole, and the branch is checked
// out by name. A URL is cloned shallowly, and the commit that was fetched is
// checked out by id.
//
// So the failure the deployment reported - "pathspec 'FETCH_HEAD' did not
// match any file(s) known to git" - could not happen in the checks, and the
// checks passed against a build that failed in production. A `file:` URL is
// fetched by the same code as an `https:` one, so the checks use it: the
// shallow clone, the fetch by id, the FETCH_HEAD, all of it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build.js');

let failures = 0;
let checks = 0;

function ok(condition, message) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.log('  FAIL  ' + message);
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

// A product repository with a public/, a frontend/ and a little content.
function makeSource() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-source-'));
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'frontend', 'js'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'frontend', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frontend', 'assets', 'favicon.svg'), '<svg/>');
  // The client carries the address of the instance it talks to, and the
  // build reads it to give the worker and the public site the same address.
  fs.writeFileSync(path.join(dir, 'frontend', 'backend.json'),
    JSON.stringify({ backendUrl: 'https://api.example.test' }));
  fs.writeFileSync(path.join(dir, 'public', 'home.html'), '<!doctype html><title>one</title>');
  fs.writeFileSync(path.join(dir, 'frontend', 'index.html'),
    '<!doctype html><html><head><title>app</title></head><body></body></html>');
  fs.writeFileSync(path.join(dir, 'frontend', 'js', 'main.js'), '// one\n');

  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'build@example.test'], dir);
  git(['config', 'user.name', 'Build'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'one'], dir);
  const first = git(['rev-parse', 'HEAD'], dir);

  git(['checkout', '-q', '-b', 'feature'], dir);
  fs.writeFileSync(path.join(dir, 'public', 'home.html'), '<!doctype html><title>two</title>');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'two'], dir);
  const second = git(['rev-parse', 'HEAD'], dir);
  git(['checkout', '-q', 'main'], dir);

  return { dir, first, second };
}

// A copy of the build that fetches from the given repository, in a directory
// of its own.
function makeBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-build-'));
  fs.copyFileSync(BUILD, path.join(dir, 'build.js'));
  fs.cpSync(path.join(ROOT, 'public-overrides'), path.join(dir, 'public-overrides'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wrangler.jsonc'), '{"name":"trycord","assets":{"directory":"./dist"}}');
  return dir;
}

function runBuild(dir, env) {
  const merged = Object.assign({}, process.env, { TRYCORD_REPO: env.repo, TRYCORD_REF: env.ref }, env.extra || {});
  try {
    const out = execFileSync(process.execPath, ['build.js'], {
      cwd: dir, encoding: 'utf8', env: merged, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: (error.stdout || '') + (error.stderr || ''), error };
  }
}

// The two ways a deployment can name the source.
//
// A path is the offline and development case. A URL is what a deployment
// fetches from, and the build fetches the two differently: a local path
// cannot do a shallow fetch, and a URL can.
const TRANSPORTS = [
  {
    name: 'a path on this machine',
    url: (dir) => dir,
    shallow: false,
  },
  {
    name: 'a URL',
    url: (dir) => 'file://' + dir,
    // A URL is cloned shallowly, and a path is not: a local path cannot do a
    // shallow fetch. So the clone says which of the two was used, and the
    // check looks at it. Without this the checks would pass against a build
    // that took the wrong path - which is how they passed against the build
    // that failed in production.
    shallow: true,
  },
];

for (const transport of TRANSPORTS) {
  console.log('\nthe build fetches the product source from ' + transport.name);

  const source = makeSource();
  const repo = transport.url(source.dir);

  // A cold build of a branch.
  {
    const dir = makeBuild();
    const result = runBuild(dir, { repo, ref: 'main' });
    ok(result.ok, 'a cold build of a branch failed:\n' + result.out);
    ok(fs.existsSync(path.join(dir, 'dist', 'index.html')), 'the cold build produced no tree');
    ok(fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8').indexOf('one') !== -1,
      'the cold build shipped the wrong content');

    // The source was fetched the way this transport is fetched.
    const clone = path.join(dir, '.build', 'src', '.git');
    const shallow = fs.existsSync(path.join(clone, 'shallow'));
    ok(shallow === transport.shallow,
      'the source was fetched the wrong way: the clone is '
      + (shallow ? 'shallow' : 'whole') + ', and this transport expects the opposite');

    // And the fetch left behind what the checkout reads, so a checkout of
    // FETCH_HEAD cannot fail with "pathspec 'FETCH_HEAD' did not match any
    // file(s) known to git" - which is the failure the deployment reported.
    ok(fs.existsSync(path.join(clone, 'FETCH_HEAD')),
      'the fetch left no FETCH_HEAD, so the checkout of it would fail');
  }

  // A warm build after the branch moved.
  {
    const dir = makeBuild();
    runBuild(dir, { repo, ref: 'main' });

    // The branch moves.
    fs.writeFileSync(path.join(source.dir, 'public', 'home.html'), '<!doctype html><title>three</title>');
    git(['add', '-A'], source.dir);
    git(['commit', '-q', '-m', 'three'], source.dir);

    const result = runBuild(dir, { repo, ref: 'main' });
    ok(result.ok, 'a warm build failed:\n' + result.out);
    ok(fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8').indexOf('three') !== -1,
      'the warm build shipped the old content: a build that fetched the newest '
      + 'source and then checked out the branch it already had');
  }

  // A build pinned to a commit, cold and warm.
  {
    const dir = makeBuild();
    const cold = runBuild(dir, { repo, ref: source.second });
    ok(cold.ok, 'a build pinned to a commit failed:\n' + cold.out);
    const warm = runBuild(dir, { repo, ref: source.second });
    ok(warm.ok, 'a warm build pinned to a commit failed:\n' + warm.out);
    const shipped = fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8');
    ok(shipped.indexOf('two') !== -1,
      'the build pinned to a commit shipped something else: ' + shipped);
  }

  // A ref that does not exist must fail the build, and must leave no tree.
  {
    const dir = makeBuild();
    runBuild(dir, { repo, ref: 'main' });
    ok(fs.existsSync(path.join(dir, 'dist', 'index.html')),
      'the first build produced no tree to go stale');

    const result = runBuild(dir, { repo, ref: 'no-such-branch' });
    ok(!result.ok, 'a build of a ref that does not exist succeeded');
    ok(!fs.existsSync(path.join(dir, 'dist', 'index.html')),
      'a failed build left the previous tree on disk, so a deploy would publish '
      + "yesterday's site as if it were new");
  }
}

console.log('\nthe build refuses to fetch the deployment\'s own repository');
{
  const dir = makeBuild();
  const result = runBuild(dir, {
    repo: 'https://github.com/trycord/.trycord-cloudflare.git',
    ref: 'main',
  });
  ok(!result.ok, 'the build fetched the deployment repository itself');
  ok(/deployment repository itself/i.test(result.out),
    'the refusal does not say what was wrong:\n' + result.out);
  ok(/FATAL/.test(result.out), 'the refusal is not marked as fatal:\n' + result.out);
}

console.log('\n' + checks + ' check(s), ' + failures + ' failure(s).');
process.exit(failures ? 1 : 0);
