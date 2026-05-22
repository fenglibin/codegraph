# Tasks: Add LLM trust signals — confidence, provenance, freshness, mandatory rules

This change was implemented as 6 sequential todos (T1–T6) under the
dev-workflow stage 4.5 closure loop. Each todo passed: (a) 10-dimension
deep self-check, (b) 5-level pyramid (L1 compile → L5 full suite), and
(c) 17-redline anti-laziness scan. Every checklist box below reflects
work already on disk; this file is the durable trail for archive.

## T1 — Provenance + confidence persistence (R2)

- [x] 1.1 Verify `name-matcher.ts` already attaches `confidence` ∈ [0.3, 0.95]
  to every `ResolvedRef`.
- [x] 1.2 Verify `resolution/index.ts:createEdges` already writes
  `metadata: { confidence, resolvedBy }` to each Edge.
- [x] 1.3 Verify `db/queries.ts:insertEdge` already persists `metadata` as
  JSON string and reads it back via `safeJsonParse`.
- [x] 1.4 Grep `edges.push({...})` across `src/extraction/` and `src/resolution/`
  — discover 11 sites missing `provenance` field (zero coverage today).
- [x] 1.5 Stamp `provenance: 'tree-sitter'` on all 11 contains-edge sites:
  `tree-sitter.ts` (2), `liquid-extractor.ts` (6), `dfm-extractor.ts` (1),
  `svelte-extractor.ts` (1), `vue-extractor.ts` (1).
- [x] 1.6 Stamp `provenance: 'heuristic'` on `resolution/index.ts:createEdges`
  output.
- [x] 1.7 Add `__tests__/p0-confidence-output.test.ts` (7 cases) — mock
  ResolvedRef → createEdges path.
- [x] 1.8 Add `__tests__/p0-provenance-integration.test.ts` (3 cases) — real
  `CodeGraph.init() + resolveReferences()` over a TS fixture, then
  `getOutgoingEdges` and assert distribution is `{ tree-sitter: N>0,
  heuristic: M>0, NULL: 0, other: 0 }` and every heuristic edge carries
  confidence ∈ [0, 1].
- [x] 1.9 L4 real-system probe — index a small TS fixture, inspect provenance
  distribution via public API.

## T2 — MCP tool output: trust tags + low-confidence warning (R1)

- [x] 2.1 Add module-level constants and helpers in `src/mcp/tools.ts`:
  - `_internal_CONFIDENCE_LOW_THRESHOLD = 0.7` (exported for tests).
  - `_internal_readEdgeConfidence(edge)` — defensive read with type check.
  - `_internal_formatEdgeTag(edge)` — render `[ast]` / `[heur 0.NN]` /
    `[heur 0.NN ⚠️]` / `[heur ?]`.
- [x] 2.2 Extend `ToolHandler.formatNodeList(nodes, title, edges?)`:
  - When edges Map provided, append per-row trust tag.
  - Pre-compute low-confidence count and emit top-level `> ⚠️ N of M
    relationship(s) below confidence 0.7` warning, or
    `> N of M relationship(s) are heuristic` when none are low-trust.
- [x] 2.3 Update `handleCallers` and `handleCallees` to collect
  `edgesByCaller`/`edgesByCallee` Map<nodeId, Edge> from
  `cg.getCallers(id)`/`cg.getCallees(id)` return values (the `.edge`
  field was previously dropped).
- [x] 2.4 Update `formatImpact` to compute `astEdgeCount`,
  `heuristicEdgeCount`, `lowConfidenceEdgeCount` across
  `impact.edges[]` and emit a single-line `> Trust:` summary.
- [x] 2.5 Update `src/context/formatter.ts:serializeEdge` — additively emit
  `provenance` and `confidence` fields when present (with type/range
  guard for `confidence`).
- [x] 2.6 Add `__tests__/p0-mcp-edge-trust.test.ts` (10 unit cases over
  the three helpers — boundary 0.7, undefined edge, malformed metadata,
  unknown provenance, etc.).
- [x] 2.7 Add `__tests__/p0-mcp-edge-trust-integration.test.ts` (4 cases —
  real CodeGraph + real ToolHandler.execute, assert trust tags appear
  in actual `codegraph_callers`/`codegraph_callees`/`codegraph_impact`
  text output).
- [x] 2.8 Add `__tests__/p0-context-json-edge-trust.test.ts` (5 cases —
  serialize sample TaskContext through `formatContextAsJson`, assert
  edge JSON includes `provenance` and `confidence` when present and
  omits them when absent).

## T3 — Index-age footer (R4)

- [x] 3.1 Add `QueryBuilder.getMaxIndexedAt(): number | null` to
  `src/db/queries.ts` using a cached prepared statement
  (`this.stmts.getMaxIndexedAt` slot — follow codegraph idiom).
- [x] 3.2 Add `CodeGraph.getMaxIndexedAt()` public delegate in `src/index.ts`.
- [x] 3.3 Add `_internal_formatIndexAgeFooter(maxIndexedAt, now?)` to
  `src/mcp/tools.ts`. Bucket label by raw ms (not rounded minutes) so
  `<1m` actually triggers under 60 seconds.
- [x] 3.4 Add `INDEX_AGE_STALE_MS = 30 * 60 * 1000` constant.
- [x] 3.5 Add `TOOLS_SKIP_INDEX_AGE = Set(['codegraph_status'])`.
- [x] 3.6 Refactor `ToolHandler.execute()`:
  - Extract pure name→handler dispatch into private `dispatch()`.
  - In `execute()`, after `dispatch()` returns, append index-age footer
    unless: (a) tool in skip-list, (b) `result.isError === true`, or
    (c) `tryGetCodeGraph()` failed.
- [x] 3.7 Add `tryGetCodeGraph(projectPath)` private helper — swallow
  "not initialized" errors so the footer is purely informational.
- [x] 3.8 Add `__tests__/p0-index-age-footer.test.ts` (14 cases — 9 unit
  + 5 integration via spawned ToolHandler). Cover null/0/negative
  maxIndexedAt, clock skew, exact-30m boundary, hour formatting,
  status-tool suppression, error-response suppression).
- [x] 3.9 L4 probe verifies footer appears on data tools, absent on
  status, absent on errors.

## T4 — Watcher health on initialize handshake (R3)

- [x] 4.1 Refactor `src/mcp/server-instructions.ts`:
  - Keep `export const SERVER_INSTRUCTIONS` (backwards-compat).
  - Add `BuildServerInstructionsOptions` interface (`projectRoot?`,
    `watchReasonOverride?`).
  - Add `buildServerInstructions(opts?)` builder — pure function,
    consults `watchDisabledReason(opts.projectRoot)` and appends a
    `## ⚠️ Index Sync Status` markdown section explaining the off-state
    and pointing the agent to `codegraph sync` / `codegraph_status`.
- [x] 4.2 Update `src/mcp/index.ts:handleInitialize` to use
  `buildServerInstructions({ projectRoot: explicitPath })` instead of
  the static constant. Remove unused `SERVER_INSTRUCTIONS` import.
- [x] 4.3 Add `__tests__/p0-watch-health-instructions.test.ts` (9 unit
  cases — projectRoot present/absent, override path, parity with
  static playbook).
- [x] 4.4 Add `__tests__/p0-watch-health-instructions-integration.test.ts`
  (2 real `codegraph serve --mcp` spawn cases — once with
  `CODEGRAPH_NO_WATCH=1` to force the warning section, once without).

## T5 — Mandatory Rules in SERVER_INSTRUCTIONS, bilingual (R5)

- [x] 5.1 Insert `## 🚫 Mandatory Rules / 强制规则` section into
  `SERVER_INSTRUCTIONS` between the intro paragraph and the existing
  `## Answer directly` section.
- [x] 5.2 Write English block: 5 numbered `**NEVER**` rules. Rules 4
  and 5 name concrete thresholds (`confidence < 0.7`, `Index age over
  30 minutes`) to track the runtime constants.
- [x] 5.3 Write Chinese mirror block: 5 numbered `**绝不**` rules with
  identical semantics. Both blocks reference DeepSeek/Qwen/GLM as
  trigger models for the mandatory framing.
- [x] 5.4 Preserve existing `## Tool selection by intent`,
  `## Common chains`, `## Anti-patterns`, `## Limitations` verbatim
  (Claude already responds well to these — don't risk regression).
- [x] 5.5 Add `__tests__/p0-mandatory-rules.test.ts` (14 cases). Includes:
  - 4 structure invariants (intro / heading / section ordering).
  - 4 English rule presence checks.
  - 3 Chinese rule presence checks (use dot-all `/s` flag for newline-
    spanning matches — Chinese commas can wrap at column 80).
  - 2 budget guards (length floor + ceiling).
  - 1 **drift guard** — assert `_internal_CONFIDENCE_LOW_THRESHOLD ===
    0.7` and `SERVER_INSTRUCTIONS.contains('confidence < ${threshold}')`
    so future changes to either side fail loudly.
- [x] 5.6 Fix two pre-existing T4 test assertions that were
  over-broad (`not.toContain('⚠️')`, `not.toContain('codegraph sync')`)
  — anchor them to the unique `## ⚠️ Index Sync Status` header instead.

## T6 — Bilingual installer instructions template (R6)

- [x] 6.1 Modify `src/installer/instructions-template.ts:INSTRUCTIONS_TEMPLATE`:
  append a `## CodeGraph（中文）` mirror section after the existing
  English content but **inside** the existing marker pair. Include:
  - 🚫 强制规则 section with 5 numbered `**绝不**` rules.
  - When-to-prefer-codegraph paragraph.
  - 经验法则 (Rules of thumb).
  - 如果 `.codegraph/` 不存在 fallback prompt.
- [x] 6.2 **Critical**: keep `CODEGRAPH_SECTION_START` /
  `CODEGRAPH_SECTION_END` byte-identical to the previous version —
  marker drift would break idempotent re-install across 5 installer
  targets.
- [x] 6.3 Preserve English section content verbatim (existing 84
  installer-targets tests assert specific English phrases like
  `codegraph_callers`).
- [x] 6.4 Add `__tests__/p0-installer-bilingual.test.ts` (14 cases):
  - 4 structure invariants (marker count, exact strings, ordering,
    `CLAUDE_MD_TEMPLATE` alias).
  - 3 English section preservation checks.
  - 4 Chinese section presence checks (with dot-all regex for wrapped
    Chinese-comma lists, sharing the pattern fix from T5).
  - 2 drift guards (`confidence < 0.7` and `30 minutes` / `30 分钟`
    appear in both languages).
  - 1 budget guard (length in [3000, 8000]).
- [x] 6.5 Re-run `__tests__/installer-targets.test.ts` (84 cases) — all
  pass without modification, proving marker stability and idempotency.

## Closing — cross-cutting verification

- [x] C.1 Full `npm test` baseline comparison:
  - Pre-P0: 659 passing / 1 watcher flake.
  - Post-T6: 773 passing / 1 watcher flake. Delta: **+114 passing, 0
    new failure**.
- [x] C.2 P0 test files total **82 cases** across 10 files — all green.
- [x] C.3 `tsc -p ./tsconfig.json --noEmit` clean.
- [x] C.4 17-redline anti-laziness scan across every changed file —
  0 real triggers (only fixture-string and pre-existing baseline
  matches).
- [x] C.5 All 6 todos passed the 5-level pyramid (L1 compile → L2 CLI
  starts → L3 module loads → L4 real-system probe → L5 test suite).

## P1 — Backlog absorbed into this change (post-T6 follow-up)

After the main P0 batch landed, four backlog items were enumerated.
Three were closed in-line (rationale below); one was explicitly
**won't-fix** with risk-mitigation evidence.

- [x] **P1.1** Export `_internal_INDEX_AGE_STALE_MS` and
  `_internal_INDEX_AGE_STALE_MINUTES` from `src/mcp/tools.ts` (parallel
  to `_internal_CONFIDENCE_LOW_THRESHOLD`). Add cross-module drift-guard
  tests in `p0-mandatory-rules.test.ts` and `p0-installer-bilingual.
  test.ts` asserting the literal "30 minutes" / "30 分钟" in
  `SERVER_INSTRUCTIONS` and `INSTRUCTIONS_TEMPLATE` matches the
  exported constant (+2 cases). Closes the lockstep gap T5/T6 left
  open.

- [x] **P1.2** Add a Vue + Svelte sub-extraction integration case to
  `p0-provenance-integration.test.ts` (+1 case). Fixture writes a
  `Component.vue` and `Counter.svelte` with inner `<script>` classes,
  runs `CodeGraph.init`, then asserts `WidgetController` and
  `CounterStore` got extracted (proves sub-extraction path executed)
  AND outgoing-edge `provenance` distribution is `{ tree-sitter > 0,
  NULL = 0, other = 0 }`. Closes the implicit-dependency risk that
  vue/svelte's `this.edges.push(edge)` transit relies on
  `tree-sitter.ts` having stamped provenance everywhere upstream.

- [x] **P1.3** ❌ **Won't fix**: change `Edge.provenance` from optional
  to required. Investigation showed:
  - Pre-T1 SQLite databases contain rows with `provenance = NULL`;
    making the field required at the TypeScript level would prevent
    those rows from round-tripping (DB → JS), forcing every user
    onto a manual `codegraph reindex` to upgrade.
  - `__tests__/p0-context-json-edge-trust.test.ts:101` *intentionally*
    constructs an edge without provenance to exercise the
    backwards-compat serialization path; making the field required
    invalidates this test's premise.
  - The intended risk (future contributors forget to stamp
    provenance) is already covered by
    `p0-confidence-output.test.ts::extraction-layer edges declare
    'tree-sitter'` and `p0-provenance-integration.test.ts::distribution
    after a real index has zero NULL provenance` — any new push site
    that omits provenance fails one of these in CI.
  - The marginal benefit of compile-time strictness is smaller than
    the cost of breaking backwards-compat and a deliberate test
    fixture. Decision: keep optional, rely on integration-test guard.

- [x] **P1.4** Document the 5 cross-project lessons learned across P0
  in CodeBuddy memory for reuse on future projects (CodeMate / TDiff /
  this codebase / future ones). Lessons:
  1. Schema column ↔ code field consistency check before declaring a
     persistence change "done" (avoid half-dead columns).
  2. Graph-query outputs returning `{node, edge}` MUST NOT silently
     drop `.edge` — relationship semantics live there.
  3. Round-then-bucket pure functions need bucket-boundary unit tests
     at every threshold ±1 unit (the `<1m` bug pattern).
  4. Builder/formatter/serializer functions need a wiring integration
     test (the function being correct ≠ being called by production).
  5. `not.toContain` negative assertions MUST anchor on a unique
     section header, not a common token like an emoji or command name
     — and bilingual markdown grep needs dot-all regex for wrapped
     CJK punctuation.

## Final tally (with P1 absorbed)

- [x] T1.x P1: full `npm test` 659 → 776 passing baseline (=773 after
  T6 + 3 P1 cases). Watcher flakiness count unchanged.
- [x] P0 + P1 totals: **11 src files modified, 10 test files added,
  85 test cases (T1–T6 + P1.1 + P1.2)**, 1 OpenSpec change
  (`add-llm-trust-signals`, strict-valid).

