// Shared ID-derivation logic. MUST stay in sync with
// 06-inventory-crawler/fingerprint.py and extract.js so that observed
// automation events line up with the crawled inventory.

const SLUG_RE = /[^a-z0-9]+/g;

export function slug(text) {
  return (text || "").trim().toLowerCase().replace(SLUG_RE, "-").replace(/^-+|-+$/g, "");
}

// Small, dependency-free hash to match Python's short_hash usage as a last resort.
export function shortHash(value, length = 8) {
  let h = 0;
  for (let i = 0; i < (value || "").length; i++) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(length, "0").slice(0, length);
}

const DEFAULT_DYNAMIC = [/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-/, /^\d+$/, /^[0-9a-f]{24}$/];

export function normalizePath(pathname, dynamicPatterns = DEFAULT_DYNAMIC) {
  let path = (pathname || "/").split("?")[0].split("#")[0];
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
  return (
    path
      .split("/")
      .map(part => {
        if (!part) return part;
        return dynamicPatterns.some(rx => rx.test(part)) ? "{id}" : part;
      })
      .join("/") || "/"
  );
}

export function routeIdFromPath(normalizedPath) {
  if (normalizedPath === "" || normalizedPath === "/") return "route-root";
  const body = slug(normalizedPath.replace(/\{id\}/g, "id"));
  return `route-${body || "root"}`;
}

export function elementKey(el) {
  const testid = el.getAttribute("data-testid");
  const coverageId = el.getAttribute("data-coverage-id") || el.getAttribute("data-coverage-action");
  if (testid) return `testid:${testid}`;
  if (coverageId) return `coverageId:${coverageId}`;
  if (el.id) return `id:${el.id}`;
  const name = el.getAttribute("name");
  if (name) return `name:${name}`;
  const aria = el.getAttribute("aria-label");
  if (aria) return `aria:${slug(aria)}`;
  const role = el.getAttribute("role") || el.tagName.toLowerCase();
  const text = slug((el.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 40);
  if (text) return `${role}:${text}`;
  return `path:${shortHash(cssPath(el))}`;
}

export function cssPath(node) {
  const parts = [];
  let el = node;
  while (el && el.nodeType === 1 && parts.length < 6) {
    let seg = el.tagName.toLowerCase();
    if (el.id) {
      seg += `#${el.id}`;
      parts.unshift(seg);
      break;
    }
    const parent = el.parentElement;
    if (parent) {
      const sameTag = [...parent.children].filter(c => c.tagName === el.tagName);
      if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
    parts.unshift(seg);
    el = el.parentElement;
  }
  return parts.join(" > ");
}

function containerKey(el) {
  const landmark = el.closest(
    "form, nav, section, aside, header, main, [role='region'], [data-coverage-id], [data-testid]"
  );
  if (!landmark) return "page";
  return (
    landmark.getAttribute("data-testid") ||
    landmark.getAttribute("data-coverage-id") ||
    landmark.getAttribute("aria-label") ||
    landmark.id ||
    (landmark.className && String(landmark.className).split(" ")[0]) ||
    landmark.tagName.toLowerCase()
  );
}

export function componentIdFor(normalizedPath, el) {
  const rid = routeIdFromPath(normalizedPath).slice(6);
  const ckey = slug(containerKey(el)) || shortHash(containerKey(el));
  return `component-${rid}-${ckey}`;
}

export function actionIdFor(normalizedPath, el) {
  const rid = routeIdFromPath(normalizedPath).slice(6);
  return `action-${rid}-${slug(elementKey(el))}`;
}
