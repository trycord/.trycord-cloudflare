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

    if (path.startsWith('/app/')) {
      const response = await env.ASSETS.fetch(request);

      // `response.ok` rather than `status !== 404`: a real asset is a 2xx, and
      // everything else under /app/ is a client route.
      if (response.ok) return response;

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

    // The 404 page, with a 404 status. Fetching it plainly would hand back a
    // 200 carrying the not-found page, so a crawler or a client checking status
    // would read a missing path as a real one.
    const page = await env.ASSETS.fetch(
      new Request(new URL('/404.html', request.url), request),
    );
    return new Response(page.body, {
      status: 404,
      headers: page.headers,
    });
  },
};