# .trycord-cloudflare

Deployment for the Trycord public site and web client on Cloudflare.

This repository contains **only the deployment**. The product source lives in
[trycord/.trycord](https://github.com/trycord/.trycord) and is fetched by the
build at a pinned ref, so there is exactly one copy of the source and this
repository cannot drift into carrying a stale fork of it.

## Contents

| Path | Purpose |
| --- | --- |
| `build.js` | Fetches the product source and builds `dist/`. The build's only implementation. |
| `verify-dist.js` | Asserts the built tree is deployable. Exits non-zero if it is not. |
| `build-pages.sh` | Thin wrapper that runs both, for the existing build entry point. |
| `wrangler.jsonc` | Cloudflare Worker + static assets configuration. |
| `cloudflare/worker.js` | The Worker: clean-URL routing into `dist/`. |
| `dist/` | The built deployment tree, committed so a deploy needs no build step. |

## Building

```bash
node build.js          # fetch the product source at TRYCORD_REF and build dist/
node verify-dist.js    # or: ./build-pages.sh, which runs both
```

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRYCORD_REPO` | `https://github.com/trycord/.trycord.git` | Product source. A local path also works. |
| `TRYCORD_REF` | `main` | Branch, tag or commit to build. Pin a SHA for a reproducible deploy. |

```bash
TRYCORD_REF=<sha> node build.js
```

The build clones into `.build/`, which is gitignored. The resolved commit is
printed so a deploy can be traced back to a source revision.

## Deploying

```bash
npx wrangler deploy
```

`dist/` is committed, so `wrangler deploy` alone is enough. Rebuild and commit
`dist/` whenever the product source changes; nothing regenerates it implicitly.

## Deploy tree shape

```
dist/
  index.html          public site at the root (from welcome.html or home.html)
  *.html  css/  js/   public site pages
  assets/             brand images, republished from the WAC tree
  app/                the web client
    index.html  js/  css/  assets/  backend.json
```

Two details are easy to get wrong and are asserted by `verify-dist.js`:

- **`index.html` must exist at the root.** The public source has used both
  `welcome.html` and `home.html` for the homepage. The build accepts either and
  fails loudly if it finds neither, because a missing `index.html` takes the
  whole site root down rather than degrading one page.
- **`assets/` must exist at the root.** The public pages and the web client both
  reference `/assets/...` absolutely, the client lives under `dist/app/`, and
  the product repo keeps one copy of the brand images. `build.js` republishes
  them at the deployment root.

## Why the build is one file

`build-pages.sh` and `verify-dist.js` previously had separate bash and Node
implementations of the same copy steps. The two drifted, the verifier went on
reporting 34/36 while asserting a tree the build no longer produced, and a
brand image 404'd in production. The logic now lives once, in `build.js`, and
both entry points run it.

`verify-dist.js` also checks the web client's module graph: 172 static imports,
4 dynamic imports, and that every module is reachable from the `app.js` entry
either by import or by a `<script>` tag. A dangling import renders a blank app
with no other signal, and neither the build nor a Wrangler deploy would notice.
