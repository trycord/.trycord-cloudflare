// Routing for trycord.dev.
//
// Two surfaces share this origin: the public website at the root, and the WAC
// application under /app/. Everything that decides which one answers a request
// is in this file, because Cloudflare Pages-style _redirects is not an option
// here - wrangler validates it and rejects a rule whose target matches its own
// source pattern.
//
// The app is a single-page application, so any path under /app/ that is not a
// real file has to be answered with its shell and left to the client router.
// Getting that wrong is subtle: the asset binding does NOT answer an unknown
// path with a 404. It answers with a redirect to the containing directory, so a
// fallback written as `if (status !== 404)` never fires and every route in the
// app bounces to /app/.

// A path whose last segment carries a file extension is an asset, not a client
// route. The origin draws the same line (serve-client.js: `/\.[a-z0-9]+$/`), and
// it has to be drawn here too or the two hosts disagree: the generic fallback
// below answers a missing module with the shell, so a typo or a stale reference
// arrives at the browser as HTML where it expected JavaScript - a MIME/syntax
// error a long way from the cause, instead of a 404 at the address that is wrong.
const ASSET_PATH = /\.[a-z0-9]+$/i;

// The public 404 page, with a 404 status. Fetching it plainly would return a 200
// carrying the not-found page, so a client checking status would read a missing
// path as a real one.
async function notFound(request, env) {
  const page = await env.ASSETS.fetch(
    new Request(new URL('/404.html', request.url), request),
  );
  return new Response(page.body, { status: 404, headers: page.headers });
}

// The instance the application is served from.
//
// The application is the product. The instance serves it, at the version the
// instance is running, and it is the instance that knows the mount, the
// client routes and the assets. This deployment carries the *website*.
//
// So the application is proxied rather than copied.
//
// It used to be copied: the build put a snapshot of the client into
// dist/app/ and the worker served that snapshot. A snapshot goes stale the
// moment the instance moves, and it did - for as long as the site was
// published from a tree that had not been rebuilt, a reader who opened the
// application on trycord.dev was given the client of an older release, with
// the older register form and the older console, while the same reader on
// api.trycord.dev was given the current one. Two addresses, two products.
//
// A proxy cannot go stale. The worker asks the instance for the application
// and passes the answer on.
const BACKEND_VAR = 'BACKEND_ORIGIN';

// Where the application lives, or null when the deployment was not told.
function backendOrigin(env) {
  const configured = String((env && env[BACKEND_VAR]) || '').trim();
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

// The application's own answer, passed on as it is.
//
// The status, the content type, the cache headers and the redirects all
// belong to the instance: the instance knows whether a route is a document,
// an asset or a client route, and it knows what a redirect means.
async function proxyApp(request, env, origin) {
  const target = new URL(request.url);
  const base = new URL(origin);
  target.protocol = base.protocol;
  target.host = base.host;
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', base.host);
  headers.set('X-Forwarded-Proto', base.protocol);
  let response;
  try {
    response = await fetch(new Request(target, request));
  } catch (error) {
    return unavailable(request, env, error);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// The page's own metadata.
//
// The instance adds the canonical link and the social tags to the pages it
// serves, using its own address. This deployment serves the same files from
// the asset binding, so it has to do the same thing - otherwise the pages
// here have no canonical address and no link preview, while the instance's
// own copy of the same files has both.
//
// The address is the one the request came in on, so a self-hosted deployment
// points at itself and never at somebody else's site.
async function withPageMeta(request, response) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let html;
  try {
    html = await response.text();
  } catch {
    return response;
  }
  if (!html.includes('</head>')) return response;

  const origin = new URL(request.url).origin;
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const url = origin + path;
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const titleM = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const descM = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html);
  const title = titleM ? esc(titleM[1].trim()) : 'Trycord';
  const image = origin + '/assets/trycord-assets/app/trycord-og-image.png';
  const meta = [
    '<link rel="canonical" href="' + esc(url) + '">',
    '<meta property="og:url" content="' + esc(url) + '">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Trycord">',
    '<meta property="og:title" content="' + title + '">',
    '<meta property="og:image" content="' + esc(image) + '">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + title + '">',
    '<meta name="twitter:image" content="' + esc(image) + '">',
  ];
  if (descM) {
    meta.push('<meta property="og:description" content="' + esc(descM[1]) + '">');
    meta.push('<meta name="twitter:description" content="' + esc(descM[1]) + '">');
  }
  const head = html.replace('</head>', '  ' + meta.join('\n  ') + '\n</head>');
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(head, { status: response.status, statusText: response.statusText, headers });
}

// The instance could not be reached.
//
// The page says so, in words, and offers a retry. It does not serve a copy
// of the application: a copy is what got stale in the first place, and a
// reader would be given an old client and no idea that anything was wrong.
async function unavailable(request, env) {
  const body = await env.ASSETS.fetch(
    new Request(new URL('/404.html', request.url), request),
  );
  const html = await body.text();
  const notice = `
    <div style="max-width:34rem;margin:6rem auto;padding:0 1.5rem;font:16px/1.6 system-ui,sans-serif;color:#e8e8ea">
      <h1 style="font-size:1.6rem;margin:0 0 .6rem">The application is not answering</h1>
      <p style="margin:0 0 1rem;color:#a9a9b0">This site could not reach the Trycord instance that serves the
      application. The site itself is fine; the instance is not answering at the moment.</p>
      <p style="margin:0 0 1.4rem;color:#a9a9b0">If you are the operator, the instance is the thing to
      look at. If you are a reader, try again in a moment.</p>
      <a href="${request.url}" style="display:inline-block;padding:.6rem 1.1rem;border-radius:8px;background:#ff4d24;color:#fff;text-decoration:none;font-weight:600">Try again</a>
    </div>`;
  const page = html.replace('</body>', notice + '</body>');
  return new Response(page, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '30' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // The application's own paths, reachable from the root of the site.
    //
    // Auth is part of the application, not the website. Someone who bookmarked
    // /login or followed a link from elsewhere should land on the app's own
    // sign-in rather than the public 404, but the canonical location is under
    // /app/ - a redirect rather than a second copy, so there is exactly one
    // place a session is established from.
    //
    // The application's home is the same. `/home` is the application's home
    // route, and the public homepage has its own address, which is `/`. So
    // `/home` is redirected into the application rather than answered with a
    // second copy of the marketing page - which is what the catch-all below
    // did with it, because the public site keeps its homepage in a file
    // called home.html.
    const APP_ALIASES = {
      '/login': '/app/login',
      '/register': '/app/register',
      '/forgot': '/app/forgot',
      '/home': '/app/home',
    };
    // A trailing slash is the same path: `/home/` is `/home`.
    const alias = APP_ALIASES[path] || APP_ALIASES[path.replace(/\/+$/, '')];
    if (alias) {
      return Response.redirect(new URL(alias, request.url), 302);
    }

    // The origin also serves the Mobile module at the origin-root alias /mobile/
    // (serve-client.js registers it beside /app/mobile/). Here the root belongs to
    // the public website, so the alias is a redirect to the canonical mounted
    // location rather than a second copy of the document - one place the base and
    // the router agree, exactly as /app and /app/mobile are handled.
    if (path === '/mobile' || path.startsWith('/mobile/')) {
      const rest = path.slice('/mobile'.length).replace(/^\/+/, '');
      return Response.redirect(new URL('/app/mobile/' + rest, request.url), 302);
    }

    // Public clean routes
    // The homepage is addressed as the directory, never as /index.html. The
    // asset binding redirects a request for an explicit index file to its
    // directory, so mapping '/' onto '/index.html' asks for /index.html, gets
    // redirected back to '/', and asks again.
    const publicRoutes = {
      '/': '/',
      '/welcome': '/',
      '/features': '/features.html',
      '/docs': '/docs.html',
      '/developers': '/developers.html',
      '/download': '/download.html',
      '/about': '/about.html',
      '/support': '/support.html',
      '/security': '/security.html',
      '/status': '/status.html',
      '/privacy': '/privacy.html',
      '/terms': '/terms.html',
      '/instances-terms': '/instances-terms.html',
      '/trust-and-safety': '/trust-and-safety.html',
    };

    if (publicRoutes[path]) {
      const page = await env.ASSETS.fetch(
        new Request(new URL(publicRoutes[path], request.url), request),
      );
      return withPageMeta(request, page);
    }

    if (path === '/app') {
      return Response.redirect(new URL('/app/', request.url), 302);
    }

    // The shell. Asked for as /app/ rather than /app/index.html, because the
    // asset binding redirects a request for an index file to its directory -
    // which is the same redirect that broke the fallback below.
    if (path === '/app/') {
      return env.ASSETS.fetch(new Request(new URL('/app/', request.url), request));
    }

    // The Mobile module is a second entry document under the same mount, at
    // /app/mobile/. It is its own shell with its own <base>, so a deep link
    // inside it has to be answered with the Mobile document, not the Desktop
    // one: the generic /app/* fallback below would hand a phone at
    // /app/mobile/settings the Desktop shell, whose router has no such route,
    // and the reader would see the not-found screen with the site chrome still
    // around it. The directory path is a redirect to the trailing-slash form so
    // the document and its <base> agree, exactly as /app is handled above.
    if (path === '/app/mobile') {
      return Response.redirect(new URL('/app/mobile/', request.url), 302);
    }

    // The application comes from the instance, not from this deployment.
    //
    // The instance serves the client at its own mount, knows its own routes
    // and its own assets, and is at the version it is running. A copy in the
    // deployment is a copy that falls behind, and a reader who arrives at
    // trycord.dev is then given a different product from the one the instance
    // serves.
    const origin = backendOrigin(env);
    if (origin && path.startsWith('/app/')) {
      return proxyApp(request, env, origin);
    }

    if (path.startsWith('/app/')) {
      // No instance was configured, so the deployment's own copy is used. It
      // is the fallback, not the rule.
      const response = await env.ASSETS.fetch(request);

      // `response.ok` rather than `status !== 404`: a real asset is a 2xx, and
      // everything else under /app/ is a client route.
      if (response.ok) return response;
      // The same asset/route line as the origin and the Mobile branch above.
      if (ASSET_PATH.test(path)) return notFound(request, env);

      return env.ASSETS.fetch(new Request(new URL('/app/', request.url), request));
    }

    // Real files at the site root - stylesheets, scripts, images, favicons,
    // and any page not in the clean-route map above.
    //
    // This has to come BEFORE the 404 fallback. The fallback used to be
    // unconditional, so /css/site.css and /js/site.js were answered with
    // 404.html: the browser was handed HTML where it expected CSS and JS, so
    // the entire public site loaded unstyled and inert.
    const direct = await env.ASSETS.fetch(request);
    if (direct.ok) return withPageMeta(request, direct);

    // A page addressed without its extension.
    //
    // The clean-route map above is a hand-written list, and a hand-written
    // list is a list that goes stale: the site grew a page, the map did
    // not, and the page 404ed here while it worked on the origin. Every
    // page in the tree is a file with a name, so a path that is not a file
    // may still be a page - and the answer is to ask for the file.
    //
    // This is what makes the map above a convenience rather than a
    // requirement: a page that is not in it is still answered, and a page
    // that is in it is answered the same way.
    if (!ASSET_PATH.test(path) && path !== '/') {
      const page = await env.ASSETS.fetch(
        new Request(new URL(path.replace(/\/+$/, '') + '.html', request.url), request),
      );
      if (page.ok) return withPageMeta(request, page);
    }

    // The 404 page, with a 404 status. Fetching it plainly would hand back a
    // 200 carrying the not-found page, so a crawler or a client checking status
    // would read a missing path as a real one.
    return notFound(request, env);
  },
};