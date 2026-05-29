/**
 * Dashboard Server — lightweight HTTP server for CodeGraph usage statistics.
 *
 * Usage:
 *   codegraph dashboard [--port 7890]
 *
 * Serves a self-contained HTML page at / and JSON API at /api/*.
 * Reads stats from ~/.codegraph/stats/ written by MCP Server instances.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { handleApiRequest } from './api';
import { getDashboardHTML } from './html';
import { cleanupOldHistory, runStartupMaintenance } from '../mcp/stats-writer';

export class DashboardServer {
  private server: Server | null = null;
  private port: number;

  constructor(port: number = 7890) {
    this.port = port;
  }

  async start(): Promise<void> {
    // Bring the on-disk stats layout up to date before serving requests:
    // migrate pre-0.10.8 loose <hash>.json files into the per-session layout
    // and archive any session files left from previous days. Without this,
    // a project the user hasn't reopened in a fresh MCP session would either
    // stay in the legacy layout or sit invisibly in <hash>/ forever.
    runStartupMaintenance();
    // Clean up old history files on startup
    cleanupOldHistory();

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      const url = req.url || '/';

      // API routes
      if (url.startsWith('/api/')) {
        const handled = handleApiRequest(req, res);
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
        return;
      }

      // Serve dashboard HTML for root and any non-API path
      if (url === '/' || url === '/index.html') {
        const html = getDashboardHTML();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(html);
        return;
      }

      // 404 for everything else
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} is already in use. Try a different port with --port.`));
        } else {
          reject(err);
        }
      });

      this.server!.listen(this.port, () => {
        const url = `http://localhost:${this.port}`;
        console.log(`\n  CodeGraph Dashboard running at ${url}\n`);
        console.log(`  Press Ctrl+C to stop.\n`);

        // Try to open in browser (best-effort)
        tryOpenBrowser(url);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

/**
 * Try to open a URL in the default browser. Best-effort, no error thrown.
 */
function tryOpenBrowser(url: string): void {
  try {
    const { exec } = require('child_process');
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    exec(`${cmd} ${url}`);
  } catch {
    // Ignore — not all environments have a browser
  }
}
