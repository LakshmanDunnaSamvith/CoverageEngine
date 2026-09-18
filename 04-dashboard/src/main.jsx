import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const api = 'http://localhost:5070/api';
function App() {
  const [sessions, setSessions] = useState([]); const [selected, setSelected] = useState(null); const [report, setReport] = useState(null);
  // The app currently being onboarded. Shared with <Onboard/> and stamped onto
  // new sessions so their coverage report compares against the right inventory.
  const [baseUrl, setBaseUrl] = useState('http://localhost:5173');
  async function refresh() { const data = await fetch(`${api}/sessions`).then(r => r.json()); setSessions(data); if (data[0]) select(data[0].id); }
  async function select(id) { setSelected(id); const data = await fetch(`${api}/sessions/${id}/report`).then(r => r.json()); setReport(data); }
  async function start() { const data = await fetch(`${api}/sessions`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name: 'Dashboard controlled session', baseUrl: baseUrl.trim() || null }) }).then(r => r.json()); await refresh(); setSelected(data.id); }
  useEffect(() => { refresh(); }, []);
  const overall = report?.overall || { expected: 0, covered: 0, missed: 0 }; const percentage = overall.expected ? Math.round(overall.covered * 100 / overall.expected) : 0;
  return <main><header><div><p className="eyebrow">COVERAGE INTELLIGENCE PILOT</p><h1>Automation coverage command center</h1><p>Routes, components, actions, and workflows observed from browser sessions.</p></div><button onClick={start}>＋ Start session</button></header><section className="metrics"><Metric label="Overall coverage" value={`${percentage}%`} tone="green" /><Metric label="Expected nodes" value={overall.expected} /><Metric label="Covered nodes" value={overall.covered} tone="blue" /><Metric label="Coverage gaps" value={overall.missed} tone="amber" /></section><Onboard baseUrl={baseUrl} setBaseUrl={setBaseUrl} /><div className="grid"><section className="panel"><h2>Session history</h2>{sessions.length === 0 && <p className="muted">Start a session from the dashboard or browser extension.</p>}{sessions.map(s => <button className={selected === s.id ? 'session selected' : 'session'} onClick={() => select(s.id)} key={s.id}><strong>{s.id}</strong><span>{s.name}</span><small>{s.status} · {s.eventCount} events</small></button>)}</section><section className="panel"><h2>Coverage gap report</h2>{!report && <p className="muted">Select a session to inspect its report.</p>}{report && <><div className="bar"><i style={{width:`${percentage}%`}} /></div><div className="report-grid"><Gap title="Missed routes" items={report.routes?.missed || []} /><Gap title="Missed actions" items={report.actions?.missed || []} /></div><h3>Next recommendations</h3><p className="muted">Prioritize high-risk inventory nodes first, then complete partial workflows.</p></>}</section></div></main>
}

// Onboard any application by base URL: check whether an inventory already
// exists, and if not, run the crawler to generate one dynamically.
function Onboard({ baseUrl, setBaseUrl }) {
  const [showAuth, setShowAuth] = useState(false);
  const [auth, setAuth] = useState({ username: '', password: '', loginPath: '', readySelector: '' });
  const [status, setStatus] = useState(null); // { exists, routes, actions }
  const [checkedUrl, setCheckedUrl] = useState(''); // base URL the current status applies to
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [error, setError] = useState('');

  function setAuthField(k, v) { setAuth(a => ({ ...a, [k]: v })); }

  // Reset the check result whenever the URL changes so a stale "ready" status
  // can't enable Crawl for a different URL than the one that was checked.
  function onUrlChange(v) { setBaseUrl(v); setStatus(null); setCheckedUrl(''); setMessage(''); setError(''); }

  // Turn an API/fetch failure into a single friendly line instead of a stack
  // trace. Prefers a structured { error } field, then the last non-empty line
  // of any stderr, then the HTTP status text.
  async function readError(res, fallback) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON body */ }
    if (payload) {
      if (payload.error) return String(payload.error);
      if (payload.stderr) return lastMeaningfulLine(payload.stderr);
    }
    return fallback || `Request failed (HTTP ${res.status})`;
  }

  function lastMeaningfulLine(text) {
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    // Python stack traces end with the actual error, e.g. "playwright…Error: …".
    const errLine = [...lines].reverse().find(l => /error|exception|refused|timeout/i.test(l));
    return errLine || lines[lines.length - 1] || 'Unknown error';
  }

  async function check() {
    const url = baseUrl.trim();
    if (!url) return;
    setBusy(true); setMessage(''); setError(''); setStatus(null);
    try {
      const res = await fetch(`${api}/inventory/status?baseUrl=${encodeURIComponent(url)}`);
      if (!res.ok) { setError(await readError(res, 'Could not check inventory status.')); return; }
      const data = await res.json();
      setStatus(data); setCheckedUrl(url);
      setMessage(data.exists
        ? `Inventory found (${data.routes} routes, ${data.actions} actions). Ready for coverage.`
        : 'No inventory yet for this URL. Click Crawl to generate one.');
    } catch (e) { setError(`Check failed: ${e.message}`); }
    finally { setBusy(false); }
  }

  async function crawl() {
    const url = baseUrl.trim();
    if (!canCrawl) return;
    setBusy(true); setMessage('Crawling… this can take a moment.'); setError('');
    try {
      const body = { baseUrl: url, ...(showAuth ? auth : {}) };
      const res = await fetch(`${api}/inventory/crawl`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setStatus({ exists: true, routes: data.routes, actions: data.actions }); setCheckedUrl(url);
        setMessage(`✔ Inventory generated: ${data.routes} routes, ${data.actions} actions.`);
      } else {
        const detail = data?.stderr ? lastMeaningfulLine(data.stderr) : (data?.error || `HTTP ${res.status}`);
        const exit = data?.exitCode != null ? ` (exit ${data.exitCode})` : '';
        setError(`Crawl failed${exit}: ${detail}`);
      }
    } catch (e) { setError(`Crawl failed: ${e.message}`); }
    finally { setBusy(false); }
  }

  // Crawl is only enabled after a successful Check on the CURRENT url that
  // reported no existing inventory.
  const canCrawl = !busy && status != null && !status.exists && checkedUrl === baseUrl.trim() && !!baseUrl.trim();
  return (
    <section className="panel onboard">
      <h2>Onboard an application</h2>
      <p className="muted">Enter a base URL. We'll check for an existing inventory; if none exists, crawl it to generate one dynamically.</p>
      <div className="onboard-row">
        <input className="url-input" type="url" placeholder="https://your-app.example.com" value={baseUrl} onChange={e => onUrlChange(e.target.value)} />
        <button className="ghost" onClick={check} disabled={busy || !baseUrl.trim()}>Check</button>
        <button onClick={crawl} disabled={!canCrawl} title={status == null ? 'Run Check first' : status.exists ? 'Inventory already exists' : 'Generate inventory'}>{busy ? '…' : '⟳ Crawl'}</button>
      </div>
      <button className="link-btn" onClick={() => setShowAuth(v => !v)}>{showAuth ? '▾ Hide login options' : '▸ App needs login?'}</button>
      {showAuth && (
        <div className="auth-grid">
          <input placeholder="Email / username" value={auth.username} onChange={e => setAuthField('username', e.target.value)} />
          <input type="password" placeholder="Password" value={auth.password} onChange={e => setAuthField('password', e.target.value)} />
          <input placeholder="Login path (default /)" value={auth.loginPath} onChange={e => setAuthField('loginPath', e.target.value)} />
          <input placeholder="Ready selector (e.g. .app-shell)" value={auth.readySelector} onChange={e => setAuthField('readySelector', e.target.value)} />
        </div>
      )}
      {status && !error && <span className={`pill ${status.exists ? 'ok' : 'warn'}`}>{status.exists ? 'Inventory ready' : 'Needs crawl'}</span>}
      {message && !error && <p className={`onboard-msg ${busy ? 'busy' : ''}`}>{message}</p>}
      {error && <p className="onboard-msg error" role="alert">⚠ {error}</p>}
    </section>
  );
}
function Metric({label,value,tone=''}) { return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></div> }
function Gap({title,items}) { return <div><h3>{title}</h3>{items.length ? <ul>{items.map(x => <li key={x}>{x}</li>)}</ul> : <p className="good">No gaps detected</p>}</div> }
createRoot(document.getElementById('root')).render(<App />);
