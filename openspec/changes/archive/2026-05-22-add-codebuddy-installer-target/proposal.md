# Change: Add CodeBuddy IDE as a supported installer target

## Why

CodeGraph today auto-configures four MCP-capable agents (Claude Code, Cursor, Codex CLI, opencode) but does not support **CodeBuddy IDE** — Tencent's AI coding IDE that has shipped first-class MCP support (`{"mcpServers": {...}}` JSON, project-level `.mcp.json` since v4.0.0, user-level `~/.codebuddy/` directory, `CODEBUDDY.md` / `AGENTS.md` project instructions, `~/.codebuddy/rules/*/RULE.mdc` user rules). CodeBuddy users today must hand-paste codegraph's MCP block and the per-agent instructions, which defeats the "one-shot installer" promise. Adding CodeBuddy as a 5th `AgentTarget` is the smallest possible extension of the existing plug-in architecture.

## What Changes

- **ADD** a new `installer-targets` capability that documents the `AgentTarget` plug-in contract and the per-agent surfaces every target writes (this capability is implicit today but was never spec'd; this proposal makes it explicit so CodeBuddy and future targets have a stable contract to extend).
- **ADD** a new agent target `codebuddy` to the installer target registry:
  - Writes MCP server entry to `~/.codebuddy/mcp.json` (global) or `<workspace>/.mcp.json` (local), using the same `{"mcpServers": {...}}` JSON shape as Claude/Cursor.
  - Writes instructions block to `~/.codebuddy/rules/codegraph/RULE.mdc` (global, with `.mdc` frontmatter `alwaysApply: true`) or `<workspace>/CODEBUDDY.md` (local, marker-delimited section). Falls back to `<workspace>/AGENTS.md` when `CODEBUDDY.md` is absent and `AGENTS.md` exists (CodeBuddy's documented compat path).
  - Detects presence via `~/.codebuddy/` (global) or `<workspace>/.codebuddy/` / `<workspace>/.mcp.json` / `<workspace>/CODEBUDDY.md` (local).
  - Implements `wireProjectSurfaces` so `codegraph init` adds the project-level `CODEBUDDY.md` marker block for users who configured CodeBuddy globally.
  - Idempotent install/uninstall preserves sibling MCP servers and unrelated `CODEBUDDY.md` content (marker-block strategy).
  - `autoAllow` is a no-op (CodeBuddy has no permissions auto-allow concept).
- **ADD** the `codebuddy` target id to the `TargetId` union, `ALL_TARGETS` registry, `--target=auto/all` resolution, and the `--print-config` CLI flag.
- **ADD** parameterized contract coverage in `installer-targets.test.ts` and a dedicated `codebuddy-target.test.ts` for CodeBuddy-only behaviors (frontmatter, AGENTS.md fallback, project-vs-user MCP path split).
- **UPDATE** `README.md`, `CLAUDE.md`, `CHANGELOG.md` to surface the new agent.

## Impact

- **Affected specs**: `installer-targets` (new capability spec, ADDED requirements).
- **Affected code**:
  - New: `src/installer/targets/codebuddy.ts`
  - Modified: `src/installer/targets/types.ts` (TargetId union)
  - Modified: `src/installer/targets/registry.ts` (one new entry in `ALL_TARGETS`)
  - New: `__tests__/codebuddy-target.test.ts`
  - Updated: `README.md`, `CLAUDE.md`, `CHANGELOG.md`
- **No changes** to the MCP server itself (it is already agent-agnostic) or to any extraction/resolution/graph/sync layer.
- **No new dependencies**.
- **Backwards compatible**: existing 4 targets unchanged; existing users see no diff unless they explicitly opt into `--target=codebuddy` or have `~/.codebuddy/` present (then `--target=auto` includes it).
