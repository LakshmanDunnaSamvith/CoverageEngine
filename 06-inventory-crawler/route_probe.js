// Browser-side route discovery, injected via page.evaluate().
// Attempts to enumerate an SPA's own route table from several common sources
// so the crawler does not have to hardcode paths. Returns a de-duplicated list
// of candidate pathnames (leading-slash, no origin). All probing is best-effort
// and defensive: any source that throws is skipped.
//
// Recognised sources (in priority order):
//   1. window.__COVERAGE_ROUTES__            -> explicit opt-in hook for apps
//   2. <script type="application/coverage-routes"> JSON array
//   3. window.__remixRouteModules / React Router data router route manifests
//   4. Vue Router instances exposed on the root app element (__vue_app__)
//   5. In-page nav/menu anchors and [data-nav] targets (same-origin)
(config) => {
  const cfg = config || {};
  const out = new Set();

  const add = (value) => {
    if (!value || typeof value !== "string") return;
    let path = value.trim();
    if (!path) return;
    // Strip origin if an absolute URL was provided.
    try {
      if (/^https?:\/\//i.test(path)) {
        const u = new URL(path);
        if (u.origin !== location.origin) return; // same-origin only
        path = u.pathname;
      }
    } catch {
      return;
    }
    if (path.startsWith("#") || path.startsWith("mailto:") || path.startsWith("tel:")) return;
    if (!path.startsWith("/")) return;
    // Ignore obvious asset requests.
    if (/\.(js|css|png|jpe?g|svg|gif|ico|woff2?|map|json)$/i.test(path)) return;
    out.add(path.split("?")[0].split("#")[0]);
  };

  // 1. Explicit opt-in global (best signal when the app cooperates).
  try {
    const hook = window.__COVERAGE_ROUTES__;
    if (Array.isArray(hook)) hook.forEach(add);
    else if (hook && typeof hook === "object") Object.values(hook).forEach(add);
  } catch {}

  // 2. Embedded JSON manifest in a <script> tag.
  try {
    document
      .querySelectorAll('script[type="application/coverage-routes"]')
      .forEach((s) => {
        try {
          const parsed = JSON.parse(s.textContent || "[]");
          const list = Array.isArray(parsed) ? parsed : parsed.routes || [];
          list.forEach((r) => add(typeof r === "string" ? r : r && r.path));
        } catch {}
      });
  } catch {}

  // 3. React Router (data routers expose route objects with `path`).
  try {
    const collect = (routes, prefix) => {
      if (!Array.isArray(routes)) return;
      for (const r of routes) {
        if (!r) continue;
        let seg = r.path || "";
        if (seg && !seg.startsWith("/")) seg = (prefix || "") + "/" + seg;
        const full = (seg || prefix || "").replace(/\/{2,}/g, "/");
        // Skip params/splats for direct navigation; the crawler normalises them anyway.
        if (full && !/[:*]/.test(full)) add(full);
        if (r.children) collect(r.children, full || prefix);
      }
    };
    const router =
      window.__reactRouterDataRouter ||
      (window.__reactRouterRoutes ? { routes: window.__reactRouterRoutes } : null);
    if (router && router.routes) collect(router.routes, "");
  } catch {}

  // 4. Vue Router (root app instance sometimes exposes the router config).
  try {
    const roots = document.querySelectorAll("[data-v-app], #app, #root");
    roots.forEach((node) => {
      const app = node.__vue_app__;
      const router = app && app.config && app.config.globalProperties && app.config.globalProperties.$router;
      const records = router && router.getRoutes && router.getRoutes();
      if (Array.isArray(records)) {
        records.forEach((rec) => {
          if (rec && rec.path && !/[:*]/.test(rec.path)) add(rec.path);
        });
      }
    });
  } catch {}

  // 5. In-page navigation anchors and data-nav buttons (same-origin).
  try {
    const navSelector =
      (cfg.navLinkSelectors && cfg.navLinkSelectors.join(",")) ||
      "a[href^='/'], [data-nav], nav a[href], aside a[href]";
    document.querySelectorAll(navSelector).forEach((el) => {
      add(el.getAttribute("href") || el.getAttribute("data-nav"));
    });
  } catch {}

  return [...out];
}
