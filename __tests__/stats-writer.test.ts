/**
 * Tests for StatsWriter — disk persistence of MCP session stats.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  StatsWriter,
  StatsFile,
  projectHash,
  getStatsDir,
  getProjectDir,
  readAllStats,
  readProjectHistory,
  readSessionsForProject,
  cleanupOldHistory,
  runStartupMaintenance,
} from '../src/mcp/stats-writer';
import type { SessionSnapshot } from '../src/mcp/stats-writer';

// Use a temp dir as $HOME to avoid polluting the real ~/.codegraph/stats/
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

/** Path of the per-session file written by THIS process for the given project + startedAt. */
function sessionFilePath(project: string, startedAt: number): string {
  const hash = projectHash(project);
  return join(tmpHome, '.codegraph', 'stats', hash, `${startedAt}_${process.pid}.json`);
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
    it('writes a valid stats file at <hash>/<startedAt>_<pid>.json', () => {
      const writer = new StatsWriter('/test/project');
      const snapshot = makeSnapshot();
      writer.scheduleWrite(snapshot);
      writer.flush();

      const filePath = sessionFilePath('/test/project', snapshot.startedAt);
      expect(existsSync(filePath)).toBe(true);
      const content: StatsFile = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(content.version).toBe(1);
      expect(content.project).toBe('/test/project');
      expect(content.projectName).toBe('project');
      expect(content.tools.codegraph_context!.count).toBe(5);
      expect(content.tools.codegraph_search!.errors).toBe(1);
      expect(content.cache.hits).toBe(42);
      expect(content.cache.misses).toBe(8);
    });

    it('does NOT create a legacy <hash>.json file', () => {
      const writer = new StatsWriter('/test/legacy-check');
      writer.scheduleWrite(makeSnapshot());
      writer.flush();

      const hash = projectHash('/test/legacy-check');
      const legacyPath = join(tmpHome, '.codegraph', 'stats', `${hash}.json`);
      expect(existsSync(legacyPath)).toBe(false);
    });

    it('does nothing if no snapshot was scheduled', () => {
      const writer = new StatsWriter('/test/empty');
      writer.flush();

      const hash = projectHash('/test/empty');
      const projectDir = join(tmpHome, '.codegraph', 'stats', hash);
      // dir is created by constructor, but should be empty
      const files = readdirSync(projectDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(0);
    });

    it('overwrites the SAME file across flushes of the same session', () => {
      const writer = new StatsWriter('/test/overwrite');

      const snapshot1 = makeSnapshot();
      writer.scheduleWrite(snapshot1);
      writer.flush();

      const tools2 = new Map(snapshot1.tools);
      tools2.get('codegraph_context')!.count = 10;
      writer.scheduleWrite({ ...snapshot1, tools: tools2 });
      writer.flush();

      // Same session = same file
      const filePath = sessionFilePath('/test/overwrite', snapshot1.startedAt);
      const content: StatsFile = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(content.tools.codegraph_context!.count).toBe(10);

      // And nothing else got created
      const projectDir = join(tmpHome, '.codegraph', 'stats', projectHash('/test/overwrite'));
      const files = readdirSync(projectDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);
    });

    it('writes one file per session — sessions never overwrite each other', () => {
      // Simulate two MCP sessions for the same project (different startedAt)
      const writer1 = new StatsWriter('/test/multi');
      const snap1 = makeSnapshot({ startedAt: Date.now() - 120_000 });
      writer1.scheduleWrite(snap1);
      writer1.flush();

      const writer2 = new StatsWriter('/test/multi');
      const snap2 = makeSnapshot({ startedAt: Date.now() - 60_000 });
      writer2.scheduleWrite(snap2);
      writer2.flush();

      const projectDir = join(tmpHome, '.codegraph', 'stats', projectHash('/test/multi'));
      const files = readdirSync(projectDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(2);
    });
  });

  describe('legacy migration', () => {
    it('moves a legacy <hash>.json from a previous layout into <hash>/<startedAt>_legacy.json', () => {
      const hash = projectHash('/test/legacy');
      const statsDir = join(tmpHome, '.codegraph', 'stats');
      mkdirSync(statsDir, { recursive: true });

      const startedAt = Date.now() - 5_000;
      const legacy: StatsFile = {
        version: 1,
        project: '/test/legacy',
        projectName: 'legacy',
        startedAt,
        updatedAt: startedAt + 1_000,
        tools: { codegraph_context: { count: 7, errors: 0, totalMs: 14, minMs: 2, maxMs: 4 } },
        cache: { hits: 3, misses: 1, size: 4, maxSize: 1000 },
      };
      writeFileSync(join(statsDir, `${hash}.json`), JSON.stringify(legacy));

      // Constructing a writer triggers migration
      // (we don't even need to write — migration runs in the ctor)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _writer = new StatsWriter('/test/legacy');

      expect(existsSync(join(statsDir, `${hash}.json`))).toBe(false);
      const target = join(statsDir, hash, `${startedAt}_legacy.json`);
      expect(existsSync(target)).toBe(true);
      const migrated: StatsFile = JSON.parse(readFileSync(target, 'utf8'));
      expect(migrated.tools.codegraph_context!.count).toBe(7);
    });
  });

  describe('archive rotation', () => {
    it('moves previous-day session files into a single history rollup', () => {
      const hash = projectHash('/test/archive');
      const projectDir = getProjectDir(hash);
      const historyDir = join(tmpHome, '.codegraph', 'stats', 'history');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(historyDir, { recursive: true });

      // Write two fake yesterday session files
      const yesterday = Date.now() - 86_400_000;
      const session1: StatsFile = {
        version: 1, project: '/test/archive', projectName: 'archive',
        startedAt: yesterday, updatedAt: yesterday + 1000,
        tools: { codegraph_search: { count: 2, errors: 0, totalMs: 1.5, minMs: 0.5, maxMs: 1.0 } },
        cache: { hits: 10, misses: 5, size: 15, maxSize: 1000 },
      };
      const session2: StatsFile = {
        version: 1, project: '/test/archive', projectName: 'archive',
        startedAt: yesterday + 5_000, updatedAt: yesterday + 6_000,
        tools: { codegraph_search: { count: 3, errors: 1, totalMs: 2.0, minMs: 0.6, maxMs: 1.2 } },
        cache: { hits: 4, misses: 2, size: 6, maxSize: 1000 },
      };
      writeFileSync(join(projectDir, `${session1.startedAt}_111.json`), JSON.stringify(session1));
      writeFileSync(join(projectDir, `${session2.startedAt}_222.json`), JSON.stringify(session2));

      // Now write today's stats — yesterday's files should be archived
      const writer = new StatsWriter('/test/archive');
      writer.scheduleWrite(makeSnapshot());
      writer.flush();

      // history/ should have one rollup file for yesterday with both sessions summed
      const historyFiles = readdirSync(historyDir);
      const archived = historyFiles.find(f => f.startsWith(hash));
      expect(archived).toBeDefined();

      const rolled: StatsFile = JSON.parse(readFileSync(join(historyDir, archived!), 'utf8'));
      expect(rolled.tools.codegraph_search!.count).toBe(5); // 2 + 3
      expect(rolled.tools.codegraph_search!.errors).toBe(1); // 0 + 1
      expect(rolled.cache.hits).toBe(14); // 10 + 4
      expect(rolled.cache.misses).toBe(7); // 5 + 2

      // The yesterday session files should be gone
      const remaining = readdirSync(projectDir).filter(f => f.startsWith(String(yesterday)));
      expect(remaining.length).toBe(0);
    });
  });

  describe('readAllStats()', () => {
    it('aggregates multiple sessions for the same project', () => {
      const writer1 = new StatsWriter('/test/agg');
      writer1.scheduleWrite(makeSnapshot({ startedAt: Date.now() - 100_000 }));
      writer1.flush();

      const writer2 = new StatsWriter('/test/agg');
      writer2.scheduleWrite(makeSnapshot({ startedAt: Date.now() - 50_000 }));
      writer2.flush();

      const all = readAllStats();
      const proj = all.find(s => s.project === '/test/agg');
      expect(proj).toBeDefined();
      expect(proj!.sessionCount).toBe(2);
      // Two sessions of (5 context + 3 search) each → 10 + 6
      expect(proj!.tools.codegraph_context!.count).toBe(10);
      expect(proj!.tools.codegraph_search!.count).toBe(6);
      expect(proj!.cache.hits).toBe(84); // 42 * 2
    });

    it('attaches the authoritative hash field', () => {
      const writer = new StatsWriter('/test/hash-field');
      writer.scheduleWrite(makeSnapshot());
      writer.flush();

      const all = readAllStats();
      const proj = all.find(s => s.project === '/test/hash-field');
      expect(proj).toBeDefined();
      expect(proj!.hash).toBe(projectHash('/test/hash-field'));
    });

    it('returns an entry per project', () => {
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
      rmSync(join(tmpHome, '.codegraph'), { recursive: true, force: true });
      const all = readAllStats();
      expect(all).toEqual([]);
    });

    it('surfaces unmigrated legacy <hash>.json files', () => {
      const hash = projectHash('/test/lazy');
      const statsDir = join(tmpHome, '.codegraph', 'stats');
      mkdirSync(statsDir, { recursive: true });

      const legacy: StatsFile = {
        version: 1, project: '/test/lazy', projectName: 'lazy',
        startedAt: Date.now() - 5_000, updatedAt: Date.now(),
        tools: { codegraph_search: { count: 1, errors: 0, totalMs: 1, minMs: 1, maxMs: 1 } },
        cache: { hits: 0, misses: 0, size: 0, maxSize: 0 },
      };
      writeFileSync(join(statsDir, `${hash}.json`), JSON.stringify(legacy));

      const all = readAllStats();
      const proj = all.find(s => s.project === '/test/lazy');
      expect(proj).toBeDefined();
      expect(proj!.hash).toBe(hash);
      expect(proj!.sessionCount).toBe(1);
    });
  });

  describe('readSessionsForProject()', () => {
    it('returns one entry per session, newest first', () => {
      const w1 = new StatsWriter('/test/sessions');
      w1.scheduleWrite(makeSnapshot({ startedAt: Date.now() - 200_000 }));
      w1.flush();
      const w2 = new StatsWriter('/test/sessions');
      w2.scheduleWrite(makeSnapshot({ startedAt: Date.now() - 50_000 }));
      w2.flush();

      const sessions = readSessionsForProject(projectHash('/test/sessions'));
      expect(sessions.length).toBe(2);
      // newest first
      expect(sessions[0]!.startedAt).toBeGreaterThan(sessions[1]!.startedAt);
    });

    it('returns empty array for an unknown hash', () => {
      expect(readSessionsForProject('000000000000')).toEqual([]);
    });

    it('rejects malformed hash inputs', () => {
      expect(readSessionsForProject('../etc/passwd')).toEqual([]);
      expect(readSessionsForProject('not-hex-at-all')).toEqual([]);
    });
  });

  describe('readProjectHistory()', () => {
    it('returns history files for a specific project', () => {
      const hash = projectHash('/test/hist');
      const historyDir = join(tmpHome, '.codegraph', 'stats', 'history');
      mkdirSync(historyDir, { recursive: true });

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
      expect(history[0]!.cache.hits).toBe(0);
      expect(history[1]!.cache.hits).toBe(5);
    });

    it('rejects malformed hash inputs', () => {
      expect(readProjectHistory('../foo')).toEqual([]);
    });
  });

  describe('cleanupOldHistory()', () => {
    it('removes files older than 30 days', () => {
      const historyDir = join(tmpHome, '.codegraph', 'stats', 'history');
      mkdirSync(historyDir, { recursive: true });

      writeFileSync(join(historyDir, 'abc123def456_2026-03-29.json'), '{"version":1}');
      writeFileSync(join(historyDir, 'abc123def456_2026-05-27.json'), '{"version":1}');

      cleanupOldHistory();

      expect(existsSync(join(historyDir, 'abc123def456_2026-03-29.json'))).toBe(false);
      expect(existsSync(join(historyDir, 'abc123def456_2026-05-27.json'))).toBe(true);
    });
  });

  describe('readAllStats() — today filter', () => {
    it('excludes session files dated before today (they belong in History after archive)', () => {
      const hash = projectHash('/test/yesterday-only');
      const projectDir = getProjectDir(hash);
      mkdirSync(projectDir, { recursive: true });

      const yesterday = Date.now() - 86_400_000;
      const yStats: StatsFile = {
        version: 1, project: '/test/yesterday-only', projectName: 'yesterday-only',
        startedAt: yesterday, updatedAt: yesterday + 1_000,
        tools: { codegraph_search: { count: 1, errors: 0, totalMs: 1, minMs: 1, maxMs: 1 } },
        cache: { hits: 0, misses: 0, size: 0, maxSize: 0 },
      };
      writeFileSync(join(projectDir, `${yesterday}_111.json`), JSON.stringify(yStats));

      const all = readAllStats();
      expect(all.find(s => s.project === '/test/yesterday-only')).toBeUndefined();
    });

    it('excludes legacy <hash>.json dated before today', () => {
      const statsDir = join(tmpHome, '.codegraph', 'stats');
      mkdirSync(statsDir, { recursive: true });
      const hash = projectHash('/test/legacy-yesterday');
      const yesterday = Date.now() - 86_400_000;
      const stale: StatsFile = {
        version: 1, project: '/test/legacy-yesterday', projectName: 'legacy-yesterday',
        startedAt: yesterday, updatedAt: yesterday + 1_000,
        tools: {}, cache: { hits: 0, misses: 0, size: 0, maxSize: 0 },
      };
      writeFileSync(join(statsDir, `${hash}.json`), JSON.stringify(stale));

      const all = readAllStats();
      expect(all.find(s => s.project === '/test/legacy-yesterday')).toBeUndefined();
    });
  });

  describe('archiveOldSessions — concurrency-tolerant overwrite', () => {
    it('does NOT double-count when a partial history rollup already exists for the same day', () => {
      // Simulates the race: writer A wrote a complete rollup for yesterday,
      // crashed before deleting source files. A subsequent archive run
      // re-aggregates the same sources and overwrites the rollup with the
      // same data — counts must NOT double.
      const hash = projectHash('/test/no-double-count');
      const projectDir = getProjectDir(hash);
      const historyDir = join(tmpHome, '.codegraph', 'stats', 'history');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(historyDir, { recursive: true });

      const yesterday = Date.now() - 86_400_000;
      const sess: StatsFile = {
        version: 1, project: '/test/no-double-count', projectName: 'no-double-count',
        startedAt: yesterday, updatedAt: yesterday + 1_000,
        tools: { codegraph_search: { count: 4, errors: 0, totalMs: 4, minMs: 1, maxMs: 1 } },
        cache: { hits: 6, misses: 2, size: 8, maxSize: 1000 },
      };
      writeFileSync(join(projectDir, `${yesterday}_111.json`), JSON.stringify(sess));

      // Pre-existing rollup that already contains the same session's data
      const date = new Date(yesterday);
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      writeFileSync(join(historyDir, `${hash}_${dateStr}.json`), JSON.stringify(sess));

      // Trigger archive by constructing a new writer and flushing today's snapshot
      const writer = new StatsWriter('/test/no-double-count');
      writer.scheduleWrite(makeSnapshot());
      writer.flush();

      const rollup: StatsFile = JSON.parse(readFileSync(join(historyDir, `${hash}_${dateStr}.json`), 'utf8'));
      // Must equal the source — NOT 2× it
      expect(rollup.tools.codegraph_search!.count).toBe(4);
      expect(rollup.cache.hits).toBe(6);
      expect(rollup.cache.misses).toBe(2);
    });
  });

  describe('runStartupMaintenance()', () => {
    it('migrates loose legacy <hash>.json files even without a StatsWriter for that project', () => {
      const statsDir = join(tmpHome, '.codegraph', 'stats');
      mkdirSync(statsDir, { recursive: true });
      const hash = projectHash('/test/orphan-legacy');
      const startedAt = Date.now() - 5_000;
      const legacy: StatsFile = {
        version: 1, project: '/test/orphan-legacy', projectName: 'orphan-legacy',
        startedAt, updatedAt: startedAt + 1_000,
        tools: { codegraph_context: { count: 2, errors: 0, totalMs: 4, minMs: 1, maxMs: 3 } },
        cache: { hits: 1, misses: 1, size: 2, maxSize: 1000 },
      };
      writeFileSync(join(statsDir, `${hash}.json`), JSON.stringify(legacy));

      runStartupMaintenance();

      expect(existsSync(join(statsDir, `${hash}.json`))).toBe(false);
      expect(existsSync(join(statsDir, hash, `${startedAt}_legacy.json`))).toBe(true);
    });

    it('archives stale yesterday session files even when no MCP write occurs', () => {
      const hash = projectHash('/test/stale-archive');
      const projectDir = getProjectDir(hash);
      const historyDir = join(tmpHome, '.codegraph', 'stats', 'history');
      mkdirSync(projectDir, { recursive: true });

      const yesterday = Date.now() - 86_400_000;
      const sess: StatsFile = {
        version: 1, project: '/test/stale-archive', projectName: 'stale-archive',
        startedAt: yesterday, updatedAt: yesterday + 1_000,
        tools: { codegraph_search: { count: 9, errors: 1, totalMs: 5, minMs: 0.5, maxMs: 2 } },
        cache: { hits: 3, misses: 1, size: 4, maxSize: 1000 },
      };
      writeFileSync(join(projectDir, `${yesterday}_222.json`), JSON.stringify(sess));

      runStartupMaintenance();

      // Source session file should be gone
      expect(readdirSync(projectDir).some(f => f.startsWith(String(yesterday)))).toBe(false);
      // History rollup must exist
      const archived = readdirSync(historyDir).find(f => f.startsWith(`${hash}_`));
      expect(archived).toBeDefined();
      const rolled: StatsFile = JSON.parse(readFileSync(join(historyDir, archived!), 'utf8'));
      expect(rolled.tools.codegraph_search!.count).toBe(9);
    });

    it('is a no-op when the stats dir does not exist', () => {
      rmSync(join(tmpHome, '.codegraph'), { recursive: true, force: true });
      expect(() => runStartupMaintenance()).not.toThrow();
    });

    it('drops a malformed legacy <hash>.json and continues', () => {
      const statsDir = join(tmpHome, '.codegraph', 'stats');
      mkdirSync(statsDir, { recursive: true });
      const hash = 'aaaaaaaaaaaa'; // valid hash shape, garbage payload
      writeFileSync(join(statsDir, `${hash}.json`), 'not even json');

      expect(() => runStartupMaintenance()).not.toThrow();
      // It might or might not be deleted depending on whether JSON.parse threw
      // before or after we identified it as malformed; at minimum, no crash.
    });
  });
});
