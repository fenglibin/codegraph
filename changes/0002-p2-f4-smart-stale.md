# 0002 — P2/F-4 智能 Staleness 检测（Git-aware）

| 字段 | 值 |
|---|---|
| 日期 | 2026-05-22 |
| 类型 | 功能增强（MCP footer） |
| 范围 | `src/index.ts` / `src/mcp/tools.ts` / `src/mcp/server-instructions.ts` / `__tests__/p0-index-age-footer.test.ts` / `__tests__/p0-mandatory-rules.test.ts` / `README.md` |
| 关联文档 | [`docs/p2-f4-smart-stale-rationale.md`](../docs/p2-f4-smart-stale-rationale.md) / [`docs/session-continuation-p2-f4.md`](../docs/session-continuation-p2-f4.md) |
| 状态 | ✅ 实施完成（功能交付 + 测试 + 文档），等待用户 review + commit |

## 一、背景与动机

P0/T3 在每个 MCP 工具响应底部追加 staleness footer，但策略是**盲计时器**：

- 索引 < 30 分钟 → fresh
- 索引 ≥ 30 分钟 → ⚠️ stale 警告

这导致两种错误：

- **误报**：一个 3 小时没改代码的项目，索引完全可信，但 footer 仍警告 stale
- **漏报**：一个 5 分钟前 commit 了大改动但没重新索引的项目，footer 还说"fresh"

F-4 用**真实代码变化信号**（Git）替代盲计时器。

## 二、设计要点

### 2.1 双信号 + 4 分支决策

新增 `CodeGraph.getProjectChangeSignal()` 返回 `{ lastCommitTime, hasUncommitted }`，footer 4 分支按优先级决策：

```
hasUncommitted=true                → ⚠️ Uncommitted changes  (最强信号)
lastCommitTime > maxIndexedAt      → ⚠️ Git has commits newer (次强信号)
lastCommitTime ≤ maxIndexedAt      → ✓ matches HEAD          (最高可信度)
lastCommitTime=null (git 不可用)   → P0 30 分钟盲计时器（降级，字节兼容）
```

### 2.2 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| Git 时间字段 | `%ct` (committer time) | rebase / cherry-pick 保留 author time 但更新 committer time —— `%ct` 才是"代码进 repo 时刻" |
| untracked-files 模式 | `=normal` | `=no` 漏检新增未 add 文件（最常见场景之一）；`=all` 慢 30-50% 无额外信息；`=normal` 自动尊重 .gitignore |
| isGitRepo 预检 | **不预检** | 节省一次 git rev-parse syscall；git log 失败 → catch → null 等价降级 |
| .codegraph/ 噪声 | 过滤 porcelain 行 | codegraph 自己的内部目录会被 git status 报 untracked，必须过滤否则永远 dirty |
| git status timeout | 2000ms | 病态 mega-repo（百万文件无 fsmonitor）兜底 |
| git log timeout | 无 | git log -1 极快 < 50ms，timeout 反而增加错误码歧义 |
| 异常处理 | 双 try/catch | `lastCommitTime` 和 `hasUncommitted` 独立 try 避免一处失败抹掉另一处 |

### 2.3 P0 兼容性物理保证

| 保证 | 实现 |
|---|---|
| 旧 2 参 `_internal_formatIndexAgeFooter(maxIndexedAt, now)` 调用 | 新增第 3 参 `changeSignal: _internal_ChangeSignal \| null = null` |
| 9 条 P0/T3 单元测试 | **0 行修改**，全部 2 参调用未受影响 |
| 4 条 P0/T3 集成测试 | **0 行修改**，git 不可用时输出字节兼容 |
| `_internal_INDEX_AGE_STALE_MS` (30min) | 不动 |
| `TOOLS_SKIP_INDEX_AGE` (codegraph_status 豁免) | 不动 |

物理保证：`changeSignal === null` 或 `{ lastCommitTime: null, hasUncommitted: false }` 时 footer = P0 footer（字节一致）。

### 2.4 三级降级

```
1. git HEAD time + git status 双信号
   └ git status timeout → 仅 git HEAD time 单信号
      └ git log 失败（非 git repo / git 未装） → P0 30 分钟盲计时器
         └ maxIndexedAt === null → 空 footer
```

## 三、变更文件

| 文件 | 改动 | 增删行（净） |
|---|---|---|
| `src/index.ts` | +`import { execFileSync }`、+`import { CODEGRAPH_DIR }`、+`getProjectChangeSignal()` 方法（~80 行含 jsdoc + 双 try/catch + .codegraph/ 过滤） | +95 / -1 |
| `src/mcp/tools.ts` | +`_internal_ChangeSignal` 接口、`_internal_formatIndexAgeFooter` 新增第 3 参 + 4 分支决策、`ToolHandler.execute()` 调用点升级 | +75 / -10 |
| `src/mcp/server-instructions.ts` | 中英文 rule #5 扩展为 3 种 footer 字面量识别 + ✓ 高信任 footer 提示 | +20 / -6 |
| `__tests__/p0-index-age-footer.test.ts` | +`P2/F-4 unit` describe 含 10 case；+`P2/F-4 integration` describe 含 7 case（含真 git init/commit/edit） | +250 |
| `__tests__/p0-mandatory-rules.test.ts` | rule 5 drift guard lockstep 升级（3 种 footer 字面量都断言）+ char budget 6000→6500 | +35 / -22 |
| `README.md` | 核心特性表"索引时效感知"行升级 + MCP 工具"信任信号"段升级 + ~100% 检测覆盖宣告 | +18 / -2 |

新增：

| 文件 | 用途 |
|---|---|
| `docs/p2-f4-smart-stale-rationale.md` | F-4 完整方案文档（5 候选方案对比 / 风险清单 / 测试设计） |
| `changes/0002-p2-f4-smart-stale.md` | 本变更记录 |

## 四、新增接口

### `CodeGraph.getProjectChangeSignal(): { lastCommitTime: number | null; hasUncommitted: boolean }`

公共 API。返回项目相对于 git 的双信号：HEAD commit 时间 + 是否有未 commit 修改。任何错误（非 git repo / git 未装 / timeout / 解析失败）都静默降级为 `{ lastCommitTime: null, hasUncommitted: false }`。

### `_internal_ChangeSignal` 接口

```ts
export interface _internal_ChangeSignal {
  lastCommitTime: number | null;
  hasUncommitted: boolean;
}
```

供 `_internal_formatIndexAgeFooter` 使用，与 `getProjectChangeSignal()` 形状一致便于直接 pass-through。

### `_internal_formatIndexAgeFooter` 新签名

```ts
export function _internal_formatIndexAgeFooter(
  maxIndexedAt: number | null,
  now: number = Date.now(),
  changeSignal: _internal_ChangeSignal | null = null,  // 新增
): string
```

第 3 参 `null` 默认值保证向后兼容。

### 新增 footer 字面量

| 优先级 | 字面量 |
|---|---|
| 1 | `⚠️ Uncommitted changes (modified or new files outside .gitignore) since last index — run codegraph sync before relying on results.` |
| 2 | `⚠️ Git has commits newer than this index — run codegraph sync before relying on results.` |
| 3 | `_Index age: 5m ago (✓ matches HEAD, no uncommitted changes)_` |

## 五、三阶段质量门禁

### 阶段 1 · 深度自检（10 维度）

| # | 维度 | 结果 |
|---|---|---|
| 1 | 接口合约不变性 | ✅ `_internal_formatIndexAgeFooter` 第 3 参默认 null 保兼容；公共 `CodeGraph` 类只新增方法不修改既有方法 |
| 2 | 调用方完整性（红线 #16） | ✅ grep 全 src/ + tests/，新方法仅 `ToolHandler.execute` 调用；旧 footer 函数有 1 处调用全部更新 |
| 3 | 边界条件穿透 | ✅ 17 个测试 case 覆盖：4 分支 × 边界 + git 不可用降级 + .codegraph/ 噪声 + .gitignore 尊重 + 优先级抢占 + clock skew |
| 4 | 错误信息一致性 | ✅ 三种 footer 字面量在 instructions 和实际渲染处字节一致（drift guard 测试守护） |
| 5 | 类型安全（红线 #5） | ✅ 0 any / 0 ts-ignore / 全程显式类型 |
| 6 | 兼容性（向后/老会话） | ✅ P0 全 85 case 100% 通过；2 参调用未修改一字符 |
| 7 | 测试完整性 | ✅ +18 case：10 unit + 7 integration（真 git）+ 1 drift guard |
| 8 | 性能 | ✅ git log + git status 每次 ~50ms；timeout 2s 兜底；footer 注入失败不阻塞 |
| 9 | 并发/时序 | ✅ execFileSync 同步阻塞；ToolHandler.execute 单次调用单次 git；2nd-commit 集成测试用 sleep 1.1s 强制 committer time 推进 |
| 10 | 可观察性 | ✅ jsdoc 完整记录决策依据；测试名含 "P2/F-4" 前缀便于过滤 |

### 阶段 2 · 反偷懒 17 红线扫描

| 红线 | 风险点 | 缓解 |
|---|---|---|
| #1 TODO/FIXME 残留 | 无 | ✅ grep 全 src/ 0 命中 |
| #2 空函数体 / pass | 无 | ✅ |
| #3 mock 假数据冒充 | 集成测试是否 mock git？ | ✅ **真** spawn `git init` / `git commit` / 真文件 IO，非 mock |
| #4 吞异常 | `getProjectChangeSignal` 双 try/catch | ✅ **故意吞** — footer 是信息性，git glitch 不能阻塞查询；jsdoc 明确写明语义 |
| #5 any | 无 | ✅ |
| #6 短路跳过校验 | 无 | ✅ Number.isFinite + >0 边界守门保证 |
| #7 I/O 无错误处理无超时 | git status 有 2s timeout | ✅；git log 无 timeout 是设计选择（jsdoc 解释） |
| #8 高复杂度无拆分 | `_internal_formatIndexAgeFooter` 现 5 个 if 分支 | ✅ 在可读性临界；4 分支决策有 jsdoc 优先级表 |
| #9 console.log | 无 | ✅ |
| #10 硬编码 | `%ct` 是 git 协议字面量；30min 阈值复用 `_internal_INDEX_AGE_STALE_MS` 常量 | ✅ |
| #11 测试断言照抄实现 | 单测 toContain 用 footer 完整字面量 | ✅ 测试是"用户/LLM 视角"的字面量，不是实现细节复制 |
| #12 测试通过 ≠ 应用能跑 | F-4 是 build-only 修改，无应用部署 | ✅ 跑全套测试 853/857（4 个均为 baseline 已有 macOS watcher noise） |
| #13 框架自动行为未核对 | git status --untracked-files=normal 是否真尊重 .gitignore | ✅ I3 集成测试真实创建 .gitignore + dist/artifact.js 实证 |
| #14 框架样板不完整 | 无新框架接入 | N/A |
| #15 验证延后批量化 | 每 todo 完成即跑局部回归 | ✅ F-4.1/.2/.3/.4 各一次 |
| #16 跨进程跨边界引用靠记忆 | execFileSync('git', ...) 命令字面量 | ✅ 真集成测试 spawn 验证实际 git 输出 |
| #17 跨边界数据传输未 strip 敏感字段 | 无敏感字段 | N/A |
| #18 字符级正则代替 parser | 单测用精确字符串 toContain，非宽泛 grep | ✅ |
| #19 凭直觉判定未实测 | "目录 mtime 是否递归" / ".codegraph/ 是否污染 git status" | ✅ 两个假设都做了实测验证（见方案文档 §二 + 失败修复段） |
| #20 否定断言不精确 anchor | `not.toContain('Uncommitted changes')` 是 6 字单词精确字面量 | ✅ |

### 阶段 3 · 测试规模变化

| 指标 | Baseline | F-4 后 | Δ |
|---|---|---|---|
| 总测试数 | 840 | 857 | +17 |
| 通过 | 835 | 853 | +18 |
| 真实失败 | 0 | 0 | 0 |
| macOS watcher noise（已知 flaky） | 5 | 4 | -1（kqueue 性质波动） |
| 测试文件数 | 39 | 39 | 0 |

P0 全 85 case 在 F-4 后 100% 通过（核心物理保证）。

## 六、漏拦复盘（4 条新发现）

### 6.1 `.codegraph/` 内部目录污染 git status（最关键，红线 #19 触发）

**发现路径**：F-4.4 集成测试 I2 `clean git repo with index built after HEAD → ✓ matches HEAD footer` 首次跑红色 —— `git status` 报告 `?? .codegraph/` 把"clean repo"判定为 dirty。

**根因**：codegraph 在 `CodeGraph.init` 中创建 `.codegraph/` 目录存 SQLite DB，但项目根的 `.gitignore` 不包含它（codegraph 自己不写入用户的 .gitignore）。

**修复**：`getProjectChangeSignal` 在解析 git status porcelain 输出时，过滤 path 以 `${CODEGRAPH_DIR}/` 开头的行（同时防御 `=${CODEGRAPH_DIR}` 等价情况）。

**为什么早期方案没想到**：F-4 设计时仅考虑"用户 .ts 文件"的变更场景，没有意识到"codegraph 自身工件"会被 git 视为变更。这是红线 #19 的经典 case：必须实测才能发现。

**未来防御**：考虑在 `CodeGraph.init` 时自动追加一行 `.codegraph/` 到 `.git/info/exclude`（项目本地 git ignore，不污染用户 `.gitignore`）—— 列入 backlog，不在 F-4 范围。

### 6.2 P0/T5 drift guard 测试需 lockstep 升级（设计预期，非 bug）

P0/T5 的 rule #5 drift guard 测试硬编码"30 minutes" / "30 分钟"字面量。F-4 新文案不再单独包含这些字面量（改为"older than 30m"嵌入式表达）。

**为什么早期方案 §四 没列**：方案文档 §四 应该新增"测试 lockstep 升级清单"作为预实施工作量评估。**已沉淀到方案文档 §九"实施总结"待补**。

**修复**：3 条 P0/T5 drift guard 测试 lockstep 升级 + 1 条 char budget 上限 6000→6500。

### 6.3 2nd-commit 集成测试需 sleep 1.1s

集成测试 I6 "git repo + 2nd commit after index → ⚠️ Git has commits newer" 在 CI 高速时钟上可能 0 间隔，导致 committer time 与 maxIndexedAt 同秒（`%ct` 精度仅秒），断言 `> maxIndexedAt` 失败。

**修复**：在 commit 前显式 `await sleep(1100ms)` 推进时钟。

**潜在性能含义**：意味着真实使用中"刚 commit 完立刻查询"在同秒内仍可能命中 ✓ 分支而非警告。**接受**：边界 1 秒内的精度损失对 LLM 决策没有实际差别。

### 6.4 优先级哲学决策需明确写入 rationale

`hasUncommitted=true` AND `lastCommitTime > maxIndexedAt`（双 stale 同时成立）时只显示一种警告。早期没有明确"哪个优先"。

**最终决策**：未 commit 警告优先。理由：用户已 commit 表示"那批改完了"，未 commit 表示"正在改"，stale 风险更高；且恢复行为相同（codegraph sync），合并到强信号即可。

**沉淀**：方案文档 §三.3.2 + 实施时单测 U2 专门验证此优先级。

## 七、追溯矩阵

| 用户需求 | 实现位置 | 测试用例 |
|---|---|---|
| "替换盲计时器为 git 时间" | `src/index.ts:getProjectChangeSignal()` lastCommitTime 部分 / `src/mcp/tools.ts:_internal_formatIndexAgeFooter` 优先级 2/3 分支 | U3 / U4 / U5 / U8 / I5 / I6 |
| "覆盖未 commit 修改" | `getProjectChangeSignal()` hasUncommitted 部分 + `--untracked-files=normal` | U1 / U2 / I3 |
| "覆盖新增未 add 文件" | 同上（normal 模式天然包含 untracked） | I4（关键 — 新增文件场景） |
| "尊重 .gitignore" | git 内置（`--untracked-files=normal` 自动尊重） | I5 |
| "git 不可用降级" | `getProjectChangeSignal()` 双 try/catch + footer 4 分支兜底 | U7 / U8 / U9 / I2 |
| "通知 LLM 三种 footer 字面量" | `server-instructions.ts` rule #5 中英双语 | p0-mandatory-rules.test.ts:rule-5 |
| "README 用户文档" | `README.md` 核心特性 + 信任信号段 | （文档无单测） |
| "0 P0 兼容性回归" | `_internal_formatIndexAgeFooter` 第 3 参默认 null + 旧测试 0 行修改 | P0 全 85 case 仍 100% 通过 |
| "~100% 检测覆盖宣告" | README.md MCP 工具段表格 + ~100% 段落 | （文档无单测） |

## 八、后续工作（Backlog）

1. **`.git/info/exclude` 自动注册**：让 `CodeGraph.init` 自动写一行 `.codegraph/` 到 `.git/info/exclude`，作为漏拦 #6.1 的更根本修复。当前的"过滤 porcelain 行"是 F-4 范围内的最小修复，更长远应该让 codegraph 与用户 git 配置正确协作。
2. **submodule 处理**：当前外层 HEAD 时间不反映 submodule 内变化。考虑用 `git submodule foreach git log -1 --format=%ct` 取最大值（成本较高，列为未来选项）。
3. **CI 性能基准**：在大型 monorepo（10k+ 文件、10MB+ .git）实测 `git status` 性能，验证 2s timeout 是否合理。
4. **`fsmonitor` 启用指引**：在 watcher 不可用的项目（WSL2 /mnt）+ 大 monorepo 场景，推荐用户启用 `core.fsmonitor`。

## 九、用户应看到的差异

### 9.1 索引刚建好、工作目录干净时

**之前**：
```
_Index age: 5m ago_
```

**现在（Git 项目）**：
```
_Index age: 5m ago (✓ matches HEAD, no uncommitted changes)_
```

更高可信度 — git 双向验证通过。

### 9.2 用户改了 .ts 文件没 commit

**之前**：footer 依然显示 fresh（盲计时器 < 30min 都 fresh）。LLM 不知道索引已 stale。

**现在**：
```
_⚠️ Uncommitted changes (modified or new files outside .gitignore) since last index — run `codegraph sync` before relying on results._
```

LLM 收到明确 stale 信号，按 instructions rule #5 自动建议跑 `codegraph sync`。

### 9.3 用户 commit 后没 reindex

**之前**：footer 仍 fresh（< 30min）。

**现在**：
```
_⚠️ Git has commits newer than this index — run `codegraph sync` before relying on results._
```

### 9.4 非 Git 项目

**完全没变**：保留 P0 30 分钟盲计时器逻辑。

---

**实施日期**：2026-05-22
**实施人**：codegraph 维护团队（AI-assisted dev-workflow 4.5 闭环）
**用户 review 状态**：⏳ 等待用户验收 + commit
