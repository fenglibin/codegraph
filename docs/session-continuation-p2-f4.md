# Session continuation — codegraph P2 F-4 (smart stale detection)

> **Purpose**: Self-contained briefing for a NEW AI session continuing
> codegraph work. Read top-to-bottom before ANY action.
>
> **Project**: `codegraph` at `/Users/fenglibin/data/code/opensource/codegraph/`
>
> **Current state**: All P0+P1 completed + committed. OpenSpec archived.
> CHANGELOG 0.10.1 written but NOT committed. Next task: **P2 F-4 —
> git-based smart index staleness** (design approved, not started).

---

## 0. Hard rules — read FIRST

### 0.1 Workflow (mandatory)

1. **dev-workflow stage 4.5 closure loop** for every todo: ① 10-dim deep
   self-check → ② 17 redline scan → ③ write tests ≥3 cases (happy/boundary/
   exception) → ④ local regression → ⑤ task close checklist.
2. **Quality > speed**. Don't batch-verify — each todo closes before next starts.
3. **`npm test` before declaring done**. Don't skip.

### 0.2 No git commit without explicit user instruction

User reviews + commits manually. Never: `git commit`, `git push`, `git stash
drop`, `openspec archive`. You MAY: `git status`, `git diff`, non-destructive
experiments.

### 0.3 Node 22 required

Export PATH before running tests:
```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

---

## 1. Project context — codegraph in 2 paragraphs

A code-intelligence MCP server. Indexes source files into a SQLite knowledge
graph (nodes=symbols, edges=relationships). Exposes 9 MCP tools. Installed on
Claude Code, Cursor, Codex, opencode, CodeBuddy IDE via 5 installer targets.

Tech: TypeScript/Node.js, better-sqlite3, tree-sitter, vitest.
Build: `npm run build`. Test: `npm test`.

---

## 2. Completed work (everything before this session)

| What | When | Status |
|---|---|---|
| P0 T1-T6 + P1 (LLM trust signals) | 2026-05-22 | ✅ Committed (`709c2c9`) |
| OpenSpec archive (2 changes → capabilities) | 2026-05-22 | ✅ Committed |
| C path — watcher test abortController fix | 2026-05-22 | ✅ Committed (`e031f4e`) |
| A path — CHANGELOG 0.10.1 + version bump | 2026-05-22 | ⚠️ NOT committed |

### 2.1 What P0 did (trust signals)

Every MCP tool response now includes:
- `[tree-sitter, conf:0.95]` / `[heuristic, conf:0.6 ⚠️]` per symbol
- `Index updated N minutes ago` footer at end
- Watcher health on MCP initialize
- 5 English `NEVER` + 5 Chinese `绝不` rules in instructions

### 2.2 What C path did (watcher test fix)

`__tests__/watcher.test.ts`: `waitFor` helper now accepts optional `AbortSignal`
to stop recursive `setTimeout` chains on test teardown — eliminates spurious
`database is not open` unhandled error. 3 new waitFor unit tests added.
5 fs.watch integration tests remain inherently flaky on macOS (kqueue).

### 2.3 What A path did (CHANGELOG)

CHANGELOG written as `[0.10.1] - 2026-05-22` with 3 entries: LLM trust
signals, CodeBuddy IDE support, watcher test fix. NOT committed.

### 2.4 Uncommitted files (user edits)

```
 M CHANGELOG.md       (0.10.1 section written by AI)
 M README.md          (user manual edits)
 M package.json       (version 0.10.1, name @xuefadevdev/codegraph — user set)
 M package-lock.json  (auto)
```

---

## 3. Key invariants — DO NOT BREAK

### 3.1 `Edge.provenance` — every new edge MUST stamp it

Every `edges.push({...})` must include `provenance: 'tree-sitter' | 'heuristic' | 'scip'`.
NULL allowed only for pre-T1 legacy rows.

### 3.2 `CODERAPH_START/END` markers — byte-exact

In `src/installer/instructions-template.ts`, these markers are sacred.
Changing 1 byte causes re-install duplication. Guarded by `p0-installer-bilingual.test.ts`.

### 3.3 `_internal_*` convention

Constants exported solely for testing use `_internal_` prefix:
```ts
export const _internal_INDEX_AGE_STALE_MS = 30 * 60 * 1000;
export const _internal_CONFIDENCE_LOW_THRESHOLD = 0.7;
```
Cross-module drift guards import these to verify text matches.

### 3.4 Footer injection centralized

`ToolHandler.execute()` is the SOLE footer injection point.
`TOOLS_SKIP_INDEX_AGE = new Set(['codegraph_status'])` lists exemptions.

### 3.5 Backwards-compat fixture

`__tests__/p0-context-json-edge-trust.test.ts:101` deliberately constructs an
Edge WITHOUT provenance. Do NOT "fix" it.

### 3.6 Test suite known noise

5 fs.watch integration tests in `__tests__/watcher.test.ts` flaky on macOS.
Documented in `docs/changes/watcher-test-flaky-fix.md`.
Verify isolation: `npx vitest run __tests__/watcher.test.ts` → 15/15 ✅.

---

## 4. Current task: F-4 — git-based smart index staleness

### 4.1 What problem it solves

P0 added "⚠️ Index updated 47 minutes ago" footer — warns the LLM but doesn't
change behavior. The 30-minute threshold is a **blind timer** — a project
that hasn't changed in 3 hours has a perfectly valid index, but P0 still warns.

F-4 replaces the blind timer with **git-aware staleness**:

```
git HEAD commit time > maxIndexedAt → "⚠️ Git has commits newer than this index"
otherwise                         → "✓ Indexed N minutes ago"
```

### 4.2 What it does NOT do

- Does NOT reject/block queries
- Does NOT require user interaction
- The LLM sees the enhanced footer and decides to `codegraph sync` autonomously
  (already instructed to do so by P0 T5's bilingual rule #4)

### 4.3 How it works

```
ToolHandler.execute(toolName, args):
  1. Normal dispatch → get result
  2. cg.getMaxIndexedAt() → maxIndexedAt (already exists from P0 T3)
  3. cg.getLastGitCommitTime() → gitTime (NEW)
  4. If gitTime > maxIndexedAt → footer warns about git commits
     Elif !gitTime && age > 30min → footer warns about staleness (fallback)
     Else → normal freshness footer
```

### 4.4 Files to change (estimated ~100 lines total)

| File | What | Lines |
|---|---|---|
| `src/index.ts` | Add `getLastGitCommitTime(projectRoot): number | null` — `git log -1 --format=%ct`, parse to ms, try/catch with null fallback | ~15 |
| `src/mcp/tools.ts` | Modify `_internal_formatIndexAgeFooter()` to accept `gitHeadTime?: number` param, decision logic: gitHeadTime > maxIndexedAt → "Git commits after this index" | ~30 |
| `src/mcp/server-instructions.ts` | Strengthen rule #4: explicitly tell LLMs "run `codegraph sync` before relying on stale data when footer says Git commits after index" | ~5 |
| `__tests__/p0-index-age-footer.test.ts` | Add test cases: (a) git commits newer → specific footer, (b) git head == index time → fresh footer, (c) no git repo → fallback to timer footer | ~50 |

### 4.5 Design decisions (pre-approved by user)

1. **Git-based, not timer-based**. Staleness = "code changed since last index",
   not "time passed since last index".
2. **No rejection**. AI sees footer, decides to sync autonomously. Zero user
   friction.
3. **Graceful fallback**. If `git` command fails (non-git project / git not
   installed), falls back to existing 30-minute timer.
4. **Tool-level injection**. Footer logic stays in `ToolHandler.execute()`,
   same centralized pattern as P0 T3.

### 4.6 Before coding

Read these files for context:
1. `src/mcp/tools.ts` — `_internal_formatIndexAgeFooter`, `execute()`, `TOOLS_SKIP_INDEX_AGE`
2. `src/index.ts` — `getMaxIndexedAt()` (already exists)
3. `src/mcp/server-instructions.ts` — `buildServerInstructions()`, bilingual rules
4. `__tests__/p0-index-age-footer.test.ts` — existing test patterns

---

## 5. Useful commands

```bash
# Build
npm run build

# Full test suite
npm test

# P0 tests only
npx vitest run __tests__/p0-*.test.ts

# Watcher tests (for known-noise verification)
npx vitest run __tests__/watcher.test.ts

# Lint / type check
npx tsc -p ./tsconfig.json --noEmit
```

---

## 6. First action checklist for new session

Before ANY work:

- [ ] Read this entire file.
- [ ] Run `git status --short` — confirm uncommitted files match §2.4.
- [ ] Run `npm test` — confirm baseline (expected: ~840 tests, 5 known watcher
      noise ﻿failures, 0 other failures).
- [ ] Confirm user wants to proceed with F-4 (design is pre-approved in this
      document, but user may have changed their mind).

Then for F-4 implementation:
1. Read files listed in §4.6 for context.
2. Implement in order: `src/index.ts` → `src/mcp/tools.ts` →
   `src/mcp/server-instructions.ts` → tests.
3. Each step passes dev-workflow 4.5 closure: deep self-check → redline scan →
   write tests ≥3 cases → regression → close.
4. P0 tests must stay 85/85 passing throughout.

---

## 7. Authorship

- **Generated**: 2026-05-22 20:39, end of a session that completed C path
  (watcher test fix) + A path (CHANGELOG 0.10.1) + F-4 design review.
- **Next session resumes from**: §4 — implement F-4 git-based smart staleness.