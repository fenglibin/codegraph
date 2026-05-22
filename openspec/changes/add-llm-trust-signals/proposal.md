# Change: Add LLM trust signals — confidence, provenance, freshness, mandatory rules

## Why

Codegraph today returns structurally-correct relationships, but **gives the
LLM no way to distinguish high-trust edges from heuristic guesses**, no way
to detect a stale graph, and no machine-imperative rules on when to use
codegraph vs grep/Read. As a result we observed three failure modes that
no amount of tool-description copy-editing fixed:

1. **Silently wrong answers from low-confidence edges.** The resolver
   layer (`name-matcher.ts`) already computes a 0–1 `confidence` score
   per resolved reference and the schema already had a `provenance`
   column, but neither field was propagated into the MCP tool output.
   LLMs treated a fuzzy cross-language name-match (`confidence=0.5`)
   identically to an AST-direct edge, producing confidently-wrong
   refactoring advice.

2. **Stale-graph blind spots.** When the file watcher silently disabled
   itself (WSL2 `/mnt`, `CODEGRAPH_NO_WATCH=1`, container mounts) the
   server still answered every query against an indefinitely-old
   snapshot. Users reported `codegraph_callers` returning callers that
   were deleted hours ago. There was no per-response signal to detect
   this — only a mid-session `codegraph_status` call.

3. **Non-Claude models fall back to grep.** DeepSeek, Qwen, GLM, … are
   not fine-tuned on codegraph. Even with codegraph configured, they
   defaulted to Read+grep loops by training-data habit, costing 10–30×
   more tokens than the equivalent codegraph chain. Soft "Anti-pattern"
   bullets in the existing instructions text didn't change behavior.

**P0 fixes all three by exposing the data the system already had**
(items 1 and 2) and **strengthens the surface that influences model
behavior** (item 3, with bilingual mandatory rules).

## What Changes

### Persistence layer — `Edge.provenance` becomes universally stamped (R2)

- **MODIFY** every edge construction site to stamp `provenance`:
  - `src/extraction/tree-sitter.ts` (2 contains-edge sites): `'tree-sitter'`
  - `src/extraction/{liquid,dfm,svelte,vue}-extractor.ts` (9 sites): `'tree-sitter'`
  - `src/resolution/index.ts:createEdges` (resolver output): `'heuristic'`
- **No schema change** — the `provenance` column already existed (added in
  migration v2); this proposal just stops shipping it as `NULL`.
- **No change** to `metadata.confidence` propagation — it was already
  persisted by `resolution/index.ts:createEdges`; T1 just verified it
  end-to-end with an integration test.

### MCP output — confidence + provenance reach the LLM (R1)

- **MODIFY** `src/mcp/tools.ts`:
  - Add `_internal_formatEdgeTag(edge)` — renders `[ast]` for AST-direct
    edges, `[heur 0.NN]` for heuristic edges, `[heur 0.NN ⚠️]` when
    confidence < 0.7, `[heur ?]` for legacy NULL-confidence edges.
  - Extend `formatNodeList` with an optional `edges?: Map<string, Edge>`
    parameter; appends per-row trust tag and a top-level summary warning
    when low-confidence edges dominate.
  - `handleCallers` and `handleCallees` now collect the edge alongside
    the node and pass it through (previously the `.edge` field was
    dropped after the graph query returned it).
  - `formatImpact` adds a `> Trust: N AST edges, M heuristic edges
    (K below confidence 0.7 ⚠️)` summary line to the impact subgraph.
- **MODIFY** `src/context/formatter.ts:serializeEdge` (JSON output path):
  emit `provenance` and `confidence` when present (additive — older
  consumers ignore the new fields).

### MCP output — index-age footer (R4)

- **ADD** `QueryBuilder.getMaxIndexedAt()` to `src/db/queries.ts` (with
  a prepared-statement cache slot in `this.stmts`).
- **ADD** `CodeGraph.getMaxIndexedAt()` public API in `src/index.ts`.
- **ADD** `_internal_formatIndexAgeFooter(maxIndexedAt, now?)` helper in
  `src/mcp/tools.ts`.
- **MODIFY** `ToolHandler.execute()` — split into `execute()` + private
  `dispatch()`. `execute()` now post-processes the result to append
  `_Index age: Xm ago_` to the last text content item, with a `⚠️`
  variant when age ≥ 30 minutes. Footer is **suppressed for
  `codegraph_status`** (the freshness truth source) and for explicit
  error responses.

### MCP transport — initialize handshake exposes watcher health (R3)

- **MODIFY** `src/mcp/server-instructions.ts`:
  - **Preserve** `SERVER_INSTRUCTIONS` as `export const string` (existing
    consumers keep working).
  - **ADD** `buildServerInstructions(opts: { projectRoot?: string;
    watchReasonOverride?: string | null })` — when a project root is
    available and `watchDisabledReason(root)` returns a reason, append
    a `## ⚠️ Index Sync Status` section to the body explaining why the
    file watcher is off and what to do (run `codegraph sync`).
- **MODIFY** `src/mcp/index.ts:handleInitialize` to call
  `buildServerInstructions({ projectRoot: explicitPath })` instead of
  using the static `SERVER_INSTRUCTIONS` constant.

### LLM-rule strengthening — Mandatory Rules section, bilingual (R5, R6)

- **MODIFY** `src/mcp/server-instructions.ts:SERVER_INSTRUCTIONS`:
  - Insert a `## 🚫 Mandatory Rules / 强制规则` section right after the
    intro paragraph, containing 5 numbered `**NEVER**` rules in English
    and a parallel `**绝不**` block in Chinese. Rules name the concrete
    threshold (`confidence < 0.7`, `Index age over 30 minutes`) so they
    track the runtime constants from R1/R4.
  - Existing tool-selection table, common chains, anti-patterns, and
    limitations all preserved verbatim — Claude already reads them.
- **MODIFY** `src/installer/instructions-template.ts:INSTRUCTIONS_TEMPLATE`:
  - Append a `## CodeGraph（中文）` mirror section after the existing
    English section, structured identically (mandatory rules, tool table
    summary, rules of thumb, fallback prompt).
  - **Marker strings unchanged** — five installers
    (claude/cursor/codex/opencode/codebuddy) detect+replace by
    `<!-- CODEGRAPH_START -->` / `<!-- CODEGRAPH_END -->`. If those
    drifted, every existing user install would degrade to "append-on-
    re-install".

## Impact

- **Affected specs**:
  - `mcp-tools` (new capability spec, ADDED requirements covering
    confidence/provenance exposure, index-age footer, watcher-health
    instructions, mandatory rules — none of these were previously
    spec'd).
  - `installer-targets` (MODIFIED to add the bilingual mandatory rules
    requirement on the shared instructions template).
- **Affected code**:
  - Modified: `src/extraction/{tree-sitter,liquid-extractor,dfm-extractor,svelte-extractor,vue-extractor}.ts`,
    `src/resolution/index.ts`, `src/db/queries.ts`, `src/index.ts`,
    `src/context/formatter.ts`, `src/mcp/tools.ts`,
    `src/mcp/server-instructions.ts`, `src/mcp/index.ts`,
    `src/installer/instructions-template.ts`.
  - Added: 10 test files (`__tests__/p0-*.test.ts`) totaling 82 cases.
- **No new dependencies**.
- **No schema migration** — `provenance` and `metadata` columns already
  existed.
- **Backwards compatible**:
  - Old DB rows with `provenance = NULL` render as `[heur ?]` (legacy
    branch, documented in `formatEdgeTag` jsdoc).
  - `SERVER_INSTRUCTIONS` still exported as a string for external
    consumers; new behavior comes from the additive
    `buildServerInstructions` builder.
  - `serializeEdge` output is additive — extra fields ignored by older
    JSON consumers.
  - `formatNodeList` got an optional 3rd parameter; existing 2-arg
    callers behave identically.
- **Performance**:
  - Per-edge: `+1 short string` (~13 bytes) on persistence; ~+1.3 MB
    for a 100k-edge project. JSON.stringify cost negligible.
  - Per MCP call: `+1 SELECT MAX(indexed_at) FROM files` (microseconds
    via prepared-statement cache).
  - Per session: `SERVER_INSTRUCTIONS` length grew 2716 → 5256
    characters (~+900 tokens, one-shot at handshake).
- **LLM impact**:
  - Trust tags on every edge in callers/callees/impact responses.
  - Footer on every non-status tool response.
  - Bilingual mandatory rules at handshake AND in agent files
    (CLAUDE.md / AGENTS.md / `.mdc` / CODEBUDDY.md / `.mcp.json`'s
    sibling instruction file).
