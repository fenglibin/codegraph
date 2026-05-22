/**
 * P0 / T5 — SERVER_INSTRUCTIONS Mandatory Rules section.
 *
 * The Mandatory Rules section (added in T5) carries codegraph's *strong*
 * usage rules in both English and Chinese, targeted at LLMs that are
 * not fine-tuned on codegraph (DeepSeek / Qwen / GLM / etc.) and tend
 * to fall back to grep / Read out of training-data habit.
 *
 * Tests verify:
 *   • Section header is present and prominent ("🚫 Mandatory Rules /
 *     强制规则") so agents recognize it as a hard rule block, not a
 *     soft suggestion.
 *   • All 5 numbered rules appear in BOTH English and Chinese (parity).
 *   • Each rule's actionable verb is mandatory-strength
 *     ("NEVER" / "绝不"), not advisory ("don't" / "请不要").
 *   • The section sits BEFORE "Tool selection by intent" so the rules
 *     are read first.
 *   • Total instructions length stayed within a reasonable budget (we
 *     don't want token cost to balloon: ≤ 6000 chars baseline).
 *
 * 8 cases: 4 normal + 2 boundary + 2 exception per dev-baseline §4.
 */

import { describe, it, expect } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';

describe('P0/T5 — Mandatory Rules section in SERVER_INSTRUCTIONS', () => {
  describe('section presence and structure', () => {
    it('happy: contains the bilingual section header "🚫 Mandatory Rules / 强制规则"', () => {
      expect(SERVER_INSTRUCTIONS).toContain('## 🚫 Mandatory Rules / 强制规则');
    });

    it('happy: section header sits BEFORE "Tool selection by intent" so rules are read first', () => {
      const rulesIdx = SERVER_INSTRUCTIONS.indexOf('🚫 Mandatory Rules');
      const toolSelectIdx = SERVER_INSTRUCTIONS.indexOf('## Tool selection by intent');
      expect(rulesIdx).toBeGreaterThan(0);
      expect(toolSelectIdx).toBeGreaterThan(rulesIdx);
    });

    it('happy: section header sits AFTER the introductory paragraph (not at the very top, which is reserved for the project intro)', () => {
      const rulesIdx = SERVER_INSTRUCTIONS.indexOf('🚫 Mandatory Rules');
      const introIdx = SERVER_INSTRUCTIONS.indexOf(
        'Codegraph is a SQLite knowledge graph'
      );
      expect(introIdx).toBeGreaterThanOrEqual(0);
      expect(rulesIdx).toBeGreaterThan(introIdx);
    });
  });

  describe('English rules (5 numbered items)', () => {
    it('all 5 English rules use the mandatory-strength verb "NEVER"', () => {
      // We grep on the rule prefix (e.g. "1. **NEVER ") rather than a
      // free-form verb count to pin the wording — so a future edit
      // that softens any rule to "Don't" would fail this test.
      for (const n of [1, 2, 3, 4, 5]) {
        expect(SERVER_INSTRUCTIONS).toContain(`${n}. **NEVER`);
      }
    });

    it('rule 1 forbids grep for symbol lookup', () => {
      expect(SERVER_INSTRUCTIONS).toMatch(
        /1\. \*\*NEVER grep \/ find \/ Read to look up a symbol by name/
      );
    });

    it('rule 4 names the low-confidence threshold (< 0.7) so agents have a concrete cutoff', () => {
      expect(SERVER_INSTRUCTIONS).toMatch(
        /4\. \*\*NEVER trust an edge with confidence < 0\.7/
      );
    });

    it('rule 5 names the index-age stale threshold (30 minutes)', () => {
      // Note the literal "30 minutes" must match the
      // INDEX_AGE_STALE_MS constant in src/mcp/tools.ts (T3). If that
      // constant changes, both this rule text and the matching test
      // below should change in lockstep.
      expect(SERVER_INSTRUCTIONS).toMatch(/30 minutes/);
    });

    it('drift guard: rule 4 confidence threshold matches _internal_CONFIDENCE_LOW_THRESHOLD in tools.ts', async () => {
      // Cross-module consistency check. The Mandatory Rules text and
      // the runtime threshold must agree, or the LLM gets one rule
      // from instructions and a contradictory ⚠️ tag from tool output.
      // We import lazily to avoid loading the entire MCP tools module
      // at suite collection time.
      const { _internal_CONFIDENCE_LOW_THRESHOLD } = await import(
        '../src/mcp/tools'
      );
      expect(_internal_CONFIDENCE_LOW_THRESHOLD).toBe(0.7);
      expect(SERVER_INSTRUCTIONS).toContain(
        `confidence < ${_internal_CONFIDENCE_LOW_THRESHOLD}`
      );
    });

    it('drift guard: rule 5 stale-index threshold matches _internal_INDEX_AGE_STALE_MS in tools.ts', async () => {
      // P1/F4 — closes the backlog item from T5. The literal "30
      // minutes" / "30 分钟" in both English and Chinese mandatory
      // rules must equal `_internal_INDEX_AGE_STALE_MS / 60_000`. If
      // someone changes the constant to 15min or 60min, this test
      // fails and forces both rule texts to update in lockstep.
      const { _internal_INDEX_AGE_STALE_MINUTES } = await import(
        '../src/mcp/tools'
      );
      expect(_internal_INDEX_AGE_STALE_MINUTES).toBe(30);
      // English rule: "Index age: older than 30m" + "30 minutes"
      expect(SERVER_INSTRUCTIONS).toContain(
        `${_internal_INDEX_AGE_STALE_MINUTES} minutes`
      );
      // Chinese rule: "30 分钟"
      expect(SERVER_INSTRUCTIONS).toContain(
        `${_internal_INDEX_AGE_STALE_MINUTES} 分钟`
      );
    });
  });

  describe('Chinese rules (5 numbered items, parity with English)', () => {
    it('all 5 Chinese rules use the mandatory-strength verb "绝不"', () => {
      for (const n of [1, 2, 3, 4, 5]) {
        expect(SERVER_INSTRUCTIONS).toContain(`${n}. **绝不**`);
      }
    });

    it('Chinese rule 1 forbids grep for symbol lookup (parity with English rule 1)', () => {
      expect(SERVER_INSTRUCTIONS).toMatch(
        /1\. \*\*绝不\*\*用 grep \/ find \/ Read 按名查找符号/
      );
    });

    it('Chinese rule 5 names the same 30-minute stale threshold (parity with English rule 5)', () => {
      expect(SERVER_INSTRUCTIONS).toMatch(/30 分钟/);
    });
  });

  describe('budget and completeness', () => {
    it('boundary: total SERVER_INSTRUCTIONS length stays ≤ 6000 chars (token-budget guard against unchecked growth)', () => {
      // Anchor the upper bound. Current size is roughly 4500-5500 chars
      // after T5; 6000 leaves headroom for typo fixes / one more rule
      // before the suite forces a re-evaluation of the token budget.
      expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(6000);
    });

    it('boundary: total length ≥ 3000 chars (regression guard against accidental hollowing)', () => {
      // The pre-T5 baseline was ~2700 chars. If a future refactor drops
      // back below 3000, that almost certainly means the Mandatory Rules
      // section was removed by mistake.
      expect(SERVER_INSTRUCTIONS.length).toBeGreaterThanOrEqual(3000);
    });

    it('exception: section parity — both languages mention DeepSeek/Qwen/GLM as triggering models', () => {
      // The whole point of bilingual + mandatory-strength rules is to
      // reach non-Claude models. Lose the explicit model list and the
      // motivation gets harder to defend.
      expect(SERVER_INSTRUCTIONS).toContain('DeepSeek, Qwen, GLM');
      // Chinese variant — note the line break between Chinese commas
      // is allowed (the source wraps at column 80), so we use the `s`
      // flag for dot-all matching across the wrap.
      expect(SERVER_INSTRUCTIONS).toMatch(/DeepSeek、\s*Qwen、GLM/s);
    });
  });
});
