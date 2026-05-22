# Design: LLM trust signals

## Context

The 6 P0 todos addressed in this change all share a single design
question: **"How do we expose what codegraph already knows in a form
the LLM will actually use?"**

The data was there. `name-matcher.ts` had been computing a 0–1
confidence score per resolved reference for months. The schema had a
`provenance` column added in migration v2. The file watcher reported
its disabled-reason via `watch-policy.ts:watchDisabledReason`. None of
it reached the LLM. This document records the shape decisions made
while wiring those signals end-to-end.

## Stakeholders & constraints

- **Claude users**: existing `SERVER_INSTRUCTIONS` text was tuned and
  shipped. Don't regress.
- **Non-Claude users (DeepSeek, Qwen, GLM, …)**: soft "Anti-patterns"
  bullets weren't strong enough; mandatory framing + Chinese mirror
  improves adherence per training-language distribution.
- **Performance budget**: every MCP tool call already triggers a
  SQLite read. One extra `MAX(indexed_at)` aggregate is acceptable
  if statement-cached.
- **Backwards compatibility**: external consumers may import
  `SERVER_INSTRUCTIONS` (string) and `INSTRUCTIONS_TEMPLATE` (string)
  directly. Breaking either would silently regress downstream
  installers.
- **No schema migration**: `provenance` and `metadata` columns already
  exist. We must not add a new migration in this change.

## Decision 1 — Provenance values are an open string union, not an enum

`Edge.provenance` is typed `'tree-sitter' | 'scip' | 'heuristic' |
undefined`. Open string union (TypeScript literal types) was chosen
over a TypeScript `enum`:

- **Why string union**: persistable as-is to SQLite TEXT, no JSON
  encoding round-trip mismatch.
- **Why include `'scip'`**: codegraph has a stub SCIP-import path that
  will eventually carry semantically-precise edges. Reserving the
  literal now means MCP output already renders `[ast]` for SCIP edges
  when they arrive — no further changes needed.
- **Why keep `undefined` legal**: pre-T1 databases shipped before this
  change have `provenance = NULL`. Forcing the field required would
  either break those databases or require a migration we explicitly
  ruled out.

## Decision 2 — Trust tag rendering: `[ast]` vs `[heur 0.NN]` vs `[heur 0.NN ⚠️]` vs `[heur ?]`

Four states render four distinct tags:

| Provenance | Confidence | Tag | Why |
|---|---|---|---|
| `tree-sitter` / `scip` | (any) | `[ast]` | AST-direct edge — confidence is irrelevant; the relationship is structurally certain. |
| `heuristic` | ≥ 0.7 | `[heur 0.NN]` | Heuristic edge with strong evidence — LLM can rely on it. |
| `heuristic` | < 0.7 | `[heur 0.NN ⚠️]` | Heuristic edge with weak evidence — LLM should verify. |
| `heuristic` / undefined | NULL | `[heur ?]` | Pre-T1 legacy edge or stamping bug. Render as low-trust. |

Threshold of 0.7 aligns with `name-matcher.ts:matchByExactName`'s
"narrow match" tier — anything below is fuzzy or cross-language.

The `[heur ?]` legacy branch is intentionally not a separate `[legacy]`
tag. Two reasons: (a) every pre-T1 heuristic edge IS heuristic — the
provenance is just unrecorded, not different; (b) reducing the
distinction to "low-trust" is the only thing the LLM can act on
anyway. The jsdoc on `formatEdgeTag` explains the behavior so future
maintainers don't try to "fix" it.

## Decision 3 — Footer injection at `execute()` exit, not in handlers

`ToolHandler.execute()` was refactored from `try { switch(...) }
catch` into a thin wrapper around private `dispatch()`. The post-
processing branch is centralized:

```
async execute(toolName, args) {
  let result = await dispatch(...);                  // pure routing
  if (TOOLS_SKIP_INDEX_AGE.has(toolName)) return result;
  if (result.isError) return result;
  const cg = tryGetCodeGraph(args.projectPath);     // best-effort
  if (cg) appendFooter(result, cg.getMaxIndexedAt());
  return result;
}
```

**Alternative considered**: extend each of the 21 `this.textResult(...)`
call sites with a `, indexAge` argument. Rejected because (a) one
handler missing the parameter silently drops the footer, (b) error
responses produced via `textResult` would also pick up the footer
which we don't want, (c) 21 mechanical edits invite typos.

**Suppression policy**:
- `codegraph_status` is the freshness truth source — adding a footer
  is redundant noise.
- `result.isError === true` paths are explicit programmer errors;
  freshness adds nothing to "Tool execution failed: …".
- "Symbol not found" responses (which are *not* `isError`) DO get the
  footer — the LLM can use it to distinguish "really not in the graph"
  from "indexed snapshot is stale".

## Decision 4 — Bucket `<1m` by raw ms, not rounded minutes

Initial implementation:

```ts
const ageMin = Math.round(ageMs / 60000);
const ageLabel = ageMin < 1 ? '<1m' : `${ageMin}m`;
```

Bug: `Math.round(30000 / 60000) = 1`. The `<1m` branch never fires
under 60 seconds — anything from 1 ms to 59 999 ms gets labeled "1m
ago". Caught by `p0-index-age-footer.test.ts`'s 30-second boundary
case in the first test run.

Fix: bucket by raw `ageMs`:

```ts
let ageLabel: string;
if (ageMs < 60_000)        ageLabel = '<1m';
else if (ageMs < 3_600_000) ageLabel = `${Math.round(ageMs / 60_000)}m`;
else                        ageLabel = `${(ageMs / 3_600_000).toFixed(1)}h`;
```

This is the canonical "round-then-bucket vs bucket-by-threshold"
pitfall. Filed as a test-design lesson: **any pure formatter that
maps numbers to discrete labels needs a unit test at every bucket
boundary, including ±1 unit on each side.**

## Decision 5 — `buildServerInstructions(opts)` builder, not a `let SERVER_INSTRUCTIONS`

Watcher health needs to vary per-session (different projects, different
WSL2 mount situations). Three options were considered:

1. **Mutate the const**: convert `export const SERVER_INSTRUCTIONS` to
   `export let SERVER_INSTRUCTIONS` and rewrite it on each handshake.
   *Rejected*: external imports (e.g. `import { SERVER_INSTRUCTIONS }`)
   would observe inconsistent values across sessions in a shared
   process. Surprising and hard to test.
2. **Drop the const, export only the builder**: `export function
   buildServerInstructions(opts) { ... }`.
   *Rejected*: breaking change for downstream consumers who imported
   the string directly.
3. **Keep the const for back-compat, add a builder**: `export const
   SERVER_INSTRUCTIONS = ...; export function buildServerInstructions
   (opts) { return SERVER_INSTRUCTIONS + maybeAppendWatchSection(opts); }`.
   *Chosen*: additive, no breaking change, lazy evaluation, testable in
   isolation, the runtime path uses the builder.

The static const path (no opts) returns the bilingual playbook
verbatim; the dynamic path appends a `## ⚠️ Index Sync Status` section
when the project is known and the watcher is off.

## Decision 6 — Bilingual: English first, Chinese mirror, single block

Two layouts were considered for the bilingual `INSTRUCTIONS_TEMPLATE`
and `SERVER_INSTRUCTIONS`:

1. **Interleaved** — each rule has English+Chinese on alternate lines.
2. **Mirrored** — full English block, separator, full Chinese block.

We chose **mirrored**. Reasons:

- Easier to keep in sync at edit time (the two lists are visually
  parallel, not interleaved character-by-character).
- Easier to add a third language later (just append another mirror
  block).
- LLMs trained primarily in one language can skip past the other on
  inference without confusing token-prediction state — interleaving
  bilingual content forces the model to language-switch every line.
- Existing English readers (humans + Claude) see the original content
  unchanged; Chinese readers see a structurally-identical translation.

The single-marker-block layout (one START/END pair wrapping both
languages) was chosen over per-language markers (one EN block, one
ZH block) because installer idempotency hinges on a unique
marker-pair detection. Two pairs would double the surface area for
re-install drift bugs without any user-visible benefit.

## Decision 7 — Drift guards over hardcoded literals

Both `SERVER_INSTRUCTIONS` rules and `INSTRUCTIONS_TEMPLATE` rules
mention the runtime thresholds (`confidence < 0.7`, `30 minutes`).
These are duplicated literals — text says one thing, code does
another, drift over time.

Three protection levels:

- **Cross-module test** (`p0-mandatory-rules.test.ts`): imports
  `_internal_CONFIDENCE_LOW_THRESHOLD` from `tools.ts` and asserts
  `SERVER_INSTRUCTIONS.contains('confidence < ${threshold}')`. If
  someone changes the constant, this test breaks; if someone changes
  the text, this test breaks.
- **Same-file test** (`p0-installer-bilingual.test.ts`): asserts both
  English `confidence < 0.7` and Chinese `置信度 < 0.7` appear in
  `INSTRUCTIONS_TEMPLATE`. Catches one-language-only edits.
- **No drift guard** for `30 minutes` / `INDEX_AGE_STALE_MS`:
  `INDEX_AGE_STALE_MS` is module-private in `tools.ts`. Adding an
  export just for the test is overkill for a constant we don't expect
  to change. **Filed as P1 backlog**.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Marker drift breaks 5 installers' idempotent re-install. | `p0-installer-bilingual.test.ts::structure invariants` asserts byte-exact marker strings; `installer-targets.test.ts::idempotent re-install` exercises the full re-install loop on each of the 5 targets. |
| Footer growth bloats every MCP response. | Test budget guard caps `INSTRUCTIONS_TEMPLATE` length at 8000 chars and `SERVER_INSTRUCTIONS` length at ~6000 chars. Footer text is short (~40 chars normal, ~140 chars with stale warning). |
| Pre-T1 NULL-provenance rows render as `[heur ?]` in production. | Documented in `formatEdgeTag` jsdoc with `codegraph reindex` recovery instructions. Acceptable for a one-time migration window; no DB rewrite required. |
| Future contributors mistake `_internal_*` exports as public API. | All names prefixed `_internal_`; jsdoc explicitly says "Exported for unit testing only — not part of the public MCP API." |

## Out of scope (explicit)

- **Confidence calibration** — we expose what `name-matcher.ts`
  computes today. Improving the score (e.g., differentiating
  cross-language vs same-language fuzzy match) is a separate
  R&D effort.
- **Index-age action** — the footer informs the LLM but doesn't
  block. We do not auto-reject queries against a 30-minute-stale
  graph because a non-trivial subset of users disable the watcher
  intentionally (large monorepos with manual `codegraph sync`).
- **Mandatory rules in tool descriptions** — we strengthen the
  server-level instructions (handshake) and per-agent instructions
  files. We do NOT change individual `tool.description` fields
  because those are short, language-agnostic, and tested separately.
