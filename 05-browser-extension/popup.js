const status = document.querySelector('#status');
function send(type) { chrome.runtime.sendMessage({ type }, result => { if (chrome.runtime.lastError) { status.textContent = chrome.runtime.lastError.message; return; } status.textContent = result?.error || (result?.active ? `Active · ${result.events?.length || 0} queued` : 'No active session'); }); }
send('status'); document.querySelector('#start').onclick = () => send('start'); document.querySelector('#stop').onclick = () => send('stop');
