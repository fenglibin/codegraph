/**
 * P0/T6 — Installer instructions template bilingual coverage.
 *
 * Tests the `INSTRUCTIONS_TEMPLATE` shipped into every agent's
 * conventional instructions file (CLAUDE.md / AGENTS.md / codegraph.mdc /
 * etc.) by `installer/targets/*.ts`. The block now ships English first,
 * then a Chinese mirror, so non-Claude models (DeepSeek, Qwen, GLM)
 * also see the mandatory rules in their training-language register.
 *
 * The marker pair `<!-- CODEGRAPH_START/END -->` is the idempotency
 * anchor — five installers (claude, cursor, codex, opencode, codebuddy)
 * detect and replace the section via these markers. Tests below verify
 * the markers are unchanged and that the new bilingual content is
 * fully wrapped between them.
 */
import { describe, it, expect } from 'vitest';
import {
  INSTRUCTIONS_TEMPLATE,
  CLAUDE_MD_TEMPLATE,
  CODEGRAPH_SECTION_START,
  CODEGRAPH_SECTION_END,
} from '../src/installer/instructions-template';

describe('P0/T6 installer instructions bilingual template', () => {
  describe('structure invariants (idempotency)', () => {
    it('happy: markers unchanged — start and end exactly as before', () => {
      // Five installers detect+replace by exact marker match. If these
      // strings ever drift, existing user installs degrade to "append"
      // mode and the section duplicates on re-install.
      expect(CODEGRAPH_SECTION_START).toBe('<!-- CODEGRAPH_START -->');
      expect(CODEGRAPH_SECTION_END).toBe('<!-- CODEGRAPH_END -->');
    });

    it('happy: template starts with start-marker and ends with end-marker', () => {
      expect(INSTRUCTIONS_TEMPLATE.startsWith(CODEGRAPH_SECTION_START)).toBe(
        true
      );
      expect(INSTRUCTIONS_TEMPLATE.endsWith(CODEGRAPH_SECTION_END)).toBe(true);
    });

    it('happy: markers each appear exactly once (no nesting, no duplication)', () => {
      const startCount =
        INSTRUCTIONS_TEMPLATE.split(CODEGRAPH_SECTION_START).length - 1;
      const endCount =
        INSTRUCTIONS_TEMPLATE.split(CODEGRAPH_SECTION_END).length - 1;
      expect(startCount).toBe(1);
      expect(endCount).toBe(1);
    });

    it('happy: CLAUDE_MD_TEMPLATE re-export still aliases INSTRUCTIONS_TEMPLATE', () => {
      // Backwards-compat surface for older importers.
      expect(CLAUDE_MD_TEMPLATE).toBe(INSTRUCTIONS_TEMPLATE);
    });
  });

  describe('English section (preserved baseline)', () => {
    it('happy: English Mandatory rules section present with all 5 rules', () => {
      // Mirrors the SERVER_INSTRUCTIONS rule set from T5 — keep the two
      // lists in sync. We do not assert a numbered "1. **NEVER" pattern
      // because future copy-editing might split a rule across lines.
      expect(INSTRUCTIONS_TEMPLATE).toContain(
        '🚫 Mandatory rules — do NOT skip'
      );
      const neverCount = (
        INSTRUCTIONS_TEMPLATE.match(/\*\*NEVER /g) ?? []
      ).length;
      expect(neverCount).toBeGreaterThanOrEqual(5);
    });

    it('happy: English keeps the "When to prefer codegraph" intent table', () => {
      // Existing installer tests assert `codegraph_callers` is present;
      // we add the broader anchor to catch accidental table deletion.
      expect(INSTRUCTIONS_TEMPLATE).toContain(
        'When to prefer codegraph over native search'
      );
      expect(INSTRUCTIONS_TEMPLATE).toContain('codegraph_callers');
      expect(INSTRUCTIONS_TEMPLATE).toContain('codegraph_explore');
      expect(INSTRUCTIONS_TEMPLATE).toContain('codegraph_status');
    });

    it('happy: English keeps the "If .codegraph/ doesn\'t exist" fallback prompt', () => {
      expect(INSTRUCTIONS_TEMPLATE).toContain('not initialized');
      expect(INSTRUCTIONS_TEMPLATE).toContain('codegraph init -i');
    });
  });

  describe('Chinese mirror section (new in T6)', () => {
    it('happy: Chinese section appears after English and has its own heading', () => {
      // Heading is `## CodeGraph（中文）`; the parens are full-width
      // so an ASCII "(" would miss. Match exactly.
      expect(INSTRUCTIONS_TEMPLATE).toContain('## CodeGraph（中文）');
      // Order: English `## CodeGraph` must come before Chinese mirror.
      const enIdx = INSTRUCTIONS_TEMPLATE.indexOf('## CodeGraph\n');
      const zhIdx = INSTRUCTIONS_TEMPLATE.indexOf('## CodeGraph（中文）');
      expect(enIdx).toBeGreaterThanOrEqual(0);
      expect(zhIdx).toBeGreaterThan(enIdx);
    });

    it('happy: Chinese Mandatory rules section present with all 5 "绝不" rules', () => {
      expect(INSTRUCTIONS_TEMPLATE).toContain('🚫 强制规则');
      // Each rule starts with `**绝不**`. Five mandatory rules → at
      // least five matches. Using `g` flag for global count.
      const juebuCount = (
        INSTRUCTIONS_TEMPLATE.match(/\*\*绝不\*\*/g) ?? []
      ).length;
      expect(juebuCount).toBeGreaterThanOrEqual(5);
    });

    it('happy: Chinese section names the same trigger models as English', () => {
      // DeepSeek/Qwen/GLM appear in both languages to explain *why* the
      // rules are mandatory rather than suggestions. If either side
      // drops the list, the motivation gets harder to defend. Note
      // the source wraps at column 80, so `DeepSeek、Qwen、GLM` may
      // straddle a newline — match with the `s` flag for dot-all.
      expect(INSTRUCTIONS_TEMPLATE).toMatch(/DeepSeek、\s*Qwen、\s*GLM/s);
    });

    it('happy: Chinese section covers the "未初始化" fallback prompt', () => {
      // The Chinese fallback prompt mirrors the English one so users
      // operating in CN locales also see the actionable hint.
      expect(INSTRUCTIONS_TEMPLATE).toContain('codegraph init -i');
      expect(INSTRUCTIONS_TEMPLATE).toContain('要我运行');
    });

    it('happy: Chinese section ships its own "问题 / 工具" decision table mirroring the English one', () => {
      // Without a Chinese-side decision table, CN-locale models that
      // anchor to the Chinese mirror lose the fastest "question →
      // codegraph_<verb>" mapping and tend to fall back to grep/Read
      // by training-data habit. The English table lists 9 mappings;
      // we assert the Chinese mirror covers all 9 codegraph tools so
      // the two languages stay in lockstep on tool coverage.
      expect(INSTRUCTIONS_TEMPLATE).toContain('| 问题 | 工具 |');
      const zhTableTools = [
        'codegraph_search',
        'codegraph_callers',
        'codegraph_callees',
        'codegraph_impact',
        'codegraph_node',
        'codegraph_context',
        'codegraph_explore',
        'codegraph_files',
        'codegraph_status',
      ];
      // Slice from the Chinese heading onwards so we only count
      // occurrences inside the Chinese section, not the English one.
      const zhStart = INSTRUCTIONS_TEMPLATE.indexOf('## CodeGraph（中文）');
      expect(zhStart).toBeGreaterThan(0);
      const zhSection = INSTRUCTIONS_TEMPLATE.slice(zhStart);
      for (const tool of zhTableTools) {
        expect(zhSection).toContain(tool);
      }
    });
  });

  describe('drift guard: rules track the runtime thresholds', () => {
    it('rule 4 mentions confidence < 0.7 in both languages', () => {
      // T2 constant. If `_internal_CONFIDENCE_LOW_THRESHOLD` changes,
      // both the English and Chinese sections must update. We assert
      // the EN literal here; the deeper cross-module drift guard lives
      // in p0-mandatory-rules.test.ts because that one can import the
      // constant from tools.ts.
      expect(INSTRUCTIONS_TEMPLATE).toContain('confidence < 0.7');
      expect(INSTRUCTIONS_TEMPLATE).toContain('置信度 < 0.7');
    });

    it('rule 5 mentions the 30-minute stale threshold in both languages', () => {
      // T3 constant. Same lockstep rule as above.
      expect(INSTRUCTIONS_TEMPLATE).toContain('over 30 minutes');
      expect(INSTRUCTIONS_TEMPLATE).toContain('30 分钟');
    });

    it('drift guard (P1.1): rule 5 minute count matches _internal_INDEX_AGE_STALE_MS in tools.ts', async () => {
      // Closes the same P1 backlog entry as the SERVER_INSTRUCTIONS
      // drift guard. The installer template must mention the same
      // minute count the runtime constant defines, in BOTH languages,
      // so re-installing on stale-threshold changes keeps users in
      // sync without manual edits.
      const { _internal_INDEX_AGE_STALE_MINUTES } = await import(
        '../src/mcp/tools'
      );
      expect(_internal_INDEX_AGE_STALE_MINUTES).toBe(30);
      expect(INSTRUCTIONS_TEMPLATE).toContain(
        `over ${_internal_INDEX_AGE_STALE_MINUTES} minutes`
      );
      expect(INSTRUCTIONS_TEMPLATE).toContain(
        `${_internal_INDEX_AGE_STALE_MINUTES} 分钟`
      );
    });
  });

  describe('exception: budget guard', () => {
    it('total template length stays within a reasonable per-project budget', () => {
      // The template is appended to every agent instructions file the
      // installer touches. Doubling its size by adding the Chinese
      // mirror is intentional, but we still want a ceiling so future
      // edits don't drift into runaway prose.
      expect(INSTRUCTIONS_TEMPLATE.length).toBeLessThan(8000);
      // And a floor — if someone accidentally deletes the Chinese
      // section, the template will halve. Catch that here.
      expect(INSTRUCTIONS_TEMPLATE.length).toBeGreaterThan(3000);
    });
  });
});
