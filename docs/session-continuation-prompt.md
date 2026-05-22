# Session continuation prompt — codegraph LLM trust signals (P0+P1)

> **Purpose**: This document is a self-contained briefing for a NEW
> AI assistant session that needs to continue work on this project
> without access to the prior conversation history. Read it top-to-
> bottom before taking any action.
>
> **Project**: `codegraph` — a SQLite knowledge-graph code-intelligence
> tool exposed to LLMs over MCP. Located at
> `/Users/fenglibin/data/code/opensource/codegraph/`.
>
> **Last batch completed**: P0 (T1–T6) + P1 (P1.1, P1.2, P1.4) on
> 2026-05-22 by the previous session. Code changes ON DISK but NOT
> COMMITTED. Awaiting user review + commit decision.

---

## 0. Hard rules — read these FIRST

These are user-imposed constraints that override default AI behavior.
Violating them is a critical mistake.

### 0.1 Workflow rules (mandatory, no exceptions)

1. **Use dev-workflow stage 4.5 closure loop for every todo**:
   (a) 10-dimension deep self-check, (b) 17-redline anti-laziness scan,
   (c) write tests immediately (≥3 cases: happy / boundary / exception),
   (d) local regression, (e) task-close checklist.
2. **Use 5-level pyramid for verification**: L1 compile → L2 CLI starts
   → L3 module loads → L4 real-system probe → L5 full test suite.
   Skipping L4 is the most common failure mode — DO NOT skip.
3. **Quality > speed**. "宁可慢不可乱" (rather slow than chaotic). Do
   not declare a todo "done" until the closure loop is complete.
4. **No batch verification**. Each todo passes its own closure loop
   before the next todo starts. Do NOT accumulate self-check until end.
5. **Write a 漏拦复盘 (gap-retrospective) for every todo**, even when
   nothing was found. Sample format: "Anti-laziness scan: 0 real
   triggers. Self-check found N additional issues, all fixed in-batch."

### 0.2 Anti-laziness 17 red-lines (zero tolerance)

A scan is required after each todo. Real triggers (not fixture strings,
not pre-existing baseline) must be fixed before the todo closes:

1. TODO/FIXME/XXX/HACK comments
2. Empty function bodies / `pass` placeholders
3. Mock/fake data passing as real
4. Swallowed exceptions (`catch {}`)
5. `any` / `@ts-ignore` / `@ts-expect-error` overuse
6. Short-circuit skip of validation
7. I/O without error handling / timeout
8. High-complexity functions without decomposition
9. `console.log` / `console.error` left in production code
10. Hardcoded URLs / secrets / constants
11. Test assertions copy-paste from implementation
12. **Tests pass ≠ application works** (the most insidious one — fix by
    pairing pure-function unit tests with end-to-end integration tests
    that prove the wiring)
13. Framework auto-behavior not verified
14. Framework boilerplate incomplete
15. Verification deferred to batch end
16. Cross-process references written from memory (always grep)
17. Cross-process data without explicit `stripSensitive()`
18. Character-level regex replacing real-parser verification

### 0.3 No git commits without explicit user approval

The user reviews and commits manually. Never:
- Run `git commit`
- Run `git push` (especially `--force`)
- Run `git stash drop`
- Modify `.git/` config
- Run `openspec archive` (that's a commit-class operation)

You MAY: read git status, do `git diff`, use `git stash` for non-
destructive experiments — but always restore.

### 0.4 OpenSpec is the change-record protocol

This project uses [OpenSpec](https://github.com/Fission-AI/OpenSpec)
for spec-driven development. The spec lives at `openspec/`, with:
- `openspec/AGENTS.md` — full instructions for the protocol
- `openspec/project.md` — project conventions
- `openspec/changes/<id>/{proposal,tasks,design}.md` + `specs/` —
  in-flight changes
- `openspec/specs/<capability>/spec.md` — current capabilities
  (created on archive)

Run `openspec validate <change-id> --strict` after editing any
spec/proposal. **OpenSpec parser is fragile** — `### Requirement:` first
paragraph MUST contain SHALL or MUST on the first sentence (single-
line, no wrap before SHALL/MUST appears).

---

## 1. Project context — codegraph in 2 paragraphs

**What it is**: A code-intelligence MCP server. Indexes a project's
source files into a SQLite knowledge graph (nodes = symbols, edges =
relationships). Exposes 9 MCP tools to LLM agents (`codegraph_search`,
`codegraph_callers`, `codegraph_callees`, `codegraph_impact`,
`codegraph_node`, `codegraph_explore`, `codegraph_context`,
`codegraph_files`, `codegraph_status`). Installed on Claude Code,
Cursor, Codex CLI, opencode, and CodeBuddy IDE via 5 installer targets.

**Tech stack**: TypeScript / Node.js, better-sqlite3 (with WASM
fallback), tree-sitter (with language-specific grammars), vitest,
no other heavy deps. Build = `npm run build`. Test = `npm test`.

---

## 2. P0 batch — what was done

**Goal**: Surface the trust signals codegraph already had (provenance,
confidence, freshness) to the LLM so it can distinguish AST-direct
from heuristic relationships, detect stale graphs, and follow
mandatory rules in non-Claude models.

### 2.1 P0 / T1–T6 todo list (ALL COMPLETE)

| Todo | Requirement | Status | Key output |
|---|---|---|---|
| **T1** | R2: confidence/provenance persistence | ✅ DONE | All 11 `edges.push({...})` sites + resolver `createEdges` stamp `provenance`. Tests: `p0-confidence-output.test.ts` (7) + `p0-provenance-integration.test.ts` (4 incl. P1.2). |
| **T2** | R1: confidence/provenance reach LLM | ✅ DONE | `_internal_formatEdgeTag`, `formatNodeList(edges?)`, `formatImpact` Trust line, `serializeEdge` JSON. Tests: `p0-mcp-edge-trust.test.ts` (10) + `p0-mcp-edge-trust-integration.test.ts` (4) + `p0-context-json-edge-trust.test.ts` (5). |
| **T3** | R4: index-age footer | ✅ DONE | `QueryBuilder.getMaxIndexedAt()` (cached prepared stmt) + `_internal_formatIndexAgeFooter` + `execute()` post-process injection + status-tool suppression. Tests: `p0-index-age-footer.test.ts` (14). |
| **T4** | R3: watcher-health on initialize | ✅ DONE | `buildServerInstructions(opts)` builder, `handleInitialize` calls it. Tests: `p0-watch-health-instructions.test.ts` (9) + `p0-watch-health-instructions-integration.test.ts` (2). |
| **T5** | R5: bilingual mandatory rules in SERVER_INSTRUCTIONS | ✅ DONE | 5 NEVER + 5 绝不 rules section. Tests: `p0-mandatory-rules.test.ts` (15 incl. P1.1 drift guard). |
| **T6** | R6: bilingual installer template | ✅ DONE | `INSTRUCTIONS_TEMPLATE` mirror block with `## CodeGraph（中文）` heading. Tests: `p0-installer-bilingual.test.ts` (15 incl. P1.1 drift guard). |

### 2.2 P1 backlog (resolved)

| Item | Status | Outcome |
|---|---|---|
| **P1.1** Export `INDEX_AGE_STALE_MS` + drift guard | ✅ DONE | `_internal_INDEX_AGE_STALE_MS` and `_internal_INDEX_AGE_STALE_MINUTES` exported. +2 cases across mandatory-rules + installer-bilingual tests. |
| **P1.2** vue/svelte sub-extract provenance guard | ✅ DONE | Vue + Svelte fixture in `p0-provenance-integration.test.ts` (+1 case) asserts inner classes get extracted AND distribution `{tree-sitter > 0, NULL = 0}`. |
| **P1.3** `Edge.provenance` optional → required | ❌ **WON'T-FIX** | Decision: would break pre-T1 DB backwards-compat AND invalidate `p0-context-json-edge-trust.test.ts:101` (which deliberately constructs an edge without provenance to test the legacy path). Risk is already covered by integration tests — not worth the cost. Documented in `tasks.md`. |
| **P1.4** Distill cross-project lessons | ✅ DONE | 8 lessons in CodeBuddy memory ID **66947442**; 8 project-specific notes in `docs/codegraph-engineering-notes.md`. |

### 2.3 Final tally

- **11 src files modified** (lines net +569 / -40)
- **10 test files added under `__tests__/p0-*.test.ts`** = **85 cases**
  (verify with `grep -c '  it(' __tests__/p0-*.test.ts | awk -F: '{s+=$2} END {print s}'`)
- **OpenSpec change**: `openspec/changes/add-llm-trust-signals/`
  (proposal 157 + tasks 250 + design 225 + spec deltas 263 = 895 lines,
  `openspec validate add-llm-trust-signals --strict` passes)
- **Project notes**: `docs/codegraph-engineering-notes.md` (255 lines)
- **CodeBuddy memory**: ID 66947442 (8 cross-project lessons)
- **Test count**: baseline 659 passing → current 775 passing (**+116
  net**, 0 real new failures)
- **Known noise** (NOT regressions):
  - `__tests__/watcher.test.ts` flakes on busy CI (1 fail, baseline)
  - `__tests__/extraction.test.ts` worker exit on solo run (baseline)

### 2.4 Files modified (verify with `git diff --stat`)

```
src/extraction/dfm-extractor.ts        +1   (provenance: 'tree-sitter')
src/extraction/liquid-extractor.ts     +6   (× 6 push sites)
src/extraction/svelte-extractor.ts     +1
src/extraction/tree-sitter.ts          +2   (× 2 push sites)
src/extraction/vue-extractor.ts        +1
src/resolution/index.ts                +5   (createEdges output)
src/db/queries.ts                     +26   (getMaxIndexedAt + cache)
src/index.ts                          +10   (CodeGraph.getMaxIndexedAt)
src/context/formatter.ts              +21   (serializeEdge fields)
src/mcp/tools.ts                     +325   (largest — helpers + execute refactor + handlers)
src/mcp/server-instructions.ts       +141   (Mandatory Rules + buildServerInstructions builder)
src/mcp/index.ts                      +13   (handleInitialize wiring)
src/installer/instructions-template.ts +58   (Chinese mirror block)
```

---

## 3. Open work — what could be done next (NOT prescribed)

The following are POSSIBLE directions. None is in-flight. The user
may pick one, none, or something entirely new. Do NOT start any of
these without explicit instruction.

### 3.1 Awaiting user decision (no work needed yet)

- **D-1 Commit**: User reviews `git diff` and commits the P0+P1 batch.
  Likely as a single squash commit or a sequence (1 per T-todo).
  AI must NOT commit autonomously.
- **D-2 OpenSpec archive**: After commit, `openspec archive
  add-llm-trust-signals` moves the change to `openspec/changes/
  archive/YYYY-MM-DD-add-llm-trust-signals/` and updates
  `openspec/specs/`. Same story for `add-codebuddy-installer-target`
  (also pending in `openspec/changes/`, completed but not archived).
- **D-3 Release**: Bump version (currently 0.9.2 — see
  `package.json`), update `CHANGELOG.md`, npm publish. AI must NOT
  publish autonomously.

### 3.2 Identified follow-up work (potential P2 batch)

These came up during P0 self-check but are out of P0 scope. Listed
for the user's consideration, not for AI to start without sign-off:

- **F-1 SCIP integration** — `Edge.provenance` reserves `'scip'` but
  no SCIP importer exists yet. The shape is ready for it.
- **F-2 Dashboard / metrics view** — index age, provenance
  distribution, low-confidence-edge ratio could surface in a
  dashboard tool. Requires new MCP tool design.
- **F-3 Confidence calibration** — `name-matcher.ts` confidence is
  derived from heuristic tiers (exact / namespace / fuzzy). Could be
  improved by signal-fusion (call-site context, type info, etc.).
  Out of scope for trust-surfacing; this is R&D.
- **F-4 Auto-stale rejection** — currently the >30m footer just warns
  the LLM. Could optionally auto-reject queries when stale. Decided
  against in P0 (some users disable watcher intentionally), but
  re-evaluable.
- **F-5 ESLint rule for `Edge` construction** — runtime enforcement of
  "every `edges.push({...})` includes provenance". Currently
  enforced by integration tests; ESLint would be earlier-stage.

### 3.3 Other unrelated open work in the repo

- **`openspec/changes/add-codebuddy-installer-target`**: completed but
  not archived. Should archive after commit (D-2).
- **`docs/plans/2026-04-24-framework-resolver-extract.md`**: separate
  framework-resolver plan, status unknown. Out of P0 scope.
- **`__tests__/watcher.test.ts`**: known flaky (timing-dependent OS
  file events). Not P0's problem but a candidate for stabilization.
- **`__tests__/extraction.test.ts`**: worker-exit on solo run. Likely
  better-sqlite3 ABI mismatch with current Node version. Investigate
  separately.

---

## 4. Critical invariants — DO NOT BREAK

These are runtime invariants enforced by P0 tests. Breaking any of
them means the test suite fails AND production behavior degrades.

### 4.1 Edge provenance invariant

Every Edge written to SQLite via the new code paths MUST stamp
`provenance: 'tree-sitter' | 'scip' | 'heuristic'`. NULL is allowed
ONLY for pre-T1 legacy database rows being read back.

**Enforcement**:
- 11 literal `edges.push({...})` sites in `src/extraction/*.ts` +
  `src/resolution/index.ts` each include `provenance:`.
- 2 transit sites in `vue-extractor.ts:180` + `svelte-extractor.ts:201`
  rely on upstream `tree-sitter.ts` having stamped.
- Test guards: `p0-confidence-output.test.ts` (extractor-layer),
  `p0-provenance-integration.test.ts` (full integration with
  `{tree-sitter > 0, NULL = 0, other = 0}` distribution assertion).

### 4.2 Marker contract for installer

`<!-- CODEGRAPH_START -->` / `<!-- CODEGRAPH_END -->` strings in
`src/installer/instructions-template.ts` MUST stay byte-identical.
Five installers detect+replace by these markers. Drift = users get
duplicated sections on re-install.

**Enforcement**: `p0-installer-bilingual.test.ts::structure invariants`
asserts byte-exact strings; `installer-targets.test.ts` (84 cases)
exercises full re-install loop on each of 5 targets.

### 4.3 Cross-module threshold drift guards

Constants in `src/mcp/tools.ts`:
```ts
export const _internal_CONFIDENCE_LOW_THRESHOLD = 0.7;
export const _internal_INDEX_AGE_STALE_MS = 30 * 60 * 1000;
export const _internal_INDEX_AGE_STALE_MINUTES = 30;
```

If you change ANY of these, you MUST also update:
- `src/mcp/server-instructions.ts` text references
- `src/installer/instructions-template.ts` text references (both EN
  and ZH sections)

**Enforcement**: drift guards in `p0-mandatory-rules.test.ts` (×2)
and `p0-installer-bilingual.test.ts` (×2) fail if text and constants
disagree.

### 4.4 Backwards-compat fixture

`__tests__/p0-context-json-edge-trust.test.ts:101` constructs an Edge
WITHOUT provenance ON PURPOSE — it tests the legacy serialization
path. **Do not "fix" this fixture by adding provenance**. If P1.3 is
ever revisited (Edge.provenance required), this fixture's purpose
must be re-evaluated first.

### 4.5 SERVER_INSTRUCTIONS export still required

`SERVER_INSTRUCTIONS` is still exported as `export const string` for
backwards-compat with downstream consumers, even though `mcp/index.ts`
now uses `buildServerInstructions(opts)` instead. Do NOT delete the
const export.

---

## 5. Project conventions — important details

### 5.1 The `_internal_*` export naming

Constants and pure helper functions exported solely for testing use a
`_internal_` prefix. jsdoc must say "Exported for unit testing only —
not part of the public API." Within the same module, an unprefixed
alias (`const formatEdgeTag = _internal_formatEdgeTag`) is used for
readability.

### 5.2 Footer injection at `execute()` exit

The `ToolHandler.execute()` method centralizes cross-cutting concerns:
- Outer try/catch → uniform error responses
- Index-age footer post-processing
- Tool-skip set: `TOOLS_SKIP_INDEX_AGE = new Set(['codegraph_status'])`

When adding a 10th MCP tool, it picks up the footer automatically. If
the new tool is itself a freshness query, add to skip-set.

### 5.3 Bilingual markdown grep gotcha

When asserting Chinese text in tests, 80-column line wrapping breaks
`toContain('DeepSeek、Qwen、GLM')`. Use dot-all regex:

```ts
expect(text).toMatch(/DeepSeek、\s*Qwen、\s*GLM/s);
```

### 5.4 `not.toContain` precision

Negative assertions MUST anchor on a unique section header:

```ts
// BAD — too broad, future content might include ⚠️ for unrelated reasons
expect(out).not.toContain('⚠️');

// GOOD — specific to the target section
expect(out).not.toContain('## ⚠️ Index Sync Status');
```

### 5.5 Round-then-bucket trap

Avoid `Math.round(value / threshold)` followed by threshold comparison.
The rounding loses sub-bucket precision. Instead, bucket by raw value:

```ts
// BAD
const ageMin = Math.round(ageMs / 60000);
if (ageMin < 1) { /* never triggers when ageMs ∈ [1, 59999] */ }

// GOOD
if (ageMs < 60_000) { /* '<1m' bucket */ }
else if (ageMs < 3_600_000) { /* 'Nm' bucket */ }
```

### 5.6 Test fixture vs production code distinction

When a test file deliberately constructs invalid/incomplete data to
test edge cases, the comment surrounding the fixture is your primary
signal. **Read comments before "fixing" missing fields**.

---

## 6. Useful commands

```bash
# Build
npm run build

# Type check (strict)
npx tsc -p ./tsconfig.json --noEmit

# Test
npm test                                    # full suite
npx vitest run __tests__/p0-*.test.ts       # P0 only
npx vitest run __tests__/<pattern>          # specific pattern

# OpenSpec
openspec list                                # active changes
openspec validate <change-id> --strict       # validate a change
openspec show <change-id>                    # render the change
openspec list --specs                        # current capabilities

# Anti-laziness 17-redline scan (manual grep, no tooling)
for f in <changed-files> ; do
  echo "[$f]"
  grep -cE '(TODO|FIXME|XXX|HACK):' $f                   # #1
  grep -cE 'function[^{]*\{\s*\}|=>\s*\{\s*\}' $f        # #2
  grep -cE 'catch[^{]*\{[[:space:]]*\}' $f               # #4
  grep -nE ': any[ ;,\)\}]|@ts-ignore|@ts-expect-error' $f | grep -v 'as unknown as' | wc -l   # #5
  grep -cE 'console\.(log|error|warn|debug)\(' $f        # #9
  grep -cE 'https?://[^\\s\"]+' $f                       # #10
done
```

---

## 7. Reading list (in order)

When picking up this work, read in this order:

1. **This file** (you're reading it).
2. `docs/codegraph-engineering-notes.md` (255 lines, 8 project-specific
   conventions).
3. CodeBuddy memory ID 66947442 (8 cross-project lessons).
4. `openspec/AGENTS.md` (workflow protocol, ~250 lines).
5. `openspec/project.md` (project conventions).
6. `openspec/changes/add-llm-trust-signals/proposal.md` (157 lines —
   why P0 was needed).
7. `openspec/changes/add-llm-trust-signals/tasks.md` (250 lines —
   complete task ledger including P1).
8. `openspec/changes/add-llm-trust-signals/design.md` (225 lines — 7
   key decisions).
9. (As-needed) `openspec/changes/add-llm-trust-signals/specs/{mcp-tools,
   installer-targets}/spec.md` (Spec deltas in OpenSpec format).

After (1)–(9) you should have full context. Then check `git status`
and `git diff --stat` to confirm the on-disk state matches this
document's claims.

---

## 8. First action checklist for the new session

Before doing ANY work, the new AI must:

- [ ] Read this entire file.
- [ ] Read `docs/codegraph-engineering-notes.md`.
- [ ] Run `git status --short` to confirm uncommitted P0+P1 changes
      are still present.
- [ ] Run `npx vitest run __tests__/p0-*.test.ts` and confirm 85/85
      pass. If not, something has changed since the previous session
      ended; investigate before any new work.
- [ ] Run `openspec validate add-llm-trust-signals --strict` and
      confirm "is valid".
- [ ] Confirm with the user what the next direction is. Do NOT pick
      a direction from §3 autonomously — that section is for the
      user's reference, not for AI to act on.

If the user says "continue" or "auto-推进" without specifying a
direction, ask explicitly: "P0+P1 is fully complete. The next
direction options are §3.1 (commit/archive/release — requires user
action) and §3.2 (potential P2 batch — requires user sign-off). Which
do you want?"

---

## 9. Authorship & timestamp

- **Generated**: 2026-05-22 by the prior AI session, after completing
  P0 (T1–T6) and P1 (P1.1, P1.2, P1.4) closure including a final
  cross-batch deep self-check.
- **Verified**: 775 passing / 0 real failures via `npm test`; 85/85
  P0 cases pass; OpenSpec strict valid; tsc strict clean; 0 lint;
  17-redline scan 0 real triggers across 13 changed files.
- **Next session resumes from**: any point in §3, by user choice.
