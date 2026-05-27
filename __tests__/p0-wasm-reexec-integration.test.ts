/**
 * 0005 / T4 — Integration test for the WASM re-exec wiring.
 *
 * Unit-tests in p0-wasm-reexec.test.ts cover the pure helpers in
 * isolation, but they can't catch wiring regressions in
 * src/bin/codegraph.ts (e.g. someone deletes the `if (shouldReExec)`
 * block, or accidentally swaps `nodeMajor` for `nodeMinor`).
 *
 * This file spawns the actual compiled `dist/bin/codegraph.js` and
 * inspects observable side-effects (notice on stderr, exit code) to
 * verify the re-exec branch is wired correctly. We don't actually
 * load WASM grammars or index files — we use `--version` as a fast
 * subcommand that returns immediately.
 *
 * Why use --version: We need to verify that re-exec triggers for
 * WASM-requiring subcommands (`index`/`sync`) and skips for others.
 * `--version` is the fastest "non-WASM" path (commander prints version
 * and exits), so it's safe to spawn many times in tests. For the
 * "should re-exec" assertion we use `index` with a non-existent path
 * — re-exec fires before path validation, so the notice appears on
 * stderr even though the eventual indexing fails.
 *
 * Cases (4 normal + 2 boundary):
 *   - --version (no subcommand) → re-exec NOT triggered
 *   - query (non-WASM subcommand) → re-exec NOT triggered
 *   - index <bogus path> → re-exec triggered, notice appears
 *   - sync <bogus path> → re-exec triggered, notice appears
 *   - CODEGRAPH_NO_REEXEC=1 + index → opt-out respected
 *   - CODEGRAPH_WASM_REEXEC=1 + index → sentinel prevents recursion
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const CODEGRAPH_BIN = path.join(__dirname, '..', 'dist', 'bin', 'codegraph.js');
const REEXEC_NOTICE_PATTERN = /Engaging WASM Liftoff-only mode/;

const skipIfNotBuilt = !fs.existsSync(CODEGRAPH_BIN);

describe.skipIf(skipIfNotBuilt)('0005/T4 — WASM re-exec wiring (integration)', () => {
  // Each case spawns a fresh node child running the compiled CLI.
  // We pin a 10s timeout per case so a hang in re-exec doesn't drag
  // the suite. NODE_OPTIONS is cleared so we don't inherit anything
  // from the test harness that would interfere with the assertion.
  const baseEnv = {
    ...process.env,
    NODE_OPTIONS: '',
  };

  function runCodegraph(
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {}
  ): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, [CODEGRAPH_BIN, ...args], {
      env: { ...baseEnv, ...extraEnv },
      timeout: 10_000,
      encoding: 'utf-8',
    });
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      status: result.status,
    };
  }

  // --- normal cases (re-exec should fire) ---

  it('normal: `codegraph index <bogus>` triggers re-exec notice on stderr', () => {
    const out = runCodegraph(['index', '/nonexistent/path/for/test/0005']);
    // The notice fires from the re-exec parent process *before* the
    // child runs, so it should reach stderr regardless of whether
    // the eventual index succeeds. We don't care about exit code
    // here — the path doesn't exist so the child will fail, but
    // re-exec must have already happened.
    expect(out.stderr).toMatch(REEXEC_NOTICE_PATTERN);
  });

  it('normal: `codegraph sync <bogus>` triggers re-exec notice on stderr', () => {
    const out = runCodegraph(['sync', '/nonexistent/path/for/test/0005']);
    expect(out.stderr).toMatch(REEXEC_NOTICE_PATTERN);
  });

  // --- normal cases (re-exec should NOT fire) ---

  it('normal: `codegraph --version` does NOT trigger re-exec', () => {
    const out = runCodegraph(['--version']);
    // --version exits successfully without WASM
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^\d+\.\d+\.\d+/); // semver line
    expect(out.stderr).not.toMatch(REEXEC_NOTICE_PATTERN);
  });

  it('normal: `codegraph query foo` does NOT trigger re-exec', () => {
    const out = runCodegraph(['query', 'foo']);
    // query may fail (no .codegraph dir in /tmp etc.) but the
    // notice must not appear regardless of outcome
    expect(out.stderr).not.toMatch(REEXEC_NOTICE_PATTERN);
  });

  // --- boundary cases ---

  it('boundary: `CODEGRAPH_NO_REEXEC=1 codegraph index` skips re-exec (user opt-out)', () => {
    const out = runCodegraph(['index', '/nonexistent/0005-noreexec'], {
      CODEGRAPH_NO_REEXEC: '1',
    });
    expect(out.stderr).not.toMatch(REEXEC_NOTICE_PATTERN);
  });

  it('boundary: `CODEGRAPH_WASM_REEXEC=1 codegraph index` skips re-exec (sentinel set, simulates inside-child)', () => {
    const out = runCodegraph(['index', '/nonexistent/0005-sentinel'], {
      CODEGRAPH_WASM_REEXEC: '1',
    });
    // The notice must NOT fire — this proves the recursion guard
    // works. Without the guard, the child would re-spawn another
    // child, which would re-spawn another, etc.
    expect(out.stderr).not.toMatch(REEXEC_NOTICE_PATTERN);
  });
});
