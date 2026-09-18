import {
  normalizePath,
  routeIdFromPath,
  componentIdFor,
  actionIdFor,
  cssPath,
} from "./shared/fingerprint.js";

const eventId = () => crypto.randomUUID();

function emit(kind, target, extra = {}) {
  const norm = normalizePath(location.pathname);
  const el = target && target.closest ? target : document.body;
  const isElement = el && el.nodeType === 1 && el !== document.body;
  chrome.runtime.sendMessage({
    type: "event",
    event: {
      eventId: eventId(),
      kind,
      routeId: routeIdFromPath(norm),
      componentId: isElement ? componentIdFor(norm, el) : null,
      actionId: isElement ? actionIdFor(norm, el) : null,
      workflowIds: el?.dataset?.coverageWorkflow ? [el.dataset.coverageWorkflow] : [],
      source: "automation",
      timestamp: new Date().toISOString(),
      metadata: {
        tag: el?.tagName || "document",
        text: (el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        selector: isElement ? cssPath(el) : null,
        path: norm,
      },
      ...extra,
    },
  });
}

document.addEventListener("click", event => emit("action", event.target));
document.addEventListener("submit", event => emit("action", event.target));
document.addEventListener("change", event => emit("action", event.target));

let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    emit("route", document.body);
  }
}, 500);

emit("route", document.body);
