/**
 * Tests for `shouldAskAutoAllow()` pure helper.
 *
 * Covers:
 *  - normal: only Claude selected → prompt
 *  - boundary: Claude + CodeBuddy → no prompt
 *  - boundary: only CodeBuddy → no prompt
 *  - boundary: empty targets → no prompt
 *  - edge: opts.autoAllow set → no prompt (caller pre-set)
 *  - edge: useDefaults = true → no prompt (non-interactive)
 */
import { describe, it, expect } from 'vitest';
import { shouldAskAutoAllow } from '../src/installer/index';
import type { AgentTarget, RunInstallerOptions } from '../src/installer/targets/types';

function makeTarget(id: string): AgentTarget {
  return { id } as unknown as AgentTarget;
}

function makeOpts(autoAllow?: boolean): RunInstallerOptions {
  return { autoAllow };
}

describe('shouldAskAutoAllow', () => {
  // ── normal ────────────────────────────────────────────────
  it('normal: only Claude selected → should prompt', () => {
    const targets = [makeTarget('claude')];
    const result = shouldAskAutoAllow(targets, false, makeOpts());
    expect(result).toBe(true);
  });

  // ── boundary ───────────────────────────────────────────────
  it('boundary: Claude + CodeBuddy selected → should NOT prompt', () => {
    const targets = [makeTarget('claude'), makeTarget('codebuddy')];
    const result = shouldAskAutoAllow(targets, false, makeOpts());
    expect(result).toBe(false);
  });

  it('boundary: only CodeBuddy selected → should NOT prompt', () => {
    const targets = [makeTarget('codebuddy')];
    const result = shouldAskAutoAllow(targets, false, makeOpts());
    expect(result).toBe(false);
  });

  it('boundary: empty targets → should NOT prompt', () => {
    const targets: AgentTarget[] = [];
    const result = shouldAskAutoAllow(targets, false, makeOpts());
    expect(result).toBe(false);
  });

  it('boundary: three targets including Claude → should NOT prompt', () => {
    const targets = [makeTarget('claude'), makeTarget('cursor'), makeTarget('codex')];
    const result = shouldAskAutoAllow(targets, false, makeOpts());
    expect(result).toBe(false);
  });

  // ── edge: opts.autoAllow pre-set ─────────────────────────
  it('edge: opts.autoAllow=true → should NOT prompt (caller forced)', () => {
    const targets = [makeTarget('claude')];
    const result = shouldAskAutoAllow(targets, false, makeOpts(true));
    expect(result).toBe(false);
  });

  it('edge: opts.autoAllow=false → should NOT prompt (caller forced)', () => {
    const targets = [makeTarget('claude')];
    const result = shouldAskAutoAllow(targets, false, makeOpts(false));
    expect(result).toBe(false);
  });

  // ── edge: useDefaults = true ──────────────────────────────
  it('edge: useDefaults=true → should NOT prompt (non-interactive)', () => {
    const targets = [makeTarget('claude')];
    const result = shouldAskAutoAllow(targets, true, makeOpts());
    expect(result).toBe(false);
  });

  // ── extra: other single-target cases ──────────────────────
  it('extra: only cursor selected → should NOT prompt', () => {
    const targets = [makeTarget('cursor')];
    const result = shouldAskAutoAllow(targets, false, makeOpts());
    expect(result).toBe(false);
  });

  it('extra: only codex selected → should NOT prompt', () => {
    const targets = [makeTarget('codex')];
    const result = shouldAskAutoAllow(targets, false, makeOpts());
    expect(result).toBe(false);
  });
});
