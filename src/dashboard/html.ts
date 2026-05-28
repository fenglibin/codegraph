/**
 * Dashboard HTML — self-contained single-page app for CodeGraph usage stats.
 *
 * Features:
 *   - Summary card with aggregate stats
 *   - Per-project cards with tool call bar charts and cache stats
 *   - Dark mode support (prefers-color-scheme)
 *   - 5-second auto-refresh
 *   - History view per project
 */

export function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeGraph Dashboard</title>
<style>
:root {
  --bg: #f8f9fa;
  --card-bg: #ffffff;
  --text: #1a1a2e;
  --text-secondary: #6c757d;
  --border: #e9ecef;
  --accent: #4361ee;
  --accent-light: #e8edff;
  --success: #2ecc71;
  --warning: #f39c12;
  --error: #e74c3c;
  --bar-bg: #e9ecef;
  --shadow: 0 2px 8px rgba(0,0,0,0.08);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --card-bg: #161b22;
    --text: #e6edf3;
    --text-secondary: #8b949e;
    --border: #30363d;
    --accent: #58a6ff;
    --accent-light: #1c2d44;
    --success: #3fb950;
    --warning: #d29922;
    --error: #f85149;
    --bar-bg: #21262d;
    --shadow: 0 2px 8px rgba(0,0,0,0.3);
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
header h1 {
  font-size: 1.5rem;
  font-weight: 600;
}
.refresh-badge {
  font-size: 0.8rem;
  color: var(--text-secondary);
  background: var(--accent-light);
  padding: 4px 10px;
  border-radius: 12px;
}
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.stat-box {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  text-align: center;
  box-shadow: var(--shadow);
}
.stat-box .value {
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--accent);
}
.stat-box .label {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-top: 4px;
}
.projects {
  display: grid;
  gap: 16px;
}
.project-card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  box-shadow: var(--shadow);
}
.project-card h3 {
  font-size: 1.1rem;
  margin-bottom: 4px;
}
.project-card .path {
  font-size: 0.75rem;
  color: var(--text-secondary);
  word-break: break-all;
  margin-bottom: 12px;
}
.project-card .meta {
  display: flex;
  gap: 16px;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 16px;
}
.card-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
@media (max-width: 600px) {
  .card-body { grid-template-columns: 1fr; }
}
.tool-list { list-style: none; }
.tool-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 0.82rem;
}
.tool-item .name {
  width: 110px;
  text-align: right;
  color: var(--text-secondary);
  font-family: monospace;
  font-size: 0.75rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-item .bar-container {
  flex: 1;
  height: 18px;
  background: var(--bar-bg);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.tool-item .bar {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
  transition: width 0.3s ease;
  min-width: 2px;
}
.tool-item .count {
  width: 40px;
  font-size: 0.75rem;
  font-weight: 600;
}
.cache-box {
  background: var(--bar-bg);
  border-radius: 8px;
  padding: 14px;
}
.cache-box h4 {
  font-size: 0.85rem;
  margin-bottom: 10px;
  color: var(--text-secondary);
}
.cache-stat {
  display: flex;
  justify-content: space-between;
  font-size: 0.82rem;
  margin-bottom: 6px;
}
.cache-stat .val { font-weight: 600; }
.hit-rate {
  font-size: 1.3rem;
  font-weight: 700;
  text-align: center;
  margin-top: 8px;
}
.hit-rate.good { color: var(--success); }
.hit-rate.ok { color: var(--warning); }
.hit-rate.bad { color: var(--error); }
.history-btn {
  margin-top: 12px;
  background: var(--accent-light);
  color: var(--accent);
  border: none;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 500;
}
.history-btn:hover { opacity: 0.8; }
.history-panel {
  margin-top: 12px;
  padding: 12px;
  background: var(--bar-bg);
  border-radius: 8px;
  font-size: 0.8rem;
  display: none;
}
.history-panel.open { display: block; }
.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.75rem;
}
.history-table th, .history-table td {
  padding: 4px 8px;
  text-align: right;
  border-bottom: 1px solid var(--border);
}
.history-table th { color: var(--text-secondary); font-weight: 500; }
.history-table td:first-child, .history-table th:first-child { text-align: left; }
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--text-secondary);
}
.empty-state h2 { margin-bottom: 8px; font-weight: 500; }
.empty-state p { font-size: 0.9rem; }
</style>
</head>
<body>
<header>
  <h1>CodeGraph Dashboard</h1>
  <span class="refresh-badge" id="refresh-badge">Auto-refresh: 5s</span>
</header>

<div id="content">
  <div class="empty-state">
    <h2>Loading...</h2>
    <p>Fetching stats from CodeGraph MCP servers</p>
  </div>
</div>

<script>
const API_BASE = '';
let historyCache = {};

async function fetchStats() {
  try {
    const res = await fetch(API_BASE + '/api/stats');
    if (!res.ok) throw new Error('Failed to fetch');
    const stats = await res.json();
    render(stats);
  } catch (e) {
    // Keep last view on error
  }
}

function render(stats) {
  const content = document.getElementById('content');
  if (!stats || stats.length === 0) {
    content.innerHTML = \`
      <div class="empty-state">
        <h2>No Active Projects</h2>
        <p>No CodeGraph MCP servers have reported stats yet.<br>
        Start using CodeGraph in a project and stats will appear here.</p>
      </div>\`;
    return;
  }

  // Compute summary
  let totalCalls = 0, totalErrors = 0, totalLatency = 0, totalCallsForAvg = 0;
  let totalHits = 0, totalMisses = 0;
  let maxUptime = 0;

  for (const s of stats) {
    for (const t of Object.values(s.tools)) {
      totalCalls += t.count;
      totalErrors += t.errors;
      totalLatency += t.totalMs;
      totalCallsForAvg += t.count;
    }
    totalHits += s.cache.hits;
    totalMisses += s.cache.misses;
    const uptime = s.updatedAt - s.startedAt;
    if (uptime > maxUptime) maxUptime = uptime;
  }

  const avgLatency = totalCallsForAvg > 0 ? (totalLatency / totalCallsForAvg).toFixed(1) : '0';
  const cacheRate = (totalHits + totalMisses) > 0
    ? ((totalHits / (totalHits + totalMisses)) * 100).toFixed(1) : '—';

  let html = \`
    <div class="summary">
      <div class="stat-box"><div class="value">\${totalCalls}</div><div class="label">Total Calls</div></div>
      <div class="stat-box"><div class="value">\${totalErrors}</div><div class="label">Total Errors</div></div>
      <div class="stat-box"><div class="value">\${avgLatency}ms</div><div class="label">Avg Latency</div></div>
      <div class="stat-box"><div class="value">\${cacheRate}%</div><div class="label">Cache Hit Rate</div></div>
      <div class="stat-box"><div class="value">\${stats.length}</div><div class="label">Active Projects</div></div>
      <div class="stat-box"><div class="value">\${formatUptime(maxUptime)}</div><div class="label">Max Uptime</div></div>
    </div>
    <div class="projects">\`;

  for (const s of stats) {
    html += renderProject(s);
  }

  html += '</div>';
  content.innerHTML = html;
}

function renderProject(s) {
  const uptime = s.updatedAt - s.startedAt;
  const startTime = new Date(s.startedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  const tools = Object.entries(s.tools).sort((a, b) => b[1].count - a[1].count);
  const maxCount = tools.length > 0 ? tools[0][1].count : 1;

  let toolsHtml = '<ul class="tool-list">';
  for (const [name, t] of tools) {
    const pct = (t.count / maxCount * 100).toFixed(0);
    const shortName = name.replace('codegraph_', '');
    const avg = t.count > 0 ? (t.totalMs / t.count).toFixed(1) : '0';
    toolsHtml += \`
      <li class="tool-item">
        <span class="name" title="\${name}">\${shortName}</span>
        <span class="bar-container"><span class="bar" style="width:\${pct}%"></span></span>
        <span class="count">\${t.count}</span>
      </li>\`;
  }
  toolsHtml += '</ul>';

  const hitRate = (s.cache.hits + s.cache.misses) > 0
    ? ((s.cache.hits / (s.cache.hits + s.cache.misses)) * 100).toFixed(1) : '—';
  const hitClass = hitRate === '—' ? '' : parseFloat(hitRate) >= 70 ? 'good' : parseFloat(hitRate) >= 40 ? 'ok' : 'bad';

  const hash = simpleHash(s.project);

  return \`
    <div class="project-card">
      <h3>\${escapeHtml(s.projectName)}</h3>
      <div class="path">\${escapeHtml(s.project)}</div>
      <div class="meta">
        <span>Started: \${startTime}</span>
        <span>Uptime: \${formatUptime(uptime)}</span>
        <span>Updated: \${new Date(s.updatedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
      </div>
      <div class="card-body">
        <div>\${toolsHtml}</div>
        <div>
          <div class="cache-box">
            <h4>Node Cache</h4>
            <div class="cache-stat"><span>Hits</span><span class="val">\${s.cache.hits}</span></div>
            <div class="cache-stat"><span>Misses</span><span class="val">\${s.cache.misses}</span></div>
            <div class="cache-stat"><span>Size</span><span class="val">\${s.cache.size} / \${s.cache.maxSize}</span></div>
            <div class="hit-rate \${hitClass}">\${hitRate}%</div>
          </div>
          <button class="history-btn" onclick="toggleHistory('\${hash}')">View History</button>
          <div class="history-panel" id="history-\${hash}"></div>
        </div>
      </div>
    </div>\`;
}

async function toggleHistory(hash) {
  const panel = document.getElementById('history-' + hash);
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    return;
  }
  panel.innerHTML = 'Loading...';
  panel.classList.add('open');

  try {
    const res = await fetch(API_BASE + '/api/history/' + hash);
    const data = await res.json();
    if (data.length === 0) {
      panel.innerHTML = '<em>No history data yet</em>';
      return;
    }
    let table = '<table class="history-table"><tr><th>Date</th><th>Calls</th><th>Errors</th><th>Cache Hit%</th></tr>';
    for (const entry of data) {
      const date = new Date(entry.startedAt).toLocaleDateString();
      let calls = 0, errors = 0;
      for (const t of Object.values(entry.tools)) {
        calls += t.count;
        errors += t.errors;
      }
      const rate = (entry.cache.hits + entry.cache.misses) > 0
        ? ((entry.cache.hits / (entry.cache.hits + entry.cache.misses)) * 100).toFixed(1) : '—';
      table += \`<tr><td>\${date}</td><td>\${calls}</td><td>\${errors}</td><td>\${rate}%</td></tr>\`;
    }
    table += '</table>';
    panel.innerHTML = table;
  } catch {
    panel.innerHTML = '<em>Failed to load history</em>';
  }
}

function formatUptime(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm';
  return sec + 's';
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).slice(0, 12);
}

// Initial fetch + interval
fetchStats();
setInterval(fetchStats, 5000);
</script>
</body>
</html>`;
}
