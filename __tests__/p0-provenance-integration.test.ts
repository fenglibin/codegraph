/**
 * P0 / T1 — End-to-end provenance & confidence integration test.
 *
 * The companion unit suite (`p0-confidence-output.test.ts`) exercises
 * `createEdges` against an in-memory ResolutionContext. That covers the
 * function contract but does NOT prove that:
 *
 *   1. Every code path that constructs an `Edge` actually stamps a
 *      provenance (no NULLs leak to disk after a real `indexAll`).
 *   2. The two valid provenance values both appear in a healthy mixed
 *      codebase — i.e. extractors emit `'tree-sitter'` and the resolver
 *      emits `'heuristic'` against the same project.
 *   3. Heuristic edges carry a valid `confidence` ∈ [0, 1] inside
 *      `metadata.confidence` end-to-end through SQLite round-trip.
 *
 * This test answers all three by running a real `CodeGraph.init` over
 * a tiny synthetic TypeScript project, then inspecting every edge via
 * the public `getOutgoingEdges` API (which uses the same SQL the MCP
 * layer will use in T2).
 *
 * If a future refactor introduces a new `edges.push({...})` site that
 * forgets to set `provenance`, the NULL-count assertion below catches
 * it before the change can land — closing the dev-baseline "red-line
 * #12: tests pass ≠ application works" gap that the unit suite alone
 * could not cover.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

describe('P0/T1 integration — provenance & confidence after real indexAll', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p0-prov-int-'));
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

  it('persists tree-sitter provenance for AST-direct edges (contains, imports, ...) and zero NULL leaks', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export class Foo {\n` +
        `  bar(): number { return 42; }\n` +
        `}\n` +
        `export function useFoo(): number {\n` +
        `  const f = new Foo();\n` +
        `  return f.bar();\n` +
        `}\n`
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    // Collect every outgoing edge across every indexed node.
    const allNodes = cg.searchNodes('', { limit: 1000 }).map((r) => r.node);
    expect(allNodes.length).toBeGreaterThan(0);

    const dist = { 'tree-sitter': 0, heuristic: 0, NULL: 0, other: 0 };
    let totalEdges = 0;
    for (const node of allNodes) {
      for (const e of cg.getOutgoingEdges(node.id)) {
        totalEdges++;
        const p =
          e.provenance === null || e.provenance === undefined
            ? 'NULL'
            : e.provenance;
        if (p === 'tree-sitter' || p === 'heuristic' || p === 'NULL') {
          dist[p]++;
        } else {
          dist.other++;
        }
      }
    }

    expect(totalEdges).toBeGreaterThan(0);
    // AST-direct edges (contains) must exist and be stamped tree-sitter.
    expect(dist['tree-sitter']).toBeGreaterThan(0);
    // No NULL leaks — every code path that constructs an Edge must stamp it.
    expect(dist.NULL).toBe(0);
    // No unexpected provenance values (typos, copy-paste mistakes).
    expect(dist.other).toBe(0);
  });

  it('persists heuristic provenance + metadata.confidence ∈ [0,1] for resolver-produced edges', async () => {
    // Two-file fixture where file B calls a function defined in file A,
    // forcing the resolver (name-matcher) to materialize a cross-file
    // heuristic 'calls' edge with a confidence score.
    fs.writeFileSync(
      path.join(tempDir, 'lib.ts'),
      `export function doWork(): string {\n` +
        `  return 'done';\n` +
        `}\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'main.ts'),
      `import { doWork } from './lib';\n` +
        `\n` +
        `export function run(): string {\n` +
        `  return doWork();\n` +
        `}\n`
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const allNodes = cg.searchNodes('', { limit: 1000 }).map((r) => r.node);

    const heuristicEdges: Array<{ confidence: unknown; provenance: unknown }> = [];
    for (const node of allNodes) {
      for (const e of cg.getOutgoingEdges(node.id)) {
        if (e.provenance === 'heuristic') {
          const conf =
            e.metadata && typeof (e.metadata as Record<string, unknown>).confidence === 'number'
              ? (e.metadata as { confidence: number }).confidence
              : undefined;
          heuristicEdges.push({ confidence: conf, provenance: e.provenance });
        }
      }
    }

    // We must have at least one resolved cross-file call edge.
    expect(heuristicEdges.length).toBeGreaterThan(0);

    // Every heuristic edge must carry a confidence in [0, 1].
    for (const e of heuristicEdges) {
      expect(typeof e.confidence).toBe('number');
      expect(e.confidence as number).toBeGreaterThanOrEqual(0);
      expect(e.confidence as number).toBeLessThanOrEqual(1);
    }
  });

  it('rejects edges with provenance values outside the documented {tree-sitter,scip,heuristic} set', async () => {
    // Same fixture as test #1.
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export class Foo { bar() { return 42; } }\n`
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const allNodes = cg.searchNodes('', { limit: 1000 }).map((r) => r.node);
    const seenProvenance = new Set<string | null | undefined>();
    for (const node of allNodes) {
      for (const e of cg.getOutgoingEdges(node.id)) {
        seenProvenance.add(e.provenance);
      }
    }

    // Whatever values appear, they must come from the documented set,
    // or be null/undefined (legacy data — but in this fresh-index
    // scenario, even null/undefined would indicate a regression).
    const allowed = new Set<string | null | undefined>([
      'tree-sitter',
      'heuristic',
      'scip',
    ]);
    for (const p of seenProvenance) {
      expect(allowed.has(p)).toBe(true);
    }
  });

  it('P1.2 — Vue and Svelte sub-extracted edges retain provenance through the parent transit', async () => {
    // Background: VueExtractor and SvelteExtractor delegate <script>
    // block parsing to TreeSitterExtractor, then re-emit each
    // sub-edge via `this.edges.push(edge)` (vue-extractor.ts:180,
    // svelte-extractor.ts:201). That transit relies on tree-sitter.ts
    // having stamped provenance on every contains-edge it produces —
    // an implicit cross-file invariant. If a future tree-sitter.ts
    // change misses a contains-push, BOTH vue/svelte indexing will
    // silently regress to NULL provenance for inner symbols.
    //
    // This test exercises both extractors against minimal SFCs that
    // contain at least one inner class+method (forces the inner
    // contains edge), then asserts the resulting outgoing edges
    // include 'tree-sitter' provenance and zero NULL.
    fs.writeFileSync(
      path.join(tempDir, 'Component.vue'),
      `<script lang="ts">\n` +
        `export class WidgetController {\n` +
        `  refresh(): void { /* no-op */ }\n` +
        `}\n` +
        `</script>\n` +
        `<template><div /></template>\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'Counter.svelte'),
      `<script lang="ts">\n` +
        `  export class CounterStore {\n` +
        `    increment(): void { /* no-op */ }\n` +
        `  }\n` +
        `</script>\n`
    );

    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const allNodes = cg.searchNodes('', { limit: 1000 }).map((r) => r.node);
    // Sanity: both inner classes should have been extracted via the
    // delegated tree-sitter pass. If either is missing, the fixture
    // didn't exercise the sub-extraction path — fail loud.
    const innerClassNames = allNodes
      .filter((n) => n.kind === 'class')
      .map((n) => n.name);
    expect(innerClassNames).toContain('WidgetController');
    expect(innerClassNames).toContain('CounterStore');

    const dist = { 'tree-sitter': 0, heuristic: 0, NULL: 0, other: 0 };
    for (const node of allNodes) {
      for (const e of cg.getOutgoingEdges(node.id)) {
        const p =
          e.provenance === null || e.provenance === undefined
            ? 'NULL'
            : e.provenance;
        if (p === 'tree-sitter' || p === 'heuristic' || p === 'NULL') {
          dist[p]++;
        } else {
          dist.other++;
        }
      }
    }
    // Sub-extracted contains edges must reach the parent extractor
    // with provenance intact.
    expect(dist['tree-sitter']).toBeGreaterThan(0);
    expect(dist.NULL).toBe(0);
    expect(dist.other).toBe(0);
  });
});
