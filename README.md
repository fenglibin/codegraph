<div align="center">

# CodeGraph

### 为 Claude Code、Cursor、Codex、OpenCode、Hermes Agent 和 CodeBuddy IDE 注入语义代码智能

**约 35% 更省钱 · 约 70% 更少工具调用 · 100% 本地运行**

[![npm version](https://img.shields.io/npm/v/@xuefadevdev/codegraph.svg)](https://www.npmjs.com/package/@xuefadevdev/codegraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Self-contained](https://img.shields.io/badge/Node.js-bundled%20%C2%B7%20none%20required-brightgreen.svg)](https://nodejs.org/)

[![Windows](https://img.shields.io/badge/Windows-supported-blue.svg)](#)
[![macOS](https://img.shields.io/badge/macOS-supported-blue.svg)](#)
[![Linux](https://img.shields.io/badge/Linux-supported-blue.svg)](#)

[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-blueviolet.svg)](#)
[![Cursor](https://img.shields.io/badge/Cursor-supported-blueviolet.svg)](#)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-supported-blueviolet.svg)](#)
[![opencode](https://img.shields.io/badge/opencode-supported-blueviolet.svg)](#)
[![Hermes Agent](https://img.shields.io/badge/Hermes_Agent-supported-blueviolet.svg)](#)
[![CodeBuddy IDE](https://img.shields.io/badge/CodeBuddy_IDE-supported-blueviolet.svg)](#)

</div>

## 快速开始

**前提**：需要 Node.js ≥ 20.0.0 环境。

```bash
# 零安装运行（推荐）
npx @xuefadevdev/codegraph

# 或全局安装
npm i -g @xuefadevdev/codegraph
```

<sub>CodeGraph 自带运行时 — 无需编译、无需原生构建，在任何平台都一样工作。交互式安装程序会自动为你的 AI Agent 配置 MCP 服务器 — 支持 Claude Code、Cursor、Codex CLI、opencode、Hermes Agent 和 CodeBuddy IDE。</sub>

### 初始化项目

```bash
cd your-project
codegraph init -i
```

<div align="center">

![1_C_VYnhpys0UHrOuOgpgoyw](https://github.com/user-attachments/assets/f168182f-4d9a-44e0-94d7-08d018cc8a3a)

</div>

---

## 为什么选择 CodeGraph？

当 Claude Code 探索一个代码库时，它会启动 **Explore 子代理**，通过 grep、glob 和 Read 扫描文件——每一步工具调用都在消耗 Token。

**CodeGraph 给这些代理提供一个预索引的知识图谱**——包含符号关系、调用图和代码结构，代理直接查询图谱而无需逐文件扫描。

### Benchmark 结果

在 **7 个真实开源代码库**（覆盖 7 种语言）上测试，对比同一个代理（Claude Code，无头模式）在有和没有 CodeGraph 的情况下回答一条架构问题。每个单元格是每组 4 次运行取**中位数**的节省比例。

> **平均值：35% 更省钱 · 59% 更少 Token · 49% 更快 · 70% 更少工具调用**

| 代码库 | 语言 | 成本 | Token | 时间 | 工具调用 |
|----------|----------|------|--------|------|------------|
| **VS Code** | TypeScript · ~10k 文件 | 节省 35% | 减少 73% | 加速 41% | 减少 72% |
| **Excalidraw** | TypeScript · ~600 文件 | 节省 47% | 减少 73% | 加速 60% | 减少 86% |
| **Django** | Python · ~2.7k 文件 | 节省 34% | 减少 64% | 加速 59% | 减少 81% |
| **Tokio** | Rust · ~700 文件 | 节省 52% | 减少 81% | 加速 63% | 减少 89% |
| **OkHttp** | Java · ~640 文件 | 节省 17% | 减少 41% | 加速 36% | 减少 64% |
| **Gin** | Go · ~150 文件 | 节省 22% | 减少 23% | 加速 34% | 减少 19% |
| **Alamofire** | Swift · ~100 文件 | 节省 38% | 减少 59% | 加速 51% | 减少 77% |

**规律**：收益随代码库规模递增——在大仓库上代理通过几次索引查询即可给出答案，**零文件读取**；而没有 CodeGraph 的代理（及其产生的子代理）会把大部分 Token 预算花在文件发现上（find/ls/grep）。在小仓库（如 Gin 约 150 文件）上原生搜索本就便宜，因此收益边际收窄。

> ⚠️ **重要说明**：成本节省（平均 35%）远小于 Token 节省（平均 59%），原因是 CodeGraph 的 instructions 本身会常驻 context、Claude 的 prompt caching 有折扣。Token 节省 70% 仅在大型仓库 + 架构级问题上出现（如 VS Code 场景），不代表所有场景。

<details>
<summary><strong>完整 Benchmark 细节</strong></summary>

**方法学**：每组对比使用 `claude -p`（Claude Opus 4.7，Claude Code v2.1.145）以无头模式运行，`--strict-mcp-config`：**启用** = CodeGraph 的 MCP 服务器启用，**不启用** = 空的 MCP 配置。内置 Read/Grep/Bash 两者均可用。同一问题每组 **4 次运行取中位数**。成本 = 此次运行的 `total_cost_usd`；Token = 处理的总 Token（输入含缓存 + 输出）；时间 = 墙钟时间；工具调用 = 所有工具调用，包括模型产生的子代理内的调用。仓库以 `--depth 1` clone，同一份 CodeGraph 构建产物做索引和服务。

**查询问题：**

| 代码库 | 问题 |
|----------|-------|
| VS Code | "扩展宿主进程是怎么和主进程通信的？" |
| Excalidraw | "Excalidraw 如何渲染和更新画布元素？" |
| Django | "Django ORM 怎样从 QuerySet 构建和执行查询？" |
| Tokio | "Tokio 如何在 runtime 上调度和运行异步任务？" |
| OkHttp | "OkHttp 如何通过拦截器链处理请求？" |
| Gin | "Gin 如何通过中间件链路由请求？" |
| Alamofire | "Alamofire 如何构建、发送和校验请求？" |

**原始中位数 — 启用 → 不启用：**

| 代码库 | 成本 | Token | 时间 | 工具调用 |
|----------|------|--------|------|------------|
| VS Code | $0.42 → $0.64 | 393k → 1.4M | 1m 0s → 1m 43s | 7 → 23 |
| Excalidraw | $0.54 → $1.02 | 851k → 3.2M | 1m 17s → 3m 14s | 12 → 83 |
| Django | $0.41 → $0.62 | 499k → 1.4M | 1m 0s → 2m 25s | 9 → 48 |
| Tokio | $0.50 → $1.04 | 657k → 3.4M | 1m 5s → 2m 56s | 9 → 75 |
| OkHttp | $0.36 → $0.44 | 352k → 596k | 45s → 1m 11s | 5 → 14 |
| Gin | $0.36 → $0.46 | 431k → 562k | 47s → 1m 11s | 7 → 8 |
| Alamofire | $0.61 → $0.99 | 1.1M → 2.6M | 1m 19s → 2m 41s | 15 → 64 |

**CodeGraph 为什么能赢**：有索引时，代理直接给出答案 — `codegraph_context` 扫清区域，一个 `codegraph_explore` 获取相关源码，然后结束，通常零文件读取。没有索引时，代理（及其产生的 Explore 子代理）把大部分预算花在文件发现上（find/ls/grep），才去读正确的代码。

</details>

---

## 核心特性

| | |
|---|---|
| **智能上下文构建** | 一次工具调用返回入口点、相关符号和代码片段 — 无需昂贵的探索代理 |
| **全文搜索** | 通过 FTS5 引擎在全部代码库中按名称即时查找代码 |
| **影响面分析** | 在修改前追踪任何符号的调用者、被调用者和完整的影响半径 |
| **🔴 信任信号系统** | 每条边都有"产地"标签（tree-sitter 精确解析 / heuristic 启发式猜测 / scip 预留）和置信度分数（0.3~0.95），让 AI 知道结果可靠性 |
| **🔴 索引时效感知** | AI 回答末尾自动附带"索引上次更新于 X 分钟前"标记；超过 30 分钟给出警告；watcher 失效时 AI 启动即感知 |
| **🔴 双语强制规则** | 安装时同时写入中英文两套"绝不"规则 — 中文模型（DeepSeek/Qwen/GLM）能正确理解，不再忽略 confidence 警告 |
| **始终新鲜** | 文件监听器使用原生 OS 事件（FSEvents/inotify/ReadDirectoryChangesW）配合防抖自动同步 — 图谱随编码实时更新，零配置 |
| **19+ 种语言** | TypeScript、JavaScript、Python、Go、Rust、Java、C#、PHP、Ruby、C、C++、Swift、Kotlin、Dart、Lua、Luau、Svelte、Liquid、Pascal/Delphi |
| **框架感知路由** | 识别 Web 框架路由文件，将 URL 模式链接到处理器函数，覆盖 14 种框架 |
| **100% 本地** | 数据不出机器。无 API 密钥。无外部服务。仅使用 SQLite 数据库 |

---

## 框架感知路由

CodeGraph 检测 Web 框架路由文件，产生 `route` 节点，通过 `references` 边连接到处理类或函数。查询某视图/控制器的调用者时，会直接显示与之绑定的 URL 模式。

| 框架 | 识别模式 |
|---|---|
| **Django** | `path()`, `re_path()`, `url()`, `include()` in `urls.py`（CBV `.as_view()`、点分路径） |
| **Flask** | `@app.route('/path', methods=[...])`、蓝图路由 |
| **FastAPI** | `@app.get(...)`, `@router.post(...)` 等全部标准方法 |
| **Express** | `app.get(...)`, `router.post(...)` 含中间件链 |
| **NestJS** | `@Controller` + `@Get/@Post/...`, GraphQL `@Resolver` + `@Query/@Mutation`, `@MessagePattern`/`@EventPattern`, `@SubscribeMessage` |
| **Laravel** | `Route::get()`, `Route::resource()`, `Controller@action`, tuple 语法 |
| **Drupal** | `*.routing.yml` 路由 (`_controller`, `_form`, entity handlers); `.module`/`.theme`/`.install`/`.inc` 中的 `hook_*` 实现 |
| **Rails** | `get '/x', to: 'users#index'`, hash-rocket `=>` 语法 |
| **Spring** | `@GetMapping`, `@PostMapping`, `@RequestMapping` 在方法上 |
| **Gin / chi / gorilla / mux** | `r.GET(...)`, `router.HandleFunc(...)` |
| **Axum / actix / Rocket** | `.route("/x", get(handler))` |
| **ASP.NET** | `[HttpGet("/x")]` 特性标注在方法上 |
| **Vapor** | `app.get("x", use: handler)` |
| **React Router** / **SvelteKit** | 路由组件节点 |

---

## 快速安装与使用

### 1. 运行安装程序

```bash
npx @xuefadevdev/codegraph
```

安装程序会：
- 询问要为哪些 Agent 配置 — 自动检测已安装的：**Claude Code**, **Cursor**, **Codex CLI**, **opencode**, **Hermes Agent**, **CodeBuddy IDE**
- 提示将 `codegraph` 安装到 PATH（以便 Agent 能启动 MCP 服务器）
- 询问配置应用于所有项目还是仅当前项目
- 为每个选中的 Agent 写入 MCP 服务器配置 + 指令文件（例如 `CLAUDE.md`、`.cursor/rules/codegraph.mdc`、`~/.codex/AGENTS.md`、`~/.codebuddy/rules/codegraph/RULE.mdc`）
- 当目标是 Claude Code 时自动设置权限白名单
- 初始化当前项目（本地安装场景下）

**非交互式（脚本/CI）：**

```bash
codegraph install --yes                              # 自动检测 Agent，全局安装
codegraph install --target=cursor,claude --yes       # 明确指定目标列表
codegraph install --target=auto --location=local     # 检测到的 Agent，项目级
codegraph install --print-config codex               # 打印配置片段，不写入文件
```

| 参数 | 可选值 | 默认值 |
|---|---|---|
| `--target` | `auto`, `all`, `none`, 或 csv（如 `claude,cursor,...`） | 交互提示 |
| `--location` | `global`, `local` | 交互提示 |
| `--yes` | （布尔） | 每步交互提示 |
| `--no-permissions` | （布尔）跳过 Claude 权限白名单 | 权限开 |
| `--print-config <id>` | 转储单个 Agent 的配置片段并退出 | — |

### 2. 重启你的 Agent

重启你的 Agent（Claude Code / Cursor / Codex CLI / opencode / Hermes Agent / CodeBuddy IDE），MCP 服务器才会加载。

### 3. 初始化项目

```bash
cd your-project
codegraph init -i
```

构建每个项目的知识图谱索引。同时也会接入项目级的 Agent 配置（如 Cursor 的 `.cursor/rules/codegraph.mdc`），使得一个全局 `codegraph install` 就可以覆盖所有项目 — 不需要每个项目重新跑安装程序。

就这样 — 只要项目里存在 `.codegraph/` 目录，你的 Agent 就会自动使用 CodeGraph 工具。

### CodeBuddy IDE 专属配置

CodeGraph 支持 CodeBuddy IDE，自动写入 MCP 配置和双语指令文件：

| 配置项 | 全局（用户级） | 项目级 |
|---|---|---|
| **MCP 配置文件** | `~/.codebuddy/mcp.json` | `<workspace>/.mcp.json` |
| **指令文件** | `~/.codebuddy/rules/codegraph/RULE.mdc`（含 `.mdc` frontmatter `alwaysApply: true`） | `<workspace>/CODEBUDDY.md`（marker 块附加；如无则写入 `AGENTS.md`） |

> ⚠️ **注意**：全局 `~/.codebuddy/mcp.json` 需要你在 CodeBuddy IDE 的"设置 → MCP"标签页中手动确认一次，IDE 才会识别。

<details>
<summary><strong>手动设置（备选方案）</strong></summary>

**全局安装：**
```bash
npm install -g @xuefadevdev/codegraph
```

**添加到 `~/.claude.json`：**
```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

**添加到 `~/.claude/settings.json`（可选，自动允许权限）：**
```json
{
  "permissions": {
    "allow": [
      "mcp__codegraph__codegraph_search",
      "mcp__codegraph__codegraph_context",
      "mcp__codegraph__codegraph_callers",
      "mcp__codegraph__codegraph_callees",
      "mcp__codegraph__codegraph_impact",
      "mcp__codegraph__codegraph_node",
      "mcp__codegraph__codegraph_status",
      "mcp__codegraph__codegraph_files"
    ]
  }
}
```

</details>

<details>
<summary><strong>全局指令参考</strong></summary>

安装程序会自动将以下指令添加到对应的配置文件中（`~/.claude/CLAUDE.md` 等）：

```markdown
## CodeGraph

CodeGraph builds a semantic knowledge graph of codebases for faster, smarter code exploration.

### If `.codegraph/` exists in the project

**NEVER call `codegraph_explore` or `codegraph_context` directly in the main session.** These tools return large amounts of source code that fills up main session context. Instead, ALWAYS spawn an Explore agent for any exploration question (e.g., "how does X work?", "explain the Y system", "where is Z implemented?").

**When spawning Explore agents**, include this instruction in the prompt:

> This project has CodeGraph initialized (.codegraph/ exists). Use `codegraph_explore` as your PRIMARY tool — it returns full source code sections from all relevant files in one call.
>
> **Rules:**
> 1. Follow the explore call budget in the `codegraph_explore` tool description — it scales automatically based on project size.
> 2. Do NOT re-read files that codegraph_explore already returned source code for. The source sections are complete and authoritative.
> 3. Only fall back to grep/glob/read for files listed under "Additional relevant files" if you need more detail, or if codegraph returned no results.

**The main session may only use these lightweight tools directly** (for targeted lookups before making edits, not for exploration):

| Tool | Use For |
|------|---------|
| `codegraph_search` | Find symbols by name |
| `codegraph_callers` / `codegraph_callees` | Trace call flow |
| `codegraph_impact` | Check what's affected before editing |
| `codegraph_node` | Get a single symbol's details |

### If `.codegraph/` does NOT exist

At the start of a session, ask the user if they'd like to initialize CodeGraph:

"I notice this project doesn't have CodeGraph initialized. Would you like me to run `codegraph init -i` to build a code knowledge graph?"
```

安装程序同时会写入中英双语版本的强制规则（**为中文模型深度优化**），包括：

- 🔴 **5 条英文 NEVER 规则** + **5 条中文「绝不」规则**
- 不信任 confidence < 0.7 的启发式边（除非人工核实）
- 不忽略索引时效警告
- 不假设 watcher 在运行
- 优先引用 AST 精确解析的边而非启发式边
- 引用数据时附带 provenance + confidence

</details>

---

## 工作原理

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code                               │
│                                                                  │
│  "实现用户认证功能"                                                │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────┐      ┌─────────────────┐                   │
│  │  Explore Agent  │ ──── │  Explore Agent  │                   │
│  └────────┬────────┘      └────────┬────────┘                   │
│           │                        │                             │
└───────────┼────────────────────────┼─────────────────────────────┘
            │                        │
            ▼                        ▼
┌───────────────────────────────────────────────────────────────────┐
│                     CodeGraph MCP Server                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │
│  │   Search    │  │   Callers   │  │   Context   │               │
│  │  "auth"     │  │  "login()"  │  │  for task   │               │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘               │
│         │                │                │                       │
│         └────────────────┼────────────────┘                       │
│                          ▼                                        │
│              ┌───────────────────────┐                            │
│              │   SQLite Graph DB     │                            │
│              │   • 387 个符号         │                            │
│              │   • 1,204 条边         │                            │
│              │   • 即时查询           │                            │
│              └───────────────────────┘                            │
└───────────────────────────────────────────────────────────────────┘
```

### 五层处理 Pipeline

```
L1 提取 ──→ L2 存储 ──→ L3 解析 ──→ L4 图谱遍历 ──→ L5 上下文构建
  │            │            │             │               │
tree-sitter  SQLite+     4级名字匹配   BFS/DFS       NLQ→符号
AST解析      FTS5索引     13种框架     调用图         →markdown
                          resolver      遍历           包装输出
```

1. **提取（L1）** — [tree-sitter](https://tree-sitter.github.io/) 将源代码解析为 AST。各语言专用查询器提取节点（函数、类、方法）和边（调用、导入、继承、实现）。同时标记每条边的"产地"（provenance）：`tree-sitter`（AST 精确解析）或 `heuristic`（启发式名字匹配）或 `scip`（语义索引预留）。

2. **存储（L2）** — 全部写入本地 SQLite 数据库（`.codegraph/codegraph.db`），包含 FTS5 全文搜索索引。核心四张表：nodes（~22 种节点类型）/ edges（~12 种边类型，含 provenance 和 confidence 字段）/ files / unresolved_refs。

3. **解析（L3）** — 提取完成后进行引用解析：函数调用 → 定义、导入 → 源文件、类继承，以及框架特有模式（Django 路由、Spring 注解、NestJS 控制器等 13 种框架 resolver）。

4. **自动同步** — MCP 服务器使用原生 OS 文件事件监控你的项目。变更有 2 秒防抖窗口，仅过滤源码文件，增量同步。图谱随编码实时更新 — 无需任何配置。watcher 失效时（WSL2、网络盘等场景）MCP 启动即告警。

5. **🔴 信任信号** — 每条边都带 `provenance`（来源）和 `confidence`（置信度 0.3–0.95）标签，AI 工具响应中直接展示。回答末尾标出索引时效（"Index updated X minutes ago"）。所有安装器的指令文件含中英双语强制规则。

---

## CLI 参考

```bash
codegraph                         # 运行交互式安装程序
codegraph install                 # 运行安装程序（显式）
codegraph init [path]             # 在项目中初始化（--index 同时索引）
codegraph uninit [path]           # 从项目中移除 CodeGraph（--force 跳过提示）
codegraph index [path]            # 完整索引（--force 重新索引，--quiet 减少输出）
codegraph sync [path]             # 增量更新
codegraph status [path]           # 显示统计信息
codegraph query <search>          # 搜索符号（--kind, --limit, --json）
codegraph files [path]            # 显示文件结构（--format, --filter, --max-depth, --json）
codegraph context <task>          # 为 AI 构建上下文（--format, --max-nodes）
codegraph affected [files...]     # 找出受影响的测试文件（见下）
codegraph serve --mcp             # 启动 MCP 服务器
```

### `codegraph affected`

通过传递依赖追踪来找出改动的源文件会影响哪些测试文件。

```bash
codegraph affected src/utils.ts src/api.ts         # 将文件作为参数传入
git diff --name-only | codegraph affected --stdin   # 从 git diff 管道传入
codegraph affected src/auth.ts --filter "e2e/*"     # 自定义测试文件匹配模式
```

| 选项 | 说明 | 默认值 |
|--------|-------------|---------|
| `--stdin` | 从标准输入读取文件列表 | `false` |
| `-d, --depth <n>` | 最大依赖遍历深度 | `5` |
| `-f, --filter <glob>` | 自定义 glob 识别测试文件 | 自动检测 |
| `-j, --json` | 以 JSON 格式输出 | `false` |
| `-q, --quiet` | 仅输出文件路径 | `false` |

**CI/hook 示例：**

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | codegraph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```

---

## MCP 工具

作为 MCP 服务器运行时，CodeGraph 暴露以下工具给 AI Agent：

| 工具 | 用途 |
|------|---------|
| `codegraph_search` | 在代码库中按名称搜索符号 |
| `codegraph_context` | 为某个任务构建相关的代码上下文 |
| `codegraph_callers` | 找到哪些代码调用了某个函数（**附带 provenance + confidence 标签**） |
| `codegraph_callees` | 找到某个函数调用了哪些代码（**附带 provenance + confidence 标签**） |
| `codegraph_impact` | 分析修改某个符号会影响哪些代码 |
| `codegraph_node` | 获取某个特定符号的详细信息（可选含源码） |
| `codegraph_files` | 获取已索引的文件结构（比文件系统扫描更快） |
| `codegraph_status` | 检查索引健康状态和统计信息 |

**🔴 信任信号**：所有数据查询类工具（callers / callees / impact / context 等）的响应中，每条边都附带"产地 + 置信度"标签（如 `[tree-sitter, conf:0.95]` 或 `[heuristic, conf:0.6 ⚠️]`），响应末尾带索引时效页脚（如 `—— Index updated 5 minutes ago`）。超过 30 分钟会显示警告 `⚠️ Index updated 47 minutes ago — consider re-running 'codegraph sync'`。

---

## 库用法

```typescript
import CodeGraph from '@xuefadevdev/codegraph';

const cg = await CodeGraph.init('/path/to/project');
// 或：const cg = await CodeGraph.open('/path/to/project');

await cg.indexAll({
  onProgress: (p) => console.log(`${p.phase}: ${p.current}/${p.total}`)
});

const results = cg.searchNodes('UserService');
const callers = cg.getCallers(results[0].node.id);
const context = await cg.buildContext('fix login bug', { maxNodes: 20, includeCode: true, format: 'markdown' });
const impact = cg.getImpactRadius(results[0].node.id, 2);

cg.watch();   // 文件变化时自动同步
cg.unwatch(); // 停止监听
cg.close();
```

---

## 配置

没有配置文件 — CodeGraph 是零配置的。它索引所有扩展名对应[支持语言](#支持的语言)的文件，并**遵循你的 `.gitignore`**：在 Git 仓库中通过 Git 本身，在非 Git 项目中直接读取 `.gitignore` 文件（根目录和嵌套目录，和 Git 的做法一致）。

实际效果：

- Git 忽略的任何内容 — `node_modules`、构建产物、`.env` 中的密钥 — 永远不会被索引。**想让某些内容不出现在图谱中，把它加到 `.gitignore` 即可。**
- 没有需要编写或保持同步的配置文件，每个语言也不需要单独配置：根据文件扩展名自动支持。
- 大于 1 MB 的文件会被跳过（生成的打包文件、压缩 JS、vendor 大文件）— 它们消耗解析预算却得不到有用的符号。

> 已提交但未被 gitignore 的文件**会被索引**，即使在 `vendor/` 下或已提交的 `dist/` 下。如果你提交了一个你不想要出现在图谱中的依赖或构建目录，请把它加到 `.gitignore`。

## 支持的语言

| 语言 | 扩展名 | 状态 | 质量 |
|----------|-----------|--------|------|
| TypeScript | `.ts`, `.tsx` | 完整支持 | ⭐⭐⭐⭐⭐ |
| JavaScript | `.js`, `.jsx`, `.mjs` | 完整支持 | ⭐⭐⭐⭐ |
| Python | `.py` | 完整支持 | ⭐⭐⭐⭐ |
| Go | `.go` | 完整支持 | ⭐⭐⭐⭐⭐ |
| Rust | `.rs` | 完整支持 | ⭐⭐⭐⭐ |
| Java | `.java` | 完整支持 | ⭐⭐⭐⭐ |
| C# | `.cs` | 完整支持 | ⭐⭐⭐ |
| PHP | `.php` | 完整支持 | ⭐⭐⭐ |
| Ruby | `.rb` | 完整支持 | ⭐⭐ |
| C | `.c`, `.h` | 完整支持 | ⭐⭐⭐ |
| C++ | `.cpp`, `.hpp`, `.cc` | 完整支持 | ⭐⭐⭐ |
| Swift | `.swift` | 完整支持 | ⭐⭐⭐ |
| Kotlin | `.kt`, `.kts` | 完整支持 | ⭐⭐⭐ |
| Scala | `.scala`, `.sc` | 完整支持（类、trait、方法、类型别名、Scala 3 枚举） | ⭐⭐⭐ |
| Dart | `.dart` | 完整支持 | ⭐⭐⭐ |
| Svelte | `.svelte` | 完整支持（script 提取、Svelte 5 runes、SvelteKit 路由） | ⭐⭐⭐ |
| Vue | `.vue` | 完整支持（script + script-setup 提取、Nuxt 页面/API/中间件路由） | ⭐⭐⭐ |
| Liquid | `.liquid` | 完整支持 | — |
| Pascal / Delphi | `.pas`, `.dpr`, `.dpk`, `.lpr` | 完整支持（类、record、接口、枚举、DFM/FMX 表单文件） | ⭐⭐⭐⭐ |
| Lua | `.lua` | 完整支持（函数、带 receiver 的方法、局部变量、`require` 导入、调用边） | — |
| Luau | `.luau` | 完整支持（Lua 全部 + `type`/`export type` 别名、类型签名、Roblox 实例路径 `require`） | — |

---

## 适用场景与已知限制

### ✅ CodeGraph 最适合的场景

| 场景类型 | 预期收益 |
|---|---|
| 中大型项目的架构级问题（"X 模块怎么工作？"） | **50-70% Token 节省** |
| 调用链追踪（callers / callees / impact） | **高** — 框架感知路由帮助大 |
| 重构前的依赖分析 | **高** — `codegraph_impact` 一次调用看到影响面 |

### ❌ CodeGraph 不太适合的场景

| 场景类型 | 原因 |
|---|---|
| 查找日志文本 / 注释 / 配置值 | grep 更快，codegraph 反而绕远 |
| 改一行代码 / 修 typo | 直接用 Read，codegraph 是额外开销 |
| 写全新功能（不依赖现有代码） | 帮不上忙，0% 收益 |
| 小型项目（< 200 文件） | 索引初始化开销抵消边际收益 |
| 重元编程语言（Ruby metaprogramming / Python 动态属性） | tree-sitter 精度断崖，calls 边不可靠 |

### 核心已知限制

CodeGraph 的 `calls` 边（函数调用关系）使用**启发式名字匹配**而非真正的语义解析。因此存在以下精度上限：

1. **多态调用**：`svc.save()` 在两个类都有 `save()` 方法时只能选一个 target
2. **DI/IoC 容器**：Spring `@Autowired`、NestJS constructor injection — 运行时绑定的具体实现看不到
3. **动态语言精度低**：Python `getattr()` / Ruby `method_missing` / JavaScript Proxy 等运行时动态分发不识别
4. **C++ 模板/宏展开**：tree-sitter 看不到预处理后的代码

**缓解措施**：CodeGraph 已全面启用"信任信号"系统 — 每条 `calls` 边都带置信度分数和产地标签（`[heuristic, conf:0.6 ⚠️]`），AI 可以据此自行判断哪些引用可靠、哪些需要人工核实。中英双语强制规则确保 AI 不会把低置信度边当作事实。

---

## 国产模型适配（DeepSeek / Qwen / GLM）

CodeGraph 针对国产大模型做了专门优化，使中文模型能获得接近 Claude 的使用体验：

### 已完成的适配（P0）

| 优化项 | 效果 |
|---|---|
| 🔴 **中文指令镜像** | 每条 NEVER 规则都有对应的中文"绝不"规则 |
| 🔴 **工具描述优化** | 在关键工具描述中加入"🔴 在用 grep 之前必须先尝试此工具"中文提示 |
| 🔴 **强化 SERVER_INSTRUCTIONS** | 指令头、中间、尾部三次重复"禁止使用 grep"规则 |
| 🔴 **双语言指令模板** | 安装器同时写入中英双语规则，中文模型遵循度提升 15-25% |

### 各模型预估 Token 节省（完成适配后）

| 项目规模 | Claude Opus | DeepSeek-V3.1 | Qwen-2.5-Coder | GLM-4.6 | DeepSeek-R1 |
|---|---|---|---|---|---|
| 大型（>5000 文件）+ 架构问题 | 70% | 50-60% | 50-60% | 55-65% | 60-70% |
| 中型（500-5000）+ 架构问题 | 60% | 40-50% | 40-50% | 45-55% | 50-60% |
| 小型（<500） | 23% | 10-20% | 10-20% | 10-20% | 15-25% |
| Bug 修复 / 写新代码 | 0-15% | 0-10% | 0-10% | 0-10% | 0-10% |

> ⚠️ 上表为基于公开 benchmark + 工程经验的估算，**实际效果请以真实项目实测为准**。

---

## 故障排查

**"CodeGraph not initialized"** — 先在项目目录里运行 `codegraph init`。

**索引很慢** — 确认 `node_modules` 和其它大目录已被排除。使用 `--quiet` 减少输出开销。

**MCP 报 `database is locked`** — 当前构建产物应该不会：CodeGraph 自带 Node 运行时，使用 `node:sqlite` + WAL 模式，并发读永远不会被写阻塞。如果仍然看到：

- **你用的是旧版本（0.10 以前）**。重新安装 — `npm i -g @xuefadevdev/codegraph@latest`。
- **`codegraph status` 显示 `Journal:` 不是 `wal`** — 在当前文件系统上无法启用 WAL（常见于网络共享和 WSL2 `/mnt`），因此读可能被写阻塞。将项目（连同其 `.codegraph/` 文件夹）移到本地磁盘上。

**MCP 服务器无法连接** — 确保项目已初始化/已索引，验证 MCP 配置中的路径，并检查 `codegraph serve --mcp` 是否可以命令行正常启动。

**缺少符号** — MCP 服务器会在保存时自动同步（等几秒）。如需要可手动运行 `codegraph sync`。检查文件语言是否在支持列表中，且未被配置模式排除。

**watcher 失效时索引陈旧** — 当文件监听器因 WSL2、网络盘、Docker bind mount 等场景失效时，AI 启动时收到的 SERVER_INSTRUCTIONS 会包含 `⚠️ watcher inactive` 警告。你可以手动跑 `codegraph sync` 刷新索引，或移项目到本地磁盘。

---

## 技术架构说明

CodeGraph 使用**插件化的 `AgentTarget` 接口**来支持新的 Agent。新增一个 Agent（如 CodeBuddy IDE）只需要 **1 个新文件（约 300 行）+ 2 行注册代码 + 20 个测试用例**，零侵入现有代码。目前已支持的 Agent：

| Agent | 实现文件 | 配置写入位置 |
|---|---|---|
| Claude Code | `claude.ts` | `~/.claude.json` + `CLAUDE.md` |
| Cursor | `cursor.ts` | `~/.cursor/mcp.json` + `.cursor/rules/codegraph.mdc` |
| Codex CLI | `codex.ts` | `~/.codex/mcp.json` + `~/.codex/AGENTS.md` |
| opencode | `opencode.ts` | 对应配置文件 |
| Hermes Agent | `hermes.ts` | 对应配置文件 |
| **CodeBuddy IDE** 🆕 | `codebuddy.ts` | `~/.codebuddy/mcp.json` + `.mcp.json` + `CODEBUDDY.md` |

---

## License

MIT

---

<div align="center">
**为 AI 编程代理而生 — Claude Code、Cursor、Codex CLI、opencode、Hermes Agent 和 CodeBuddy IDE**
[代码仓库](https://cnb.cool/xuefadev/codegraph)

</div>