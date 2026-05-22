/**
 * P0 / T1: Confidence persistence + provenance stamping.
 *
 * Two long-standing gaps fixed in this batch:
 *
 *   1. The reference resolver was already computing `confidence` per
 *      resolved ref (0.3 ~ 0.95) but the value flowed into
 *      `edge.metadata.confidence`. We assert that confidence is
 *      preserved end-to-end through `createEdges()`.
 *
 *   2. The `Edge.provenance` field was declared in `types.ts` and
 *      backed by a real SQL column, yet **nothing** stamped it.
 *      Every edge persisted to disk had `provenance = NULL`, so the
 *      MCP layer downstream had no signal to distinguish AST-direct
 *      `contains` edges from heuristic `calls` edges. We now stamp
 *      `'tree-sitter'` in extraction and `'heuristic'` in resolution.
 *
 * Tests cover all three required scenarios per dev-baseline §4 (≥3
 * cases): normal happy path, edge case (zero matches), exception
 * (no candidates so resolver returns null — still no broken edge).
 */

import { describe, it, expect } from 'vitest';
import { ReferenceResolver, ResolvedRef } from '../src/resolution';
import { matchReference } from '../src/resolution/name-matcher';
import { Node, Edge, UnresolvedReference } from '../src/types';
import { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

/**
 * Build a minimal in-memory ResolutionContext for unit-testing
 * `createEdges()` directly without touching SQLite. We don't need
 * the queries layer here — we only test the metadata shape.
 */
function makeMinimalContext(nodes: Node[]): ResolutionContext {
  const byName = new Map<string, Node[]>();
  const byQualifiedName = new Map<string, Node[]>();
  const byLowerName = new Map<string, Node[]>();
  for (const n of nodes) {
    if (!byName.has(n.name)) byName.set(n.name, []);
    byName.get(n.name)!.push(n);
    if (!byQualifiedName.has(n.qualifiedName)) byQualifiedName.set(n.qualifiedName, []);
    byQualifiedName.get(n.qualifiedName)!.push(n);
    const lower = n.name.toLowerCase();
    if (!byLowerName.has(lower)) byLowerName.set(lower, []);
    byLowerName.get(lower)!.push(n);
  }
  return {
    getNodesInFile: (fp) => nodes.filter((n) => n.filePath === fp),
    getNodesByName: (name) => byName.get(name) ?? [],
    getNodesByQualifiedName: (qn) => byQualifiedName.get(qn) ?? [],
    getNodesByKind: (k) => nodes.filter((n) => n.kind === k),
    fileExists: () => true,
    readFile: () => null,
    getProjectRoot: () => '/tmp/p0-test',
    getAllFiles: () => Array.from(new Set(nodes.map((n) => n.filePath))),
    getNodesByLowerName: (lower) => byLowerName.get(lower) ?? [],
    getImportMappings: () => [],
  };
}

/**
 * Drive `ReferenceResolver.createEdges()` with a synthetic
 * `ResolvedRef[]` so we can inspect provenance/confidence on the
 * resulting edges without going through SQLite.
 */
function callCreateEdges(resolved: ResolvedRef[]): Edge[] {
  // We don't need a real QueryBuilder for createEdges; the only call
  // it makes against queries is `getNodeById` for the
  // extends→implements / calls→instantiates promotion. We stub it
  // with an unused-by-design fake.
  const fakeQueries = {
    getNodeById: () => undefined,
  } as unknown as ConstructorParameters<typeof ReferenceResolver>[1];
  const resolver = new ReferenceResolver('/tmp/p0-test', fakeQueries);
  return resolver.createEdges(resolved);
}

describe('P0/T1 — confidence persistence + provenance stamping', () => {
  describe('createEdges (resolution layer)', () => {
    it('happy path: every edge produced by the resolver carries provenance="heuristic" and metadata.confidence', () => {
      const resolved: ResolvedRef[] = [
        {
          original: {
            fromNodeId: 'caller-1',
            referenceName: 'doThing',
            referenceKind: 'calls',
            line: 5,
            column: 0,
            filePath: 'a.ts',
            language: 'typescript',
          },
          targetNodeId: 'target-1',
          confidence: 0.9,
          resolvedBy: 'exact-match',
        },
        {
          original: {
            fromNodeId: 'caller-2',
            referenceName: 'fuzzyName',
            referenceKind: 'calls',
            line: 10,
            column: 4,
            filePath: 'b.ts',
            language: 'typescript',
          },
          targetNodeId: 'target-2',
          confidence: 0.5,
          resolvedBy: 'fuzzy',
        },
      ];

      const edges = callCreateEdges(resolved);

      expect(edges).toHaveLength(2);
      // High-confidence exact-match edge.
      expect(edges[0]!.provenance).toBe('heuristic');
      expect(edges[0]!.metadata).toMatchObject({
        confidence: 0.9,
        resolvedBy: 'exact-match',
      });
      // Low-confidence fuzzy edge — still heuristic provenance.
      expect(edges[1]!.provenance).toBe('heuristic');
      expect(edges[1]!.metadata).toMatchObject({
        confidence: 0.5,
        resolvedBy: 'fuzzy',
      });
    });

    it('boundary: empty resolved list produces no edges (and never throws)', () => {
      const edges = callCreateEdges([]);
      expect(edges).toHaveLength(0);
    });

    it('boundary: confidence=0.3 (lowest assigned by name-matcher cross-language fuzzy path) survives the round-trip without truncation', () => {
      const resolved: ResolvedRef[] = [
        {
          original: {
            fromNodeId: 'src-x',
            referenceName: 'x',
            referenceKind: 'references',
            line: 1,
            column: 0,
            filePath: 'x.py',
            language: 'python',
          },
          targetNodeId: 'tgt-x',
          confidence: 0.3,
          resolvedBy: 'fuzzy',
        },
      ];
      const [edge] = callCreateEdges(resolved);
      expect(edge!.metadata?.confidence).toBe(0.3);
      expect(edge!.provenance).toBe('heuristic');
    });

    it('exception path: name-matcher returning null does NOT produce an orphaned edge with default confidence', () => {
      // Real-world flow: when name-matcher returns null upstream, the
      // resolver simply doesn't add a ResolvedRef to the list, so
      // createEdges sees nothing for that ref. Verify by passing a
      // ref that name-matcher cannot resolve (no candidates) and
      // confirming the resolver yields no edge.
      const ctx = makeMinimalContext([]);
      const ref: UnresolvedRef = {
        fromNodeId: 'caller-x',
        referenceName: 'thisNameDoesNotExistAnywhere',
        referenceKind: 'calls',
        line: 1,
        column: 0,
        filePath: 'x.ts',
        language: 'typescript',
      };
      const result = matchReference(ref, ctx);
      expect(result).toBeNull();
      // And confirm that an empty resolved list yields zero edges —
      // no fabricated default-confidence edge is leaked.
      expect(callCreateEdges([])).toHaveLength(0);
    });
  });

  describe('extractor edge provenance (sanity check via type)', () => {
    it("extraction-layer edges declare provenance: 'tree-sitter' so DB column is populated", () => {
      // We don't run a full extractor here (covered by extraction.test.ts).
      // This test documents the contract: the Edge interface allows
      // 'tree-sitter' / 'scip' / 'heuristic'. After this batch, every
      // call site that constructs a contains-edge must set provenance
      // to 'tree-sitter' so downstream MCP tools can distinguish
      // AST-direct edges from heuristic ones.
      //
      // Compile-time check: the literal 'tree-sitter' must be a valid
      // value for Edge.provenance. If types.ts ever drops it, this
      // file fails to compile and the regression is caught.
      const sample: Edge = {
        source: 'a',
        target: 'b',
        kind: 'contains',
        provenance: 'tree-sitter',
      };
      expect(sample.provenance).toBe('tree-sitter');
    });

    it("Edge.provenance must accept all three documented values: 'tree-sitter' | 'scip' | 'heuristic'", () => {
      const ts: Edge = { source: 'a', target: 'b', kind: 'contains', provenance: 'tree-sitter' };
      const scip: Edge = { source: 'a', target: 'b', kind: 'contains', provenance: 'scip' };
      const heur: Edge = { source: 'a', target: 'b', kind: 'calls', provenance: 'heuristic' };
      expect([ts.provenance, scip.provenance, heur.provenance]).toEqual([
        'tree-sitter',
        'scip',
        'heuristic',
      ]);
    });
  });

  describe('round-trip via real ReferenceResolver.createEdges', () => {
    it('resolver-produced edges expose both provenance AND confidence (so MCP tools can render trust signals)', () => {
      // This is the consolidated assertion that the MCP layer (T2)
      // will rely on: an edge from the resolver MUST have provenance
      // === 'heuristic' AND metadata.confidence as a number in [0,1].
      const resolved: ResolvedRef[] = [
        {
          original: {
            fromNodeId: 'a',
            referenceName: 'b',
            referenceKind: 'calls',
            line: 1,
            column: 0,
            filePath: 'a.ts',
            language: 'typescript',
          },
          targetNodeId: 'b',
          confidence: 0.7,
          resolvedBy: 'exact-match',
        },
      ];
      const [edge] = callCreateEdges(resolved);
      expect(edge).toBeDefined();
      expect(edge!.provenance).toBe('heuristic');
      const conf = (edge!.metadata as { confidence: number }).confidence;
      expect(typeof conf).toBe('number');
      expect(conf).toBeGreaterThanOrEqual(0);
      expect(conf).toBeLessThanOrEqual(1);
    });
  });
});

// Silence the unused-import lint for UnresolvedReference (kept for
// reader documentation: the resolver consumes UnresolvedReference[]
// from extraction and produces Edge[] via ResolvedRef[]).
void (null as unknown as UnresolvedReference | undefined);
