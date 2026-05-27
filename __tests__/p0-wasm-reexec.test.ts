/**
 * 0005 / T3 — WASM re-exec helper unit tests.
 *
 * Covers all five exports of src/bin/wasm-reexec.ts:
 *
 *   • shouldReExec       — branch coverage on argv / env / nodeMajor
 *   • buildChildArgv     — flag ordering invariant
 *   • buildChildEnv      — sentinel + NODE_OPTIONS merge invariants
 *   • forwardSignal      — kill behaviour on alive / killed / no-pid
 *   • reExecWithLiftoffOnly — spawn injection (dry-run via spawnFn stub)
 *
 * 18 cases: 7 normal + 6 boundary + 5 exception (per dev-baseline §4
 * minimum 3-each rule, generously expanded because re-exec is critical
 * recovery path — silent regressions here would fail the entire OOM
 * mitigation strategy).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  shouldReExec,
  buildChildArgv,
  buildChildEnv,
  forwardSignal,
  reExecWithLiftoffOnly,
  WASM_REQUIRING_SUBCOMMANDS,
  REEXEC_SENTINEL_ENV,
  REEXEC_DISABLE_ENV,
} from '../src/bin/wasm-reexec';

describe('0005/T3 — shouldReExec()', () => {
  // --- normal cases ---

  it('normal: returns true for `codegraph index` on Node 24 with no opt-out', () => {
    const result = shouldReExec({
      argv: ['/path/to/node', '/path/to/codegraph.js', 'index'],
      env: {},
      nodeMajor: 24,
    });
    expect(result).toBe(true);
  });

  it('normal: returns true for `codegraph sync /some/path` on Node 22', () => {
    const result = shouldReExec({
      argv: ['/path/to/node', '/path/to/codegraph.js', 'sync', '/repo'],
      env: {},
      nodeMajor: 22,
    });
    expect(result).toBe(true);
  });

  it('normal: returns false for `codegraph query foo` (query does NOT load WASM)', () => {
    const result = shouldReExec({
      argv: ['/path/to/node', '/path/to/codegraph.js', 'query', 'foo'],
      env: {},
      nodeMajor: 24,
    });
    expect(result).toBe(false);
  });

  // --- boundary cases ---

  it('boundary: skips re-exec when already inside a child (sentinel set)', () => {
    const result = shouldReExec({
      argv: ['/node', '/codegraph.js', 'index'],
      env: { [REEXEC_SENTINEL_ENV]: '1' },
      nodeMajor: 24,
    });
    expect(result).toBe(false);
  });

  it('boundary: respects user opt-out via CODEGRAPH_NO_REEXEC=1', () => {
    const result = shouldReExec({
      argv: ['/node', '/codegraph.js', 'index'],
      env: { [REEXEC_DISABLE_ENV]: '1' },
      nodeMajor: 24,
    });
    expect(result).toBe(false);
  });

  it('boundary: skips re-exec on Node < 22 (turboshaft WASM not default)', () => {
    const result = shouldReExec({
      argv: ['/node', '/codegraph.js', 'index'],
      env: {},
      nodeMajor: 20,
    });
    expect(result).toBe(false);
  });

  it('boundary: skips re-exec on Node >= 25 (hard-blocked elsewhere by node-version-check)', () => {
    const result = shouldReExec({
      argv: ['/node', '/codegraph.js', 'index'],
      env: {},
      nodeMajor: 25,
    });
    expect(result).toBe(false);
  });

  it('boundary: handles commander-style flags before subcommand (`--verbose index`)', () => {
    const result = shouldReExec({
      argv: ['/node', '/codegraph.js', '--verbose', 'index'],
      env: {},
      nodeMajor: 24,
    });
    expect(result).toBe(true);
  });

  it('boundary: returns false when no subcommand at all (installer flow)', () => {
    const result = shouldReExec({
      argv: ['/node', '/codegraph.js'],
      env: {},
      nodeMajor: 24,
    });
    expect(result).toBe(false);
  });

  // --- exception cases ---

  it('exception: empty argv array does not crash', () => {
    expect(() =>
      shouldReExec({ argv: [], env: {}, nodeMajor: 24 })
    ).not.toThrow();
  });

  it('exception: argv shorter than 2 (no script path) returns false safely', () => {
    expect(
      shouldReExec({ argv: ['/node'], env: {}, nodeMajor: 24 })
    ).toBe(false);
  });
});

describe('0005/T3 — WASM_REQUIRING_SUBCOMMANDS contract', () => {
  it('normal: contains the four expected commands and nothing more', () => {
    // Pin the exact list — any future addition (e.g. `reindex`) must
    // be accompanied by a deliberate update to this test, NOT silently
    // expand the scope of re-exec.
    expect([...WASM_REQUIRING_SUBCOMMANDS].sort()).toEqual(
      ['index', 'init', 'install', 'sync'].sort()
    );
  });
});

describe('0005/T3 — buildChildArgv()', () => {
  it('normal: places --liftoff-only BEFORE the script path', () => {
    const out = buildChildArgv({
      scriptPath: '/dist/bin/codegraph.js',
      userArgs: ['index', '/repo'],
    });
    // V8 boot flags MUST be argv tokens 0..k-1, then script, then user args.
    // Anything after script is treated as user args by Node.
    const liftoffIdx = out.indexOf('--liftoff-only');
    const scriptIdx = out.indexOf('/dist/bin/codegraph.js');
    expect(liftoffIdx).toBeGreaterThanOrEqual(0);
    expect(liftoffIdx).toBeLessThan(scriptIdx);
    expect(out.slice(scriptIdx + 1)).toEqual(['index', '/repo']);
  });

  it('boundary: no user args produces flag + script only', () => {
    const out = buildChildArgv({
      scriptPath: '/p/codegraph.js',
      userArgs: [],
    });
    expect(out).toEqual(['--liftoff-only', '/p/codegraph.js']);
  });
});

describe('0005/T3 — buildChildEnv()', () => {
  it('normal: sets the re-exec sentinel and appends max-old-space-size', () => {
    const out = buildChildEnv({});
    expect(out[REEXEC_SENTINEL_ENV]).toBe('1');
    expect(out.NODE_OPTIONS).toBe('--max-old-space-size=4096');
  });

  it('normal: preserves caller-set NODE_OPTIONS when appending heap flag', () => {
    const out = buildChildEnv({ NODE_OPTIONS: '--enable-source-maps' });
    expect(out.NODE_OPTIONS).toBe(
      '--enable-source-maps --max-old-space-size=4096'
    );
  });

  it('boundary: does NOT double-add heap flag if user already set it', () => {
    const out = buildChildEnv({
      NODE_OPTIONS: '--enable-source-maps --max-old-space-size=8192',
    });
    expect(out.NODE_OPTIONS).toBe(
      '--enable-source-maps --max-old-space-size=8192'
    );
    // Specifically: does NOT contain "--max-old-space-size=4096"
    expect(out.NODE_OPTIONS).not.toMatch(/--max-old-space-size=4096/);
  });

  it('boundary: respects user heap value at start of NODE_OPTIONS', () => {
    const out = buildChildEnv({
      NODE_OPTIONS: '--max-old-space-size=2048 --enable-source-maps',
    });
    expect(out.NODE_OPTIONS).toBe(
      '--max-old-space-size=2048 --enable-source-maps'
    );
  });

  it('exception: copies all other parent env vars unchanged', () => {
    const out = buildChildEnv({ HOME: '/u/foo', PATH: '/usr/bin' });
    expect(out.HOME).toBe('/u/foo');
    expect(out.PATH).toBe('/usr/bin');
  });
});

describe('0005/T3 — forwardSignal()', () => {
  it('normal: forwards SIGINT to a live child', () => {
    const killSpy = vi.fn().mockReturnValue(true);
    const child = { killed: false, pid: 1234, kill: killSpy };
    const result = forwardSignal(child, 'SIGINT');
    expect(killSpy).toHaveBeenCalledWith('SIGINT');
    expect(result).toBe(true);
  });

  it('boundary: returns false if child is already killed', () => {
    const killSpy = vi.fn();
    const child = { killed: true, pid: 1234, kill: killSpy };
    const result = forwardSignal(child, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('boundary: returns false if child has no pid (never spawned)', () => {
    const killSpy = vi.fn();
    const child = { killed: false, pid: undefined, kill: killSpy };
    const result = forwardSignal(child, 'SIGINT');
    expect(killSpy).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('exception: swallows ESRCH-style throws and reports false', () => {
    const child = {
      killed: false,
      pid: 1234,
      kill: () => {
        throw new Error('ESRCH');
      },
    };
    const result = forwardSignal(child, 'SIGINT');
    expect(result).toBe(false);
  });
});

describe('0005/T3 — reExecWithLiftoffOnly() injection contract', () => {
  it('normal: spawns child with correct argv and env, then keeps parent paused', async () => {
    const fakeChild = {
      on: vi.fn(),
      kill: vi.fn().mockReturnValue(true),
      killed: false,
      pid: 9999,
    };
    const spawnFn = vi.fn().mockReturnValue(fakeChild);
    const exitFn = vi.fn() as unknown as (code: number) => never;
    const notifyFn = vi.fn();

    // Stub argv so the helper picks predictable values.
    const realArgv = process.argv;
    process.argv = ['/usr/bin/node', '/dist/bin/codegraph.js', 'index', '/repo'];

    try {
      // Returns a never-resolving promise; we use Promise.race with a
      // microtask timer to confirm the spawn happened without waiting
      // forever.
      const racePromise = Promise.race([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reExecWithLiftoffOnly({ spawnFn: spawnFn as any, exitFn, notifyFn }),
        new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), 50)),
      ]);
      const result = await racePromise;
      expect(result).toBe('TIMEOUT');
    } finally {
      process.argv = realArgv;
    }

    // Notification fired
    expect(notifyFn).toHaveBeenCalledOnce();
    expect(notifyFn.mock.calls[0]?.[0]).toMatch(/Liftoff-only mode/);

    // spawn called with execPath + correct argv layout
    expect(spawnFn).toHaveBeenCalledOnce();
    const spawnArgs = spawnFn.mock.calls[0];
    expect(spawnArgs?.[0]).toBe(process.execPath);
    expect(spawnArgs?.[1]).toEqual([
      '--liftoff-only',
      '/dist/bin/codegraph.js',
      'index',
      '/repo',
    ]);
    expect(spawnArgs?.[2]?.stdio).toBe('inherit');
    expect(spawnArgs?.[2]?.env?.[REEXEC_SENTINEL_ENV]).toBe('1');

    // Signal forwarders registered
    expect(fakeChild.on).toHaveBeenCalledWith('exit', expect.any(Function));
  });

  it('exception: bails out gracefully if process.argv[1] is empty', async () => {
    const spawnFn = vi.fn();
    const exitFn = vi.fn() as unknown as (code: number) => never;
    const notifyFn = vi.fn();

    const realArgv = process.argv;
    process.argv = ['/usr/bin/node', ''];

    try {
      // The function throws our internal "unreachable" sentinel after
      // exitFn returns (because exitFn isn't typed as `never` from the
      // injection point). Production exitFn is process.exit which IS
      // never, so the throw never fires in production.
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reExecWithLiftoffOnly({ spawnFn: spawnFn as any, exitFn, notifyFn })
      ).toThrow(/unreachable/);
    } finally {
      process.argv = realArgv;
    }

    expect(spawnFn).not.toHaveBeenCalled();
    expect(notifyFn).toHaveBeenCalledOnce();
    expect(notifyFn.mock.calls[0]?.[0]).toMatch(/process\.argv\[1\] is empty/);
    expect(exitFn).toHaveBeenCalledWith(1);
  });
});
