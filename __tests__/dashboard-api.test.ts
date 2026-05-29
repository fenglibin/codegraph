/**
 * Tests for the Dashboard HTTP API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import type { StatsFile } from '../src/mcp/stats-writer';
import { projectHash } from '../src/mcp/stats-writer';

let originalHome: string;
let tmpHome: string;

beforeEach(() => {
  originalHome = process.env.HOME || homedir();
  tmpHome = mkdtempSync(join(tmpdir(), 'cg-dash-test-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeStats(project: string, tools: StatsFile['tools'] = {}): void {
  const hash = projectHash(project);
  const statsDir = join(tmpHome, '.codegraph', 'stats');
  mkdirSync(statsDir, { recursive: true });
  const stats: StatsFile = {
    version: 1,
    project,
    projectName: project.split('/').pop()!,
    startedAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    tools,
    cache: { hits: 10, misses: 2, size: 12, maxSize: 1000 },
  };
  writeFileSync(join(statsDir, `${hash}.json`), JSON.stringify(stats));
}

/** Write a per-session stats file under <hash>/<startedAt>_<pid>.json. */
function writeSessionStats(project: string, startedAt: number, tools: StatsFile['tools'] = {}): void {
  const hash = projectHash(project);
  const projectDir = join(tmpHome, '.codegraph', 'stats', hash);
  mkdirSync(projectDir, { recursive: true });
  const stats: StatsFile = {
    version: 1,
    project,
    projectName: project.split('/').pop()!,
    startedAt,
    updatedAt: startedAt + 30_000,
    tools,
    cache: { hits: 7, misses: 3, size: 10, maxSize: 1000 },
  };
  writeFileSync(join(projectDir, `${startedAt}_999.json`), JSON.stringify(stats));
}

/** Helper: spin up an ephemeral test server, hit one URL, return parsed body. */
async function httpGet(url: string): Promise<{ status: number; body: any }> {
  const http = await import('http');
  const { handleApiRequest } = await import('../src/dashboard/api');
  return new Promise((resolve) => {
    const testServer = http.createServer((req, res) => {
      handleApiRequest(req, res);
      res.on('finish', () => testServer.close());
    });
    testServer.listen(0, () => {
      const addr = testServer.address() as { port: number };
      http.get(`http://localhost:${addr.port}${url}`, (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
      });
    });
  });
}

describe('Dashboard API', () => {
  it('GET /api/stats returns all projects', async () => {
    writeStats('/test/project-a', { codegraph_search: { count: 3, errors: 0, totalMs: 2.0, minMs: 0.5, maxMs: 1.0 } });
    writeStats('/test/project-b', { codegraph_context: { count: 7, errors: 1, totalMs: 10.0, minMs: 1.0, maxMs: 3.0 } });

    const result = await httpGet('/api/stats');
    expect(result.status).toBe(200);
    expect(result.body).toHaveLength(2);
    expect(result.body.map((s: StatsFile) => s.project).sort()).toEqual(['/test/project-a', '/test/project-b']);
  });

  it('GET /api/stats includes the authoritative hash field on every record', async () => {
    writeStats('/test/has-hash', { codegraph_search: { count: 1, errors: 0, totalMs: 1, minMs: 1, maxMs: 1 } });

    const result = await httpGet('/api/stats');
    expect(result.status).toBe(200);
    expect(result.body).toHaveLength(1);
    const proj = result.body[0];
    expect(proj.hash).toBe(projectHash('/test/has-hash'));
    expect(proj.sessionCount).toBe(1);
  });

  it('GET /api/stats returns empty array when no stats', async () => {
    const result = await httpGet('/api/stats');
    expect(result.status).toBe(200);
    expect(result.body).toEqual([]);
  });

  it('GET /api/sessions/:hash returns per-session detail newest-first', async () => {
    const project = '/test/multi-sessions';
    const t1 = Date.now() - 200_000;
    const t2 = Date.now() - 80_000;
    writeSessionStats(project, t1, { codegraph_search: { count: 2, errors: 0, totalMs: 2, minMs: 1, maxMs: 1 } });
    writeSessionStats(project, t2, { codegraph_search: { count: 5, errors: 0, totalMs: 5, minMs: 1, maxMs: 1 } });

    const result = await httpGet(`/api/sessions/${projectHash(project)}`);
    expect(result.status).toBe(200);
    expect(result.body).toHaveLength(2);
    // Newest first
    expect(result.body[0].startedAt).toBeGreaterThan(result.body[1].startedAt);
  });

  it('GET /api/sessions/:hash returns empty array for an unknown hash', async () => {
    const result = await httpGet('/api/sessions/000000000000');
    expect(result.status).toBe(200);
    expect(result.body).toEqual([]);
  });

  it('GET /api/history/:hash returns history data', async () => {
    const hash = projectHash('/test/with-history');
    const historyDir = join(tmpHome, '.codegraph', 'stats', 'history');
    mkdirSync(historyDir, { recursive: true });

    const entry: StatsFile = {
      version: 1, project: '/test/with-history', projectName: 'with-history',
      startedAt: Date.now() - 86_400_000, updatedAt: Date.now() - 86_400_000,
      tools: { codegraph_search: { count: 5, errors: 0, totalMs: 4.0, minMs: 0.5, maxMs: 1.5 } },
      cache: { hits: 20, misses: 3, size: 23, maxSize: 1000 },
    };
    writeFileSync(join(historyDir, `${hash}_2026-05-27.json`), JSON.stringify(entry));

    const result = await httpGet(`/api/history/${hash}`);
    expect(result.status).toBe(200);
    expect(result.body).toHaveLength(1);
    expect(result.body[0].project).toBe('/test/with-history');
  });
});
