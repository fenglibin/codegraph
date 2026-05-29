/**
 * File Watcher
 *
 * Watches the project directory for file changes and emits categorized
 * change events. Consumers (code sync, doc sync) subscribe independently
 * with their own debounce timers and sync logic — they never block or
 * interfere with each other.
 *
 * Architecture (event bus pattern):
 *
 *   fs.watch (single recursive watcher)
 *       │
 *       ▼  classify file → 'source' | 'doc' | 'other'
 *       │
 *   ┌───┴───────────────────────┐
 *   │   Subscriber: code sync   │  debounce 2000ms, heavy (tree-sitter)
 *   │   Subscriber: doc sync    │  debounce 500ms, light (hash + chunk)
 *   └───────────────────────────┘
 *
 * Uses Node.js native fs.watch with recursive mode (macOS FSEvents,
 * Windows ReadDirectoryChangesW, Linux inotify on Node 19+).
 */

import * as fs from 'fs';
import { isSourceFile } from '../extraction';
import { isDocFile, isDocExcluded } from '../documents/excludes';
import { logDebug, logWarn } from '../errors';
import { normalizePath } from '../utils';
import { watchDisabledReason } from './watch-policy';

/** File change categories emitted by the watcher. */
export type FileChangeKind = 'source' | 'doc' | 'other';

/** A single change event delivered to subscribers. */
export interface FileChangeEvent {
  /** Relative path (forward-slash normalized) */
  path: string;
  /** Classified file type */
  kind: FileChangeKind;
}

/**
 * Options for the file watcher (legacy-compatible).
 * Used by CodeGraph.watch() to configure the code-sync subscriber.
 */
export interface WatchOptions {
  /**
   * Debounce delay in milliseconds for code sync.
   * After the last source file change, wait this long before triggering sync.
   * Default: 2000ms
   */
  debounceMs?: number;

  /**
   * Callback when a code sync completes (for logging/diagnostics).
   */
  onSyncComplete?: (result: { filesChanged: number; durationMs: number }) => void;

  /**
   * Callback when a code sync errors (for logging/diagnostics).
   */
  onSyncError?: (error: Error) => void;
}

/**
 * Configuration for a sync subscriber. Each subscriber operates
 * independently with its own debounce, sync function, and error handling.
 */
export interface SyncSubscriber {
  /** Which file kinds this subscriber cares about */
  kinds: FileChangeKind[];
  /** Debounce delay in ms (default: 2000) */
  debounceMs?: number;
  /** The sync function to call when debounce fires */
  syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  /** Called on successful sync */
  onSyncComplete?: (result: { filesChanged: number; durationMs: number }) => void;
  /** Called when sync throws */
  onSyncError?: (error: Error) => void;
}

/** Internal state for a registered subscriber. */
interface SubscriberState {
  config: SyncSubscriber;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  hasChanges: boolean;
  syncing: boolean;
}

/**
 * FileWatcher monitors a project directory for changes and dispatches
 * categorized events to independent sync subscribers.
 *
 * Design goals:
 * - Single OS-level watcher (no duplicate inode consumption)
 * - Subscribers are fully isolated (own debounce, own sync, own errors)
 * - Minimal resource usage (native OS file events, no polling)
 * - Filters out .codegraph/ directory changes
 */
export class FileWatcher {
  private watcher: fs.FSWatcher | null = null;
  private stopped = false;
  private readonly projectRoot: string;
  private subscribers: SubscriberState[] = [];

  // Legacy fields for backward compatibility with existing API
  private legacyDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private legacyHasChanges = false;
  private legacySyncing = false;
  private readonly legacySyncFn: (() => Promise<{ filesChanged: number; durationMs: number }>) | null;
  private readonly legacyDebounceMs: number;
  private readonly legacyOnSyncComplete?: WatchOptions['onSyncComplete'];
  private readonly legacyOnSyncError?: WatchOptions['onSyncError'];

  /**
   * Create a FileWatcher.
   *
   * For backward compatibility, accepts the same (projectRoot, syncFn, options)
   * signature as before. The syncFn is treated as a code-sync subscriber.
   * Additional subscribers can be added via addSubscriber().
   */
  constructor(
    projectRoot: string,
    syncFn: (() => Promise<{ filesChanged: number; durationMs: number }>) | null = null,
    options: WatchOptions = {}
  ) {
    this.projectRoot = projectRoot;
    this.legacySyncFn = syncFn;
    this.legacyDebounceMs = options.debounceMs ?? 2000;
    this.legacyOnSyncComplete = options.onSyncComplete;
    this.legacyOnSyncError = options.onSyncError;
  }

  /**
   * Register an independent sync subscriber.
   * Each subscriber has its own debounce timer and sync lifecycle.
   * Must be called before start().
   */
  addSubscriber(subscriber: SyncSubscriber): void {
    this.subscribers.push({
      config: subscriber,
      debounceTimer: null,
      hasChanges: false,
      syncing: false,
    });
  }

  /**
   * Start watching for file changes.
   * Returns true if watching started successfully, false otherwise.
   */
  start(): boolean {
    if (this.watcher) return true; // Already watching
    this.stopped = false;

    // Some environments make recursive fs.watch unusable — most notably WSL2
    // /mnt/ drives, where setup blocks long enough to break MCP startup
    // handshakes (issue #199). Skip watching there; callers fall back to
    // manual `codegraph sync` or the git sync hooks.
    const disabledReason = watchDisabledReason(this.projectRoot);
    if (disabledReason) {
      logDebug('File watcher disabled', { reason: disabledReason, projectRoot: this.projectRoot });
      return false;
    }

    try {
      this.watcher = fs.watch(
        this.projectRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename || this.stopped) return;

          // Normalize path separators
          const normalized = normalizePath(filename);

          // Ignore .codegraph/ directory changes (our own DB writes)
          if (
            normalized === '.codegraph' ||
            normalized.startsWith('.codegraph/') ||
            normalized.startsWith('.codegraph\\')
          ) {
            return;
          }

          // Classify the file change
          const kind = this.classifyFile(normalized);

          logDebug('File change detected', { file: normalized, kind });

          // Dispatch to legacy code sync (backward compat)
          if (kind === 'source' && this.legacySyncFn) {
            this.legacyHasChanges = true;
            this.scheduleLegacySync();
          }

          // Dispatch to subscribers
          for (const sub of this.subscribers) {
            if (sub.config.kinds.includes(kind)) {
              sub.hasChanges = true;
              this.scheduleSubscriberSync(sub);
            }
          }
        }
      );

      // Handle watcher errors gracefully
      this.watcher.on('error', (err) => {
        logWarn('File watcher error', { error: String(err) });
        // Don't crash — watcher may recover or user can restart
      });

      logDebug('File watcher started', {
        projectRoot: this.projectRoot,
        legacyDebounceMs: this.legacyDebounceMs,
        subscribers: this.subscribers.length,
      });
      return true;
    } catch (err) {
      // Recursive watch not supported (e.g., Linux < Node 19)
      logWarn('Could not start file watcher — recursive fs.watch not supported on this platform', { error: String(err) });
      return false;
    }
  }

  /**
   * Stop watching for file changes.
   */
  stop(): void {
    this.stopped = true;

    // Clear legacy timer
    if (this.legacyDebounceTimer) {
      clearTimeout(this.legacyDebounceTimer);
      this.legacyDebounceTimer = null;
    }

    // Clear subscriber timers
    for (const sub of this.subscribers) {
      if (sub.debounceTimer) {
        clearTimeout(sub.debounceTimer);
        sub.debounceTimer = null;
      }
      sub.hasChanges = false;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.legacyHasChanges = false;
    logDebug('File watcher stopped');
  }

  /**
   * Whether the watcher is currently active.
   */
  isActive(): boolean {
    return this.watcher !== null && !this.stopped;
  }

  /**
   * Classify a file path into source, doc, or other.
   */
  private classifyFile(relativePath: string): FileChangeKind {
    if (isSourceFile(relativePath)) {
      return 'source';
    }
    if (isDocFile(relativePath) && !isDocExcluded(relativePath)) {
      return 'doc';
    }
    return 'other';
  }

  // ===========================================================================
  // Legacy code sync (backward compat with existing CodeGraph.watch() API)
  // ===========================================================================

  private scheduleLegacySync(): void {
    if (this.legacyDebounceTimer) {
      clearTimeout(this.legacyDebounceTimer);
    }
    this.legacyDebounceTimer = setTimeout(() => {
      this.legacyDebounceTimer = null;
      this.flushLegacy();
    }, this.legacyDebounceMs);
  }

  private async flushLegacy(): Promise<void> {
    if (this.legacySyncing || this.stopped || !this.legacySyncFn) return;

    this.legacyHasChanges = false;
    this.legacySyncing = true;

    try {
      const result = await this.legacySyncFn();
      this.legacyOnSyncComplete?.(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logWarn('Watch sync failed', { error: error.message });
      this.legacyOnSyncError?.(error);
    } finally {
      this.legacySyncing = false;

      // If new changes arrived during sync, schedule another
      if (this.legacyHasChanges && !this.stopped) {
        this.scheduleLegacySync();
      }
    }
  }

  // ===========================================================================
  // Subscriber sync (independent per subscriber)
  // ===========================================================================

  private scheduleSubscriberSync(sub: SubscriberState): void {
    if (sub.debounceTimer) {
      clearTimeout(sub.debounceTimer);
    }
    const debounceMs = sub.config.debounceMs ?? 2000;
    sub.debounceTimer = setTimeout(() => {
      sub.debounceTimer = null;
      this.flushSubscriber(sub);
    }, debounceMs);
  }

  private async flushSubscriber(sub: SubscriberState): Promise<void> {
    if (sub.syncing || this.stopped) return;

    sub.hasChanges = false;
    sub.syncing = true;

    try {
      const result = await sub.config.syncFn();
      sub.config.onSyncComplete?.(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logWarn('Subscriber sync failed', { error: error.message });
      sub.config.onSyncError?.(error);
    } finally {
      sub.syncing = false;

      // If new changes arrived during sync, schedule another
      if (sub.hasChanges && !this.stopped) {
        this.scheduleSubscriberSync(sub);
      }
    }
  }
}
