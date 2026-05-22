# installer-targets Specification

## Purpose
TBD - created by archiving change add-codebuddy-installer-target. Update Purpose after archive.
## Requirements
### Requirement: Plug-in Agent Target Contract

The installer SHALL define a stable plug-in interface (`AgentTarget`) so that each MCP-capable agent (Claude Code, Cursor, Codex CLI, opencode, CodeBuddy IDE, and any future target) is implemented as a single self-contained file under `src/installer/targets/` and a single entry in `src/installer/targets/registry.ts`.

Every `AgentTarget` MUST own the following surfaces for its agent and MUST NOT bake agent-specific paths into orchestrator or shared code:
- A stable string `id` (kebab-case lowercase) and a human-readable `displayName`.
- `supportsLocation(loc: 'global' | 'local')` — declares which install locations are valid for this agent.
- `detect(loc)` — best-effort presence and configured-state heuristics, returning `{installed, alreadyConfigured, configPath?}`.
- `install(loc, opts)` — writes MCP server config + instructions + optional permissions. Returns a list of `{path, action}` entries where `action ∈ {created, updated, unchanged, removed, not-found, kept}`.
- `uninstall(loc)` — inverse of install. Removes only what install would have written. Preserves sibling MCP servers, sibling permissions, and unrelated content in shared files.
- `printConfig(loc)` — emits a paste-ready non-empty configuration snippet without touching the filesystem.
- `describePaths(loc)` — returns the filesystem paths this target would write to at the given location.
- Optional `wireProjectSurfaces()` — for agents whose project-local surfaces are needed even when the MCP server is configured globally.

#### Scenario: A new agent is added as a single new file + one registry entry
- **WHEN** a contributor adds a new MCP-capable agent (e.g., CodeBuddy IDE)
- **THEN** the change set includes exactly one new `src/installer/targets/<id>.ts` file implementing `AgentTarget`, and exactly one new entry appended to `ALL_TARGETS` in `src/installer/targets/registry.ts`
- **AND** the `--target=auto`, `--target=all`, `--target=<id>` CLI flags resolve the new agent automatically without orchestrator changes
- **AND** the parameterized contract suite in `__tests__/installer-targets.test.ts` covers the new target without per-target boilerplate

#### Scenario: Idempotent install across all targets
- **WHEN** any `AgentTarget.install(loc, opts)` is invoked twice with the same inputs
- **THEN** every file in the second call's `WriteResult.files` MUST have `action='unchanged'`
- **AND** every file's on-disk content is byte-identical to the first call's output

#### Scenario: Sibling preservation across all targets
- **WHEN** an `AgentTarget` writes to a shared config file (e.g., `~/.claude.json`, `~/.cursor/mcp.json`, `~/.codebuddy/mcp.json`) that already contains a sibling MCP server unrelated to codegraph
- **THEN** install MUST preserve the sibling exactly
- **AND** uninstall MUST remove only the codegraph entry, leaving the sibling intact

### Requirement: CodeBuddy IDE Agent Target

The installer SHALL provide a CodeBuddy IDE target with `id='codebuddy'` and `displayName='CodeBuddy IDE'` that integrates CodeGraph's MCP server with CodeBuddy IDE following CodeBuddy's documented configuration conventions.

The CodeBuddy target MUST:
- Support both `global` and `local` install locations.
- Write the MCP server entry to `~/.codebuddy/mcp.json` (global) or `<workspace>/.mcp.json` (local), using the standard `{"mcpServers": {"codegraph": {"type": "stdio", "command": "codegraph", "args": ["serve", "--mcp"]}}}` JSON shape.
- Write the agent instructions block to `~/.codebuddy/rules/codegraph/RULE.mdc` (global) with `.mdc` frontmatter including `alwaysApply: true` and `enabled: true`, or to `<workspace>/CODEBUDDY.md` (local) as a marker-delimited section using the `<!-- CODEGRAPH_START --> ... <!-- CODEGRAPH_END -->` markers.
- When writing local instructions and `CODEBUDDY.md` does not exist but `AGENTS.md` does, write the marker block to `AGENTS.md` instead — honoring CodeBuddy's documented fallback "if `CODEBUDDY.md` absent and `AGENTS.md` present, load `AGENTS.md`."
- Treat `opts.autoAllow` as a no-op (CodeBuddy IDE has no permissions auto-allow concept).
- Implement `wireProjectSurfaces()` so `codegraph init` adds the project-local `CODEBUDDY.md` marker block when CodeBuddy is configured globally.
- Be included in `--target=auto` resolution whenever `~/.codebuddy/` (global probe) or `<workspace>/.codebuddy/` / `<workspace>/.mcp.json` / `<workspace>/CODEBUDDY.md` (local probe) is present.
- Be included in `--target=all` resolution unconditionally.
- Support `--print-config codebuddy` returning a paste-ready JSON snippet for the appropriate location.

#### Scenario: Global install writes user MCP config and user rule
- **WHEN** `codegraph install --target=codebuddy --location=global --yes` runs in an environment where `~/.codebuddy/` does not yet exist
- **THEN** two files are created: `~/.codebuddy/mcp.json` (containing `mcpServers.codegraph`) and `~/.codebuddy/rules/codegraph/RULE.mdc` (containing the standard CodeGraph instructions with frontmatter `alwaysApply: true`)
- **AND** `detect('global')` thereafter returns `{installed: true, alreadyConfigured: true}`

#### Scenario: Local install writes project MCP and instructions
- **WHEN** `codegraph install --target=codebuddy --location=local --yes` runs in a project directory with no pre-existing CodeBuddy files
- **THEN** two files are created: `<workspace>/.mcp.json` (containing `mcpServers.codegraph`) and `<workspace>/CODEBUDDY.md` (containing the CodeGraph instructions inside marker delimiters)

#### Scenario: Local install with pre-existing CODEBUDDY.md preserves user content
- **WHEN** the project root already contains a `CODEBUDDY.md` with user-authored sections
- **AND** `codegraph install --target=codebuddy --location=local` runs
- **THEN** the CodeGraph marker block is appended (or replaced if it already exists) inside `<!-- CODEGRAPH_START --> ... <!-- CODEGRAPH_END -->`
- **AND** every byte of the user-authored content outside those markers is preserved exactly

#### Scenario: AGENTS.md fallback when CODEBUDDY.md is absent
- **WHEN** the project root has no `CODEBUDDY.md` but does have an `AGENTS.md`
- **AND** `codegraph install --target=codebuddy --location=local` runs
- **THEN** the CodeGraph marker block is written into `AGENTS.md` (not `CODEBUDDY.md`)
- **AND** no `CODEBUDDY.md` file is created

#### Scenario: Idempotent re-install
- **WHEN** `codegraph install --target=codebuddy --location=<global|local>` is invoked twice
- **THEN** every file in the second call's `WriteResult.files` has `action='unchanged'`
- **AND** files on disk are byte-identical to the first invocation's output

#### Scenario: Sibling MCP server preservation
- **WHEN** the MCP config file already contains a sibling entry such as `mcpServers.figma`
- **AND** `codegraph install --target=codebuddy` runs
- **THEN** the sibling entry survives byte-identical
- **AND** subsequent `codegraph install --target=codebuddy` uninstall via `target.uninstall()` removes only `mcpServers.codegraph`, leaving `mcpServers.figma` intact

#### Scenario: `--target=auto` selects CodeBuddy when present
- **WHEN** `~/.codebuddy/` exists on the system
- **AND** `codegraph install --target=auto --location=global` runs
- **THEN** the CodeBuddy target is among the resolved agents and is configured

#### Scenario: `wireProjectSurfaces()` writes project surfaces for global users
- **WHEN** a user has globally configured CodeBuddy (`detect('global').alreadyConfigured === true`)
- **AND** `codegraph init` runs in a fresh project
- **THEN** `<workspace>/CODEBUDDY.md` is created (or updated via marker block) with the CodeGraph instructions
- **AND** no project-level `.mcp.json` is forced (the global `~/.codebuddy/mcp.json` covers all projects)

#### Scenario: Uninstall on a never-installed state
- **WHEN** `target.uninstall('global')` runs and `~/.codebuddy/mcp.json` does not exist
- **THEN** the call returns successfully with `action='not-found'` entries
- **AND** no exception is thrown
- **AND** no file is created or modified

#### Scenario: printConfig returns parseable JSON
- **WHEN** `target.printConfig('global')` or `target.printConfig('local')` is invoked
- **THEN** the returned string contains a JSON snippet with `mcpServers.codegraph.command === 'codegraph'`
- **AND** parsing that JSON snippet with `JSON.parse` succeeds (modulo a `# Add to <path>` header line)

### Requirement: Bilingual Agent Instructions Template

The shared `INSTRUCTIONS_TEMPLATE` written by every `AgentTarget` into its agent's conventional instructions file (CLAUDE.md / AGENTS.md / codegraph.mdc / CODEBUDDY.md / RULE.mdc) SHALL contain both an English section and a Chinese mirror section inside the existing marker pair. The Chinese mirror SHALL include the same structural content as the English section (mandatory rules, when-to-prefer-codegraph guidance, rules of thumb, fallback prompt) so non-Claude models reading their conventional instructions file in their training-language register also encounter the codegraph playbook in usable form. The marker pair `<!-- CODEGRAPH_START --> ... <!-- CODEGRAPH_END -->` SHALL remain byte-identical across the bilingual rewrite — five installers (claude, cursor, codex, opencode, codebuddy) detect and replace the section by exact marker match. The bilingual template SHALL stay within a per-project budget of 8000 characters so the additive weight of the Chinese mirror does not balloon every agent file.

#### Scenario: Marker strings unchanged after bilingual rewrite
- **WHEN** the `INSTRUCTIONS_TEMPLATE` constant is read
- **THEN** it begins with the literal `<!-- CODEGRAPH_START -->`
- **AND** ends with the literal `<!-- CODEGRAPH_END -->`
- **AND** each marker appears exactly once (no nesting, no duplication)

#### Scenario: English section preserved verbatim
- **WHEN** the bilingual template is rendered
- **THEN** the English section retains the `codegraph_callers`,
  `codegraph_explore`, `codegraph_status` tool references that the
  existing installer-targets test suite asserts
- **AND** retains the "If `.codegraph/` doesn't exist" fallback prompt
  with the `codegraph init -i` command verbatim

#### Scenario: Chinese mirror section follows English with own heading
- **WHEN** the template is read
- **THEN** it contains a `## CodeGraph（中文）` heading after the
  English `## CodeGraph` heading
- **AND** the index of `## CodeGraph（中文）` is strictly greater than
  the index of `## CodeGraph\n` (English first, Chinese mirror after)

#### Scenario: Chinese mandatory rules block contains 5 绝不 rules
- **WHEN** the template is read
- **THEN** it contains the literal `🚫 强制规则`
- **AND** contains at least 5 instances of `**绝不**` (one per rule)
- **AND** mentions `DeepSeek、Qwen、GLM` (allowing line wraps via
  dot-all matching since Chinese commas wrap at column 80)

#### Scenario: Bilingual drift guard for low-confidence threshold
- **WHEN** the template is read
- **THEN** the English section contains the literal `confidence < 0.7`
- **AND** the Chinese section contains the literal `置信度 < 0.7`

#### Scenario: Bilingual drift guard for index-age threshold
- **WHEN** the template is read
- **THEN** the English section contains the literal `over 30 minutes`
- **AND** the Chinese section contains the literal `30 分钟`

#### Scenario: Template length within reasonable budget
- **WHEN** the template is read
- **THEN** its character length is greater than 3000 (Chinese mirror
  cannot be silently deleted)
- **AND** less than 8000 (future edits cannot drift into runaway prose)

#### Scenario: Idempotent re-install survives bilingual rewrite
- **WHEN** any of the 5 installer targets (claude, cursor, codex,
  opencode, codebuddy) runs `install()` twice with the same inputs
- **THEN** every file in the second call's `WriteResult.files` has
  `action='unchanged'`
- **AND** on-disk content is byte-identical to the first call
- **AND** the previously-passing 84 cases in `installer-targets.test.ts`
  continue to pass with no test modification

