/**
 * Test suite for `normalizeToolName()` — the dispatch-time fallback that
 * auto-corrects common LLM casing mistakes.
 *
 * Some LLM models (especially Chinese domestic models) habitually convert
 * snake_case MCP tool names to PascalCase or camelCase. The normalizer
 * handles these without cluttering the tool list with duplicate aliases.
 */

import { describe, it, expect } from 'vitest';
import { normalizeToolName } from '../src/mcp/tools';

describe('normalizeToolName', () => {
  // ── Normal cases: canonical names pass through ──────────────────────

  describe('canonical names (exact match)', () => {
    const canonical = [
      'codegraph_search',
      'codegraph_context',
      'codegraph_callers',
      'codegraph_callees',
      'codegraph_impact',
      'codegraph_node',
      'codegraph_explore',
      'codegraph_status',
      'codegraph_files',
      'codegraph_usage',
      'codegraph_docs',
    ];

    for (const name of canonical) {
      it(`returns "${name}" unchanged`, () => {
        expect(normalizeToolName(name)).toBe(name);
      });
    }
  });

  // ── PascalCase mistakes (common with Chinese domestic models) ───────

  describe('PascalCase → snake_case', () => {
    it('CodegraphSearch → codegraph_search', () => {
      expect(normalizeToolName('CodegraphSearch')).toBe('codegraph_search');
    });

    it('CodegraphContext → codegraph_context', () => {
      expect(normalizeToolName('CodegraphContext')).toBe('codegraph_context');
    });

    it('CodegraphCallers → codegraph_callers', () => {
      expect(normalizeToolName('CodegraphCallers')).toBe('codegraph_callers');
    });

    it('CodegraphCallees → codegraph_callees', () => {
      expect(normalizeToolName('CodegraphCallees')).toBe('codegraph_callees');
    });

    it('CodegraphImpact → codegraph_impact', () => {
      expect(normalizeToolName('CodegraphImpact')).toBe('codegraph_impact');
    });

    it('CodegraphNode → codegraph_node', () => {
      expect(normalizeToolName('CodegraphNode')).toBe('codegraph_node');
    });

    it('CodegraphExplore → codegraph_explore', () => {
      expect(normalizeToolName('CodegraphExplore')).toBe('codegraph_explore');
    });

    it('CodegraphStatus → codegraph_status', () => {
      expect(normalizeToolName('CodegraphStatus')).toBe('codegraph_status');
    });

    it('CodegraphFiles → codegraph_files', () => {
      expect(normalizeToolName('CodegraphFiles')).toBe('codegraph_files');
    });

    it('CodegraphUsage → codegraph_usage', () => {
      expect(normalizeToolName('CodegraphUsage')).toBe('codegraph_usage');
    });

    it('CodegraphDocs → codegraph_docs', () => {
      expect(normalizeToolName('CodegraphDocs')).toBe('codegraph_docs');
    });
  });

  // ── camelCase mistakes (less common but still needs handling) ───────

  describe('camelCase → snake_case', () => {
    it('codegraphSearch → codegraph_search', () => {
      expect(normalizeToolName('codegraphSearch')).toBe('codegraph_search');
    });

    it('codegraphContext → codegraph_context', () => {
      expect(normalizeToolName('codegraphContext')).toBe('codegraph_context');
    });
  });

  // ── Non-existent tools → null ───────────────────────────────────────

  describe('non-existent names return null', () => {
    it('returns null for completely unknown name', () => {
      expect(normalizeToolName('SomeOtherTool')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(normalizeToolName('')).toBeNull();
    });

    it('returns null for "codegraph" only', () => {
      expect(normalizeToolName('codegraph')).toBeNull();
    });

    it('returns null for "CodeGraph" only', () => {
      expect(normalizeToolName('CodeGraph')).toBeNull();
    });

    it('returns null for random string', () => {
      expect(normalizeToolName('blargle_flargle')).toBeNull();
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles CodeGraphSearch (capital G in prefix)', () => {
      expect(normalizeToolName('CodeGraphSearch')).toBe('codegraph_search');
    });

    it('handles Codegraph_Callers (mixed case with underscore)', () => {
      expect(normalizeToolName('Codegraph_Callers')).toBe('codegraph_callers');
    });
  });
});
