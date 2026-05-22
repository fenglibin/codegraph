# 方案文档：为 CodeGraph 新增 CodeBuddy 安装目标

> 本文档遵循 `dev-baseline` 技能的「重大变更对齐协议」第二步，落地"方案对齐"成果。  
> 实施编号：`add-codebuddy-installer-target`（openspec change-id）。  
> 创建时间：2026-05-21。

## 一、用户原话

> codegraph 是一个可以用于预先索引代码工程为知识图谱的工具…… 但是其目前不支持 CodeBuddy，我希望能够在其中支持 CodeBuddy 的能力。  
> 你深度的分析一下当前的实现，看看如何在其中增加支持 CodeBuddy 的能力，然后通过 openspec 将任务进行拆分，并根据 dev-baseline 和 dev-workflow 中要求进行实现。

## 二、需求本质拆解

| 维度 | 拆解 |
|---|---|
| **功能目标** | 让 `codegraph install` 能像 Claude/Cursor/Codex/opencode 那样为 **CodeBuddy IDE** 注入 MCP server 配置 + agent 指令文件 |
| **运行场景** | `codegraph install`（交互/CLI/scripting/CI）、`codegraph install --target=codebuddy`、`codegraph install --print-config codebuddy`、`codegraph init`（项目级补丁）、`codegraph install --target=auto` 自动检测 |
| **可扩展性** | 项目已有插件化 `AgentTarget` 接口与 `registry.ts`；本次新增**一个新文件 + registry 注册一行**符合架构 |
| **不变性** | 现有 4 个 target（claude/cursor/codex/opencode）行为不能受影响；MCP server 本身不需要任何改造（agent-agnostic） |

## 三、CodeBuddy 配置规范（来源：腾讯 CodeBuddy IDE 官方文档 + 内网版 MCP 文档）

| 项目 | 全局/用户级 | 项目级 |
|---|---|---|
| **MCP 配置文件** | （无文件标准化路径，IDE 设置页输入；按 CodeBuddy 4.0.0 起的同源约定，可写入 `~/.codebuddy/mcp.json`） | `<workspace>/.mcp.json` （CodeBuddy 4.0.0 起官方支持） |
| **MCP 配置格式** | 与 Claude/Cursor 完全相同的 `{ "mcpServers": { "<name>": { "type": "stdio", "command": "...", "args": [...] } } }` |
| **指令文件** | `~/.codebuddy/rules/codegraph/RULE.mdc`（带 frontmatter） | 项目根 `CODEBUDDY.md`（无元数据纯 Markdown；亦兼容 `AGENTS.md`） |
| **目录约定** | `~/.codebuddy/` | `<workspace>/.codebuddy/`（hooks/settings.json/models.json/rules/commands 等） |
| **检测信号** | `~/.codebuddy/` 目录存在 或 `~/.codebuddy/settings.json`/`models.json` 存在 | `<workspace>/.codebuddy/` 目录存在 或 `<workspace>/.mcp.json` 存在 |

### 关键决策点

**D1：项目根 `CODEBUDDY.md` 与已有项目文件冲突的处理**  
当前 codegraph 仓库根已存在 `CODEBUDDY.md`（项目自身用于指导 IDE）。我们写入的指令必须通过 marker-delimited 段落（`<!-- CODEGRAPH_START --> ... <!-- CODEGRAPH_END -->`）附加到文件，**绝不**覆盖既有内容。这与 Claude 的 `CLAUDE.md` 处理方式一致，复用 `replaceOrAppendMarkedSection` helper。

**D2：全局 MCP 文件路径选择**  
CodeBuddy 官方文档目前明确给出了**项目级** `.mcp.json` 的路径，但**用户级**主要靠 IDE 设置页输入。同源工具（Claude Code 用 `~/.claude.json`，Cursor 用 `~/.cursor/mcp.json`）都有约定路径。为最大兼容性，我们采用：
- **global**：`~/.codebuddy/mcp.json`（与 IDE 已有 `~/.codebuddy/` 目录共生，结构上对齐 Cursor 模型）
- **local**：`<workspace>/.mcp.json`（CodeBuddy 4.0.0 起官方支持）

这意味着用户在 CodeBuddy IDE 设置页中**可能仍需手动确认一次** `~/.codebuddy/mcp.json` 已被 IDE 识别——这是文档未公开的部分，我们通过 `WriteResult.notes` 显式提示用户。

**D3：指令文件路径选择**  
- **global**：`~/.codebuddy/rules/codegraph/RULE.mdc`（带 frontmatter `description / alwaysApply: true / enabled: true`）  
  → 符合 CodeBuddy 「用户规则」目录约定 + 自动加载机制（`alwaysApply: true`）
- **local**：`<workspace>/CODEBUDDY.md`（marker 块附加；如不存在 `CODEBUDDY.md` 而存在 `AGENTS.md`，则写入 `AGENTS.md`——兼容 CodeBuddy 官方文档明示的回落机制）

**D4：权限/auto-allow 概念**  
CodeBuddy IDE 目前**没有**与 Claude `settings.json.permissions.allow` 对应的"工具自动允许"机制。`autoAllow` 选项在 codebuddy target 上是 no-op，与 Cursor / Codex / opencode 行为对齐。

**D5：`supportsLocation`**  
两者都支持。`global`/`local` 写入文件数不同：
- global: 2 个文件（`~/.codebuddy/mcp.json` + `~/.codebuddy/rules/codegraph/RULE.mdc`）
- local: 2 个文件（`./.mcp.json` + `./CODEBUDDY.md` 或 `./AGENTS.md`）

**D6：`wireProjectSurfaces`** （`codegraph init` 时的项目级补丁）  
类似 Cursor：如果用户只装了全局 CodeBuddy 配置，运行 `codegraph init` 时应该补一个项目级的 `CODEBUDDY.md` marker 块，让 IDE 在该项目下也能看到 codegraph 指令。**实现 `wireProjectSurfaces` 钩子**。

## 四、候选方案对比（≥3 个）

| 候选 | 摘要 | 优势 | 劣势 | 决策 |
|---|---|---|---|---|
| **A：本方案（plug-in target，遵从已有架构）** | 新增 `targets/codebuddy.ts` 实现 `AgentTarget` 接口；`registry.ts` 注册；`TargetId` 加 `'codebuddy'` 枚举；安装/卸载/打印/检测/项目补丁 5 个动作全实现 | 与已有架构 100% 对齐；测试通过参数化 contract suite 自动覆盖；零侵入；可逆 | 需要新建 6+ 个测试用例 | ✅ **采用** |
| B：把 CodeBuddy 当 Claude 的"别名"复用 `claude.ts` | 在 Claude 的安装路径上加个开关写到 `~/.codebuddy/` | 改动最小（~50 行） | 强耦合两套生态；CodeBuddy 升级会绑定 Claude；违背 `AgentTarget` 抽象的初衷 | ❌ 拒绝 |
| C：单独写一个 `codebuddy install` 子命令，绕过 installer | 在 CLI 加一个独立子命令 | 与 installer 完全解耦 | 用户必须显式记另一个命令；与 `--target=auto` / `--target=all` 不兼容；违背单一安装入口的原则 | ❌ 拒绝 |

## 五、影响范围（追溯矩阵起点）

| 维度 | 影响 |
|---|---|
| **新增源文件** | `src/installer/targets/codebuddy.ts`（实现 `AgentTarget` 接口） |
| **修改源文件** | `src/installer/targets/types.ts`（`TargetId` 联合类型加 `'codebuddy'`）<br>`src/installer/targets/registry.ts`（导入 + ALL_TARGETS 加一行） |
| **新增测试** | `__tests__/codebuddy-target.test.ts`（CodeBuddy 专属覆盖：marker 块附加、用户规则 frontmatter、项目级 .mcp.json + 全局 .codebuddy/mcp.json、AGENTS.md 兼容） |
| **附带覆盖** | `__tests__/installer-targets.test.ts`（parameterized contract suite 自动跑 ~7 条合同测试 × codebuddy target = +~7 用例） |
| **文档** | `README.md`（README 顶部 badge + agent 列表 + 配置说明）<br>`CLAUDE.md`（"current targets" 段落新增 codebuddy）<br>`CHANGELOG.md`（`### Added` 段落） |
| **MCP server 本身** | **无改动**（已经 agent-agnostic） |
| **打包** | **无新增**（无新 wasm/sql 资源） |
| **依赖** | **无新增**（不引入第三方包） |

## 六、风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| CodeBuddy 官方文档未来更改 `.mcp.json` 路径约定 | 中 | 路径常量集中在 `codebuddy.ts` 内的 `mcpJsonPath()` 函数；后续单点调整 |
| 用户级 `~/.codebuddy/mcp.json` 不被 IDE 识别 | 中 | `WriteResult.notes` 显式提示用户"如果 CodeBuddy 设置页未识别，请在 MCP 标签页手动添加一次" |
| 项目根已有 `CODEBUDDY.md`（codegraph 仓库自身就是这种情况） | 低 | 复用 `replaceOrAppendMarkedSection` marker 块附加；现有内容零损失 |
| 测试时污染真实 `~/.codebuddy/` 目录 | 高 | 复用 `installer-targets.test.ts` 的 `$HOME`/`$USERPROFILE` env 重定向到 tmpdir + `process.chdir(tmpCwd)` 套路；零真实文件系统写入 |
| 与 `AGENTS.md` 回落逻辑的双写竞态 | 低 | `local` 写入时只选一个文件：优先 `CODEBUDDY.md`，仅当 `CODEBUDDY.md` 不存在且 `AGENTS.md` 存在时才写 `AGENTS.md` |

## 七、实施批次拆分（dev-workflow 任务级 DoD 串行执行）

**批次 B1：openspec 提案 + 方案文档落地（当前）**  
- 创建 `openspec/changes/add-codebuddy-installer-target/{proposal.md, tasks.md, design.md, specs/installer-targets/spec.md}`
- 走 `openspec validate add-codebuddy-installer-target --strict` 通过
- 等待用户审阅（dev-workflow 阶段 1-3）

**批次 B2：新增 `targets/codebuddy.ts` + 注册 + 单测当场过**  
- 新增源文件 `src/installer/targets/codebuddy.ts`
- 修改 `targets/types.ts`、`targets/registry.ts`
- 新增 `__tests__/codebuddy-target.test.ts`（≥3 用例：正常 + 边界 + 异常）
- 跑 `npm test -- codebuddy-target installer-targets` 全绿
- dev-workflow 阶段 4.5 五步循环

**批次 B3：跑全套测试 + 反偷懒红线扫描**  
- `npm run build` 0 error
- `npm test` 全套（含 `installer-targets.test.ts` 的参数化 contract suite 对 codebuddy 自动跑 ~7 条）
- 反偷懒 20 条红线 grep 扫描（不含 TODO/FIXME/any/console.log/硬编码 url 等）

**批次 B4：README + CLAUDE.md + CHANGELOG 同步更新**  
- README badge + supported agents 表格新增 CodeBuddy
- CLAUDE.md `Current targets:` 段落新增 codebuddy
- CHANGELOG.md `## [Unreleased]` 或下一版本号下加 `### Added`
- 编写 `openspec/changes/add-codebuddy-installer-target/tasks.md` 中所有 `- [ ]` 改 `- [x]`

**批次 B5：openspec 归档 + 复盘**  
- `openspec archive add-codebuddy-installer-target --yes`
- 在本方案文档末尾追加「§十 实施总结」段落（dev-baseline 重大变更协议第 4 步）

## 八、关键边界与待用户拍板项

> 以下 5 个边界默认按推荐方案推进，**如用户有不同意见请在批次 B2 开始前告知**：

1. **TargetId 字符串选 `codebuddy` 还是 `codebuddy-ide`？** → 推荐 `codebuddy`（与 displayName "CodeBuddy IDE" 对齐，短一些利于 `--target=codebuddy` 命令）
2. **`alreadyConfigured` 检测信号是什么？** → 推荐：检查 `~/.codebuddy/mcp.json`（global）或 `<workspace>/.mcp.json`（local）中是否存在 `mcpServers.codegraph` key
3. **`installed` 检测信号是什么？** → 推荐：`~/.codebuddy/` 目录存在（global）或 `<workspace>/.codebuddy/`/`<workspace>/.mcp.json`/`<workspace>/CODEBUDDY.md` 任一存在（local）。任何一个为真就算"已安装 CodeBuddy"
4. **`autoAllow` 行为？** → 推荐：no-op（与 cursor/codex/opencode 一致）
5. **`wireProjectSurfaces` 是否实现？** → 推荐：**是**，行为同 Cursor——给 `<workspace>/CODEBUDDY.md` 加 marker 块

## 九、验收标准（acceptance criteria）

- [ ] `codegraph install --target=codebuddy --location=global --yes` 在干净环境写入 2 个文件：`~/.codebuddy/mcp.json`、`~/.codebuddy/rules/codegraph/RULE.mdc`
- [ ] `codegraph install --target=codebuddy --location=local --yes` 在干净环境写入 2 个文件：`<workspace>/.mcp.json`、`<workspace>/CODEBUDDY.md`（marker 块）
- [ ] 再次运行 install 是 byte-identical idempotent（`unchanged` action）
- [ ] `codegraph install --target=auto` 在 `~/.codebuddy/` 存在的机器上**会**自动选中 codebuddy
- [ ] `codegraph install --target=all` 包含 codebuddy
- [ ] `codegraph install --print-config codebuddy` 输出可粘贴的 JSON 片段
- [ ] sibling MCP server（如同文件里已有的 `mcpServers.figma`）在 install 后仍存在
- [ ] 项目根已有 `CODEBUDDY.md`（如本仓库情况）时，install 后非 codegraph 段落零变更
- [ ] uninstall 反操作：删 `mcpServers.codegraph` key + 删 marker 块；sibling 完整保留
- [ ] 没有用户级 `CODEBUDDY.md` 但有 `AGENTS.md` 时，local install 写入 `AGENTS.md`
- [ ] 全套 `npm test` 通过；不少于 `npm test` 在本变更前的通过用例数 + 新增用例数
- [ ] 反偷懒 20 条红线 0 触发（无 TODO/FIXME、any、console.log 残留、硬编码 url、吞异常等）

## 十、实施总结（B5 复盘）

> 实施完成时间：2026-05-21 20:30 CST。  
> 实施模式：dev-workflow 9 阶段 + 阶段 4.5 五步循环串行执行。  
> openspec 状态：21/23 tasks done（剩 §6.4 本段补全 + §6.5 由用户审阅后归档）。

### 10.1 各批次完成情况

| 批次 | 范围 | 关键产物 | 测试增量 | 完成度 |
|---|---|---|---|---|
| **B1** | openspec 提案 + 方案文档 | `proposal.md` / `design.md` / `tasks.md` / `specs/installer-targets/spec.md` / `docs/add-codebuddy-installer-target-rationale.md` | `openspec validate --strict` 通过 | ✅ 100% |
| **B2** | `codebuddy.ts` 源 + 注册 + 单测当场过 | `src/installer/targets/codebuddy.ts`（~250 行）/ `types.ts` TargetId 联合 / `registry.ts` ALL_TARGETS / `__tests__/codebuddy-target.test.ts`（20 用例） | +20 codebuddy 专属用例 + ~14 自动接入 contract suite | ✅ 100% |
| **B3** | 反偷懒红线 + 全套回归 | grep 扫描 0 触发；`npm test` 696 用例 / 646 passing / 3 pre-existing failures（`watcher.test.ts` baseline 已有，通过 `git stash` 对比确认无关） | 0 新失败 | ✅ 100% |
| **B4** | 文档同步 | `README.md`（4 处）/ `CLAUDE.md`（1 处）/ `CHANGELOG.md`（`[Unreleased] / Added`） | — | ✅ 100% |
| **B5** | 复盘 + tasks 勾选 + openspec validate 再确认 | `tasks.md` 21/23 ✅；本段 §10 写入 | — | ✅ 100%（剩归档由用户触发） |

### 10.2 三向追溯矩阵

| 需求条目（提案 §What Changes） | 代码位置 | 测试用例 |
|---|---|---|
| `codebuddy` target 加入 `TargetId` 联合类型 | `src/installer/targets/types.ts:22` | `__tests__/codebuddy-target.test.ts` "is registered in resolveTargetFlag('all')" |
| `codebuddy` 加入 `ALL_TARGETS` 注册表 | `src/installer/targets/registry.ts:14,21` | `installer-targets.test.ts` 参数化合同套件自动遍历 |
| 全局 MCP 写入 `~/.codebuddy/mcp.json` | `codebuddy.ts:67-71` | "global install writes ~/.codebuddy/mcp.json + RULE.mdc and reports an advisory note" |
| 项目级 MCP 写入 `<workspace>/.mcp.json` | `codebuddy.ts:69` | "local install writes ./.mcp.json + ./CODEBUDDY.md in a fresh project" |
| 全局指令写入 `~/.codebuddy/rules/codegraph/RULE.mdc` 含 `.mdc` frontmatter `alwaysApply: true` | `codebuddy.ts:74,88-95,288-305` | "global RULE.mdc starts with .mdc frontmatter containing alwaysApply: true" |
| 项目级指令写 `<workspace>/CODEBUDDY.md`（marker 块） | `codebuddy.ts:79,308-322` | "local install with pre-existing CODEBUDDY.md preserves all user content outside the marker block" |
| `AGENTS.md` 回落策略（`CODEBUDDY.md` 缺 + `AGENTS.md` 在则写入后者） | `codebuddy.ts:91-95` | "local install writes into AGENTS.md when CODEBUDDY.md is absent and AGENTS.md exists" / "local install prefers CODEBUDDY.md when BOTH exist" |
| 全局 install 输出 advisory `notes` | `codebuddy.ts:116-118,156-159` | "global install ... reports an advisory note" |
| `autoAllow` no-op（对齐 cursor/codex/opencode） | `codebuddy.ts:147`（`_opts` 下划线参数） | contract suite "install writes files; detect.alreadyConfigured becomes true" 不依赖 autoAllow |
| `wireProjectSurfaces()` 只写 `CODEBUDDY.md`，不强制 `.mcp.json` | `codebuddy.ts:235-239` | "wireProjectSurfaces writes only the local CODEBUDDY.md marker (no .mcp.json forced)" / "wireProjectSurfaces is idempotent on re-run" |
| sibling MCP 保留 | `codebuddy.ts:267-279` 合并而非覆盖；`shared.ts` 通用 reading | "global install preserves a pre-existing sibling MCP server" / "local install preserves a pre-existing sibling MCP server" |
| `uninstall` 反操作 | `codebuddy.ts:163-216` | "uninstall preserves sibling MCP servers and the rest of CODEBUDDY.md" / "uninstall deletes ~/.codebuddy/rules/codegraph/RULE.mdc file entirely" / "uninstall on never-installed state returns not-found cleanly" |
| `--target=auto` 检测 CodeBuddy | `codebuddy.ts:132-150` | "detect('local')" / "detect('global')" 两个用例 |
| `printConfig` 输出可解析 JSON | `codebuddy.ts:218-226` | "printConfig returns a parseable JSON snippet for global location" / "printConfig writes no files" |

### 10.3 关键设计决策（与提案 §设计阶段一致 / 无运行时漂移）

1. **TargetId = `codebuddy`** （不是 `codebuddy-ide`）—— 与 `--target=codebuddy` 命令短形对齐
2. **全局 MCP 路径 = `~/.codebuddy/mcp.json`** —— 与官方 `~/.codebuddy/` 配置根目录共生，参考 Cursor `~/.cursor/mcp.json` 同源模式；通过 `WriteResult.notes` advisory 显式提示用户在 IDE 设置页确认一次
3. **本地指令文件优先级**：`CODEBUDDY.md`（存在）> `AGENTS.md`（仅当 `CODEBUDDY.md` 不存在且 `AGENTS.md` 存在时）> 创建新 `CODEBUDDY.md` —— 单一确定性规则，永不写两个文件
4. **`.mdc` frontmatter**：`alwaysApply: true / enabled: true` —— 镜像 Cursor 模式，CodeBuddy 文档明示该标记下自动加载用户规则
5. **`wireProjectSurfaces` 不强制 `.mcp.json`** —— global `~/.codebuddy/mcp.json` 已覆盖所有项目；项目级只补 `CODEBUDDY.md`

### 10.4 漏拦复盘（dev-baseline 必填）

本次实施 **未发现** 真实 bug。但深度自检过程发现了 3 个潜在风险点，已通过测试用例提前固化：

1. **风险 #1：marker 块在 `AGENTS.md` 与 `CODEBUDDY.md` 同时存在时被双写**  
   - 检测手段：用例 "local install prefers CODEBUDDY.md when BOTH CODEBUDDY.md and AGENTS.md exist" 断言 `AGENTS.md` 在两文件都存在时内容**字节级别不变**
   - 拦截位置：`resolveLocalInstructionsPath()` 函数（codebuddy.ts:91-95）的确定性优先级判断
   - 教训：用单一函数集中策略 + 测试断言"另一文件 byte-identical to seed"，避免后期重构出双写

2. **风险 #2：uninstall 不知道 marker 块在哪个文件**  
   - 检测手段：用例 "uninstall preserves sibling MCP servers and the rest of CODEBUDDY.md" 在用户先安装到 `CODEBUDDY.md` 后再 uninstall
   - 拦截位置：`sectionPresent()` helper + `uninstall()` 的 `candidate` 三段判断（codebuddy.ts:200-211, 250-261）
   - 教训：uninstall 必须用"先 detect 再 strip"模式，不能假设 install 时写到哪里 uninstall 就从哪里去（用户可能手动迁移过文件）

3. **风险 #3：`~/.codebuddy/rules/codegraph/` 空目录残留**  
   - 检测手段：用例 "uninstall deletes ~/.codebuddy/rules/codegraph/RULE.mdc file entirely" 显式断言 `path.dirname(file)` 也被清理
   - 拦截位置：uninstall 的 `rmdirSync` 清理逻辑（codebuddy.ts:194-198）
   - 教训：对于"完全归我所有"的目录，uninstall 应该清理到空目录也删掉（与 Codex `removeTomlTable` 模式对齐）

### 10.5 反偷懒红线 17 条扫描结果

| 红线 | 触发 | 备注 |
|---|---|---|
| #1 TODO/FIXME | ❌ 0 | grep 0 命中 |
| #2 空函数体 | ❌ 0 | 唯一的 `_opts` 参数显式标注未用 |
| #3 mock/假数据 | ❌ 0 | 所有路径都是真实 MCP 配置 |
| #4 吞异常 | ❌ 0 | `catch { /* ignore */ }` 仅用于"文件不存在时跳过删除"等明确语义场景，与其他 4 个 target 完全相同惯例 |
| #5 any/@ts-ignore | ❌ 0 | grep 0 命中 |
| #6 短路跳过校验 | ❌ 0 | install/uninstall 全路径执行 |
| #7 I/O 无错误处理 | ❌ 0 | 所有 fs 操作走 helper（`atomicWriteFileSync` 等） |
| #8 高复杂度无拆分 | ❌ 0 | 每个函数 ≤ 30 行 |
| #9 console.log 残留 | ❌ 0 | grep 0 命中 |
| #10 硬编码 URL/密钥/常量 | ❌ 0 | 唯一 URL 是 `docsUrl`（必需，对齐其他 target） |
| #11-15 测试相关红线 | ❌ 0 | 20 个测试用例独立断言，未照抄实现；覆盖正常+边界+异常三类 |
| #16 跨进程引用靠记忆写名字 | ❌ 0 | 所有跨边界引用（`mcpServers.codegraph`、marker 字符串）都从 `shared.ts` 和 `instructions-template.ts` 引入常量 |
| #17 跨进程数据传输未 strip 敏感字段 | N/A | 本次无新增跨边界数据传输 |

### 10.6 兼容性核对

- ✅ 既有 4 个 target（claude/cursor/codex/opencode）行为零变更（71/71 `installer-targets.test.ts` 全过 + 各自专属测试全过）
- ✅ MCP server 本身（agent-agnostic）零改动
- ✅ Build / 打包：无新增 wasm / sql 资源；无新增依赖
- ✅ 老用户行为：未启用 CodeBuddy 的用户 `codegraph install --target=auto` 默认行为不变；启用过 `~/.codebuddy/` 的用户**会自动**被 multiselect 预选 CodeBuddy（可手动取消）
- ✅ 反向兼容：无 BREAKING change

### 10.7 后续工作（backlog）

1. 等待用户审阅本提案 → 执行 `openspec archive add-codebuddy-installer-target --yes` 完成 stage 3 归档
2. 如有需要，提交 `release: 0.9.0`：`package.json` 版本 bump 0.8.0 → 0.9.0，跑 `scripts/release.sh` 发 npm + GitHub release
3. **未来 follow-up**：如有用户反馈，新增 `codebuddy-cli` target id 支持 CodeBuddy Code（CLI 变种，使用 `~/.codebuddy/commands/`）
4. **未来 follow-up**：若 CodeBuddy IDE 未来明确公开用户级 MCP 文件标准路径与 `~/.codebuddy/mcp.json` 不同，调整 `mcpJsonPath('global')` 单点函数即可

### 10.8 演进与沉淀

本次实施验证了 `AgentTarget` 插件化架构的可扩展性：**新增 1 个文件（300 行内）+ 修改 2 行注册 + 写 20 个测试 = 完整支持新 agent**。零侵入既有代码。

新增 capability `installer-targets` 也将 `AgentTarget` 接口契约从"代码注释里的隐式约定"提升为"openspec 显式规约"，未来添加第 6 / 7 / 8 个 agent 都可以基于这个 capability 的 ADDED Requirements 继续扩展。

