/**
 * Dashboard API — handles HTTP routes for the CodeGraph dashboard.
 *
 * Routes:
 *   GET /api/stats           — all projects' current aggregated stats (today's sessions)
 *   GET /api/stats/:hash     — one project's current aggregated stats
 *   GET /api/sessions/:hash  — one project's per-session breakdown (newest first)
 *   GET /api/history/:hash   — one project's daily history (30 days, oldest first)
 *
 * The :hash segment is the same SHA-256-prefix hash that StatsWriter uses to
 * name the on-disk project directory. Dashboard clients pull it from the
 * `hash` field returned by /api/stats — they never compute it themselves.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { readAllStats, readProjectHistory, readSessionsForProject } from '../mcp/stats-writer';

export function handleApiRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url || '/';

  if (url === '/api/stats') {
    sendJson(res, readAllStats());
    return true;
  }

  const statsMatch = url.match(/^\/api\/stats\/([a-f0-9]+)$/);
  if (statsMatch) {
    const hash = statsMatch[1]!;
    const project = readAllStats().find(s => s.hash === hash);
    if (project) {
      sendJson(res, project);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project not found' }));
    }
    return true;
  }

  const sessionsMatch = url.match(/^\/api\/sessions\/([a-f0-9]+)$/);
  if (sessionsMatch) {
    sendJson(res, readSessionsForProject(sessionsMatch[1]!));
    return true;
  }

  const historyMatch = url.match(/^\/api\/history\/([a-f0-9]+)$/);
  if (historyMatch) {
    sendJson(res, readProjectHistory(historyMatch[1]!));
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
