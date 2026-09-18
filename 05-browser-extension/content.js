const eventId = () => crypto.randomUUID();
function emit(kind, target, extra = {}) { chrome.runtime.sendMessage({ type: 'event', event: { eventId: eventId(), kind, routeId: routeId(), componentId: target?.closest?.('[data-coverage-id]')?.dataset.coverageId || null, actionId: target?.dataset?.coverageAction || null, workflowIds: target?.dataset?.coverageWorkflow ? [target.dataset.coverageWorkflow] : [], source: 'automation', timestamp: new Date().toISOString(), metadata: { tag: target?.tagName || 'document' }, ...extra } }); }
function routeId() { return `route-${location.pathname.replace(/^\//, '').replaceAll('/', '-') || 'dashboard'}`; }
document.addEventListener('click', event => emit('action', event.target));
document.addEventListener('submit', event => emit('action', event.target));
document.addEventListener('change', event => emit('action', event.target));
let lastPath = location.pathname;
setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; emit('route', document.body); } }, 500);
emit('route', document.body);
