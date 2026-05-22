# Design: Add CodeBuddy IDE as a supported installer target

## Context

CodeGraph's installer is structured around the `AgentTarget` interface defined in `src/installer/targets/types.ts`. Each MCP-capable agent (Claude Code, Cursor, Codex CLI, opencode) is one self-contained file under `src/installer/targets/` that owns its config file location, MCP-server config writing, instructions file path, optional permissions, and (optionally) a `wireProjectSurfaces()` hook for project-level bootstrap. Adding a new agent is meant to be: **one new file + one entry in `registry.ts`**.

This design follows that pattern exactly. The non-trivial work is:
1. Identifying CodeBuddy IDE's real config file conventions (researched via Tencent CodeBuddy IDE official docs + internal CodeBuddy plugin docs).
2. Handling the project-root `CODEBUDDY.md` conflict — the codegraph repo itself ships a `CODEBUDDY.md`, so the writer must use the existing marker-delimited section strategy (`<!-- CODEGRAPH_START --> ... <!-- CODEGRAPH_END -->`).
3. Implementing the `AGENTS.md` compat fallback that CodeBuddy documents as "if `CODEBUDDY.md` absent and `AGENTS.md` present, load `AGENTS.md`".

## Goals / Non-Goals

**Goals:**
- Zero-touch install: `codegraph install --target=codebuddy` writes 2 files and is idempotent on re-run.
- Coexist peacefully with existing project files (`CODEBUDDY.md`, `AGENTS.md`, `.mcp.json` containing sibling MCP servers).
- Auto-detection: `--target=auto` picks up CodeBuddy when `~/.codebuddy/` or `<workspace>/.codebuddy/` exists.
- Full reversibility: `uninstall()` strips only what we added; sibling content preserved.

**Non-Goals:**
- No CodeBuddy CLI invocation (we don't shell out to `codebuddy` — agents launch the MCP server themselves).
- No permissions / auto-allow concept (CodeBuddy has no equivalent; `opts.autoAllow` is silently ignored, matching Cursor/Codex/opencode behavior).
- No new MCP server features. The MCP server is agent-agnostic and untouched.
- No support for CodeBuddy CLI / CodeBuddy Code (the CLI variant) in this proposal — only the IDE. CLI support can be a follow-up proposal if requested.

## Decisions

### Decision 1: TargetId = `codebuddy` (not `codebuddy-ide`)
**Why**: Short, matches the existing pattern (`claude`, `cursor`, `codex`, `opencode`), reads cleanly in `--target=codebuddy`. Display name remains `CodeBuddy IDE`.
**Alternatives considered**:
- `codebuddy-ide` — clearer about IDE-vs-CLI distinction, but verbose in command lines.
- `tencent-codebuddy` — over-qualified, none of the other targets are vendor-prefixed.

### Decision 2: Config paths
| Location | Path |
|---|---|
| global MCP | `~/.codebuddy/mcp.json` |
| local MCP | `<workspace>/.mcp.json` |
| global instructions | `~/.codebuddy/rules/codegraph/RULE.mdc` |
| local instructions | `<workspace>/CODEBUDDY.md` (or `<workspace>/AGENTS.md` if the former absent and latter present) |

**Why**:
- Project-level `.mcp.json` is documented by CodeBuddy 4.0.0 release notes ("新增项目级 MCP 支持，可在项目根目录中配置 .mcp.json 文件").
- User-level `mcp.json` path is not explicitly documented; we adopt `~/.codebuddy/mcp.json` because (a) `~/.codebuddy/` is CodeBuddy's user config root (`settings.json`, `models.json`, `commands/`, `rules/` all live there), (b) the file shape (`{"mcpServers": {...}}`) is identical to project-level `.mcp.json`, and (c) Cursor follows the exact same `~/.cursor/mcp.json` pattern, which is the closest sibling target.
- Rules with `alwaysApply: true` in `~/.codebuddy/rules/<name>/RULE.mdc` get auto-loaded into every CodeBuddy session — exactly what we want for tool-usage guidance.
- Local `CODEBUDDY.md` is CodeBuddy's documented "no-frontmatter quick path" for project instructions. We use marker-delimited section (`<!-- CODEGRAPH_START --> ... <!-- CODEGRAPH_END -->`) so the file can coexist with user-authored content.
- `AGENTS.md` fallback: CodeBuddy doc explicitly says "为保持向后兼容，当项目根目录存在 AGENTS.md 而不存在 CODEBUDDY.md 时，CodeBuddy 将自动加载 AGENTS.md 的完整内容到对话上下文中"; we honor this so projects already standardized on `AGENTS.md` (like codegraph itself ships one) don't get a duplicate file.

**Risk**: If CodeBuddy IDE has a different user-level MCP path internally (not documented), `~/.codebuddy/mcp.json` may not be auto-loaded. We mitigate by emitting a `WriteResult.notes` hint: "If CodeBuddy IDE doesn't pick up codegraph automatically, open Settings → MCP and confirm `~/.codebuddy/mcp.json` is registered."

### Decision 3: MCP-server config shape
Same as Claude/Cursor (reuse `getMcpServerConfig()` from `shared.ts`):
```json
{
  "type": "stdio",
  "command": "codegraph",
  "args": ["serve", "--mcp"]
}
```
No `--path` injection (CodeBuddy launches with workspace cwd according to user reports; if a future bug surfaces we can mirror Cursor's `--path ${workspaceFolder}` trick).

### Decision 4: Instructions body
Reuse `INSTRUCTIONS_TEMPLATE` from `src/installer/instructions-template.ts` verbatim. Same agent-agnostic body Cursor/opencode/Codex use. Local `CODEBUDDY.md` writes the body inside markers (no frontmatter). Global `~/.codebuddy/rules/codegraph/RULE.mdc` prepends frontmatter:
```
---
description: CodeGraph MCP usage guide — when to use which tool
alwaysApply: true
enabled: true
---
```
This mirrors Cursor's `.mdc` frontmatter pattern.

### Decision 5: `wireProjectSurfaces()` implementation
Same pattern as Cursor: when a user has CodeBuddy configured globally (`detect('global').alreadyConfigured === true`), `codegraph init` calls `wireProjectSurfaces()` which writes the local `CODEBUDDY.md` marker block (no MCP file, since `.mcp.json` is optional locally — global `~/.codebuddy/mcp.json` already covers all projects).

### Decision 6: Detection heuristics
- `detect('global').installed` = `fs.existsSync(~/.codebuddy/)` OR `fs.existsSync(~/.codebuddy/settings.json)` OR `fs.existsSync(~/.codebuddy/models.json)`
- `detect('local').installed` = `fs.existsSync(<workspace>/.codebuddy/)` OR `fs.existsSync(<workspace>/.mcp.json)` OR `fs.existsSync(<workspace>/CODEBUDDY.md)`
- `alreadyConfigured` = `mcpServers.codegraph` exists in the location-specific MCP JSON file

These are best-effort — false positives are fine (the user can deselect in the multiselect prompt); false negatives just mean the user has to opt in manually via `--target=codebuddy`.

## Risks / Trade-offs

| Risk | Severity | Mitigation |
|---|---|---|
| CodeBuddy changes its config path conventions in a future release | Medium | All paths are centralized in single helpers (`mcpJsonPath`, `instructionsPath` functions inside `codebuddy.ts`) — single-point future adjustment |
| User-level `~/.codebuddy/mcp.json` is not auto-discovered by CodeBuddy IDE | Medium | Emit `WriteResult.notes` advisory message on every global install; document in instructions block |
| Pre-existing `CODEBUDDY.md` in the workspace (very common — e.g., the codegraph repo itself has one) gets clobbered | High | Use existing `replaceOrAppendMarkedSection` helper from `shared.ts`; only the marker-delimited section is touched; appended (not replaced) when markers absent |
| `AGENTS.md` vs `CODEBUDDY.md` ambiguity | Low | Single deterministic rule: prefer `CODEBUDDY.md`; only write `AGENTS.md` when `CODEBUDDY.md` does not exist AND `AGENTS.md` exists |
| Test pollution of real `~/.codebuddy/` | High | Reuse the `installer-targets.test.ts` pattern: `process.env.HOME` redirected to `mkdtempSync` tmpdir, `process.chdir` to a tmp cwd, full cleanup in `afterEach` |
| Permission state inconsistency on re-install | Low | CodeBuddy has no permissions concept → no state to drift |

## Migration Plan

Pure additive. No migration needed.

- Existing users running `codegraph install --target=auto` without `~/.codebuddy/` present: zero behavior change.
- Existing users with `~/.codebuddy/` present (already use CodeBuddy): on next `codegraph install`, CodeBuddy is **pre-selected** in the multiselect (because `detect.installed=true`). They can deselect if they don't want it.
- Rollback: `codegraph uninstall --target=codebuddy` (via the existing per-target uninstall machinery) strips all 2 files / sections.

## Open Questions

1. Should we also write a project-level `<workspace>/.codebuddy/rules/codegraph/RULE.mdc` (project-rule equivalent of the user rule)?
   - **Tentative decision**: No, for now. The `CODEBUDDY.md` marker block already gets always-loaded by CodeBuddy IDE per its docs. Adding a project rule on top would duplicate the instructions. Can revisit if user feedback says otherwise.
2. Should CodeBuddy CLI / CodeBuddy Code (the CLI variant, with `~/.codebuddy/commands/`) get a separate target id?
   - **Tentative decision**: Out of scope for this proposal. The CLI variant uses different configuration conventions (commands/) that warrant a separate `codebuddy-cli` target id in a future proposal if there's demand.
