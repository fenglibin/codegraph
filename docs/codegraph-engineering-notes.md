# codegraph engineering notes — distilled from P0 (LLM trust signals)

> Project-specific lessons accumulated during the P0 batch
> (`add-llm-trust-signals`) implementation, May 2026. These are
> **specific to this codebase's architecture**. For cross-project
> patterns (round-then-bucket, builder/wiring blind spot, etc.), see
> the CodeBuddy memory entry titled "codegraph P0 沉淀的 8 条工程教训
> （跨项目通用）".

## 1. The `Edge.provenance` invariant

Every `Edge` written to SQLite SHALL carry a `provenance` value drawn
from `'tree-sitter' | 'scip' | 'heuristic'`. NULL provenance is
allowed at the type level for backwards-compat with pre-T1 databases,
but **no new code path may emit a NULL-provenance edge**. The
invariant has three enforcement layers:

1. **Source stamping** — 11 literal `edges.push({...})` sites across
   `src/extraction/*.ts` and one site in `src/resolution/index.ts:
   createEdges` each set `provenance:` explicitly.
2. **Transit preservation** — `vue-extractor.ts:180` and
   `svelte-extractor.ts:201` use `this.edges.push(edge)` to re-emit
   tree-sitter sub-extracted edges. This relies on the upstream
   `tree-sitter.ts:436` and `:701` push sites having stamped
   provenance. If anyone adds a new contains/imports edge in
   `tree-sitter.ts` and forgets the provenance field,
   `p0-provenance-integration.test.ts::distribution after a real
   index has zero NULL provenance` and `::Vue and Svelte sub-extracted
   edges retain provenance through the parent transit` both fail
   loudly in CI.
3. **Round-trip preservation** — `db/queries.ts:insertEdge` writes
   `provenance` to SQLite as a string column; the SELECT path reads
   it back into `Edge.provenance`. The persistence layer treats it as
   opaque and never coerces.

**When adding a new extractor** (e.g. a future PHP/Ruby extractor):
- Every `edges.push({...})` call MUST include `provenance: 'tree-sitter'`.
- If the new extractor delegates sub-parsing to `TreeSitterExtractor`
  (the Vue/Svelte pattern), the existing transit pushes are
  sufficient — just don't re-mutate `edge.provenance` to a different
  value during the offset-line-numbers loop.

**When adding a new resolution path** (a new heuristic / SCIP
importer / cross-language matcher):
- The resolver layer's output goes through
  `resolution/index.ts:createEdges`, which stamps `provenance:
  'heuristic'`. If a new resolver bypasses `createEdges` and writes
  edges directly via `insertEdge`, **it MUST stamp provenance itself**
  with the appropriate value (`'heuristic'` for name-match, `'scip'`
  for SCIP-imported, or invent a new literal and add it to the
  `Edge.provenance` union in `src/types.ts`).

## 2. The `_internal_*` export convention

MCP-internal constants and pure helper functions that we want to
unit-test but NOT publish as a stable API use the `_internal_` prefix:

```ts
export const _internal_CONFIDENCE_LOW_THRESHOLD = 0.7;
export const _internal_INDEX_AGE_STALE_MS = 30 * 60 * 1000;
export const _internal_INDEX_AGE_STALE_MINUTES = ...;
export function _internal_formatEdgeTag(edge): string { ... }
export function _internal_formatIndexAgeFooter(...): string { ... }
export function _internal_readEdgeConfidence(...): number | null { ... }
```

The convention is:
- jsdoc on each exported `_internal_*` explicitly says "Exported for
  unit testing only — not part of the public MCP API."
- Within the same module, the rest of the code uses unqualified
  aliases (`const formatEdgeTag = _internal_formatEdgeTag;`) so call
  sites stay readable.
- Cross-module drift guards (e.g. `SERVER_INSTRUCTIONS` text matches
  `_internal_CONFIDENCE_LOW_THRESHOLD`) import the `_internal_*` name
  directly — that's the **only** legitimate use of these exports
  outside the owning module.

**When adding a new MCP-internal constant** that text content
elsewhere references (rule playbooks, agent instructions, footers):
- Export it as `_internal_*` from the owning module.
- Add a drift-guard test that imports the constant and asserts the
  text mentions it (`expect(text).toContain(\`...\${constant}...\`)`).
- Add the same drift guard in **every** text file that references it
  (currently `SERVER_INSTRUCTIONS` AND `INSTRUCTIONS_TEMPLATE` both
  need their own drift-guard tests because they're separate strings).

## 3. The MCP `<!-- CODEGRAPH_START/END -->` marker contract

Five installer targets (`claude`, `cursor`, `codex`, `opencode`,
`codebuddy`) detect+replace the codegraph section in their agent's
instructions file by **exact match** of these marker strings:

```html
<!-- CODEGRAPH_START -->
... (anything goes here, including bilingual markdown) ...
<!-- CODEGRAPH_END -->
```

**Marker strings are sacred.** If they drift by even one byte:
- Existing user installations degrade to "append-on-re-install" — the
  old block stays as orphaned content, and a fresh block gets appended
  below, doubling on every re-install.
- 84 cases in `__tests__/installer-targets.test.ts` fail.

What's safe to change inside the markers:
- The body content (English, Chinese, both, more languages).
- Markdown structure within the block.
- The total length (within the budget assertion of 3000-8000 chars).

What's NOT safe:
- The marker strings themselves (`<!-- CODEGRAPH_START -->`,
  `<!-- CODEGRAPH_END -->`) — they're constants in
  `src/installer/instructions-template.ts` AND duplicated as string
  literals in tests.
- Adding nested markers (the section MUST contain exactly one START
  and one END).

`p0-installer-bilingual.test.ts::structure invariants` enforces all
of these.

## 4. Test-fixture vs production-code Edge construction

`__tests__/p0-context-json-edge-trust.test.ts:101` deliberately
constructs an Edge without provenance:

```ts
const ctx = makeContext([{ source: 'a', target: 'b', kind: 'contains' }]);
```

**This is not an oversight.** It tests the backwards-compat
serialization path for pre-T1 database rows. If a future contributor:
- Sees this fixture as "missing provenance, let me fix it" — they're
  defeating the test's purpose.
- Wants to tighten `Edge.provenance` from `?` to required —
  recognize this fixture as the canonical reason **not to** do that
  (see P1.3 won't-fix decision in `openspec/changes/add-llm-trust-
  signals/tasks.md`).

The lesson: when grepping for "missing fields" in test fixtures,
**check the surrounding comments first**. If the fixture's purpose
is to exercise a "missing field" code path, leave it alone.

## 5. The footer-injection symmetry

`ToolHandler.execute()` appends an index-age footer to non-error,
non-status tool responses. Three tools' worth of policy lives in
ONE place — `execute()` itself — not in each handler:

```ts
async execute(toolName, args) {
  let result = await this.dispatch(toolName, args);
  if (TOOLS_SKIP_INDEX_AGE.has(toolName) || result.isError) return result;
  const cg = this.tryGetCodeGraph(args.projectPath as ...);
  if (cg) { /* append footer */ }
  return result;
}
```

**When adding a 9th MCP tool**: by default it WILL pick up the footer
automatically. If the new tool is itself a freshness/status query and
the footer would be redundant, add its name to `TOOLS_SKIP_INDEX_AGE`.
Do NOT add suppression logic in the handler — keep the policy
centralized.

**When adding a new "result kind" beyond text** (e.g. structured JSON
content type): the current footer-append only touches the LAST `text`
content item; non-text content types are skipped. If JSON becomes the
primary content type, revisit the footer rendering policy (probably
emit it as a separate `text` content item rather than appending to
nothing).

## 6. The `tryGetCodeGraph` pattern

`tryGetCodeGraph(projectPath)` wraps `getCodeGraph(projectPath)` in a
try/catch that swallows "not initialized" errors:

```ts
private tryGetCodeGraph(projectPath: string | undefined): CodeGraph | null {
  try { return this.getCodeGraph(projectPath); }
  catch { return null; }
}
```

This is a deliberate empty catch — it would normally trip anti-laziness
red-line #4 (swallowed exception). The justification:
- The footer is purely informational. Failing to retrieve a
  CodeGraph instance must NOT propagate as an error to the LLM
  (which expects the tool's actual response).
- The original `getCodeGraph` already throws a structured error that
  the dispatched handler will surface in the response body if it
  actually mattered to that handler.
- Adding the `tryGetCodeGraph` layer means a misconfigured project
  gets the real error message (from the handler) while the footer
  silently degrades to "no footer", rather than a confusing
  "Internal error: cannot read getMaxIndexedAt" superimposed on the
  real error.

If a future feature ALSO needs best-effort access to a CodeGraph in
`execute()`'s post-processing, reuse `tryGetCodeGraph`. Do NOT
duplicate the try/catch in-line.

## 7. Bilingual markdown grep gotcha

When asserting Chinese text content in tests, **80-column line
wrapping can break `toContain` literals**:

```
以下是**强制规则**，不是建议。未经 codegraph 微调的模型（DeepSeek、Qwen、
GLM 等）...
```

`expect(text).toContain('DeepSeek、Qwen、GLM')` **fails** because the
literal newline + leading whitespace splits the token sequence. Use
dot-all regex instead:

```ts
expect(text).toMatch(/DeepSeek、\s*Qwen、\s*GLM/s);
```

This pattern has hit us twice (T5 SERVER_INSTRUCTIONS, T6
INSTRUCTIONS_TEMPLATE), confirming it's a recurring trap rather than
a one-off. Default to dot-all for any Chinese-comma-separated list
that might wrap.

## 8. The `installer-targets` test as L4 proxy

Writing a new `cjs` script to spawn a real installer + read back the
written files is **redundant** with what `__tests__/installer-
targets.test.ts` already does for all 5 targets. 84 cases cover:
- marker detection
- idempotent re-install
- user-content preservation across re-install
- sibling-MCP-server preservation
- both global and local install locations

When adding a new instructions-related change (bilingual rewrite, new
section, marker adjustment, etc.):
1. Update `INSTRUCTIONS_TEMPLATE`.
2. Add unit tests in `p0-installer-bilingual.test.ts` (or similar) for
   the new content's structure.
3. **Do NOT** write a separate L4 cjs script — re-run
   `installer-targets.test.ts` and confirm all 84 cases still pass.
   That IS the L4 proof.

If `installer-targets.test.ts` fails on a content-only change, the
marker likely drifted or a sibling-preservation assertion broke.

## Cross-references

- **CodeBuddy memory entry**: `codegraph P0 沉淀的 8 条工程教训（跨项目
  通用）` (ID 66947442) — cross-project patterns.
- **Change record**: `openspec/changes/add-llm-trust-signals/`
  — full proposal, tasks, design, spec deltas.
- **Test files** (10 files, 85 cases under `__tests__/p0-*.test.ts`)
  — the actual enforcement of all invariants above.
