export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Public clean routes
    const publicRoutes = {
      "/": "/index.html",
      "/welcome": "/index.html",
      "/features": "/features.html",
      "/docs": "/docs.html",
      "/download": "/download.html",
      "/about": "/about.html",
      "/support": "/support.html",
      "/security": "/security.html",
      "/status": "/status.html",
      "/privacy": "/privacy.html",
      "/terms": "/terms.html",
      "/instances-terms": "/instances-terms.html",
      "/trust-and-safety": "/trust-and-safety.html"
    };

    if (publicRoutes[path]) {
      return env.ASSETS.fetch(
        new Request(new URL(publicRoutes[path], request.url), request)
      );
    }

    // WAC
    if (path === "/app" || path === "/app/") {
      return env.ASSETS.fetch(
        new Request(new URL("/app/index.html", request.url), request)
      );
    }

    if (path.startsWith("/app/")) {
      // Try the requested WAC asset/route first.
      const response = await env.ASSETS.fetch(request);

      // Real files are returned normally.
      if (response.status !== 404) {
        return response;
      }

      // WAC is an SPA. Unknown /app/* routes go to its shell.
      return env.ASSETS.fetch(
        new Request(new URL("/app/index.html", request.url), request)
      );
    }

    // Real files at the site root - stylesheets, scripts, images, favicons,
    // and any page not in the clean-route map above.
    //
    // This has to come BEFORE the 404 fallback. The fallback used to be
    // unconditional, so /css/site.css and /js/site.js were answered with
    // 404.html: the browser was handed HTML where it expected CSS and JS, so
    // the entire public site loaded unstyled and inert. Only genuinely missing
    // paths should reach the 404 page.
    const direct = await env.ASSETS.fetch(request);
    if (direct.status !== 404) {
      return direct;
    }

    // Everything else gets the public 404 page.
    return env.ASSETS.fetch(
      new Request(new URL("/404.html", request.url), request)
    );
  }
};