/**
 * 0005 / T5 — Signal forwarding & exit code propagation (real spawn).
 *
 * Validates that when the user hits Ctrl+C in the parent's TTY, the
 * SIGINT reaches the child node process AND the parent's exit code
 * reflects the signal (128 + signal number = 130 for SIGINT).
 *
 * We don't have a real interactive TTY in the test harness, so we
 * spawn the parent CLI ourselves and send SIGINT via process.kill.
 * The parent (which is itself the re-exec parent here) should:
 *   1. Forward SIGINT to its child
 *   2. Wait for child's exit
 *   3. Translate the signal exit to code 130 (128 + 2 for SIGINT)
 *
 * This is the only test that exercises the actual signal path. Unit
 * tests for `forwardSignal()` only verify the kill call is made;
 * they can't prove the wiring in `reExecWithLiftoffOnly()` actually
 * routes signals through.
 *
 * 4 cases: 2 normal (real index spawn + bogus path) / 1 boundary /
 * 1 exception.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const CODEGRAPH_BIN = path.join(__dirname, '..', 'dist', 'bin', 'codegraph.js');
const PROJECT_ROOT = path.join(__dirname, '..');
const skipIfNotBuilt = !fs.existsSync(CODEGRAPH_BIN);

/**
 * Spawn the codegraph CLI and inject SIGINT after `delayMs`.
 * Returns the child's close-event payload.
 */
function spawnAndSignal(
  args: string[],
  delayMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CODEGRAPH_BIN, ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    // Drain stderr so the pipe buffer doesn't fill and stall the child.
    child.stderr?.on('data', () => undefined);

    setTimeout(() => {
      try {
        child.kill('SIGINT');
      } catch {
        // Already exited — that's fine, the close handler still fires.
      }
    }, delayMs);

    child.on('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

describe.skipIf(skipIfNotBuilt)('0005/T5 — Signal forwarding & exit-code propagation', () => {
  it('normal: SIGINT during real indexing → parent exits with code 130 (POSIX 128+SIGINT)', async () => {
    // Index this project itself — guaranteed to take long enough that
    // SIGINT lands during active parsing rather than after exit.
    // 800ms gives the child time to actually start the parse loop.
    const result = await spawnAndSignal(['index', PROJECT_ROOT], 800);
    // Strict assertion — wiring must produce 130 reliably. Earlier
    // we had this looser ({130, 2, 1, signal}) but real-machine probe
    // confirmed 130 is the deterministic outcome.
    expect(result.code).toBe(130);
    expect(result.signal).toBeNull();
  });

  it('normal: SIGINT after pre-init failure → parent still terminates within timeout', async () => {
    // Bogus path → child exits ~immediately with code 1 (path not
    // initialized). SIGINT arrives after child is dead, so the
    // parent has nothing to forward to. The parent should still
    // close, exiting with the child's pre-signal code (1). This
    // verifies we don't HANG when SIGINT arrives post-mortem.
    const result = await spawnAndSignal(
      ['index', '/nonexistent/0005-signal-fast-fail'],
      400
    );
    // Either:
    //   (a) code=1 — child died before we sent SIGINT
    //   (b) code=130 — race won by SIGINT (rare on this fast-failing
    //       path but possible on slow CI)
    expect([1, 130]).toContain(result.code);
  });

  it('boundary: rapid SIGINT 50ms after spawn → parent still terminates without hanging', async () => {
    // 50ms — re-exec parent may or may not have spawned the child
    // yet. As long as the parent closes cleanly we're fine.
    const result = await spawnAndSignal(
      ['index', PROJECT_ROOT],
      50
    );
    // Liberal acceptance — race could go either way:
    //   • 130: parent caught + translated
    //   • signal=SIGINT: parent's handler not yet installed
    //   • 1: child died before re-exec engaged (unlikely on 50ms)
    const ok =
      result.code === 130 ||
      result.code === 1 ||
      result.signal === 'SIGINT' ||
      result.signal === 'SIGTERM';
    expect(ok).toBe(true);
  });

  it('exception: SIGTERM (not SIGINT) is also forwarded and translated to 128+15=143', async () => {
    // Inject SIGTERM by replacing the kill call. Re-implementing
    // spawnAndSignal here since the helper sends SIGINT only.
    const result: { code: number | null; signal: NodeJS.Signals | null } =
      await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [CODEGRAPH_BIN, 'index', PROJECT_ROOT],
          {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, NODE_OPTIONS: '' },
          }
        );
        child.stderr?.on('data', () => undefined);
        setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        }, 800);
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
    expect(result.code).toBe(143);
  });
});

