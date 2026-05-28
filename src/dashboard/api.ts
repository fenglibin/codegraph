/**
 * Dashboard API — handles HTTP routes for the CodeGraph dashboard.
 *
 * Routes:
 *   GET /api/stats         — all projects' current stats
 *   GET /api/stats/:hash   — single project's current stats
 *   GET /api/history/:hash — single project's historical stats (30 days)
 */

import { IncomingMessage, ServerResponse } from 'http';
import { readAllStats, readProjectHistory, projectHash } from '../mcp/stats-writer';

export function handleApiRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url || '/';

  if (url === '/api/stats') {
    const stats = readAllStats();
    sendJson(res, stats);
    return true;
  }

  const statsMatch = url.match(/^\/api\/stats\/([a-f0-9]+)$/);
  if (statsMatch) {
    const hash = statsMatch[1]!;
    const all = readAllStats();
    const project = all.find(s => projectHash(s.project) === hash);
    if (project) {
      sendJson(res, project);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project not found' }));
    }
    return true;
  }

  const historyMatch = url.match(/^\/api\/history\/([a-f0-9]+)$/);
  if (historyMatch) {
    const hash = historyMatch[1]!;
    const history = readProjectHistory(hash);
    sendJson(res, history);
    return true;
  }

  return false; // Not an API route
}

function sendJson(res: ServerResponse, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}
