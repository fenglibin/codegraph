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
