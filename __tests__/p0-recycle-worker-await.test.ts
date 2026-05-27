/**
 * 0005 / T2 — `recycleWorker()` MUST be awaited in retry/strip paths.
 *
 * 0004 fixed the main parse loop to `await recycleWorker()` so the old
 * worker's V8 isolate (and its WASM linear memory) is reclaimed before
 * `ensureWorker()` spawns a fresh one. Without the await, both old and
 * new workers briefly coexist, doubling peak WASM memory and re-
 * introducing the very Zone OOM 0004 was meant to prevent.
 *
 * However 0004 missed two more recycle call sites — both inside the
 * retry-pass error recovery (around src/extraction/index.ts:899/944).
 * They were left as fire-and-forget, defeating the whole fix on any
 * indexing run that hit retryable parse errors.
 *
 * 0005 / T2 fixes both call sites and pins the structural invariant
 * here: every `recycleWorker()` call in the file MUST be preceded by
 * `await`. A future refactor that drops the await would silently
 * recreate the bug — this test is the trip wire.
 *
 * 5 cases: 2 normal (each retry path has the await) + 1 boundary
 * (every recycleWorker invocation site is awaited, no exceptions) +
 * 2 exception (regex anchors not over-broadly matching definitions
 * or comments).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const EXTRACTION_SRC_PATH = path.join(__dirname, '..', 'src', 'extraction', 'index.ts');

/**
 * Find every "call expression" of recycleWorker() in the source.
 * Excludes:
 *   - the `function recycleWorker(): Promise<void>` definition line
 *   - JSDoc / inline comment mentions
 *
 * Returns an array of { lineNumber, line, hasAwaitBefore } so each test
 * case can target a specific structural property.
 */
function findRecycleWorkerCallSites(source: string): Array<{
  lineNumber: number;
  line: string;
  hasAwaitBefore: boolean;
}> {
  const lines = source.split('\n');
  const sites: Array<{ lineNumber: number; line: string; hasAwaitBefore: boolean }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match: optional whitespace + (optional `await ` + ) `recycleWorker(`
    // followed by `)` to confirm it's a call expression (not a definition).
    // Definition has `function recycleWorker` or type annotation `(): Promise`.
    const callMatch = /^(\s*)(await\s+)?recycleWorker\(\s*\)\s*;?\s*$/.exec(line);
    if (!callMatch) continue;

    sites.push({
      lineNumber: i + 1, // 1-based for easier human cross-reference
      line,
      hasAwaitBefore: callMatch[2] !== undefined,
    });
  }

  return sites;
}

describe('0005/T2 — recycleWorker() must be awaited in every call site', () => {
  const source = fs.readFileSync(EXTRACTION_SRC_PATH, 'utf-8');
  const sites = findRecycleWorkerCallSites(source);

  it('normal: discovers at least 3 recycleWorker() call sites (main loop + retry + strip)', () => {
    // Main parse loop awaits at ~line 709, retry pass at ~line 899, strip
    // pass at ~line 944. If a future refactor drops one of them entirely,
    // we want to know — fewer call sites can also indicate a regression
    // (e.g. someone removed the strip-comments fallback altogether).
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it('normal: every recycleWorker() call site has `await` before it', () => {
    const missing = sites.filter((s) => !s.hasAwaitBefore);
    if (missing.length > 0) {
      const detail = missing
        .map((s) => `  src/extraction/index.ts:${s.lineNumber}\n    ${s.line.trim()}`)
        .join('\n');
      throw new Error(
        `Found ${missing.length} recycleWorker() call site(s) missing \`await\` — this re-introduces the\n` +
          `double-worker-coexistence window 0004 fixed (see docs/wasm-compile-oom-rationale.md §2.3).\n` +
          `Offending sites:\n${detail}\n`
      );
    }
    expect(missing.length).toBe(0);
  });

  it('boundary: at least the two retry/strip paths from 0005/T2 exist (line range sanity)', () => {
    // T2 specifically targets two call sites in the error-recovery code,
    // which lives roughly between lines 880 and 990. If a future refactor
    // moves them out entirely we want a noisy failure rather than a
    // silent pass — hence the explicit range check on the post-await
    // assertion.
    const inRetryRange = sites.filter((s) => s.lineNumber >= 880 && s.lineNumber <= 990);
    expect(inRetryRange.length).toBeGreaterThanOrEqual(2);
    for (const site of inRetryRange) {
      expect(site.hasAwaitBefore).toBe(true);
    }
  });

  it('exception: regex does not match `recycleWorker` inside comments', () => {
    // Sanity — verify our matcher is precise. A line like
    //   `// later: await recycleWorker()` should NOT count as a call.
    const fakeSource = [
      '    // FIXME: should we await recycleWorker() here?',
      '    /* await recycleWorker() */',
      '    const x = "recycleWorker()";',
    ].join('\n');
    const fakeSites = findRecycleWorkerCallSites(fakeSource);
    expect(fakeSites.length).toBe(0);
  });

  it('exception: regex does not match the function definition line', () => {
    // The `async function recycleWorker(): Promise<void> {` line in
    // src/extraction/index.ts must be excluded — it's a definition,
    // not a call. Otherwise the "all calls awaited" assertion would
    // incorrectly include the definition line and probably pass for
    // the wrong reason.
    const fakeSource = [
      '    async function recycleWorker(): Promise<void> {',
      '      if (!parseWorker) return;',
      '    }',
    ].join('\n');
    const fakeSites = findRecycleWorkerCallSites(fakeSource);
    expect(fakeSites.length).toBe(0);
  });
});
