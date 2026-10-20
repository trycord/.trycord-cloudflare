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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Auth is part of the application, not the website. Someone who bookmarked
    // /login or followed a link from elsewhere should land on the app's own
    // sign-in rather than the public 404, but the canonical location is under
    // /app/ - a redirect rather than a second copy, so there is exactly one
    // place a session is established from.
    const AUTH_ALIASES = {
      '/login': '/app/login',
      '/register': '/app/register',
      '/forgot': '/app/forgot',
    };
    if (AUTH_ALIASES[path]) {
      return Response.redirect(new URL(AUTH_ALIASES[path], request.url), 302);
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
      return env.ASSETS.fetch(
        new Request(new URL(publicRoutes[path], request.url), request),
      );
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

    if (path.startsWith('/app/mobile/')) {
      const response = await env.ASSETS.fetch(request);
      if (response.ok) return response;
      // A missing file is a 404; only an extensionless route falls back to the
      // Mobile document.
      if (ASSET_PATH.test(path)) return notFound(request, env);
      return env.ASSETS.fetch(new Request(new URL('/app/mobile/', request.url), request));
    }

    if (path.startsWith('/app/')) {
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
    if (direct.ok) return direct;

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
      if (page.ok) return page;
    }

    // The 404 page, with a 404 status. Fetching it plainly would hand back a
    // 200 carrying the not-found page, so a crawler or a client checking status
    // would read a missing path as a real one.
    return notFound(request, env);
  },
};