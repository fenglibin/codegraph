/**
 * Stats Writer — persists MCP session usage statistics to disk.
 *
 * Disk layout (one file per session, never overwriting another session):
 *   ~/.codegraph/stats/<hash>/<startedAt>_<pid>.json
 *
 * where <hash> = first 12 hex chars of SHA-256(projectPath). The dashboard
 * aggregates per-project sessions into a single record on read; per-session
 * detail is exposed via readSessionsForProject().
 *
 * Cross-day archive: when a writer runs and finds session files from a
 * previous day in its project's directory, those files are aggregated by
 * date and moved to history/<hash>_<date>.json (30-day retention).
 *
 * Backward compatibility: a one-time per-writer migration moves any legacy
 * ~/.codegraph/stats/<hash>.json file (pre-0.7.x layout) into the new
 * <hash>/<startedAt>_legacy.json path so it isn't lost.
 *
 * Features:
 *   - Debounced writes (max one disk write per DEBOUNCE_MS)
 *   - Atomic writes via tmp + rename
 *   - Sync flush on server shutdown
 *   - Best-effort: stats writing never breaks the MCP server
 */

import { createHash } from 'crypto';
import { debugLog, debugError } from './debug-log';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import type { ToolStats } from './tools';

/** Per-tool aggregate counters */
export interface ToolStatsEntry {
  count: number;
  errors: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
}

/** On-disk stats file schema (one per session, also used for daily history rollups) */
export interface StatsFile {
  version: 1;
  project: string;
  projectName: string;
  startedAt: number;
  updatedAt: number;
  tools: Record<string, ToolStatsEntry>;
  cache: {
    hits: number;
    misses: number;
    size: number;
    maxSize: number;
  };
}

/**
 * Aggregated record returned by readAllStats(). Carries the authoritative
 * project hash (from the directory name) plus the count of sessions that
 * contributed, so the dashboard never has to recompute or guess.
 */
export interface AggregatedStats extends StatsFile {
  hash: string;
  sessionCount: number;
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
const HASH_RE = /^[a-f0-9]{12}$/;

/** Get the global stats directory path: ~/.codegraph/stats/ */
export function getStatsDir(): string {
  return join(homedir(), '.codegraph', STATS_DIR_NAME);
}

/** Get the history directory path: ~/.codegraph/stats/history/ */
export function getHistoryDir(): string {
  return join(getStatsDir(), HISTORY_DIR_NAME);
}

/** Get the per-project sessions directory: ~/.codegraph/stats/<hash>/ */
export function getProjectDir(hash: string): string {
  return join(getStatsDir(), hash);
}

/** Compute a stable hash for a project path (first 12 hex chars of SHA-256). */
export function projectHash(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 12);
}

export class StatsWriter {
  private projectPath: string;
  private hash: string;
  private statsDir: string;
  private projectDir: string;
  private historyDir: string;
  private sessionFilePath: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSnapshot: SessionSnapshot | null = null;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.hash = projectHash(projectPath);
    this.statsDir = getStatsDir();
    this.projectDir = getProjectDir(this.hash);
    this.historyDir = getHistoryDir();

    // Ensure directories exist (per-project + global history)
    mkdirSync(this.projectDir, { recursive: true });
    mkdirSync(this.historyDir, { recursive: true });

    // One-time migration of legacy <hash>.json layout (pre-per-session)
    this.migrateLegacyFile();
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
   * Path to this session's stats file. Stable for the lifetime of the writer
   * (every flush updates the SAME file — same startedAt + same pid).
   */
  private getSessionFilePath(startedAt: number): string {
    if (!this.sessionFilePath) {
      this.sessionFilePath = join(this.projectDir, `${startedAt}_${process.pid}.json`);
    }
    return this.sessionFilePath;
  }

  /**
   * Write the pending snapshot for THIS session to disk. Atomic via tmp + rename.
   * Sessions never overwrite each other — only the writer that owns this
   * session's `startedAt`+`pid` writes here.
   */
  private writeNow(): void {
    const snapshot = this.pendingSnapshot;
    if (!snapshot) {
      debugLog('stats-writer', 'writeNow: no pending snapshot, skipping', undefined, 'DEBUG');
      return;
    }
    this.pendingSnapshot = null;

    // Best-effort cross-day archive of stale session files for this project.
    // Failures here must not block the actual write.
    try {
      archiveOldSessions(this.hash, this.projectDir, this.historyDir);
    } catch (err) {
      debugError('stats-writer', 'archiveOldSessions failed (best-effort)', { error: err instanceof Error ? err.message : String(err) });
    }

    const statsFile = this.buildStatsFile(snapshot);
    const filePath = this.getSessionFilePath(snapshot.startedAt);
    const tmpPath = filePath + '.tmp';

    try {
      // Defensive: re-create projectDir in case it was deleted externally
      // (e.g., user `rm -rf ~/.codegraph` mid-session) — without this the
      // tmp write below would ENOENT and lose the snapshot.
      mkdirSync(this.projectDir, { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(statsFile, null, 2), 'utf8');
      renameSync(tmpPath, filePath);
      debugLog('stats-writer', 'Stats written to disk', { filePath, toolCount: Object.keys(statsFile.tools).length });
    } catch (err) {
      debugError('stats-writer', 'Failed to write stats', { filePath, error: err instanceof Error ? err.message : String(err) });
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  /** Build a single-session StatsFile from a snapshot. */
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

  /**
   * Move a legacy ~/.codegraph/stats/<hash>.json file (pre-per-session layout)
   * into ~/.codegraph/stats/<hash>/<startedAt>_legacy.json so it is preserved
   * for aggregation and archive. Idempotent and best-effort.
   */
  private migrateLegacyFile(): void {
    const legacyPath = join(this.statsDir, `${this.hash}.json`);
    if (!existsSync(legacyPath)) return;

    try {
      const st = statSync(legacyPath);
      if (st.isDirectory()) return; // shouldn't happen, but be defensive

      const raw = readFileSync(legacyPath, 'utf8');
      const existing: StatsFile = JSON.parse(raw);
      if (existing.version !== 1 || typeof existing.startedAt !== 'number') {
        // Unrecognized — drop it; the source schema is private to us
        unlinkSync(legacyPath);
        return;
      }

      const target = join(this.projectDir, `${existing.startedAt}_legacy.json`);
      if (!existsSync(target)) {
        renameSync(legacyPath, target);
        debugLog('stats-writer', 'Migrated legacy stats file', { from: legacyPath, to: target });
      } else {
        // Already migrated by an earlier run — drop the duplicate
        unlinkSync(legacyPath);
      }
    } catch (err) {
      debugError('stats-writer', 'Legacy migration failed (best-effort)', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Move all session files in projectDir whose updatedAt is older than
 * ACTIVE_WINDOW_DAYS into history/<hash>_<date>.json, aggregating per-day.
 * The session source files are deleted only after the history file is
 * successfully written.
 *
 * We use updatedAt (not startedAt) to determine "liveness": a long-lived
 * MCP server started a week ago but still active today must NOT be archived
 * simply because its startedAt falls outside the window. Only sessions whose
 * last update is older than ACTIVE_WINDOW_DAYS are considered stale and
 * eligible for archiving.
 *
 * The per-day grouping key is still startedAt (the session's logical date),
 * which preserves the existing history/<hash>_<date>.json naming convention.
 *
 * Concurrency model:
 *   - We never merge with an existing history file. Two writers archiving
 *     concurrently both compute the same aggregate over the same source
 *     files and either output is correct (last-rename-wins).
 *   - The remaining race is a writer that reads after another writer has
 *     started deleting source files: the second writer would see fewer
 *     sources and overwrite a complete rollup with a partial one. That
 *     produces an UNDER-count, which is preferable to the double-count a
 *     merge-on-existing strategy would create. Since this is best-effort
 *     statistics, we accept the rare under-count and never block on a lock.
 *   - On the next archive run, source files that haven't been deleted yet
 *     get re-archived: the resulting overwrite is idempotent on the same
 *     data, so no double-count even after a crash mid-archive.
 */
function archiveOldSessions(hash: string, projectDir: string, historyDir: string): void {
  if (!existsSync(projectDir)) return;
  const cutoff = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return;
  }

  // Group sessions by their startedAt date, but only archive those whose
  // updatedAt is older than ACTIVE_WINDOW_DAYS (i.e., no longer in the
  // active window).
  const byDate = new Map<string, { sessions: StatsFile[]; sourcePaths: string[] }>();
  for (const file of entries) {
    if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
    const fullPath = join(projectDir, file);
    let parsed: StatsFile;
    try {
      parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as StatsFile;
    } catch {
      continue;
    }
    if (parsed.version !== 1) continue;
    // A session that was updated within the active window is still visible
    // — don't archive it even if it was started on a previous day/week.
    if (parsed.updatedAt >= cutoff) continue;
    const date = toDateString(parsed.startedAt);
    let group = byDate.get(date);
    if (!group) {
      group = { sessions: [], sourcePaths: [] };
      byDate.set(date, group);
    }
    group.sessions.push(parsed);
    group.sourcePaths.push(fullPath);
  }

  if (byDate.size === 0) return;

  for (const [date, { sessions, sourcePaths }] of byDate) {
    const aggregated = aggregateSessions(sessions);
    const historyFile = join(historyDir, `${hash}_${date}.json`);
    const tmp = historyFile + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(aggregated, null, 2), 'utf8');
      renameSync(tmp, historyFile);
    } catch (err) {
      debugError('stats-writer', 'Failed to write history rollup', { historyFile, error: err instanceof Error ? err.message : String(err) });
      try { unlinkSync(tmp); } catch { /* ignore */ }
      // Don't delete sources if history write failed — try again next time
      continue;
    }

    for (const p of sourcePaths) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }

  // Clean up the project directory if it's now empty — avoids leaving hollow
  // <hash>/ directories that clutter the stats directory and waste inode space.
  try {
    const remaining = readdirSync(projectDir);
    if (remaining.length === 0) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  } catch { /* ignore — another writer may have added a file */ }
}

/**
 * Aggregate multiple StatsFile entries into one. Used for both:
 *   - the dashboard's per-project active view (aggregating today's sessions)
 *   - the daily history rollup (aggregating a day's sessions)
 *
 * Aggregation rules:
 *   - startedAt = min, updatedAt = max
 *   - tools: count/errors/totalMs summed; minMs = smallest non-zero;
 *     maxMs = largest
 *   - cache.hits / cache.misses summed across all sessions
 *   - cache.size / cache.maxSize taken from the session with the latest
 *     updatedAt (per-process LRUs are not summable; "latest" is the most
 *     useful single value)
 */
function aggregateSessions(sessions: StatsFile[]): StatsFile {
  if (sessions.length === 0) {
    throw new Error('aggregateSessions: empty input');
  }
  if (sessions.length === 1) {
    return sessions[0]!;
  }

  let startedAt = sessions[0]!.startedAt;
  let updatedAt = sessions[0]!.updatedAt;
  let latest = sessions[0]!;
  const tools: Record<string, ToolStatsEntry> = {};
  let hits = 0;
  let misses = 0;

  for (const s of sessions) {
    if (s.startedAt < startedAt) startedAt = s.startedAt;
    if (s.updatedAt > updatedAt) updatedAt = s.updatedAt;
    if (s.updatedAt >= latest.updatedAt) latest = s;

    for (const [name, t] of Object.entries(s.tools)) {
      const existing = tools[name];
      if (!existing) {
        tools[name] = { count: t.count, errors: t.errors, totalMs: t.totalMs, minMs: t.minMs, maxMs: t.maxMs };
      } else {
        existing.count += t.count;
        existing.errors += t.errors;
        existing.totalMs += t.totalMs;
        if (t.minMs > 0 && (existing.minMs === 0 || t.minMs < existing.minMs)) {
          existing.minMs = t.minMs;
        }
        if (t.maxMs > existing.maxMs) existing.maxMs = t.maxMs;
      }
    }

    hits += s.cache.hits;
    misses += s.cache.misses;
  }

  return {
    version: 1,
    project: sessions[0]!.project,
    projectName: sessions[0]!.projectName,
    startedAt,
    updatedAt,
    tools,
    cache: {
      hits,
      misses,
      size: latest.cache.size,
      maxSize: latest.cache.maxSize,
    },
  };
}

/** Clean up history files older than MAX_HISTORY_DAYS. Called from the dashboard on startup. */
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
 * Run on dashboard startup (and any other long-lived stats consumer): bring
 * the on-disk layout up to date for projects whose MCP server hasn't run
 * recently.
 *
 *   1. Migrate any loose ~/.codegraph/stats/<hash>.json files (pre-0.10.8
 *      layout) into ~/.codegraph/stats/<hash>/<startedAt>_legacy.json. Without
 *      this, a project the user hasn't reopened in a new MCP session would
 *      stay in the legacy file forever and miss out on archive rotation.
 *   2. Archive any session files in ~/.codegraph/stats/<hash>/ whose
 *      updatedAt is older than ACTIVE_WINDOW_DAYS, into
 *      history/<hash>_<date>.json. Without this, stale sessions for a
 *      project the user closed remain invisible (filtered out of
 *      readAllStats) until the next MCP write for that project — possibly
 *      forever.
 *
 * Best-effort: failures don't propagate, the dashboard still starts.
 */
export function runStartupMaintenance(): void {
  const statsDir = getStatsDir();
  if (!existsSync(statsDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(statsDir);
  } catch {
    return;
  }

  const historyDir = getHistoryDir();
  // Make sure history dir exists before any archive write below.
  try { mkdirSync(historyDir, { recursive: true }); } catch { /* ignore */ }

  // Pass 1 — migrate loose <hash>.json legacy files.
  for (const entry of entries) {
    if (entry === HISTORY_DIR_NAME) continue;
    if (!entry.endsWith('.json') || entry.endsWith('.tmp')) continue;

    const hash = entry.replace(/\.json$/, '');
    if (!HASH_RE.test(hash)) continue;

    const legacyPath = join(statsDir, entry);
    let st;
    try { st = statSync(legacyPath); } catch { continue; }
    if (!st.isFile()) continue;

    try {
      const raw = readFileSync(legacyPath, 'utf8');
      const existing = JSON.parse(raw) as StatsFile;
      if (existing.version !== 1 || typeof existing.startedAt !== 'number') {
        unlinkSync(legacyPath);
        continue;
      }

      const projectDir = getProjectDir(hash);
      mkdirSync(projectDir, { recursive: true });
      const target = join(projectDir, `${existing.startedAt}_legacy.json`);
      if (!existsSync(target)) {
        renameSync(legacyPath, target);
      } else {
        unlinkSync(legacyPath);
      }
    } catch (err) {
      debugError('stats-writer', 'Startup legacy migration failed', { legacyPath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Pass 2 — archive pre-today session files in each project directory.
  // Re-read entries because pass 1 may have created new <hash>/ dirs.
  let postMigration: string[];
  try {
    postMigration = readdirSync(statsDir);
  } catch {
    return;
  }

  for (const entry of postMigration) {
    if (entry === HISTORY_DIR_NAME) continue;
    if (!HASH_RE.test(entry)) continue;
    const projectDir = join(statsDir, entry);
    let st;
    try { st = statSync(projectDir); } catch { continue; }
    if (!st.isDirectory()) continue;

    try {
      archiveOldSessions(entry, projectDir, historyDir);
    } catch (err) {
      debugError('stats-writer', 'Startup archive failed', { projectDir, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Pass 3 — clean up empty project directories left over from previous archive
  // runs or from the pre-ACTIVE_WINDOW_DAYS era. An empty <hash>/ directory
  // wastes inodes and clutters directory listings; removing it is safe because
  // StatsWriter.mkdirSync's on the next write for that project.
  let postArchive: string[];
  try {
    postArchive = readdirSync(statsDir);
  } catch {
    return;
  }

  for (const entry of postArchive) {
    if (entry === HISTORY_DIR_NAME) continue;
    if (!HASH_RE.test(entry)) continue;
    const projectDir = join(statsDir, entry);
    let st;
    try { st = statSync(projectDir); } catch { continue; }
    if (!st.isDirectory()) continue;

    try {
      const remaining = readdirSync(projectDir);
      if (remaining.length === 0) {
        rmSync(projectDir, { recursive: true, force: true });
      }
    } catch { /* another writer may be active — skip */ }
  }
}

/** Number of days to include in the active dashboard view. */
const ACTIVE_WINDOW_DAYS = 7;

/**
 * Read all current stats from ~/.codegraph/stats/.
 *
 * Returns one AggregatedStats record per project, aggregating session files
 * whose updatedAt falls within the last ACTIVE_WINDOW_DAYS days. This gives
 * users a broader view of recent activity while still excluding truly stale
 * sessions. Results are sorted by updatedAt descending (most recently active
 * first).
 *
 * Data sources (merged by hash — never two rows for the same project):
 *   1. Active <hash>/ directories — per-session files from running MCP servers
 *   2. Top-level legacy <hash>.json — pre-0.10.8 layout, not yet migrated
 *   3. History <hash>_<date>.json — archived rollups within the active window
 *
 * Source 3 is critical: `archiveOldSessions` may have already moved a
 * session's data to history (e.g. the old "today-only" logic archived
 * yesterday's data, or maintenance ran before the window was widened to 7
 * days). By including history records whose updatedAt falls within the window,
 * the dashboard shows a complete picture even when archiving has already
 * occurred.
 */
export function readAllStats(): AggregatedStats[] {
  const statsDir = getStatsDir();
  if (!existsSync(statsDir)) return [];

  const cutoff = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = readdirSync(statsDir);
  } catch {
    return [];
  }

  // Collect recent StatsFiles per hash from THREE sources:
  //   (a) directory branch — per-session 0.10.8 layout
  //   (b) top-level legacy file — pre-0.10.8 layout
  //   (c) history directory — archived rollups within the active window
  // Same hash on multiple sources means same project — merge them.
  // A session is "recent" if updatedAt >= cutoff (last ACTIVE_WINDOW_DAYS).
  const sessionsByHash = new Map<string, StatsFile[]>();

  const addSessions = (hash: string, sessions: StatsFile[]): void => {
    if (sessions.length === 0) return;
    const existing = sessionsByHash.get(hash);
    if (existing) {
      existing.push(...sessions);
    } else {
      sessionsByHash.set(hash, sessions);
    }
  };

  for (const entry of entries) {
    if (entry === HISTORY_DIR_NAME) continue;

    const full = join(statsDir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }

    if (st.isDirectory() && HASH_RE.test(entry)) {
      const recentSessions = readSessionFiles(full).filter(
        s => s.updatedAt >= cutoff
      );
      addSessions(entry, recentSessions);
    } else if (st.isFile() && entry.endsWith('.json') && !entry.endsWith('.tmp')) {
      // Legacy <hash>.json — surface it only if it represents recent data
      // (by updatedAt within the active window). Older legacy files become
      // visible in History after `runStartupMaintenance` archives them.
      const hash = entry.replace(/\.json$/, '');
      if (!HASH_RE.test(hash)) continue;
      try {
        const parsed = JSON.parse(readFileSync(full, 'utf8')) as StatsFile;
        if (parsed.version !== 1) continue;
        if (parsed.updatedAt < cutoff) continue;
        addSessions(hash, [parsed]);
      } catch { /* skip */ }
    }
  }

  // Also include history rollups whose updatedAt falls within the active
  // window. This covers the case where sessions were already archived
  // (e.g. by the old "today-only" logic or by maintenance) but are still
  // recent enough to appear in the 7-day view.
  const historyDir = join(statsDir, HISTORY_DIR_NAME);
  if (existsSync(historyDir)) {
    try {
      for (const file of readdirSync(historyDir)) {
        if (!file.endsWith('.json')) continue;
        // History file naming: <hash>_<date>.json — extract hash from prefix.
        const underscoreIdx = file.lastIndexOf('_');
        if (underscoreIdx < 0) continue;
        const hash = file.substring(0, underscoreIdx);
        if (!HASH_RE.test(hash)) continue;
        try {
          const parsed = JSON.parse(
            readFileSync(join(historyDir, file), 'utf8')
          ) as StatsFile;
          if (parsed.version !== 1) continue;
          if (parsed.updatedAt < cutoff) continue;
          addSessions(hash, [parsed]);
        } catch { /* skip */ }
      }
    } catch { /* directory read failed */ }
  }

  const out: AggregatedStats[] = [];
  for (const [hash, sessions] of sessionsByHash) {
    const agg = aggregateSessions(sessions);
    out.push({ ...agg, hash, sessionCount: sessions.length });
  }
  // Sort by updatedAt descending — most recently active projects first.
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * Read every session file currently on disk for one project, newest first.
 * Used by the dashboard to render the "Sessions" panel — each entry is one
 * MCP server lifetime, not a daily rollup.
 */
export function readSessionsForProject(hash: string): StatsFile[] {
  if (!HASH_RE.test(hash)) return [];
  const projectDir = getProjectDir(hash);
  if (!existsSync(projectDir)) return [];
  return readSessionFiles(projectDir);
}

function readSessionFiles(projectDir: string): StatsFile[] {
  let entries: string[];
  try { entries = readdirSync(projectDir); } catch { return []; }

  const out: StatsFile[] = [];
  for (const f of entries) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(projectDir, f), 'utf8')) as StatsFile;
      if (parsed.version === 1) out.push(parsed);
    } catch { /* skip malformed file */ }
  }
  out.sort((a, b) => b.startedAt - a.startedAt); // newest first
  return out;
}

/** Read history stats for a specific project hash (oldest first). */
export function readProjectHistory(hash: string): StatsFile[] {
  if (!HASH_RE.test(hash)) return [];
  const historyDir = getHistoryDir();
  if (!existsSync(historyDir)) return [];

  const results: StatsFile[] = [];
  const prefix = `${hash}_`;

  try {
    for (const file of readdirSync(historyDir)) {
      if (!file.startsWith(prefix) || !file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(historyDir, file), 'utf8')) as StatsFile;
        if (parsed.version === 1) results.push(parsed);
      } catch { /* skip */ }
    }
  } catch { /* directory read failed */ }

  results.sort((a, b) => a.startedAt - b.startedAt);
  return results;
}

function toDateString(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
