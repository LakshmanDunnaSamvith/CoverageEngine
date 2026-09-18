import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const api = 'http://localhost:5070/api';
function App() {
  const [sessions, setSessions] = useState([]); const [selected, setSelected] = useState(null); const [report, setReport] = useState(null);
  async function refresh() { const data = await fetch(`${api}/sessions`).then(r => r.json()); setSessions(data); if (data[0]) select(data[0].id); }
  async function select(id) { setSelected(id); const data = await fetch(`${api}/sessions/${id}/report`).then(r => r.json()); setReport(data); }
  async function start() { const data = await fetch(`${api}/sessions`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name: 'Dashboard controlled session' }) }).then(r => r.json()); await refresh(); setSelected(data.id); }
  useEffect(() => { refresh(); }, []);
  const overall = report?.overall || { expected: 0, covered: 0, missed: 0 }; const percentage = overall.expected ? Math.round(overall.covered * 100 / overall.expected) : 0;
  return <main><header><div><p className="eyebrow">COVERAGE INTELLIGENCE PILOT</p><h1>Automation coverage command center</h1><p>Routes, components, actions, and workflows observed from browser sessions.</p></div><button onClick={start}>＋ Start session</button></header><section className="metrics"><Metric label="Overall coverage" value={`${percentage}%`} tone="green" /><Metric label="Expected nodes" value={overall.expected} /><Metric label="Covered nodes" value={overall.covered} tone="blue" /><Metric label="Coverage gaps" value={overall.missed} tone="amber" /></section><div className="grid"><section className="panel"><h2>Session history</h2>{sessions.length === 0 && <p className="muted">Start a session from the dashboard or browser extension.</p>}{sessions.map(s => <button className={selected === s.id ? 'session selected' : 'session'} onClick={() => select(s.id)} key={s.id}><strong>{s.id}</strong><span>{s.name}</span><small>{s.status} · {s.eventCount} events</small></button>)}</section><section className="panel"><h2>Coverage gap report</h2>{!report && <p className="muted">Select a session to inspect its report.</p>}{report && <><div className="bar"><i style={{width:`${percentage}%`}} /></div><div className="report-grid"><Gap title="Missed routes" items={report.routes?.missed || []} /><Gap title="Missed actions" items={report.actions?.missed || []} /></div><h3>Next recommendations</h3><p className="muted">Prioritize high-risk inventory nodes first, then complete partial workflows.</p></>}</section></div></main>
}
function Metric({label,value,tone=''}) { return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></div> }
function Gap({title,items}) { return <div><h3>{title}</h3>{items.length ? <ul>{items.map(x => <li key={x}>{x}</li>)}</ul> : <p className="good">No gaps detected</p>}</div> }
createRoot(document.getElementById('root')).render(<App />);
