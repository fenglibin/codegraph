# Tasks: Add CodeBuddy IDE as a supported installer target

## 1. Scaffolding & Spec Lock-in (B1)

- [x] 1.1 Run `openspec validate add-codebuddy-installer-target --strict` and resolve any complaints before any source code touches.
- [x] 1.2 Confirm scope with the user — five edge decisions listed in `docs/add-codebuddy-installer-target-rationale.md` §8 (TargetId string, detection heuristics, `autoAllow` behavior, `wireProjectSurfaces` policy, MCP path choice). Default to the recommended choices unless the user objects.
- [x] 1.3 No code changes in this batch — implementation begins in §2 after sign-off.

## 2. Add the `codebuddy` target source (B2)

- [x] 2.1 Extend `TargetId` union in `src/installer/targets/types.ts` to include `'codebuddy'`.
- [x] 2.2 Create `src/installer/targets/codebuddy.ts` implementing `AgentTarget`:
  - [x] 2.2.1 Path helpers: `mcpJsonPath(loc)`, `instructionsPath(loc)`, `userRulePath()`, `codebuddyMdPath()`, `agentsMdPath()`, `resolveLocalInstructionsPath()`.
  - [x] 2.2.2 `supportsLocation(loc)` returns true for both.
  - [x] 2.2.3 `detect(loc)` — installed heuristic + `alreadyConfigured` from `mcpServers.codegraph` presence.
  - [x] 2.2.4 `install(loc, opts)` — writes 2 files; ignores `opts.autoAllow`. Emits `notes` advisory on global install.
  - [x] 2.2.5 `uninstall(loc)` — strips `mcpServers.codegraph` (preserving siblings); deletes lone `.mcp.json` file when no siblings remain; deletes `~/.codebuddy/rules/codegraph/RULE.mdc` entirely (since we own that file outright); strips marker block from whichever local file holds it (`CODEBUDDY.md` or `AGENTS.md`).
  - [x] 2.2.6 `printConfig(loc)` — emit a paste-ready JSON snippet for both locations.
  - [x] 2.2.7 `describePaths(loc)` — return both target paths.
  - [x] 2.2.8 `wireProjectSurfaces()` — writes only the project-level `CODEBUDDY.md` marker block.
  - [x] 2.2.9 Internal helper: when writing local instructions, prefer `CODEBUDDY.md`; fall back to existing `AGENTS.md` only when `CODEBUDDY.md` does not exist on disk.
  - [x] 2.2.10 Reuse `getMcpServerConfig()`, `readJsonFile()`, `writeJsonFile()`, `jsonDeepEqual()`, `atomicWriteFileSync()`, `replaceOrAppendMarkedSection()`, `removeMarkedSection()` from `shared.ts` — no duplication.
- [x] 2.3 Register the target in `src/installer/targets/registry.ts`: import + add to `ALL_TARGETS`.
- [x] 2.4 Run `npm run build` — TypeScript compiles with zero errors.

## 3. Test (B2 closing — dev-workflow 阶段 4.5 当场写测当场过)

- [x] 3.1 Created `__tests__/codebuddy-target.test.ts` with 20 test cases covering:
  - [x] 3.1.1 正常 / global install + idempotency
  - [x] 3.1.2 正常 / local install fresh project
  - [x] 3.1.3 边界 / AGENTS.md fallback when CODEBUDDY.md absent
  - [x] 3.1.4 边界 / sibling MCP server preservation (global and local)
  - [x] 3.1.5 边界 / wireProjectSurfaces writes only CODEBUDDY.md + is idempotent
  - [x] 3.1.6 边界 / preserves both files when CODEBUDDY.md and AGENTS.md exist (prefers CODEBUDDY.md)
  - [x] 3.1.7 异常 / uninstall on never-installed state returns not-found cleanly
  - [x] 3.1.8 异常 / uninstall preserves siblings + rest of CODEBUDDY.md
  - [x] 3.1.9 异常 / uninstall removes RULE.mdc file + cleans up empty dir
  - [x] 3.1.10 printConfig outputs parseable JSON
  - [x] 3.1.11 printConfig writes no files (read-only)
  - [x] 3.1.12 frontmatter correctness (alwaysApply: true, enabled: true)
  - [x] 3.1.13 resolveTargetFlag('all') includes codebuddy
  - [x] 3.1.14 resolveTargetFlag('codebuddy') returns only codebuddy
  - [x] 3.1.15 detect('local') signal — CODEBUDDY.md existence
  - [x] 3.1.16 detect('global') signal — settings.json existence
  - [x] 3.1.17 describePaths returns both MCP + instructions paths
- [x] 3.2 Used `os.homedir` redirection + `process.chdir(tmpCwd)` pattern from `installer-targets.test.ts` — no real `~/.codebuddy/` touched.
- [x] 3.3 Run `npx vitest run __tests__/codebuddy-target.test.ts` — 20/20 passing.
- [x] 3.4 Run `npx vitest run __tests__/installer-targets.test.ts` — 71/71 passing (parameterized contract suite picked up codebuddy automatically, +~14 new test cases auto-covered).

## 4. Anti-laziness scan (B3)

- [x] 4.1 Grep the new files for `TODO`, `FIXME`, `console.log`, ` as any`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, empty function bodies, swallowed catches, hardcoded URLs — all clean (only docsUrl present, mirroring other targets).
- [x] 4.2 Confirm `npm test` full suite: 646 passing / 3 pre-existing failures in `watcher.test.ts` confirmed unrelated via `git stash` baseline comparison (same 3 fail without our changes too — they're environment-dependent FileWatcher debounce tests, present on main branch).

## 5. Documentation (B4)

- [x] 5.1 `README.md` — added CodeBuddy IDE badge to the supported-agents shield row, updated installer banner, updated `installer.will:` list, updated footer credit line.
- [x] 5.2 `CLAUDE.md` — `Current targets:` line in the "Multi-agent installer" section now lists 5 files (including `codebuddy.ts`).
- [x] 5.3 `CHANGELOG.md` — added `## [Unreleased]` block above `[0.8.0]` with `### Added` entry describing CodeBuddy support.

## 6. Validation Gates (B5)

- [x] 6.1 `openspec validate add-codebuddy-installer-target --strict` passes (`Change 'add-codebuddy-installer-target' is valid`).
- [x] 6.2 Build artifact verified: `npm run build` succeeded, `dist/installer/targets/codebuddy.js` exists.
- [x] 6.3 Run-through smoke covered by the 20-case codebuddy-target test suite (global + local + idempotency + uninstall + wireProjectSurfaces, all via deterministic API calls in tmpdir).
- [x] 6.4 Update `docs/add-codebuddy-installer-target-rationale.md` §10 with implementation summary — _done; includes batches, 4-way traceability matrix, blind-spot retrospective, anti-laziness scan, compatibility check, backlog._
- [ ] 6.5 `openspec archive add-codebuddy-installer-target --yes` — _to be run after user reviews + approves._

## 7. Reporting

- [x] 7.1 Progress reported in chat after each batch close: B1 → B2 → B3 → B4 → B5 (this checklist update is the B5 marker).
- [x] 7.2 No open question outside scope arose. Auto-advanced per user's permanent "auto-recurse" directive.
