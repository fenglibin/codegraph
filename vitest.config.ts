import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * --- Why `pool: 'forks'` + `isolate: true` + per-fork `--liftoff-only`? ---
 *
 * The test suite loads ~10 large tree-sitter WASM grammars (python, java,
 * go, c, cpp, php, ruby, rust, pascal, drupal …) across many test files.
 * On Node 24.x the V8 engine eagerly tier-ups WASM through the Turboshaft
 * pipeline (`WasmLoweringPhase` → `MachineOptimizationReducer`), and the
 * Zone allocator used for that pipeline can run out of memory ("Fatal
 * process out of memory: Zone") when many big grammars are compiled in
 * the same V8 isolate, killing the test worker with no JS-level error —
 * vitest then surfaces it as `Worker exited unexpectedly` from tinypool.
 *
 * Two-pronged mitigation:
 *
 *  1. `pool: 'forks'` + `isolate: true`
 *     Each test file runs in its own forked Node process with a fresh V8
 *     isolate, so WASM Zones do not accumulate across the suite. Slightly
 *     slower than threads but eliminates the cross-file pressure.
 *
 *  2. `poolOptions.forks.execArgv: ['--liftoff-only']`
 *     V8 flag that keeps WASM compilation on the baseline Liftoff tier
 *     and skips Turboshaft optimization — that tier is what blew up. The
 *     parsers stay correct (Liftoff is a complete WASM compiler), they
 *     just don't get the optional optimization pass that triggered the
 *     OOM. `--no-turboshaft-wasm` was tried first but Node 24 rejects
 *     it ("bad option"); `--liftoff-only` is the supported equivalent.
 *
 *     Injecting via `execArgv` (instead of a `NODE_OPTIONS` env var on
 *     the npm script) keeps the workaround declarative, cross-platform
 *     (Windows cmd.exe doesn't support inline `FOO=bar` on npm scripts),
 *     and confined to the test worker — the parent vitest process and
 *     unrelated tooling are unaffected.
 *
 * If a future Node release fixes the underlying V8 issue, both knobs can
 * be removed.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    // Several watcher / sync tests rely on real fs.watch events whose end-to-end
    // latency on macOS FSEvents can be several hundred ms. The waitFor helpers
    // inside those tests already cap at 5000–10000ms; make the vitest-level
    // timeout strictly larger so we never see the confusing
    // "Test timed out in 5000ms" error before the test's own waitFor times out
    // and produces a more actionable message.
    testTimeout: 15000,
    pool: 'forks',
    poolOptions: {
      forks: {
        // Each test file → its own fork → its own V8 isolate.
        // Prevents WASM Zone accumulation across files.
        isolate: true,
        // Disable Turboshaft WASM optimization in the worker; see header.
        execArgv: ['--liftoff-only'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
