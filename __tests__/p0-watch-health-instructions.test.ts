/**
 * P0 / T4 — `buildServerInstructions` watch-health diagnostic.
 *
 * Validates the dynamic build path that runs at MCP `initialize` time:
 *
 *   • watch enabled (no reason)         → returns the static playbook
 *                                          unchanged
 *   • watch disabled (any reason)       → appends a "## ⚠️ Index Sync
 *                                          Status" section quoting the
 *                                          exact reason
 *   • projectRoot not yet known         → static playbook (no false
 *                                          alarm — agent can still call
 *                                          codegraph_status mid-session)
 *   • watchReasonOverride === null      → forces "watch is enabled" path
 *                                          regardless of project root
 *
 * Tests inject `watchReasonOverride` so they never touch real env vars
 * or the WSL detector — keeps the suite hermetic and fast.
 *
 * 8 cases: 3 normal + 3 boundary + 2 exception per dev-baseline §4.
 */

import { describe, it, expect } from 'vitest';
import {
  SERVER_INSTRUCTIONS,
  buildServerInstructions,
} from '../src/mcp/server-instructions';

describe('P0/T4 — buildServerInstructions watch-health diagnostic', () => {
  describe('watch is enabled (no reason)', () => {
    it('happy: no projectRoot + no override → returns the static playbook unchanged', () => {
      const out = buildServerInstructions();
      // The strongest assertion is byte-for-byte identity with the
      // baseline; the dynamic warning section never gets appended in
      // this path. We deliberately do NOT also check `not.toContain('⚠️')`
      // because the baseline now embeds ⚠️ inside the Mandatory Rules
      // section (T5) — a substring match would over-trigger.
      expect(out).toBe(SERVER_INSTRUCTIONS);
      expect(out).not.toContain('## ⚠️ Index Sync Status');
    });

    it('happy: projectRoot present + watch enabled (override = null) → static playbook unchanged', () => {
      const out = buildServerInstructions({
        projectRoot: '/some/healthy/repo',
        watchReasonOverride: null,
      });
      expect(out).toBe(SERVER_INSTRUCTIONS);
      expect(out).not.toContain('Index Sync Status');
    });

    it('happy: undefined projectRoot still works without throwing (defensive)', () => {
      const out = buildServerInstructions({ projectRoot: undefined });
      expect(out).toBe(SERVER_INSTRUCTIONS);
    });
  });

  describe('watch is disabled (reason present)', () => {
    it('appends a "## ⚠️ Index Sync Status" section quoting the disabled reason verbatim', () => {
      const reason =
        'project is on a WSL2 /mnt/ drive, where recursive fs.watch is too slow to be reliable';
      const out = buildServerInstructions({
        projectRoot: '/mnt/c/repo',
        watchReasonOverride: reason,
      });

      // The static playbook must remain at the top (cache-friendly prefix).
      expect(out.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
      // The dynamic section must appear AFTER the static text, with a
      // clearly-marked header so agents recognize it as a runtime warning.
      expect(out).toContain('## ⚠️ Index Sync Status');
      // The exact reason is quoted so the agent can act on it.
      expect(out).toContain(reason);
      // Action items are present so the agent has a clear next step.
      expect(out).toContain('codegraph sync');
      expect(out).toContain('codegraph_status');
    });

    it('boundary: short reason ("env var") still produces a complete warning section', () => {
      const out = buildServerInstructions({
        projectRoot: '/somewhere',
        watchReasonOverride: 'CODEGRAPH_NO_WATCH=1 is set',
      });
      expect(out).toContain('## ⚠️ Index Sync Status');
      expect(out).toContain('CODEGRAPH_NO_WATCH=1');
      expect(out).toContain('snapshot');
    });

    it('boundary: very long reason text is included verbatim, not truncated', () => {
      const longReason = 'X'.repeat(500);
      const out = buildServerInstructions({
        projectRoot: '/anywhere',
        watchReasonOverride: longReason,
      });
      expect(out).toContain(longReason);
      expect(out.indexOf(longReason)).toBeGreaterThan(SERVER_INSTRUCTIONS.length);
    });
  });

  describe('static playbook integrity', () => {
    it('SERVER_INSTRUCTIONS still includes the documented tool-selection table (no regression on baseline content)', () => {
      // The base text is what every legacy importer sees. Pin a few key
      // anchors so a future refactor of buildServerInstructions can't
      // accidentally hollow out the static playbook.
      expect(SERVER_INSTRUCTIONS).toContain('codegraph_search');
      expect(SERVER_INSTRUCTIONS).toContain('codegraph_context');
      expect(SERVER_INSTRUCTIONS).toContain('codegraph_callers');
      expect(SERVER_INSTRUCTIONS).toContain('codegraph_callees');
      expect(SERVER_INSTRUCTIONS).toContain('codegraph_impact');
      expect(SERVER_INSTRUCTIONS).toContain("Don't grep first");
    });
  });

  describe('exception: unusual inputs', () => {
    it('empty options object behaves the same as no argument', () => {
      expect(buildServerInstructions({})).toBe(SERVER_INSTRUCTIONS);
    });

    it('explicit null override for non-empty projectRoot suppresses runtime probing', () => {
      // This is the fast path used by tests / callers that have already
      // determined watch is healthy — we should NOT consult
      // watchDisabledReason() in that case (the override wins).
      const out = buildServerInstructions({
        projectRoot: '/mnt/c/repo', // would normally trigger WSL warning
        watchReasonOverride: null, // but we explicitly say "no reason"
      });
      expect(out).toBe(SERVER_INSTRUCTIONS);
    });
  });
});
