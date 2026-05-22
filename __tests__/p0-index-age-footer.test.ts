/**
 * P0 / T3 — Index-age footer helpers and end-to-end injection.
 *
 * Covers two layers:
 *   1. Unit tests for `_internal_formatIndexAgeFooter` — pure function,
 *      time-injected so we don't depend on the wall clock.
 *   2. Integration test driving real `ToolHandler.execute` against a
 *      real `CodeGraph` instance to confirm the footer actually reaches
 *      tool responses (and is suppressed for `codegraph_status`).
 *
 * Cases (≥ 3 normal + boundary + exception per dev-baseline §4):
 *   • happy: fresh index < 1m → "<1m ago" without warning
 *   • happy: 5-minute-old index → "5m ago" without warning
 *   • boundary: 30-minute threshold exact → still without warning
 *   • boundary: 30m + 1ms → ⚠️ stale warning fires
 *   • happy: 90-minute-old index → "1.5h ago" with warning
 *   • exception: maxIndexedAt === null → empty string
 *   • exception: maxIndexedAt === 0 / negative → empty string
 *   • boundary: now < maxIndexedAt (clock skew) → clamped to 0 ms,
 *     <1m ago, no warning
 *   • integration: codegraph_search response includes footer
 *   • integration: codegraph_status response does NOT include footer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { ToolHandler, _internal_formatIndexAgeFooter } from '../src/mcp/tools';

describe('P0/T3 — _internal_formatIndexAgeFooter (unit)', () => {
  // Anchor "now" at a fixed point so the math is deterministic.
  const NOW = 1_700_000_000_000;

  it('happy: <1m old index renders "<1m ago" without warning', () => {
    const footer = _internal_formatIndexAgeFooter(NOW - 30_000, NOW); // 30s ago
    expect(footer).toContain('<1m ago');
    expect(footer).not.toContain('⚠️');
    expect(footer).not.toContain('stale');
  });

  it('happy: 5-minute-old index renders "5m ago" without warning', () => {
    const footer = _internal_formatIndexAgeFooter(NOW - 5 * 60_000, NOW);
    expect(footer).toContain('5m ago');
    expect(footer).not.toContain('⚠️');
  });

  it('boundary: exactly 30m old (threshold) is treated as stale and warns', () => {
    // The threshold is "ageMs >= INDEX_AGE_STALE_MS" (>=, not >). Anything
    // >= 30 minutes triggers the warning. This pins the policy.
    const footer = _internal_formatIndexAgeFooter(NOW - 30 * 60_000, NOW);
    expect(footer).toContain('⚠️');
    expect(footer).toContain('30m ago');
    expect(footer).toContain('stale');
  });

  it('boundary: just below threshold (29m 59s) renders without warning', () => {
    const footer = _internal_formatIndexAgeFooter(NOW - (30 * 60_000 - 1_000), NOW);
    expect(footer).not.toContain('⚠️');
    expect(footer).toContain('30m ago'); // Math.round → 30
  });

  it('happy: 90-minute-old index renders as "1.5h ago" with warning', () => {
    const footer = _internal_formatIndexAgeFooter(NOW - 90 * 60_000, NOW);
    expect(footer).toContain('1.5h ago');
    expect(footer).toContain('⚠️');
  });

  it('exception: null timestamp returns empty string (no footer rendered)', () => {
    expect(_internal_formatIndexAgeFooter(null, NOW)).toBe('');
  });

  it('exception: zero / negative timestamp returns empty string', () => {
    expect(_internal_formatIndexAgeFooter(0, NOW)).toBe('');
    expect(_internal_formatIndexAgeFooter(-1, NOW)).toBe('');
  });

  it('boundary: clock skew (maxIndexedAt > now) clamps to 0ms — renders "<1m ago" rather than negative', () => {
    const footer = _internal_formatIndexAgeFooter(NOW + 60_000, NOW);
    expect(footer).toContain('<1m ago');
    expect(footer).not.toContain('-');
  });

  it('format: footer is markdown italic (single underscore wrap) so it stands out without breaking layout', () => {
    const footer = _internal_formatIndexAgeFooter(NOW - 5 * 60_000, NOW);
    // Footer starts with a blank line + underscore-wrapped italic block.
    expect(footer).toMatch(/^\n\n_.*_$/);
  });
});

describe('P2/F-4 — _internal_formatIndexAgeFooter git-aware staleness (unit)', () => {
  // Reuse the same fixed-NOW anchor as the P0/T3 unit suite for
  // determinism; arithmetic is plain epoch math.
  const NOW = 1_700_000_000_000;

  it('priority 1: hasUncommitted=true returns Uncommitted warning regardless of git/index timing', () => {
    // Even when the index is fresh and HEAD is older — uncommitted
    // edits are the strongest stale signal so they win the priority
    // ladder.
    const footer = _internal_formatIndexAgeFooter(
      NOW - 5 * 60_000, // index 5m ago
      NOW,
      { lastCommitTime: NOW - 10 * 60_000, hasUncommitted: true }, // HEAD older, but dirty
    );
    expect(footer).toMatch(
      /⚠️ Uncommitted changes \(modified or new files outside \.gitignore\)/,
    );
    expect(footer).not.toContain('Git has commits newer');
    expect(footer).not.toContain('matches HEAD');
  });

  it('priority 1 wins over priority 2: hasUncommitted=true beats lastCommitTime>index', () => {
    // Worst-case stale: HEAD also moved past the index AND working
    // tree is dirty. Uncommitted warning must surface because the
    // recovery action ("run codegraph sync") is the same and the
    // stronger anchor helps the LLM react.
    const footer = _internal_formatIndexAgeFooter(
      NOW - 60 * 60_000, // index 1h ago
      NOW,
      { lastCommitTime: NOW - 30 * 60_000, hasUncommitted: true }, // HEAD newer, dirty
    );
    expect(footer).toContain('⚠️ Uncommitted changes');
    expect(footer).not.toContain('Git has commits newer');
  });

  it('priority 2: lastCommitTime > maxIndexedAt returns Git-newer warning when clean', () => {
    const footer = _internal_formatIndexAgeFooter(
      NOW - 60 * 60_000, // index 1h ago
      NOW,
      { lastCommitTime: NOW - 30 * 60_000, hasUncommitted: false }, // HEAD 30m newer, clean
    );
    expect(footer).toMatch(
      /⚠️ Git has commits newer than this index — run `codegraph sync`/,
    );
    expect(footer).not.toContain('Uncommitted');
    expect(footer).not.toContain('matches HEAD');
  });

  it('priority 3: clean working tree + HEAD ≤ index emits the high-trust ✓ footer', () => {
    // The double-verification path: git itself confirms the index is
    // current. Higher trust than any timer-only footer.
    const footer = _internal_formatIndexAgeFooter(
      NOW - 5 * 60_000, // index 5m ago
      NOW,
      { lastCommitTime: NOW - 10 * 60_000, hasUncommitted: false }, // HEAD older, clean
    );
    expect(footer).toContain('(✓ matches HEAD, no uncommitted changes)');
    expect(footer).toContain('5m ago');
    expect(footer).not.toContain('⚠️');
  });

  it('boundary: lastCommitTime === maxIndexedAt — uses ≤ comparison, falls into ✓ branch', () => {
    // The boundary policy: "HEAD time equals index time" is treated as
    // matching, not as newer. Asserts the inequality direction.
    const footer = _internal_formatIndexAgeFooter(
      NOW - 5 * 60_000,
      NOW,
      { lastCommitTime: NOW - 5 * 60_000, hasUncommitted: false },
    );
    expect(footer).toContain('matches HEAD');
    expect(footer).not.toContain('Git has commits newer');
  });

  it('priority 2 even at 1ms newer: lastCommitTime > index emits warning (boundary on > vs ≥)', () => {
    // 1 millisecond newer must already trigger the warning — pins the
    // strict-> policy. Otherwise off-by-one bugs would slip past.
    const footer = _internal_formatIndexAgeFooter(
      NOW - 5 * 60_000,
      NOW,
      { lastCommitTime: NOW - 5 * 60_000 + 1, hasUncommitted: false },
    );
    expect(footer).toContain('Git has commits newer');
  });

  it('fallback: changeSignal=null + stale age — byte-identical to P0/T3 timer warning', () => {
    // P0 compatibility physics guard: with changeSignal=null, the
    // output must match P0/T3 verbatim. We snapshot the P0 footer at
    // the same input and assert structural equality.
    const p0Footer = _internal_formatIndexAgeFooter(NOW - 45 * 60_000, NOW);
    const f4FallbackFooter = _internal_formatIndexAgeFooter(
      NOW - 45 * 60_000,
      NOW,
      null,
    );
    expect(f4FallbackFooter).toBe(p0Footer);
    expect(f4FallbackFooter).toContain('⚠️ Index age: 45m ago');
    expect(f4FallbackFooter).toContain('older than 30m');
    expect(f4FallbackFooter).toContain('stale');
  });

  it('fallback: changeSignal=null + fresh age — byte-identical to P0/T3 fresh footer', () => {
    const p0Footer = _internal_formatIndexAgeFooter(NOW - 2 * 60_000, NOW);
    const f4FallbackFooter = _internal_formatIndexAgeFooter(
      NOW - 2 * 60_000,
      NOW,
      null,
    );
    expect(f4FallbackFooter).toBe(p0Footer);
    expect(f4FallbackFooter).toBe('\n\n_Index age: 2m ago_');
  });

  it('fallback: empty changeSignal (lastCommitTime=null, hasUncommitted=false) drops to P0 path', () => {
    // Defensive edge: if both git probes failed but changeSignal was
    // still constructed (rather than passed as `null`), the function
    // must still degrade to P0 — not emit a "no signal" footer that
    // would confuse the LLM. Asserts the `hasGitSignal` gate works.
    const f4EmptyFooter = _internal_formatIndexAgeFooter(
      NOW - 2 * 60_000,
      NOW,
      { lastCommitTime: null, hasUncommitted: false },
    );
    const p0Footer = _internal_formatIndexAgeFooter(NOW - 2 * 60_000, NOW);
    expect(f4EmptyFooter).toBe(p0Footer);
  });

  it('exception: maxIndexedAt=null still returns empty string even with full changeSignal', () => {
    // Empty index trumps every signal — no footer at all (no data to
    // describe). Asserts the early-return survives the new arg.
    const footer = _internal_formatIndexAgeFooter(null, NOW, {
      lastCommitTime: NOW - 60_000,
      hasUncommitted: true,
    });
    expect(footer).toBe('');
  });
});

describe('P0/T3 integration — index-age footer is injected by ToolHandler', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p0-t3-'));
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function textOf(result: { content: Array<{ type: string; text: string }> }): string {
    return result.content.map((c) => c.text).join('\n');
  }

  it('codegraph_search response carries an "Index age:" footer (fresh index, no warning)', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export function findMe(): number { return 1; }\n`
    );
    cg = await CodeGraph.init(tempDir, { index: true });

    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_search', { query: 'findMe' });
    const text = textOf(result);

    // Footer present and not warning (fresh index just created).
    expect(text).toMatch(/_Index age: <?\d+m ago_/);
    expect(text).not.toContain('⚠️ Index age');
  });

  it('codegraph_status response is suppressed — status IS the freshness source, footer would be redundant', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export function statusProbe(): void {}\n`
    );
    cg = await CodeGraph.init(tempDir, { index: true });

    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_status', {});
    const text = textOf(result);

    // The status response itself reports indexing info; we deliberately
    // skip the footer to avoid confusing duplicate signals.
    expect(text).not.toMatch(/_Index age: \d+m ago_/);
    expect(text).not.toMatch(/_⚠️ Index age:/);
  });

  it('codegraph_callers response carries the footer (verifies non-status tools still get it)', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'lib.ts'),
      `export function target(): number { return 1; }\n` +
        `export function caller(): number { return target() + 1; }\n`
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_callers', { symbol: 'target' });
    const text = textOf(result);

    expect(text).toMatch(/_Index age: <?\d+m ago_/);
  });

  it('error response (unknown tool) does NOT carry a footer — index age is irrelevant for protocol errors', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export function x(): void {}\n`
    );
    cg = await CodeGraph.init(tempDir, { index: true });

    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_NOT_A_TOOL', {});
    const text = textOf(result);

    // Unknown tool path returns isError-marked response — footer is
    // suppressed so the LLM sees a clean error, not a noisy footer.
    expect(text).not.toMatch(/_Index age:/);
    expect(text).not.toMatch(/_⚠️ Index age:/);
  });

  it('handler with no loaded CodeGraph does not crash — footer silently degrades to empty', async () => {
    // No CodeGraph passed to the handler. The footer code path tries
    // to look one up, fails, and must not propagate the error.
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_search', { query: 'whatever' });
    const text = textOf(result);

    // We expect an error message about no loaded project, but no crash
    // and no half-rendered footer.
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/_Index age: undefined/);
    expect(text).not.toMatch(/_Index age: NaN/);
  });
});

describe('P2/F-4 integration — git-aware staleness footer end-to-end', () => {
  // Real `git init` / `git commit` / file edits drive these tests —
  // we explicitly do NOT mock git. The only way to verify
  // `getProjectChangeSignal` actually queries git is to run it. CI is
  // assumed to have git on PATH (codegraph itself depends on it).
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p2-f4-'));
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = undefined;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function textOf(result: { content: Array<{ type: string; text: string }> }): string {
    return result.content.map((c) => c.text).join('\n');
  }

  /**
   * Spawn `git` with the args, ignore stderr, return stdout. Throws
   * the underlying error on failure — callers (test setup) want loud
   * failures, unlike production code which silently degrades.
   */
  function gitRun(args: string[]): string {
    const { execFileSync } = require('child_process');
    return execFileSync('git', args, {
      cwd: tempDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  }

  /**
   * Minimal git repo bootstrap — init, set local identity (CI hosts
   * may not have a global user.* config), make an initial commit of
   * the indexed file. Returns the file path so tests can mutate it.
   */
  function bootstrapGitRepoWithFile(filename: string, contents: string): string {
    const filePath = path.join(tempDir, filename);
    gitRun(['init', '-q']);
    gitRun(['config', 'user.email', 'test@codegraph.local']);
    gitRun(['config', 'user.name', 'codegraph test']);
    fs.writeFileSync(filePath, contents);
    gitRun(['add', '.']);
    gitRun(['commit', '-q', '-m', 'initial']);
    return filePath;
  }

  it('non-git project falls back to P0 timer — no git-derived footer literal appears', async () => {
    // tempDir has no `.git`. The footer must look like a P0 fresh
    // footer (or empty), not contain any F-4 literals.
    fs.writeFileSync(path.join(tempDir, 'a.ts'), `export function nonGit(): void {}\n`);
    cg = await CodeGraph.init(tempDir, { index: true });

    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_search', { query: 'nonGit' });
    const text = textOf(result);

    expect(text).not.toContain('Uncommitted changes');
    expect(text).not.toContain('Git has commits newer');
    expect(text).not.toContain('matches HEAD');
    // Still emits the P0 fresh footer (just-created index < 1 min).
    expect(text).toMatch(/_Index age: <?\d+m ago_/);
  });

  it('clean git repo with index built after HEAD → ✓ matches HEAD footer', async () => {
    bootstrapGitRepoWithFile('clean.ts', `export function clean(): number { return 1; }\n`);
    cg = await CodeGraph.init(tempDir, { index: true });

    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_search', { query: 'clean' });
    const text = textOf(result);

    expect(text).toContain('(✓ matches HEAD, no uncommitted changes)');
    expect(text).not.toContain('⚠️');
  });

  it('git repo + modified tracked file (uncommitted) → ⚠️ Uncommitted changes', async () => {
    const filePath = bootstrapGitRepoWithFile(
      'mod.ts',
      `export function mod(): number { return 1; }\n`,
    );
    cg = await CodeGraph.init(tempDir, { index: true });

    // Mutate the tracked file but do NOT commit. `git status` will
    // report "M mod.ts" → hasUncommitted=true.
    fs.writeFileSync(filePath, `export function mod(): number { return 2; }\n`);

    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_search', { query: 'mod' });
    const text = textOf(result);

    expect(text).toContain('⚠️ Uncommitted changes');
    expect(text).toContain('outside .gitignore');
  });

  it('git repo + NEW untracked .ts file (not git add-ed) → ⚠️ Uncommitted changes (covers new-file scenario)', async () => {
    // Critical F-4 case: the user creates a new source file, doesn't
    // even `git add` it, expects the index to be flagged stale.
    // `git status --untracked-files=normal` reports "?? newfile.ts"
    // → hasUncommitted=true. This was the gap in early F-4 designs
    // that picked --untracked-files=no.
    bootstrapGitRepoWithFile('base.ts', `export function base(): number { return 1; }\n`);
    cg = await CodeGraph.init(tempDir, { index: true });

    fs.writeFileSync(
      path.join(tempDir, 'newfeature.ts'),
      `export function neverIndexed(): void {}\n`,
    );

    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_search', { query: 'base' });
    const text = textOf(result);

    expect(text).toContain('⚠️ Uncommitted changes');
  });

  it('git repo + change to .gitignore-d file does NOT trigger uncommitted footer (gitignore is honored)', async () => {
    // Build the .gitignore inside the initial commit so the rule is
    // active. Then create a build artifact in the ignored path — git
    // status should not report it.
    bootstrapGitRepoWithFile('src.ts', `export function src(): number { return 1; }\n`);
    // Add .gitignore in a second commit so the initial commit doesn't
    // include the build artifact.
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'dist/\n');
    gitRun(['add', '.gitignore']);
    gitRun(['commit', '-q', '-m', 'add gitignore']);
    cg = await CodeGraph.init(tempDir, { index: true });

    // Now create a "build artifact" in the ignored path. Should be
    // invisible to `git status` and to F-4.
    fs.mkdirSync(path.join(tempDir, 'dist'));
    fs.writeFileSync(path.join(tempDir, 'dist', 'artifact.js'), 'console.log(1)');

    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_search', { query: 'src' });
    const text = textOf(result);

    expect(text).not.toContain('⚠️ Uncommitted changes');
    // The clean-repo footer should win (✓ matches HEAD).
    expect(text).toContain('(✓ matches HEAD, no uncommitted changes)');
  });

  it('git repo + 2nd commit after index → ⚠️ Git has commits newer', async () => {
    bootstrapGitRepoWithFile('a.ts', `export function a(): number { return 1; }\n`);
    cg = await CodeGraph.init(tempDir, { index: true });

    // Second commit must have committer time strictly after the
    // index's maxIndexedAt. CI clocks tick fast but `git commit` can
    // land in the same second as `CodeGraph.init` — force at least a
    // 1-second gap so committer time advances past index time.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export function a(): number { return 2; }\n`,
    );
    gitRun(['add', '.']);
    gitRun(['commit', '-q', '-m', 'second']);

    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_search', { query: 'a' });
    const text = textOf(result);

    expect(text).toContain('⚠️ Git has commits newer than this index');
    expect(text).not.toContain('Uncommitted'); // 2nd commit cleaned working tree
  });

  it('codegraph_status remains exempt even under F-4 — no footer of any flavor', async () => {
    // The TOOLS_SKIP_INDEX_AGE exemption was P0/T3 behavior;
    // verifying F-4 didn't accidentally regress it.
    bootstrapGitRepoWithFile('s.ts', `export function s(): void {}\n`);
    cg = await CodeGraph.init(tempDir, { index: true });

    // Make it dirty so a non-status tool WOULD show a warning,
    // proving the absence is selective and not a bug.
    fs.writeFileSync(
      path.join(tempDir, 's.ts'),
      `export function s(): void { return; }\n`,
    );

    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_status', {});
    const text = textOf(result);

    expect(text).not.toContain('Uncommitted changes');
    expect(text).not.toContain('Git has commits newer');
    expect(text).not.toContain('matches HEAD');
    expect(text).not.toContain('_Index age:');
  });
});
