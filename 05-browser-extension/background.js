const API = 'http://127.0.0.1:5070/api';
const state = { active: false, sessionId: null, events: [], lastFlush: 0, error: null };
chrome.runtime.onMessage.addListener((message, sender, respond) => { handle(message).then(respond); return true; });
async function handle(message) {
  if (message.type === 'status') return state;
  if (message.type === 'start') { try { const response = await fetch(`${API}/sessions`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name:'Browser automation session' }) }); if (!response.ok) throw new Error(`API returned ${response.status}`); const session = await response.json(); state.active=true; state.sessionId=session.id; state.error=null; await chrome.storage.local.set({ coverageState: state }); return state; } catch (error) { state.error=`Cannot reach ${API}: ${error.message}`; await chrome.storage.local.set({ coverageState: state }); return state; } }
  if (message.type === 'event' && state.active) { state.events.push({ ...message.event, sessionId: state.sessionId }); if (state.events.length >= 5) await flush(); await chrome.storage.local.set({ coverageState: state }); return { queued: state.events.length }; }
  if (message.type === 'stop' && state.sessionId) { await flush(); const response = await fetch(`${API}/sessions/${state.sessionId}/stop`, { method:'POST' }); const result = await response.json(); state.active=false; await chrome.storage.local.set({ coverageState: state }); return result; }
}
async function flush() { if (!state.events.length || !state.sessionId) return; const events = state.events.splice(0); await fetch(`${API}/sessions/${state.sessionId}/events`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ events }) }); state.lastFlush=Date.now(); }
chrome.runtime.onStartup.addListener(async () => { const saved = await chrome.storage.local.get('coverageState'); if (saved.coverageState?.active) Object.assign(state, saved.coverageState); });
