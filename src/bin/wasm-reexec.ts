/**
 * WASM Re-exec Helper
 *
 * Mitigates a V8 turboshaft WASM compile-zone OOM that crashes
 * `codegraph index` / `codegraph sync` mid-parse on Node 24.x with
 * tree-sitter grammars. The crash signature is:
 *
 *   Fatal process out of memory: Zone
 *     ... Zone::Expand
 *     ... turboshaft::WasmLoweringReducer ... MachineOptimizationReducer
 *     ... wasm::WasmCompilationUnit::ExecuteCompilation
 *     ... wasm::BackgroundCompileJob::Run
 *
 * Root cause: V8's turboshaft tier-up compiler for WebAssembly allocates
 * an unbounded compile-zone when lowering tree-sitter's large WASM
 * grammars (370 files = enough call-count to trigger tier-up). The
 * baseline Liftoff compiler does not use turboshaft — passing
 * `--liftoff-only` to the V8 isolate forces baseline-only WASM
 * compilation, completely sidestepping the turboshaft pipeline.
 *
 * Why a re-exec is required: V8 boot-time flags (`--liftoff-only`,
 * `--max-old-space-size`) MUST be set before the V8 isolate is created.
 * They cannot be enabled at runtime via `v8.setFlagsFromString` (the
 * 0004 attempt that did NOT work — confirmed in the rationale doc).
 * Worse, `--liftoff-only` is NOT in Node's NODE_OPTIONS allowlist —
 * trying `NODE_OPTIONS=--liftoff-only` exits with `not allowed in
 * NODE_OPTIONS`. The only path is to spawn a fresh `node` child with
 * the flag on argv[1] and forward stdio + signals + exit code.
 *
 * Design choices (see docs/wasm-compile-oom-rationale.md §3 Q1-Q5):
 *
 * - Q1 → `--liftoff-only` (safest, narrowest scope) + NODE_OPTIONS
 *   `--max-old-space-size=4096` (defence in depth — Zone OOM doesn't
 *   actually live in old space, but headroom can't hurt).
 * - Q2 → re-exec ONLY for `index` / `sync` subcommands (other commands
 *   never load WASM grammars). Provide `CODEGRAPH_NO_REEXEC=1` escape
 *   hatch for debugging.
 * - Q4 → friendly stderr line on Node 24+ when re-exec actually fires,
 *   so users know the work-around is engaged.
 *
 * Sentinel env var `CODEGRAPH_WASM_REEXEC=1` marks the child process
 * so it skips the re-exec branch (avoiding infinite loops).
 */

import { spawn, type ChildProcess } from 'child_process';

/**
 * Subcommands that load tree-sitter WASM grammars. Only these need the
 * Liftoff-only re-exec; lightweight commands like `query`, `status`,
 * `--version` are unaffected and run in the original process.
 */
export const WASM_REQUIRING_SUBCOMMANDS: readonly string[] = [
  'index',
  'sync',
  'init',     // init runs an initial index pass
  'install',  // install also indexes
] as const;

/**
 * Sentinel env var set on the child process so it skips re-exec
 * (preventing infinite spawn loops if the parent's heuristic
 * misfires).
 */
export const REEXEC_SENTINEL_ENV = 'CODEGRAPH_WASM_REEXEC';

/**
 * User-facing escape hatch. If set, the parent skips re-exec entirely
 * and runs the original Node process. Used for debugging, profiling
 * with custom V8 flags, or testing on Node versions where the bug is
 * already fixed upstream.
 */
export const REEXEC_DISABLE_ENV = 'CODEGRAPH_NO_REEXEC';

/**
 * Decide whether to re-exec the current process with V8 flags applied.
 *
 * Returns `true` only when ALL of the following hold:
 *   1. The first non-flag CLI argument is in WASM_REQUIRING_SUBCOMMANDS.
 *   2. We are NOT already inside a re-exec child (sentinel env unset).
 *   3. The user has not opted out via CODEGRAPH_NO_REEXEC.
 *   4. Node major version is in the affected range (>= 22, < 25 — Node
 *      25+ is hard-blocked elsewhere; Node < 22 doesn't have the
 *      turboshaft WASM pipeline default-enabled).
 *
 * Pure function — no side effects, no I/O, no spawn. All inputs are
 * explicit so tests can drive every branch.
 */
export function shouldReExec(opts: {
  argv: readonly string[];     // Full process.argv (e.g. ['node', 'codegraph.js', 'index', '/path'])
  env: NodeJS.ProcessEnv;
  nodeMajor: number;
}): boolean {
  const { argv, env, nodeMajor } = opts;

  // Branch 1: already inside a re-exec child → never recurse
  if (env[REEXEC_SENTINEL_ENV] === '1') return false;

  // Branch 2: user opt-out
  if (env[REEXEC_DISABLE_ENV] === '1') return false;

  // Branch 3: only Node major versions that have the turboshaft WASM
  // pipeline default-enabled. Node 25+ is blocked elsewhere; Node < 22
  // pre-dates default turboshaft WASM. The bug *can* surface on older
  // Node 22.x point releases too, but the cost of re-exec there is
  // negligible — apply uniformly across 22-24 for simplicity.
  if (nodeMajor < 22 || nodeMajor >= 25) return false;

  // Branch 4: scan argv for the first non-flag token after the script
  // path. argv[0] = node, argv[1] = script path, argv[2+] = args.
  // We accept commander-style flags before the subcommand
  // (e.g. `codegraph --verbose index`).
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok || tok.startsWith('-')) continue;
    return WASM_REQUIRING_SUBCOMMANDS.includes(tok);
  }

  // No subcommand at all (e.g. `codegraph` alone) → installer flow,
  // doesn't need WASM re-exec.
  return false;
}

/**
 * Build the argv that will be passed to the child Node process.
 * Layout:
 *   [v8Flag1, v8Flag2, ..., scriptPath, ...originalUserArgs]
 *
 * The V8 flags MUST come BEFORE the script path — Node parses argv
 * left-to-right and treats anything after the script as user args.
 *
 * Pure function for testability.
 */
export function buildChildArgv(opts: {
  scriptPath: string;       // e.g. dist/bin/codegraph.js (process.argv[1])
  userArgs: readonly string[]; // process.argv.slice(2)
}): string[] {
  return [
    // Force baseline Liftoff compiler for WASM — bypasses the turboshaft
    // tier-up pipeline that hits Zone::Expand OOM on tree-sitter grammars.
    '--liftoff-only',
    opts.scriptPath,
    ...opts.userArgs,
  ];
}

/**
 * Build the env to pass to the child. Adds:
 *   - REEXEC_SENTINEL_ENV=1 (so child skips re-exec)
 *   - NODE_OPTIONS appended with --max-old-space-size=4096 (defence
 *     in depth; preserves any user-set NODE_OPTIONS)
 *
 * Pure function for testability.
 */
export function buildChildEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const HEAP_FLAG = '--max-old-space-size=4096';
  const existing = parentEnv.NODE_OPTIONS ?? '';

  // If user already set --max-old-space-size, respect it. Otherwise
  // append our default. Use word-boundary check so we don't match e.g.
  // `--max-old-space-size-stats` if such a flag ever exists.
  const alreadySet = /(^|\s)--max-old-space-size=/.test(existing);
  const nextNodeOptions = alreadySet
    ? existing
    : (existing ? `${existing} ${HEAP_FLAG}` : HEAP_FLAG);

  return {
    ...parentEnv,
    [REEXEC_SENTINEL_ENV]: '1',
    NODE_OPTIONS: nextNodeOptions,
  };
}

/**
 * Forward a POSIX signal from parent to child. Returns true if the
 * signal was forwarded (child still alive), false otherwise.
 *
 * Why care: when the user hits Ctrl+C in the parent's TTY, the SIGINT
 * goes to the parent only (we created a new process group implicitly).
 * Without forwarding, the child keeps running invisibly until it
 * finishes its current parse batch — confusing UX.
 *
 * Pure function (no side effects on globals); takes the child as an
 * explicit argument for testability.
 */
export function forwardSignal(
  child: Pick<ChildProcess, 'kill' | 'killed' | 'pid'>,
  signal: NodeJS.Signals
): boolean {
  if (child.killed) return false;
  if (child.pid === undefined) return false;
  try {
    return child.kill(signal);
  } catch {
    // If kill throws (e.g. ESRCH — process already gone) it's
    // effectively the same as "already dead"; just report not-forwarded.
    return false;
  }
}

/**
 * Spawn a child Node process with the WASM workaround flags applied,
 * then exit the parent with the child's exit code (or signal-translated
 * code 128+N). Forwards SIGINT / SIGTERM / SIGHUP to the child so the
 * user's Ctrl+C reaches the actual worker.
 *
 * IMPORTANT: this function calls `process.exit()` and never returns
 * normally — it's a fork in the program control flow. Tests cover the
 * pure helpers above and a child-spawning integration test (T4).
 */
export function reExecWithLiftoffOnly(opts?: {
  // Optional injection point for tests / dry-run.
  spawnFn?: typeof spawn;
  exitFn?: (code: number) => never;
  notifyFn?: (msg: string) => void;
}): never {
  const spawnImpl = opts?.spawnFn ?? spawn;
  const exitImpl = opts?.exitFn ?? ((code: number) => process.exit(code));
  const notify = opts?.notifyFn ?? ((msg: string) => process.stderr.write(msg + '\n'));

  const scriptPath: string | undefined = process.argv[1];
  if (!scriptPath) {
    // Should never happen in a real CLI invocation — argv[1] is the
    // script path the user ran. If it IS missing (e.g. `node -e ...`
    // weird invocation), bail out and let the parent run normally
    // rather than spawning an unparented child.
    notify(
      '[CodeGraph] Skipping WASM re-exec: process.argv[1] is empty (cannot locate script).'
    );
    exitImpl(1);
    // Defensive: exitImpl is typed as `never` so this throw is
    // unreachable in production. We add it so TypeScript control-flow
    // narrowing works even when callers pass a custom exitFn that the
    // compiler can't prove is `never` from the call-site.
    throw new Error('unreachable');
  }
  const userArgs = process.argv.slice(2);

  notify(
    '[CodeGraph] Engaging WASM Liftoff-only mode to avoid V8 turboshaft Zone OOM ' +
      `(Node ${process.versions.node}). Set CODEGRAPH_NO_REEXEC=1 to disable.`
  );

  const child = spawnImpl(
    process.execPath,
    buildChildArgv({ scriptPath, userArgs }),
    {
      stdio: 'inherit',
      env: buildChildEnv(process.env) as NodeJS.ProcessEnv,
    }
  );

  // Forward common termination signals so Ctrl+C in parent's TTY
  // reaches the real worker.
  //
  // Tricky: installing a SIGINT handler suppresses Node's default
  // "exit with 130" behaviour for the parent. Without compensation,
  // the parent would only forward to child and then exit with the
  // child's business code (typically 1 if path validation failed).
  // Users hitting Ctrl+C would see exit code 1 instead of the
  // POSIX-conventional 128 + signal_number. Track which signal we
  // forwarded so the child-exit handler can translate correctly.
  const SIGNALS_TO_FORWARD: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let forwardedSignal: NodeJS.Signals | null = null;
  for (const sig of SIGNALS_TO_FORWARD) {
    process.on(sig, () => {
      forwardedSignal = sig;
      forwardSignal(child, sig);
    });
  }

  child.on('exit', (code, signal) => {
    // Priority order:
    //   1. Explicit signal field (kernel killed child) — translate
    //   2. We forwarded a signal earlier — translate that signal
    //   3. Fall back to child's exit code
    const SIGNAL_OFFSET = 128;
    const SIGNAL_NUMS: Partial<Record<NodeJS.Signals, number>> = {
      SIGINT: 2,
      SIGTERM: 15,
      SIGHUP: 1,
    };

    if (signal !== null) {
      const n = SIGNAL_NUMS[signal] ?? 1;
      exitImpl(SIGNAL_OFFSET + n);
      return;
    }

    if (forwardedSignal !== null) {
      const n = SIGNAL_NUMS[forwardedSignal] ?? 1;
      exitImpl(SIGNAL_OFFSET + n);
      return;
    }

    exitImpl(code ?? 0);
  });

  // Returning here would let the parent continue running the original
  // index/sync flow in addition to the child — must NOT happen. We
  // pause indefinitely; only the child's `exit` handler above ever
  // calls process.exit. (Using `return undefined as never` would lie
  // to the type system without preventing parent execution.)
  return new Promise<never>(() => {
    /* never resolves */
  }) as never;
}
