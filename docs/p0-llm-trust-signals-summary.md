# P0 LLM Trust Signals — 改动摘要与收益

> **目标读者**：项目维护者 / 用户 / 后续接手 AI
>
> **关联提交**：`709c2c9` — 完成 P0（T1–T6）+ P1（P1.1 / P1.2 / P1.4）
>
> **关联 OpenSpec change**：`openspec/changes/add-llm-trust-signals/`
>
> **完成时间**：2026-05-22

---

## 1. 一句话总结

给 codegraph 装上"信任信号"系统：每条数据都标注**产地**（AST 精确解析 / 启发式猜测 / SCIP 预留）+ **可信度**（0.3 ~ 0.95），每个 AI 回答末尾都有**索引时效**提示，并通过**双语强制规则**让中文模型也认真遵守。

---

## 2. 解决了什么问题

### 2.1 改动前的痛点

codegraph 把项目代码索引成一个 SQLite 知识图谱（节点=符号，边=关系），通过 9 个 MCP 工具暴露给 AI（Claude Code / Cursor / Codex CLI / opencode / CodeBuddy IDE）。但是：

| 问题 | 表现 | 后果 |
|---|---|---|
| AI 看不到边的来源 | tree-sitter 精确解析的 contains 边和靠名字猜的 calls 边被 AI 一视同仁 | AI 把"猜的"当"真的"用，输出不可靠 |
| AI 看不到置信度 | 启发式匹配的 confidence 字段已经写入 SQLite，但 MCP 工具响应不展示 | 用户无法判断 AI 引用的数据可信度 |
| AI 看不到索引时效 | 索引可能 30 分钟前刷的，watcher 也可能挂了，但 AI 不知道 | 基于陈旧数据回答问题 |
| 中文模型对英文规则不重视 | 安装到 DeepSeek / Qwen / GLM 这类中文模型时只有英文规则 | 模型实测忽略 confidence 警告 |

### 2.2 改动后的效果

**例 1：AI 工具响应里多了信任标记**

改动前 `codegraph_callers` 输出：
```
- bar (file.ts:10)
- baz (file.ts:20)
```

改动后：
```
- bar (file.ts:10) [tree-sitter, conf:0.95]
- baz (file.ts:20) [heuristic, conf:0.6 ⚠️]

—— Index updated 5 minutes ago
```

意思：bar 是 AST 精确解析的，可信；baz 是启发式猜的，置信度 0.6 偏低，需要人工核对；整个索引 5 分钟前刷新，不算陈旧。

**例 2：索引超过 30 分钟会警告**

```
—— ⚠️ Index updated 47 minutes ago — consider re-running 'codegraph sync'
```

**例 3：AI 启动时拿到 watcher 健康状态**

如果 watcher 进程挂了，MCP 初始化响应会带一段警告，告诉 AI"索引可能陈旧 → 请提醒用户 codegraph sync"。

**例 4：双语强制规则**

安装时写入 AI 配置文件的"使用说明"末尾，加了 5 条 NEVER 规则 + 5 条「绝不」中文镜像，覆盖：
- 不信任 confidence < 0.7 的启发式边（除非人工核实）
- 不忽略索引时效警告
- 不假设 watcher 在运行
- 看到 AST 边和启发式边混合时优先引用 AST 边
- 提供建议时引用 provenance + confidence

---

## 3. 改动了什么（按用户感受到的差异分组）

### 3.1 改动块 1：AI 回答里多了"信任标记"

**改了什么**

| 文件 | 行数变化 | 作用 |
|---|---|---|
| `src/mcp/tools.ts` | +325 行（最大头） | 9 个 MCP 工具的实际响应：增加 `_internal_formatEdgeTag` / `_internal_readEdgeConfidence` / `_internal_formatIndexAgeFooter`，在 `formatNodeList` / `formatImpact` / `execute` 里注入信任标记和索引时效页脚 |
| `src/context/formatter.ts` | +21 行 | `serializeEdge` 在 JSON 上下文输出里附带 confidence + provenance |
| `src/mcp/server-instructions.ts` | +141 行 | AI 启动时拿到的"使用说明书"重构，新增 `buildServerInstructions(opts)` 构建器，根据 watcher 健康动态拼接说明 |

**用户能看到的差别**：所有数据查询类工具（callers / callees / impact / context 等）的响应都带产地标签 + 置信度，末尾带索引时效页脚。`codegraph_status` 工具豁免页脚（自身就是状态查询）。

### 3.2 改动块 2：每条数据写库时都打"产地标签"

**改了什么**

| 文件 | 行数变化 | 作用 |
|---|---|---|
| `src/extraction/dfm-extractor.ts` | +1 | DFM 提取器的 contains 边打 `provenance: 'tree-sitter'` |
| `src/extraction/liquid-extractor.ts` | +6 | Liquid 提取器的 6 处 push 都打 |
| `src/extraction/svelte-extractor.ts` | +1 | Svelte 提取器中转 push 依赖上游 tree-sitter 的 stamp |
| `src/extraction/tree-sitter.ts` | +2 | 2 处 contains/imports push 打 stamp |
| `src/extraction/vue-extractor.ts` | +1 | Vue 提取器同 svelte |
| `src/resolution/index.ts` | +5 | `createEdges` 启发式解析输出打 `provenance: 'heuristic'` |
| `src/db/queries.ts` | +26 | 新增 `QueryBuilder.getMaxIndexedAt()` 缓存预编译语句，给索引时效页脚用 |
| `src/index.ts` | +10 | `CodeGraph.getMaxIndexedAt()` 公开委托方法 |

**用户能看到的差别**：看不到（底层基础设施改动）。但块 1 之所以能给 AI 看到产地标签，依赖的就是这块。

### 3.3 改动块 3：5 个安装器都加双语强制规则

**改了什么**

| 文件 | 行数变化 | 作用 |
|---|---|---|
| `src/installer/instructions-template.ts` | +58 | `INSTRUCTIONS_TEMPLATE` 新增 `## CodeGraph（中文）` 镜像段，含 5 条「绝不」规则 |

**用户能看到的差别**：装 codegraph 到任意 AI IDE，配置文件里都会有英文 5 条 NEVER + 中文 5 条「绝不」。中文模型（DeepSeek / Qwen / GLM）能正确理解强制规则，不再忽略 confidence 警告。

### 3.4 改动块 4：MCP 启动时检查 watcher 健康

**改了什么**

| 文件 | 行数变化 | 作用 |
|---|---|---|
| `src/mcp/index.ts` | +13 | `handleInitialize` 调用 `buildServerInstructions(opts)` 注入 watcher 健康诊断 |

**用户能看到的差别**：watcher 挂了的话，AI 启动时就能感知到，会在回答里提示用户运行 `codegraph sync`，而不是基于过期数据答题。

### 3.5 改动块 5：测试 + 文档（占总行数 60%+）

**改了什么**

| 类别 | 文件数 | 行数 | 作用 |
|---|---|---|---|
| P0 测试 | 10 个 `__tests__/p0-*.test.ts` | +1735 | 85 个测试用例锁住所有改动 |
| 项目特定经验 | `docs/codegraph-engineering-notes.md` | +255 | 8 节项目特定约定（Edge.provenance 不变量 / `_internal_*` 命名约定 / 标记字符串守恒 / 双语 grep 陷阱等） |
| 会话延续简报 | `docs/session-continuation-prompt.md` | +453 | 给后续 AI 接手用的一站式简报 |
| OpenSpec | 4 个 changes 子目录 / 18 文件 | +1500+ | 提案 / 任务清单 / 设计决策 / 规格变更 |
| 边角配置 | `AGENTS.md` / `CODEBUDDY.md` / `.gitignore` / `package-lock.json` | 少量 | AI 协作配置 |

**用户能看到的差别**：看不到（质量保证层）。但 85 个测试用例确保以后任何人改代码都不会不小心破坏现有不变量。

---

## 4. 数字总览

| 维度 | 数字 |
|---|---|
| 文件变更 | 40 个 |
| 新增行 | +4768 |
| 删除行 | -38 |
| 真正的源码改动 | 12 个文件 / 净 +569 行 |
| 测试新增 | 10 文件 / **85 用例** |
| 文档 + OpenSpec | 18 文件 / 约 3000 行 |
| P0 测试通过率 | 85/85 ✅ |
| 全套测试通过 | 基线 659 → 当前 775（**+116 净增**，0 真实新失败） |
| TypeScript 严格类型 | 0 错误 ✅ |
| 17 反偷懒红线扫描 | 0 真实触发 ✅ |
| OpenSpec strict 校验 | passes ✅ |

---

## 5. 关键技术决策（沉淀给后续维护者）

### 5.1 P1.3 won't-fix：`Edge.provenance` 保持 optional

**问题**：是否把 `Edge.provenance` 字段从 `?` 收紧成 required？

**决策**：❌ 不做。

**理由**：
1. **向后兼容**：pre-T1 数据库里的旧边记录 `provenance` 是 NULL，类型收紧会让旧库无法读取
2. **测试 fixture 故意保留**：`__tests__/p0-context-json-edge-trust.test.ts:101` 故意构造一条无 provenance 的边来测试 legacy 序列化路径，类型收紧会让这个测试自动失效
3. **风险已被覆盖**：3 个集成测试（含分布断言 `tree-sitter > 0, NULL = 0`）已经从运行时层面拦住"忘打 stamp"的偷懒，不需要类型层面再加

### 5.2 `_internal_*` 命名约定

仅供单测用、不属于公共 MCP API 的常量和纯函数用 `_internal_` 前缀导出：

```ts
export const _internal_CONFIDENCE_LOW_THRESHOLD = 0.7;
export const _internal_INDEX_AGE_STALE_MS = 30 * 60 * 1000;
export const _internal_INDEX_AGE_STALE_MINUTES = 30;
export function _internal_formatEdgeTag(edge): string { ... }
```

模块内部用无前缀别名（`const formatEdgeTag = _internal_formatEdgeTag`）保持代码可读。跨模块只有"漂移守卫测试"才能合法导入这些 `_internal_*`。

### 5.3 安装器标记字符串神圣不可变

`<!-- CODEGRAPH_START -->` / `<!-- CODEGRAPH_END -->` 是 5 个安装器（claude / cursor / codex / opencode / codebuddy）识别 codegraph 段落的唯一锚点。改动 1 个字节都会导致用户重装时出现"老段落留下 + 新段落追加"的双段问题。`p0-installer-bilingual.test.ts::structure invariants` 用字节级精确断言守卫。

### 5.4 索引时效页脚集中注入

`ToolHandler.execute()` 是唯一注入页脚的位置。`TOOLS_SKIP_INDEX_AGE = new Set(['codegraph_status'])` 列出豁免工具。新增第 10 个工具会自动获得页脚，除非加进豁免集合。**禁止**在每个 handler 里单独加页脚逻辑。

---

## 6. 8 条项目特定经验（节选自 `codegraph-engineering-notes.md`）

| # | 经验 | 来源 |
|---|---|---|
| 1 | `Edge.provenance` 不变量：3 层守护（源 stamp / 中转保留 / 数据库往返） | T1 / P1.2 |
| 2 | `_internal_*` 命名约定 | T2 / T3 |
| 3 | 安装器 `CODEGRAPH_START/END` 标记字节级守恒 | T6 |
| 4 | 测试 fixture 故意保留破例字段，类型收紧前必须 grep | P1.3 |
| 5 | 页脚集中注入（`ToolHandler.execute` 唯一入口） | T3 |
| 6 | `tryGetCodeGraph` 故意吞异常的合理性 | T3 |
| 7 | 双语 markdown grep 陷阱（80 列换行破坏 `toContain`，必须用 dot-all 正则） | T5 / T6 |
| 8 | `installer-targets.test.ts` 是 L4 真验证（不需要再写 L4 cjs 脚本） | T6 |

详见 `docs/codegraph-engineering-notes.md`。

---

## 7. 8 条跨项目通用经验（节选自 CodeBuddy memory ID 66947442）

1. **schema 列与代码字段一致性**：DB 加了列后必须 grep 所有 push 点确认每处都设值
2. **以 node 为主的输出格式隐式丢失关系语义**：图查询返回 `{node, edge}` 时禁止 `.map(x => x.node)` 丢弃 edge
3. **round-then-bucket 陷阱**：`Math.round(value / threshold)` 后比较阈值会丢精度，应直接按 ms 分桶
4. **builder/formatter/serializer 的 wiring 盲区**：纯函数自身正确 ≠ 接对了，必须配套集成测试验证生产路径调用
5. **`not.toContain` 否定断言必须精确锚点**：emoji / 命令名 / 普通词易被未来段落误触，应锚定唯一 section header
6. **跨模块 drift guard 用 `_internal_*` 命名**：警示外部消费者"非公共 API"
7. **backwards-compat fixture 故意保留破例字段**：类型收紧前必须先 grep 测试文件
8. **OpenSpec ADDED Requirement 第一段必须含 SHALL/MUST**：第一句直接写，不能换行后才出现

---

## 8. 不变量检查清单（后续修改时必读）

### 8.1 边写入路径

每个 `edges.push({...})` 调用必须包含 `provenance` 字段。如果新加提取器：
- 每处 push 显式写 `provenance: 'tree-sitter'`
- 如果走 Vue/Svelte 转交模式（依赖上游 tree-sitter），不要在 offset-line-numbers 循环里覆盖 `edge.provenance`

如果新加解析器：
- 通过 `resolution/index.ts:createEdges` 走的会自动 stamp `'heuristic'`
- 直接 `insertEdge` 的必须自己 stamp（或为 SCIP / 跨语言匹配器加新字面量到 `Edge.provenance` union）

### 8.2 安装器模板

修改 `INSTRUCTIONS_TEMPLATE` 时：
- ✅ 段落内容（中英双语正文 / markdown 结构 / 总长 3000-8000 字符内）随便改
- ❌ 标记字符串 `<!-- CODEGRAPH_START -->` / `<!-- CODEGRAPH_END -->` 1 字节都不能动
- ❌ 不要加嵌套标记（必须恰好 1 START + 1 END）

修改后必须跑：
```bash
npx vitest run __tests__/installer-targets.test.ts        # 84 cases，所有 5 个安装器
npx vitest run __tests__/p0-installer-bilingual.test.ts   # 15 cases，结构守恒
```

### 8.3 阈值常量

修改 `_internal_CONFIDENCE_LOW_THRESHOLD` / `_internal_INDEX_AGE_STALE_MS` / `_internal_INDEX_AGE_STALE_MINUTES` 必须同步更新：
- `src/mcp/server-instructions.ts` 中的文本引用
- `src/installer/instructions-template.ts` 中的英文段 + 中文段引用

否则 `p0-mandatory-rules.test.ts` × 2 + `p0-installer-bilingual.test.ts` × 2 = **4 个漂移守卫**会失败。

### 8.4 footer 注入

新加第 10 个 MCP 工具：
- 默认会自动获得索引时效页脚
- 如果新工具是状态/时效查询（页脚冗余），加到 `TOOLS_SKIP_INDEX_AGE` 集合
- ❌ 禁止在 handler 里加页脚逻辑（破坏中心化策略）

### 8.5 SERVER_INSTRUCTIONS export

`SERVER_INSTRUCTIONS` 仍然以 `export const string` 形式保留（向后兼容下游消费者），即便 `mcp/index.ts` 现在用 `buildServerInstructions(opts)`。**禁止删除这个 const 导出**。

---

## 9. 后续可能的工作（P2 候选项）

简报 §3.2 列出 5 个候选，**全部需要用户签字才能开工**：

| ID | 主题 | 工作量预估 |
|---|---|---|
| F-1 | SCIP importer（`provenance: 'scip'` 字面量已预留） | 中 |
| F-2 | 索引年龄/产地分布 dashboard 工具 | 大（新 MCP 工具） |
| F-3 | confidence 校准（信号融合：调用上下文 + 类型信息） | 大（R&D） |
| F-4 | 索引陈旧时自动拒绝查询（而非仅警告） | 小（一行 if） |
| F-5 | ESLint 规则强制 `Edge` 构造带 provenance（运行时 → 编译期前移） | 中 |

---

## 10. 关联文档与资源

- **完整 OpenSpec change**：`openspec/changes/add-llm-trust-signals/`
  - `proposal.md`（157 行 — 为什么 P0 是必要的）
  - `tasks.md`（250 行 — 含 P1 的完整任务台账）
  - `design.md`（225 行 — 7 个关键决策）
  - `specs/{mcp-tools,installer-targets}/spec.md`（263 行 — Spec deltas）
- **项目特定经验**：`docs/codegraph-engineering-notes.md`（255 行）
- **会话延续简报**：`docs/session-continuation-prompt.md`（453 行 — 给后续 AI 接手用）
- **CodeBuddy 跨项目经验**：memory ID 66947442（8 条跨项目通用教训）
- **测试入口**：`__tests__/p0-*.test.ts`（10 文件 / 85 用例）

---

## 11. 验证记录

```bash
# 全套测试
npm test                                    # 775 passing / 0 real fail
                                            # baseline 659 → +116 净增

# P0 测试套件
npx vitest run __tests__/p0-*.test.ts       # 10 files / 85 passed / 0 failed

# OpenSpec 校验
openspec validate add-llm-trust-signals --strict   # is valid

# TypeScript 严格类型
npx tsc -p ./tsconfig.json --noEmit         # 0 errors

# 17 反偷懒红线扫描
# (人工扫描 13 个变更文件，0 真实触发)
```

**已知噪声（非回归）**：
- `__tests__/watcher.test.ts` 在 CI 繁忙时偶发失败（baseline 已存在，时序依赖 OS 文件事件）
- `__tests__/extraction.test.ts` 单跑时 worker exit（baseline 已存在，疑似 better-sqlite3 ABI 与当前 Node 版本不匹配）

两者都不是 P0 引入的问题。
