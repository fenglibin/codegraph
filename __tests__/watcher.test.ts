/**
 * FileWatcher Tests
 *
 * Tests for the file watcher that auto-syncs on changes.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileWatcher } from '../src/sync/watcher';
import CodeGraph from '../src/index';

/**
 * Helper to wait for a condition with timeout.
 *
 * Accepts an optional AbortSignal so callers (e.g. `afterEach`) can cancel
 * the recursive setTimeout chain when the test ends. Without this, a vitest
 * timeout can leave a pending `setTimeout(check, ...)` that fires after the
 * test's resources (DB handle, watcher, etc.) are torn down — which surfaces
 * as confusing `database is not open` unhandled errors and false-positive
 * test failures on subsequent runs.
 */
function waitFor(
  condition: () => boolean,
  timeoutMs = 10000,
  intervalMs = 100,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const start = Date.now();
    const check = () => {
      if (signal?.aborted) return reject(new Error('aborted'));
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe('waitFor helper (test-internal)', () => {
  it('normal: resolves immediately when condition is already true', async () => {
    const start = Date.now();
    await waitFor(() => true, 5000, 100);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('boundary: pre-aborted signal rejects without ever calling condition', async () => {
    const ac = new AbortController();
    ac.abort();
    const condition = vi.fn(() => false);
    await expect(waitFor(condition, 5000, 100, ac.signal)).rejects.toThrow(
      'aborted'
    );
    expect(condition).not.toHaveBeenCalled();
  });

  it('exception: signal aborted mid-flight stops the polling loop', async () => {
    const ac = new AbortController();
    let callCount = 0;
    const condition = () => {
      callCount += 1;
      // Abort on the 3rd poll so we can prove the loop actually stops.
      if (callCount === 3) ac.abort();
      return false;
    };

    await expect(waitFor(condition, 5000, 10, ac.signal)).rejects.toThrow(
      'aborted'
    );

    // Capture the call count at the moment of rejection and confirm no
    // additional polls fire after a short settle delay.
    const callsAtReject = callCount;
    await new Promise((r) => setTimeout(r, 100));
    expect(callCount).toBe(callsAtReject);
  });
});

/**
 * Probe whether fs.watch({ recursive: true }) actually delivers events in the
 * current environment. macOS FSEvents can be silently blocked when the host
 * process lacks Full Disk Access (sandboxed terminals, some IDE-embedded
 * shells), and Linux requires Node ≥ 19 for recursive support. In those
 * environments the watcher tests would hang for 5 s each and false-fail the
 * whole publish pipeline, even though production code is fine. We probe once
 * and skip the event-driven cases when the platform can't deliver events.
 */
async function probeFsWatchUsable(): Promise<boolean> {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-probe-'));
  try {
    let received = false;
    let watcher: fs.FSWatcher | null = null;
    try {
      watcher = fs.watch(probeDir, { recursive: true }, () => {
        received = true;
      });
    } catch {
      return false;
    }
    // Give fs.watch a beat to register, then write and wait briefly.
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(probeDir, 'probe.ts'), 'x');
    const start = Date.now();
    while (!received && Date.now() - start < 800) {
      await new Promise((r) => setTimeout(r, 50));
    }
    watcher.close();
    return received;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

let fsWatchUsable = true;

describe('FileWatcher', () => {
  let testDir: string;

  beforeAll(async () => {
    fsWatchUsable = await probeFsWatchUsable();
    if (!fsWatchUsable) {
      // eslint-disable-next-line no-console
      console.warn(
        '[watcher.test] fs.watch did not deliver events in this environment ' +
          '(likely macOS Full Disk Access denied or sandboxed shell). ' +
          'Event-driven cases will be skipped; lifecycle cases still run.'
      );
    }
  });

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-watcher-'));
    // Create a source file so the directory isn't empty
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('start/stop lifecycle', () => {
    it('should start and stop without errors', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn);

      const started = watcher.start();
      expect(started).toBe(true);
      expect(watcher.isActive()).toBe(true);

      watcher.stop();
      expect(watcher.isActive()).toBe(false);
    });

    it('should be idempotent on double start', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn);

      expect(watcher.start()).toBe(true);
      expect(watcher.start()).toBe(true); // Should not throw
      expect(watcher.isActive()).toBe(true);

      watcher.stop();
    });

    it('should be idempotent on double stop', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn);

      watcher.start();
      watcher.stop();
      watcher.stop(); // Should not throw
      expect(watcher.isActive()).toBe(false);
    });
  });

  describe('debounced sync', () => {
    it('should trigger sync after file change', async () => {
      if (!fsWatchUsable) return;
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200 });

      watcher.start();

      // Create a new file
      fs.writeFileSync(path.join(testDir, 'src', 'new.ts'), 'export const y = 2;');

      // Wait for debounced sync to fire
      await waitFor(() => syncFn.mock.calls.length > 0, 5000);
      expect(syncFn).toHaveBeenCalled();

      watcher.stop();
    });

    it('should debounce rapid changes into a single sync', async () => {
      if (!fsWatchUsable) return;
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 500 });

      watcher.start();

      // Rapid-fire changes
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(
          path.join(testDir, 'src', `file${i}.ts`),
          `export const v${i} = ${i};`
        );
        await new Promise((r) => setTimeout(r, 50));
      }

      // Wait for the single debounced sync
      await waitFor(() => syncFn.mock.calls.length > 0, 5000);

      // Should have been called once (debounced), not 5 times
      expect(syncFn.mock.calls.length).toBe(1);

      watcher.stop();
    });
  });

  describe('filtering', () => {
    it('should ignore files not matching include patterns', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200 });

      watcher.start();

      // Let watcher settle — fs.watch may fire residual events from beforeEach
      await new Promise((r) => setTimeout(r, 400));
      syncFn.mockClear();

      // Create a file that doesn't match include patterns
      fs.writeFileSync(path.join(testDir, 'src', 'readme.md'), '# Hello');

      // Wait a bit longer than debounce — sync should NOT trigger
      await new Promise((r) => setTimeout(r, 500));
      expect(syncFn).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should ignore .codegraph directory changes', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, syncFn, { debounceMs: 200 });

      watcher.start();

      // Let watcher settle — fs.watch may fire residual events from beforeEach
      await new Promise((r) => setTimeout(r, 400));
      syncFn.mockClear();

      // Simulate a .codegraph directory change
      const cgDir = path.join(testDir, '.codegraph');
      fs.mkdirSync(cgDir, { recursive: true });
      fs.writeFileSync(path.join(cgDir, 'db.sqlite'), 'fake');

      // Wait — sync should NOT trigger
      await new Promise((r) => setTimeout(r, 500));
      expect(syncFn).not.toHaveBeenCalled();

      watcher.stop();
    });
  });

  describe('callbacks', () => {
    it('should call onSyncComplete after successful sync', async () => {
      if (!fsWatchUsable) return;
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 2, durationMs: 50 });
      const onSyncComplete = vi.fn();
      const watcher = new FileWatcher(testDir, syncFn, {
        debounceMs: 200,
        onSyncComplete,
      });

      watcher.start();

      fs.writeFileSync(path.join(testDir, 'src', 'test.ts'), 'export const z = 3;');

      await waitFor(() => onSyncComplete.mock.calls.length > 0, 5000);
      expect(onSyncComplete).toHaveBeenCalledWith({ filesChanged: 2, durationMs: 50 });

      watcher.stop();
    });

    it('should call onSyncError when sync throws', async () => {
      if (!fsWatchUsable) return;
      const syncFn = vi.fn().mockRejectedValue(new Error('sync failed'));
      const onSyncError = vi.fn();
      const watcher = new FileWatcher(testDir, syncFn, {
        debounceMs: 200,
        onSyncError,
      });

      watcher.start();

      fs.writeFileSync(path.join(testDir, 'src', 'test.ts'), 'export const z = 3;');

      await waitFor(() => onSyncError.mock.calls.length > 0, 5000);
      expect(onSyncError).toHaveBeenCalled();
      expect(onSyncError.mock.calls[0]![0]).toBeInstanceOf(Error);

      watcher.stop();
    });
  });

  describe('CodeGraph integration', () => {
    let cg: CodeGraph;
    let abortController: AbortController;

    beforeEach(() => {
      abortController = new AbortController();
    });

    afterEach(() => {
      // Abort any in-flight waitFor BEFORE closing the DB. Otherwise a
      // recursive setTimeout(check, intervalMs) that was already scheduled
      // can fire after cg.close() and crash with `database is not open`.
      abortController.abort();
      if (cg) cg.close();
    });

    it('should watch and unwatch via CodeGraph API', async () => {
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      expect(cg.isWatching()).toBe(false);

      const started = cg.watch({ debounceMs: 200 });
      expect(started).toBe(true);
      expect(cg.isWatching()).toBe(true);

      cg.unwatch();
      expect(cg.isWatching()).toBe(false);
    });

    it('should stop watching on close', async () => {
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      cg.watch({ debounceMs: 200 });
      expect(cg.isWatching()).toBe(true);

      cg.close();
      // After close, isWatching should be false
      // (we can't call isWatching after close since DB is closed,
      //  but we verify no errors are thrown)
    });

    it('should auto-sync when files change while watching', async () => {
      if (!fsWatchUsable) return;
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const initialStats = cg.getStats();
      const initialNodes = initialStats.nodeCount;

      cg.watch({ debounceMs: 300 });

      // Add a new file with a function
      fs.writeFileSync(
        path.join(testDir, 'src', 'added.ts'),
        'export function added() { return 42; }'
      );

      // Wait for auto-sync to pick it up. Pass the AbortSignal so that if
      // the test times out at the vitest level, the recursive check loop
      // stops immediately and does not touch a closed DB in afterEach.
      await waitFor(
        () => {
          const stats = cg.getStats();
          return stats.nodeCount > initialNodes;
        },
        10000,
        100,
        abortController.signal
      );

      // The new function should be in the graph
      const results = cg.searchNodes('added');
      expect(results.length).toBeGreaterThan(0);

      cg.unwatch();
    });
  });
});
