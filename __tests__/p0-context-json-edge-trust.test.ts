/**
 * P0 / T2 — `formatContextAsJson` exposes edge confidence + provenance.
 *
 * Closes the dev-baseline blind-spot found during T1 deep self-review:
 * `serializeEdge` in `src/context/formatter.ts` was filtering out
 * `metadata.confidence` and `provenance` from JSON output. After the
 * fix, JSON consumers can read both signals and decide trust per-edge.
 *
 * 5 cases: AST edge / heuristic with confidence / heuristic w/o confidence
 * / null provenance (legacy data) / malformed metadata (defensive).
 */

import { describe, it, expect } from 'vitest';
import { formatContextAsJson } from '../src/context/formatter';
import type { TaskContext, Edge, Node, Subgraph } from '../src/types';

function makeNode(id: string, name: string): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: `test::${name}`,
    filePath: 'test.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 5,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

function makeContext(edges: Edge[]): TaskContext {
  const nodeMap = new Map<string, Node>();
  for (const e of edges) {
    if (!nodeMap.has(e.source)) nodeMap.set(e.source, makeNode(e.source, e.source));
    if (!nodeMap.has(e.target)) nodeMap.set(e.target, makeNode(e.target, e.target));
  }
  const subgraph: Subgraph = {
    nodes: nodeMap,
    edges,
    roots: edges.length > 0 ? [edges[0]!.source] : [],
  };
  return {
    query: 'test query',
    subgraph,
    entryPoints: [],
    codeBlocks: [],
    relatedFiles: [],
    summary: 'test',
    stats: {
      nodeCount: nodeMap.size,
      edgeCount: edges.length,
      fileCount: 1,
      codeBlockCount: 0,
      totalCodeSize: 0,
    },
  };
}

describe('P0/T2 — formatContextAsJson exposes edge trust signals', () => {
  it('AST edge: provenance="tree-sitter" appears in JSON, no confidence (none was set)', () => {
    const ctx = makeContext([
      { source: 'a', target: 'b', kind: 'contains', provenance: 'tree-sitter' },
    ]);
    const out = JSON.parse(formatContextAsJson(ctx));
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].provenance).toBe('tree-sitter');
    expect(out.edges[0].confidence).toBeUndefined();
  });

  it('heuristic edge with confidence: both fields surfaced in JSON', () => {
    const ctx = makeContext([
      {
        source: 'a',
        target: 'b',
        kind: 'calls',
        provenance: 'heuristic',
        metadata: { confidence: 0.85, resolvedBy: 'exact-match' },
      },
    ]);
    const out = JSON.parse(formatContextAsJson(ctx));
    expect(out.edges[0].provenance).toBe('heuristic');
    expect(out.edges[0].confidence).toBe(0.85);
  });

  it('heuristic edge without confidence: provenance only, no fabricated confidence', () => {
    const ctx = makeContext([
      { source: 'a', target: 'b', kind: 'calls', provenance: 'heuristic' },
    ]);
    const out = JSON.parse(formatContextAsJson(ctx));
    expect(out.edges[0].provenance).toBe('heuristic');
    expect(out.edges[0].confidence).toBeUndefined();
  });

  it('legacy edge with null/undefined provenance: omits the field rather than emitting null', () => {
    // Pre-T1 databases may still hold edges with NULL provenance after
    // an upgrade-without-reindex. We deliberately omit the field rather
    // than emitting `provenance: null` so downstream consumers aren't
    // forced to handle a third state.
    const ctx = makeContext([{ source: 'a', target: 'b', kind: 'contains' }]);
    const out = JSON.parse(formatContextAsJson(ctx));
    expect(out.edges[0]).not.toHaveProperty('provenance');
    expect(out.edges[0]).not.toHaveProperty('confidence');
  });

  it('defensive: malformed metadata.confidence (non-number, out-of-range) is dropped silently', () => {
    const ctx = makeContext([
      {
        source: 'a',
        target: 'b',
        kind: 'calls',
        provenance: 'heuristic',
        metadata: { confidence: 'high' as unknown as number, resolvedBy: 'fuzzy' },
      },
      {
        source: 'c',
        target: 'd',
        kind: 'calls',
        provenance: 'heuristic',
        metadata: { confidence: 1.5, resolvedBy: 'fuzzy' }, // out of range
      },
    ]);
    const out = JSON.parse(formatContextAsJson(ctx));
    expect(out.edges[0].provenance).toBe('heuristic');
    expect(out.edges[0].confidence).toBeUndefined(); // string dropped
    expect(out.edges[1].provenance).toBe('heuristic');
    expect(out.edges[1].confidence).toBeUndefined(); // out-of-range dropped
  });
});
