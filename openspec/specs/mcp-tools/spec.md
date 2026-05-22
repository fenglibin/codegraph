# mcp-tools Specification

## Purpose
TBD - created by archiving change add-llm-trust-signals. Update Purpose after archive.
## Requirements
### Requirement: Edge Trust Signal Persistence

Codegraph SHALL persist a `provenance` field on every Edge written to
the SQLite store, identifying whether the edge was extracted directly
from an AST (`'tree-sitter'`, `'scip'`) or inferred via heuristic
name-matching at the resolution layer (`'heuristic'`). Edges written by
the resolver SHALL additionally carry `metadata.confidence ∈ [0, 1]`,
where 0.7 is the threshold below which the relationship is treated as
low-trust.

The `provenance` and `metadata.confidence` fields SHALL flow unchanged
through the persistence layer (`db/queries.ts` insert/select round-
trip) so downstream MCP consumers can render trust signals without
re-deriving them.

#### Scenario: Extraction-layer edges declare AST provenance
- **WHEN** any extractor (`tree-sitter`, `liquid`, `dfm`, `svelte`,
  `vue`) emits a containment or import edge
- **THEN** the resulting `Edge` object MUST set `provenance: 'tree-sitter'`
- **AND** subsequent `db/queries.ts:insertEdges` MUST persist that
  literal value to the `edges.provenance` column

#### Scenario: Resolver-layer edges declare heuristic provenance with confidence
- **WHEN** `resolution/index.ts:createEdges` produces a calls/references/
  instantiates/extends edge from a `ResolvedRef`
- **THEN** the resulting `Edge` MUST set `provenance: 'heuristic'`
- **AND** `metadata.confidence` MUST equal the resolver's per-match
  score (0.3–0.95 range as documented in `name-matcher.ts`)

#### Scenario: Round-trip preserves provenance through SQLite
- **WHEN** an edge with `provenance: 'tree-sitter'` and another with
  `provenance: 'heuristic'` and `metadata.confidence: 0.85` are inserted
- **AND** subsequently read back via `getOutgoingEdges` / similar query
- **THEN** both edges return their original `provenance` value verbatim
- **AND** the heuristic edge's `metadata.confidence` returns as the
  literal number `0.85` (no precision loss, no string round-trip
  mismatch)

#### Scenario: Distribution after a real index has zero NULL provenance
- **WHEN** `CodeGraph.init(projectRoot, { index: true })` runs over a
  fixture containing both class-method extractions and cross-function
  call references
- **AND** `cg.resolveReferences()` completes
- **THEN** `SELECT provenance, COUNT(*) FROM edges GROUP BY provenance`
  returns rows for `'tree-sitter'` and `'heuristic'`
- **AND** returns zero rows for `provenance IS NULL`
- **AND** returns zero rows for any unexpected value

### Requirement: MCP Tool Output Surfaces Edge Trust

The MCP tools `codegraph_callers`, `codegraph_callees`, and `codegraph_impact` SHALL surface per-edge trust signals in their text output so the consuming LLM can distinguish AST-direct relationships from heuristic name-matched ones. The trust signal SHALL be a compact, machine-recognizable suffix on each rendered relationship row, plus a top-level summary when low-confidence edges dominate the result. The summary SHALL name the exact threshold (0.7) and recommend verification. The JSON serialization path (`context/formatter.ts:serializeEdge`) SHALL additionally expose `provenance` and `confidence` fields additively (omitted when absent on the source edge).

#### Scenario: Caller list shows AST tags for tree-sitter edges
- **WHEN** `codegraph_callers` is called for a symbol whose only caller
  reaches it through a tree-sitter contains edge
- **THEN** the corresponding row in the rendered text output ends with
  the literal suffix ` [ast]`

#### Scenario: Caller list shows heuristic confidence for heuristic edges
- **WHEN** `codegraph_callers` is called for a symbol whose caller
  reaches it through a heuristic edge with `metadata.confidence = 0.85`
- **THEN** the corresponding row ends with ` [heur 0.85]`
- **AND** the row does NOT contain the `⚠️` warning glyph

#### Scenario: Low-confidence edges trigger row-level and summary warnings
- **WHEN** `codegraph_callers` is called for a symbol whose caller
  reaches it through a heuristic edge with `metadata.confidence = 0.50`
- **THEN** the corresponding row ends with ` [heur 0.50 ⚠️]`
- **AND** the rendered output contains a top-level summary line
  matching `/N of M relationship\(s\) below confidence 0\.7/`

#### Scenario: Impact report summarizes trust over the subgraph
- **WHEN** `codegraph_impact` returns a subgraph containing 1 AST
  contains-edge and 2 heuristic call-edges (one of which has
  `confidence < 0.7`)
- **THEN** the rendered text contains a single-line summary matching
  `/^> Trust: 1 AST edges, 2 heuristic edges \(1 below confidence 0\.7 ⚠️\)/m`

#### Scenario: JSON edge serialization adds provenance and confidence
- **WHEN** `formatContextAsJson` is called with a TaskContext containing
  an edge with `provenance: 'heuristic'` and `metadata.confidence: 0.92`
- **THEN** the serialized edge object includes `provenance: 'heuristic'`
- **AND** includes `confidence: 0.92`
- **AND** does NOT include any other extraneous fields beyond the
  baseline `source/target/kind/line/column`

#### Scenario: Legacy edges with missing provenance render as low-trust
- **WHEN** `codegraph_callers` encounters an edge whose `provenance`
  is `null` or `undefined` (pre-T1 database, never re-stamped)
- **THEN** the rendered row ends with ` [heur ?]`
- **AND** the LLM sees this as a reduced-trust signal equivalent to
  low-confidence heuristic

### Requirement: MCP Tool Output Carries Index Freshness Footer

Every successful, non-status MCP tool response SHALL append a footer
declaring the index age (most recent `files.indexed_at` timestamp
across all tracked files). The footer SHALL flip to a `⚠️` warning
variant when the age exceeds 30 minutes, advising the LLM to run
`codegraph sync` or check `codegraph_status`. The `codegraph_status`
tool itself SHALL NOT carry a footer (it is the freshness truth source
and the footer would be redundant).

The footer injection SHALL be implemented at the `ToolHandler.execute()`
exit, not in individual handlers, so all 8 data-bearing tools
participate uniformly.

#### Scenario: Recent index produces a fresh-age footer
- **WHEN** `codegraph_search` is executed against a project whose most
  recent indexed_at is 90 seconds before now
- **THEN** the response text ends with a footer matching
  `/_Index age: 2m ago_$/`

#### Scenario: Sub-minute age renders as `<1m`
- **WHEN** the index was updated 30 seconds before the tool call
- **THEN** the footer text reads `_Index age: <1m ago_`
- **AND** the literal `<1m` (not `0m`, not `1m`) appears in the output

#### Scenario: Stale index (over 30 minutes) triggers warning footer
- **WHEN** the most recent indexed_at is 45 minutes before the tool call
- **THEN** the footer matches `/⚠️ Index age: 45m ago — older than 30m/`
- **AND** the footer mentions `codegraph sync` and `codegraph status`
  as remediation actions

#### Scenario: Status tool suppresses the footer
- **WHEN** `codegraph_status` is invoked
- **THEN** the response text MUST NOT contain `Index age:` or
  `⚠️ Index age:` (the tool's own body covers freshness)

#### Scenario: Error responses suppress the footer
- **WHEN** a tool returns a result with `isError: true`
- **THEN** the response text MUST NOT contain an index-age footer

#### Scenario: Footer survives empty-result responses
- **WHEN** `codegraph_search` returns "Symbol not found" (a non-error
  textResult path)
- **THEN** the index-age footer IS appended (LLM uses it to distinguish
  "really absent" from "stale snapshot")

### Requirement: Initialize Handshake Surfaces Watcher Health

When the MCP server handles the `initialize` JSON-RPC request and the project root is known, the response's `instructions` field SHALL incorporate a `## ⚠️ Index Sync Status` section whenever `watch-policy.ts:watchDisabledReason(projectRoot)` returns a non-empty reason. The section SHALL state the disabled-reason verbatim and point the LLM to `codegraph sync` and `codegraph_status` as remediation actions. When the project root is not yet known (deferred resolution via `roots/list`) or the watcher is healthy, the `instructions` field SHALL equal the static playbook (`SERVER_INSTRUCTIONS`) without the warning section. The handshake response time MUST NOT regress regardless of watcher state — the watcher-state inspection is non-blocking.

#### Scenario: Watcher off (CODEGRAPH_NO_WATCH=1) appends warning section
- **WHEN** `codegraph serve --mcp` is spawned with environment
  `CODEGRAPH_NO_WATCH=1` and a known `rootUri`
- **AND** an MCP `initialize` request is sent
- **THEN** the response `result.instructions` field contains the
  literal section header `## ⚠️ Index Sync Status`
- **AND** mentions `codegraph sync` as a remediation
- **AND** mentions `codegraph_status` as a state-check action

#### Scenario: Healthy watcher returns static playbook
- **WHEN** the watcher is enabled and the project root is known
- **THEN** the response `result.instructions` field equals the static
  `SERVER_INSTRUCTIONS` constant byte-for-byte
- **AND** does NOT contain the warning section header

#### Scenario: Unknown project root falls back to static playbook
- **WHEN** the initialize request omits `rootUri` and the explicit
  `--path` flag was not provided
- **THEN** `result.instructions` equals `SERVER_INSTRUCTIONS` (no
  warning section attempted, since there's no root to inspect)
- **AND** the LLM can still discover the watcher state mid-session via
  `codegraph_status`

### Requirement: Mandatory Rules in Server Instructions, Bilingual

The server-level `SERVER_INSTRUCTIONS` text SHALL contain a `## 🚫
Mandatory Rules / 强制规则` section enumerating 5 numbered `**NEVER**`
rules in English and a parallel `**绝不**` block in Chinese. The
section SHALL be positioned near the top of the playbook (after the
intro paragraph, before the tool-selection table) so non-Claude models
encounter it before any softer guidance.

Each rule SHALL name a concrete tool / threshold (`codegraph_search`,
`confidence < 0.7`, `Index age over 30 minutes`) so it remains
actionable rather than aspirational. The two language blocks SHALL
maintain rule-by-rule semantic parity (rule 1 EN ≡ rule 1 ZH, …).

#### Scenario: English block contains 5 NEVER rules
- **WHEN** `SERVER_INSTRUCTIONS` is read
- **THEN** it contains the literal `🚫 Mandatory Rules`
- **AND** contains exactly 5 instances of the `**NEVER ` marker (one
  per numbered rule)
- **AND** each rule names at least one `codegraph_*` tool name OR a
  literal threshold (0.7, 30 minutes)

#### Scenario: Chinese mirror block contains 5 绝不 rules
- **WHEN** `SERVER_INSTRUCTIONS` is read
- **THEN** it contains the literal `强制规则`
- **AND** contains at least 5 instances of `**绝不**`
- **AND** mentions `DeepSeek、Qwen、GLM` (with possible line wraps) to
  motivate the mandatory framing for non-Claude models

#### Scenario: Drift guard between rule text and runtime threshold
- **WHEN** the constant `_internal_CONFIDENCE_LOW_THRESHOLD` from
  `mcp/tools.ts` is read
- **THEN** its value is `0.7`
- **AND** `SERVER_INSTRUCTIONS` contains the literal substring
  `confidence < 0.7`
- **AND** if the constant changes, the test harness fails loudly so
  the rule text is updated in lockstep

