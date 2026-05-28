/**
 * Tests for StatsWriter — disk persistence of MCP session stats.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { StatsWriter, StatsFile, projectHash, getStatsDir, readAllStats, readProjectHistory, cleanupOldHistory } from '../src/mcp/stats-writer';
import type { SessionSnapshot } from '../src/mcp/stats-writer';

// Use a temp dir as the home to avoid polluting the real ~/.codegraph/stats/
let originalHome: string;
let tmpHome: string;

beforeEach(() => {
  originalHome = process.env.HOME || homedir();
  tmpHome = mkdtempSync(join(tmpdir(), 'cg-stats-test-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function makeSnapshot(overrides?: Partial<SessionSnapshot>): SessionSnapshot {
  const tools = new Map();
  tools.set('codegraph_context', { count: 5, errors: 0, totalMs: 15.5, minMs: 2.0, maxMs: 5.0 });
  tools.set('codegraph_search', { count: 3, errors: 1, totalMs: 3.6, minMs: 0.8, maxMs: 1.5 });
  return {
    startedAt: Date.now() - 60_000,
    tools,
    cache: { hits: 42, misses: 8, size: 50, maxSize: 1000 },
    ...overrides,
  };
}

describe('StatsWriter', () => {
  describe('projectHash', () => {
    it('returns a 12-char hex string', () => {
      const h = projectHash('/Users/test/my-project');
      expect(h).toMatch(/^[a-f0-9]{12}$/);
    });

    it('returns different hashes for different paths', () => {
      const h1 = projectHash('/path/a');
      const h2 = projectHash('/path/b');
      expect(h1).not.toBe(h2);
    });

    it('returns the same hash for the same path', () => {
      const h1 = projectHash('/consistent/path');
      const h2 = projectHash('/consistent/path');
      expect(h1).toBe(h2);
    });
  });

  describe('flush()', () => {
    it('writes a valid stats file to disk', () => {
      const writer = new StatsWriter('/test/project');
      const snapshot = makeSnapshot();
      writer.scheduleWrite(snapshot);
      writer.flush();

      const hash = projectHash('/test/project');
      const statsDir = join(tmpHome, '.codegraph', 'stats');
      const filePath = join(statsDir, `${hash}.json`);

      expect(existsSync(filePath)).toBe(true);
      const content: StatsFile = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(content.version).toBe(1);
      expect(content.project).toBe('/test/project');
      expect(content.projectName).toBe('project');
      expect(content.tools.codegraph_context.count).toBe(5);
      expect(content.tools.codegraph_search.errors).toBe(1);
      expect(content.cache.hits).toBe(42);
      expect(content.cache.misses).toBe(8);
    });

    it('does nothing if no snapshot was scheduled', () => {
      const writer = new StatsWriter('/test/empty');
      writer.flush();

      const hash = projectHash('/test/empty');
      const statsDir = join(tmpHome, '.codegraph', 'stats');
      expect(existsSync(join(statsDir, `${hash}.json`))).toBe(false);
    });

    it('overwrites existing stats file for same session', () => {
      const writer = new StatsWriter('/test/overwrite');

      const snapshot1 = makeSnapshot();
      writer.scheduleWrite(snapshot1);
      writer.flush();

      // Update with more calls
      const tools2 = new Map(snapshot1.tools);
      tools2.get('codegraph_context')!.count = 10;
      writer.scheduleWrite({ ...snapshot1, tools: tools2 });
      writer.flush();

      const hash = projectHash('/test/overwrite');
      const filePath = join(tmpHome, '.codegraph', 'stats', `${hash}.json`);
      const content: StatsFile = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(content.tools.codegraph_context.count).toBe(10);
    });
  });

  describe('archive rotation', () => {
    it('moves previous day stats to history/', () => {
      const hash = projectHash('/test/archive');
      const statsDir = join(tmpHome, '.codegraph', 'stats');
      const historyDir = join(statsDir, 'history');
      mkdirSync(statsDir, { recursive: true });
      mkdirSync(historyDir, { recursive: true });

      // Write a fake stats file with yesterday's startedAt
      const yesterday = Date.now() - 86_400_000;
      const oldStats: StatsFile = {
        version: 1,
        project: '/test/archive',
        projectName: 'archive',
        startedAt: yesterday,
        updatedAt: yesterday + 1000,
        tools: { codegraph_search: { count: 2, errors: 0, totalMs: 1.5, minMs: 0.5, maxMs: 1.0 } },
        cache: { hits: 10, misses: 5, size: 15, maxSize: 1000 },
      };
      writeFileSync(join(statsDir, `${hash}.json`), JSON.stringify(oldStats));

      // Now write new stats — the old one should be archived
      const writer = new StatsWriter('/test/archive');
      writer.scheduleWrite(makeSnapshot());
      writer.flush();

      // Check that history/ has the old file
      const historyFiles = require('fs').readdirSync(historyDir);
      const archived = historyFiles.find((f: string) => f.startsWith(hash));
      expect(archived).toBeDefined();
    });
  });

  describe('readAllStats()', () => {
    it('returns all valid stats files', () => {
      const writer1 = new StatsWriter('/test/proj-a');
      writer1.scheduleWrite(makeSnapshot());
      writer1.flush();

      const writer2 = new StatsWriter('/test/proj-b');
      writer2.scheduleWrite(makeSnapshot());
      writer2.flush();

      const all = readAllStats();
      expect(all.length).toBe(2);
      const projects = all.map(s => s.project).sort();
      expect(projects).toEqual(['/test/proj-a', '/test/proj-b']);
    });

    it('returns empty array when no stats dir exists', () => {
      // tmpHome/.codegraph/stats won't exist without any writer
      rmSync(join(tmpHome, '.codegraph'), { recursive: true, force: true });
      const all = readAllStats();
      expect(all).toEqual([]);
    });
  });

  describe('readProjectHistory()', () => {
    it('returns history files for a specific project', () => {
      const hash = projectHash('/test/hist');
      const historyDir = join(tmpHome, '.codegraph', 'stats', 'history');
      mkdirSync(historyDir, { recursive: true });

      // Write two fake history entries
      const entry1: StatsFile = {
        version: 1, project: '/test/hist', projectName: 'hist',
        startedAt: Date.now() - 172_800_000, updatedAt: Date.now() - 172_800_000,
        tools: {}, cache: { hits: 0, misses: 0, size: 0, maxSize: 1000 },
      };
      const entry2: StatsFile = {
        version: 1, project: '/test/hist', projectName: 'hist',
        startedAt: Date.now() - 86_400_000, updatedAt: Date.now() - 86_400_000,
        tools: {}, cache: { hits: 5, misses: 2, size: 7, maxSize: 1000 },
      };
      writeFileSync(join(historyDir, `${hash}_2026-05-26.json`), JSON.stringify(entry1));
      writeFileSync(join(historyDir, `${hash}_2026-05-27.json`), JSON.stringify(entry2));

      const history = readProjectHistory(hash);
      expect(history.length).toBe(2);
      // Should be sorted oldest first
      expect(history[0].cache.hits).toBe(0);
      expect(history[1].cache.hits).toBe(5);
    });
  });

  describe('cleanupOldHistory()', () => {
    it('removes files older than 30 days', () => {
      const historyDir = join(tmpHome, '.codegraph', 'stats', 'history');
      mkdirSync(historyDir, { recursive: true });

      // Create a file "from" 60 days ago
      writeFileSync(join(historyDir, 'abc123def456_2026-03-29.json'), '{"version":1}');
      // Create a file from yesterday (should be kept)
      writeFileSync(join(historyDir, 'abc123def456_2026-05-27.json'), '{"version":1}');

      cleanupOldHistory();

      expect(existsSync(join(historyDir, 'abc123def456_2026-03-29.json'))).toBe(false);
      expect(existsSync(join(historyDir, 'abc123def456_2026-05-27.json'))).toBe(true);
    });
  });
});
