const status = document.querySelector('#status');
function send(message) { chrome.runtime.sendMessage(message, result => { if (chrome.runtime.lastError) { status.textContent = chrome.runtime.lastError.message; return; } status.textContent = result?.error || (result?.active ? `Active · ${result.events?.length || 0} queued` : 'No active session'); }); }

// Include the active tab's origin so the session's coverage report compares
// against that app's crawled inventory (apps/<slug>.json), not a fixed default.
async function activeOrigin() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url ? new URL(tab.url).origin : null;
  } catch { return null; }
}

send({ type: 'status' });
document.querySelector('#start').onclick = async () => send({ type: 'start', baseUrl: await activeOrigin() });
document.querySelector('#stop').onclick = () => send({ type: 'stop' });
