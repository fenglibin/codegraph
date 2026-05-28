/**
 * Stats Writer — persists MCP session usage statistics to disk.
 *
 * Each MCP Server instance writes its stats to ~/.codegraph/stats/<hash>.json
 * where <hash> is the first 12 hex chars of SHA-256(projectPath).
 *
 * Features:
 *   - Debounced writes (max one disk write per DEBOUNCE_MS)
 *   - Atomic writes via tmp + rename
 *   - Sync flush on server shutdown
 *   - Daily archive rotation to history/ (30-day retention)
 */

import { createHash } from 'crypto';
import { debugLog, debugError } from './debug-log';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import type { ToolStats } from './tools';

/** On-disk stats file schema */
export interface StatsFile {
  version: 1;
  project: string;
  projectName: string;
  startedAt: number;
  updatedAt: number;
  tools: Record<string, {
    count: number;
    errors: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
  }>;
  cache: {
    hits: number;
    misses: number;
    size: number;
    maxSize: number;
  };
}

/** Snapshot passed from ToolHandler to StatsWriter on each update */
export interface SessionSnapshot {
  startedAt: number;
  tools: Map<string, ToolStats>;
  cache: { hits: number; misses: number; size: number; maxSize: number } | null;
}

const STATS_DIR_NAME = 'stats';
const HISTORY_DIR_NAME = 'history';
const DEBOUNCE_MS = 5_000;
const MAX_HISTORY_DAYS = 30;

/**
 * Get the global stats directory path: ~/.codegraph/stats/
 */
export function getStatsDir(): string {
  return join(homedir(), '.codegraph', STATS_DIR_NAME);
}

/**
 * Get the history directory path: ~/.codegraph/stats/history/
 */
export function getHistoryDir(): string {
  return join(getStatsDir(), HISTORY_DIR_NAME);
}

/**
 * Compute a stable hash for a project path (first 12 hex chars of SHA-256).
 */
export function projectHash(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 12);
}

export class StatsWriter {
  private projectPath: string;
  private hash: string;
  private statsDir: string;
  private historyDir: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSnapshot: SessionSnapshot | null = null;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.hash = projectHash(projectPath);
    this.statsDir = getStatsDir();
    this.historyDir = getHistoryDir();

    // Ensure directories exist
    mkdirSync(this.statsDir, { recursive: true });
    mkdirSync(this.historyDir, { recursive: true });
  }

  /**
   * Schedule a debounced write. Called by ToolHandler after each execute().
   * Only the most recent snapshot is kept; intermediate ones are discarded.
   */
  scheduleWrite(snapshot: SessionSnapshot): void {
    this.pendingSnapshot = snapshot;

    if (this.timer) {
      debugLog('stats-writer', 'scheduleWrite: timer already pending, updated snapshot', undefined, 'DEBUG');
      return;
    }

    debugLog('stats-writer', 'scheduleWrite: scheduling write in 5s', { hash: this.hash });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow();
    }, DEBOUNCE_MS);
  }

  /**
   * Synchronous flush — called from MCPServer.stop() before process exit.
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writeNow();
  }

  /**
   * Write the pending snapshot to disk (atomic: write tmp then rename).
   */
  private writeNow(): void {
    const snapshot = this.pendingSnapshot;
    if (!snapshot) {
      debugLog('stats-writer', 'writeNow: no pending snapshot, skipping', undefined, 'DEBUG');
      return;
    }
    this.pendingSnapshot = null;

    // Archive previous day's stats if needed
    this.archiveIfNeeded();

    const statsFile = this.buildStatsFile(snapshot);
    const filePath = join(this.statsDir, `${this.hash}.json`);
    const tmpPath = filePath + '.tmp';

    try {
      writeFileSync(tmpPath, JSON.stringify(statsFile, null, 2), 'utf8');
      renameSync(tmpPath, filePath);
      debugLog('stats-writer', 'Stats written to disk', { filePath, toolCount: Object.keys(statsFile.tools).length });
    } catch (err) {
      debugError('stats-writer', 'Failed to write stats', { filePath, error: err instanceof Error ? err.message : String(err) });
      // Stats writing is best-effort — never break the MCP server
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  /**
   * If an existing stats file for this project has a different date than today,
   * move it to history/ before overwriting.
   */
  private archiveIfNeeded(): void {
    const filePath = join(this.statsDir, `${this.hash}.json`);
    if (!existsSync(filePath)) return;

    try {
      const raw = readFileSync(filePath, 'utf8');
      const existing: StatsFile = JSON.parse(raw);
      const existingDate = toDateString(existing.startedAt);
      const today = toDateString(Date.now());

      if (existingDate !== today) {
        const historyFile = join(this.historyDir, `${this.hash}_${existingDate}.json`);
        renameSync(filePath, historyFile);
      }
    } catch {
      // If parsing fails, just overwrite
    }
  }

  /**
   * Build the StatsFile object from a SessionSnapshot.
   */
  private buildStatsFile(snapshot: SessionSnapshot): StatsFile {
    const tools: StatsFile['tools'] = {};
    for (const [name, s] of snapshot.tools) {
      tools[name] = {
        count: s.count,
        errors: s.errors,
        totalMs: s.totalMs,
        minMs: s.minMs === Infinity ? 0 : s.minMs,
        maxMs: s.maxMs,
      };
    }

    return {
      version: 1,
      project: this.projectPath,
      projectName: basename(this.projectPath),
      startedAt: snapshot.startedAt,
      updatedAt: Date.now(),
      tools,
      cache: snapshot.cache || { hits: 0, misses: 0, size: 0, maxSize: 0 },
    };
  }
}

/**
 * Clean up history files older than MAX_HISTORY_DAYS.
 * Called from the dashboard on startup.
 */
export function cleanupOldHistory(): void {
  const historyDir = getHistoryDir();
  if (!existsSync(historyDir)) return;

  const cutoff = Date.now() - MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const cutoffDate = toDateString(cutoff);

  try {
    for (const file of readdirSync(historyDir)) {
      // Expected format: <hash>_YYYY-MM-DD.json
      const match = file.match(/_(\d{4}-\d{2}-\d{2})\.json$/);
      if (match && match[1]! < cutoffDate) {
        try { unlinkSync(join(historyDir, file)); } catch { /* ignore */ }
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Read all current stats files from ~/.codegraph/stats/
 */
export function readAllStats(): StatsFile[] {
  const statsDir = getStatsDir();
  if (!existsSync(statsDir)) return [];

  const results: StatsFile[] = [];
  try {
    for (const file of readdirSync(statsDir)) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
      try {
        const raw = readFileSync(join(statsDir, file), 'utf8');
        const parsed = JSON.parse(raw) as StatsFile;
        if (parsed.version === 1) {
          results.push(parsed);
        }
      } catch { /* skip malformed files */ }
    }
  } catch { /* directory read failed */ }

  return results;
}

/**
 * Read history stats for a specific project hash.
 */
export function readProjectHistory(hash: string): StatsFile[] {
  const historyDir = getHistoryDir();
  if (!existsSync(historyDir)) return [];

  const results: StatsFile[] = [];
  const prefix = `${hash}_`;

  try {
    for (const file of readdirSync(historyDir)) {
      if (!file.startsWith(prefix) || !file.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(historyDir, file), 'utf8');
        const parsed = JSON.parse(raw) as StatsFile;
        if (parsed.version === 1) {
          results.push(parsed);
        }
      } catch { /* skip */ }
    }
  } catch { /* directory read failed */ }

  // Sort by date (oldest first)
  results.sort((a, b) => a.startedAt - b.startedAt);
  return results;
}

function toDateString(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
