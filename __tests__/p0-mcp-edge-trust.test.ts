/**
 * P0 / T2 — MCP tool edge-trust output.
 *
 * Validates the unit-level helpers that power the new "trust tag"
 * column in `formatNodeList` (used by `codegraph_callers` /
 * `codegraph_callees`) and the trust-summary line in `formatImpact`
 * (used by `codegraph_impact`).
 *
 * The 8 cases below cover all branches of `_internal_formatEdgeTag` and
 * `_internal_readEdgeConfidence`:
 *   • happy: tree-sitter / scip → '[ast]'
 *   • happy: heuristic with high confidence → '[heur 0.85]'
 *   • boundary: confidence == threshold (0.7) → no warning
 *   • boundary: confidence just below threshold → warning emoji present
 *   • boundary: confidence == 0 / 1 → both clamped values accepted
 *   • exception: heuristic without confidence → '[heur ?]'
 *   • exception: malformed metadata.confidence (not a number) → null
 *   • exception: undefined edge → ''
 *
 * Companion tests for the integration path (real handler → real DB
 * round-trip → text result) live in
 * `__tests__/p0-mcp-edge-trust-integration.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  _internal_CONFIDENCE_LOW_THRESHOLD,
  _internal_readEdgeConfidence,
  _internal_formatEdgeTag,
} from '../src/mcp/tools';
import type { Edge } from '../src/types';

function mkEdge(partial: Partial<Edge>): Edge {
  return {
    source: 's',
    target: 't',
    kind: 'calls',
    ...partial,
  };
}

describe('P0/T2 — MCP edge-trust helpers', () => {
  describe('_internal_readEdgeConfidence', () => {
    it('happy: returns the numeric confidence stored in metadata', () => {
      const e = mkEdge({ metadata: { confidence: 0.85, resolvedBy: 'exact-match' } });
      expect(_internal_readEdgeConfidence(e)).toBe(0.85);
    });

    it('boundary: accepts confidence at the [0,1] range endpoints', () => {
      expect(_internal_readEdgeConfidence(mkEdge({ metadata: { confidence: 0 } }))).toBe(0);
      expect(_internal_readEdgeConfidence(mkEdge({ metadata: { confidence: 1 } }))).toBe(1);
    });

    it('exception: returns null for missing / malformed metadata', () => {
      expect(_internal_readEdgeConfidence(undefined)).toBeNull();
      expect(_internal_readEdgeConfidence(mkEdge({}))).toBeNull(); // no metadata
      expect(_internal_readEdgeConfidence(mkEdge({ metadata: {} }))).toBeNull();
      expect(_internal_readEdgeConfidence(mkEdge({ metadata: { confidence: 'high' } }))).toBeNull();
      expect(_internal_readEdgeConfidence(mkEdge({ metadata: { confidence: -0.5 } }))).toBeNull();
      expect(_internal_readEdgeConfidence(mkEdge({ metadata: { confidence: 1.5 } }))).toBeNull();
      expect(_internal_readEdgeConfidence(mkEdge({ metadata: { confidence: NaN } }))).toBeNull();
    });
  });

  describe('_internal_formatEdgeTag', () => {
    it('happy: tree-sitter and scip provenance render as [ast]', () => {
      expect(_internal_formatEdgeTag(mkEdge({ provenance: 'tree-sitter' }))).toBe(' [ast]');
      expect(_internal_formatEdgeTag(mkEdge({ provenance: 'scip' }))).toBe(' [ast]');
    });

    it('happy: heuristic with high confidence renders as [heur 0.85]', () => {
      const e = mkEdge({
        provenance: 'heuristic',
        metadata: { confidence: 0.85, resolvedBy: 'exact-match' },
      });
      expect(_internal_formatEdgeTag(e)).toBe(' [heur 0.85]');
    });

    it('boundary: confidence equal to threshold renders WITHOUT warning emoji', () => {
      const e = mkEdge({
        provenance: 'heuristic',
        metadata: { confidence: _internal_CONFIDENCE_LOW_THRESHOLD },
      });
      const tag = _internal_formatEdgeTag(e);
      expect(tag).toContain('0.70');
      expect(tag).not.toContain('⚠️');
    });

    it('boundary: confidence just below threshold renders WITH warning emoji', () => {
      const e = mkEdge({
        provenance: 'heuristic',
        metadata: { confidence: _internal_CONFIDENCE_LOW_THRESHOLD - 0.01 },
      });
      const tag = _internal_formatEdgeTag(e);
      expect(tag).toContain('0.69');
      expect(tag).toContain('⚠️');
    });

    it('exception: heuristic edge without confidence renders [heur ?] as a smell signal', () => {
      const e = mkEdge({ provenance: 'heuristic' });
      expect(_internal_formatEdgeTag(e)).toBe(' [heur ?]');
    });

    it('exception: undefined edge returns empty string so callers can concatenate unconditionally', () => {
      expect(_internal_formatEdgeTag(undefined)).toBe('');
    });

    it('exception: edge with unknown provenance falls through to heuristic-style display', () => {
      // Defensive: types declare provenance must be one of three strings,
      // but the runtime DB layer reads `as Edge['provenance']` from a
      // raw string column — a future schema drift could leak unexpected
      // values. Confirm we don't crash and we treat them like heuristic.
      const e = mkEdge({
        provenance: 'unknown-future-value' as unknown as Edge['provenance'],
        metadata: { confidence: 0.5 },
      });
      const tag = _internal_formatEdgeTag(e);
      expect(tag).toContain('0.50');
      expect(tag).toContain('⚠️'); // 0.5 < 0.7 threshold
    });
  });
});
