# P2 F-4 — Git-aware Smart Index Staleness Detection · 方案文档

> **状态**：✅ 用户已确认方案 B'（含新增文件覆盖），可实施
> **日期**：2026-05-22
> **作者**：codegraph 维护团队 (AI-assisted)
> **关联**：`docs/session-continuation-p2-f4.md`（任务交接）/ `changes/0002-p2-f4-smart-stale.md`（变更记录）

---

## 一、背景与诉求

### 1.1 P0 现状

P0/T3 在每个 MCP 工具响应底部追加 footer：

- 索引 < 30 分钟 → `_Index age: 5m ago_`（fresh）
- 索引 ≥ 30 分钟 → `_⚠️ Index age: 47m ago — older than 30m, results may be stale. Run codegraph sync..._`

**这是一个盲计时器** —— 一个 3 小时没改过任何代码的项目，索引完全可信，但 footer 仍然会警告 stale。反之，一个 5 分钟前 commit 了大改动但没重新索引的项目，footer 还会说"fresh"。

### 1.2 用户原始诉求

> P0 added "⚠️ Index updated 47 minutes ago" footer — warns the LLM but doesn't
> change behavior. The 30-minute threshold is a **blind timer** — a project
> that hasn't changed in 3 hours has a perfectly valid index, but P0 still
> warns.
>
> F-4 replaces the blind timer with **git-aware staleness**.

进一步迭代过程中用户追加 2 条诉求：

1. **目录变化能否检测**：能不能用目录 mtime 来检测变化？
2. **新增文件覆盖**：只有新增未 commit 的代码文件时也算变化（"只要不在 .gitignore 中的文件发生变化都认为有变化"）

---

## 二、候选方案对比（5 选 1）

### 方案 A — F-4 原始设计：仅 `git log -1` HEAD time

只读 HEAD commit 时间，对比 `maxIndexedAt`。

- ✅ 简单（1 次 git 调用 ~30ms）
- ❌ **漏掉所有未 commit 的本地修改** —— 用户编辑了 `src/foo.ts` 但没 git commit，footer 仍然显示 "✓ matches HEAD"，但索引其实 stale。这是最常见的开发场景之一。

### 方案 B — 项目根目录 mtime

读 `fs.statSync(projectRoot).mtimeMs`，对比 `maxIndexedAt`。

实测 POSIX 行为（红线 #19 — 不凭直觉判定，必须实测）：

| 操作 | `dir/` mtime 影响 | 父目录 mtime 影响 |
|---|---|---|
| 在 `dir/` 创建新文件 | ✅ 更新 | ❌ 不更新 |
| 在 `dir/` 删除文件 | ✅ 更新 | ❌ 不更新 |
| 在 `dir/` 重命名 | ✅ 更新 | ❌ 不更新 |
| **修改** `dir/file.ts` 内容 | ❌ **不更新** | ❌ 不更新 |
| 在 `dir/sub/` 创建文件 | ❌ **不更新** | ❌ 不更新 |

**致命漏洞**：
- 文件内容修改完全不传播到任何祖先目录 mtime
- 不递归 —— 子目录变化不反映到父目录

→ **不可靠，淘汰**。

### 方案 C — 递归 walk 取 max(file mtime)

遍历所有已索引文件取 mtime 最大值。

- ✅ 准确率 ~99%
- ❌ **性能不可接受** —— 每次 footer 注入（即每次工具调用）都要做 N 次 fs.statSync（N = indexed file 数，典型项目数千～数万）。索引规模本身就是性能压力，footer 不能放大它。

→ **淘汰**。

### 方案 D — 直接读 watcher 的 lastChangeAt

复用 FileWatcher 内部已经维护的"最新检测到的变化时刻"。

- ❌ **致命循环依赖** —— watcher 在 stale 场景下正是失效的那个组件（用户长期不打开终端 / WSL2 /mnt 关掉 watcher / 进程被 kill 重启）。它自己说"没变化"才不可信，所以才需要 F-4 这种**外部独立信号**来兜底。

→ **淘汰**。

### 方案 B'（最终选定） — git HEAD time + git status 双信号

```
getProjectChangeSignal(): {
  lastCommitTime: number | null;
  hasUncommitted: boolean;
}
```

- `git log -1 --format=%ct` → 已 commit 时间
- `git status --porcelain --untracked-files=normal` → 是否有任何未 commit 修改（含新增文件，**自动尊重 .gitignore**）

**为什么 `--untracked-files=normal` 而不是 `=no` 或 `=all`**：

| 模式 | 修改已 tracked 文件 | 新增 .ts 文件未 add | 在 .gitignore 中的新文件 | 性能 |
|---|---|---|---|---|
| `=no` | ✅ | ❌ **漏掉** | ❌ 不检测（正确） | 最快 |
| `=normal` | ✅ | ✅ | ❌ 不检测（git 自动尊重 .gitignore） | 中 |
| `=all` | ✅ | ✅ | ❌ 不检测 | 慢 30-50% |

**选 `=normal` 的两个关键理由**：

1. git 已内置 .gitignore 解析，**无需自己手写 ignore 逻辑**（避免重复造轮子+维护成本）
2. `=all` 提供的"untracked 目录内逐个文件列表"对 boolean staleness 决策没有任何额外信息

---

## 三、最终方案 B' 详细设计

### 3.1 检测覆盖率

| 用户场景 | 方案 A | **方案 B'** |
|---|---|---|
| 修改已 tracked 文件未 commit | ❌ 漏 | ✅ |
| 新增 .ts 文件未 git add | ❌ 漏 | ✅ |
| 新增 .ts 文件已 add 未 commit | ❌ 漏 | ✅ |
| 修改并 commit 一次 | ✅ | ✅ |
| 切换分支（commit 不同） | ✅ | ✅ |
| 修改 .gitignore 中的 build artifact | — | ❌ 不检测（正确） |
| 非 git repo | ❌ 完全失效（降级 P0 timer） | ❌ 同左（降级 P0 timer） |
| **覆盖率** | ~95% | **~99%** |

> **README 用户宣告**：在 git 项目中，方案 B' 对"用户主观认知中的代码变更"接近 100% 检测（修改 + 新增 + 删除 + 改名，无论是否 commit）。漏检 case 仅为：(a) 非 git 项目（降级到 30 分钟盲计时器），(b) 索引了被 .gitignore 排除的文件（罕见配置，索引 99%+ 与 git 跟踪范围重合）。

### 3.2 footer 决策优先级（4 分支）

```
┌─ maxIndexedAt 缺失 → ''  (不变，empty index)
│
├─ hasUncommitted === true                                  【最强信号】
│  └→ "⚠️ Uncommitted changes (modified or new files outside .gitignore) since last index — run `codegraph sync`."
│
├─ lastCommitTime > maxIndexedAt                            【次强信号】
│  └→ "⚠️ Git has commits newer than this index — run `codegraph sync`."
│
├─ lastCommitTime !== null && lastCommitTime ≤ maxIndexedAt 【双 ✓ 最高可信度】
│  └→ "_Index age: Xm ago (✓ matches HEAD, no uncommitted changes)_"
│
└─ lastCommitTime === null (git 不可用)                     【降级 P0 timer】
   ├─ ageMs >= 30min → P0 ⚠️ stale 警告（原样）
   └─ ageMs <  30min → P0 fresh footer（原样）
```

**优先级关键决策**：`hasUncommitted` > `lastCommitTime > maxIndexedAt`。理由：项目可能同时满足"HEAD 已 commit 但 index 没跟上" + "还有未 commit 的新修改"，前者用户已 commit 说明那批改完了，后者说明用户**正在改**，stale 风险更高且修复行为相同（都是 `codegraph sync`），合并优先级到强信号即可。

### 3.3 P0 兼容性物理保证

| 保证点 | 实现 |
|---|---|
| 旧 `_internal_formatIndexAgeFooter(maxIndexedAt, now)` 2 参调用 | 新增第 3 参 `changeSignal: ChangeSignal \| null = null`；null 走降级 |
| 现有 9 条 P0/T3 单元测试 | 全部不修改 — 都是 2 参调用，新参数默认 null |
| 4 条 P0/T3 集成测试 | 不修改 — `ToolHandler.execute` 在 git 不可用时与 P0 字节一致 |
| `_internal_INDEX_AGE_STALE_MS` (30min) | 不动 — 仍是 git 不可用时的兜底阈值 |
| `TOOLS_SKIP_INDEX_AGE` (codegraph_status 豁免) | 不动 |

**核心不变性**：`changeSignal === null` 时 footer 输出 = P0 footer 输出（字节一致）。

### 3.4 三级降级

```
1. 优先：git HEAD time + git status 双信号
   └ git status timeout (2000ms) / 病态大 repo → 仅用 git HEAD time
      └ git log 失败（非 git repo / git 未装） → P0 30 分钟盲计时器
         └ maxIndexedAt === null → 空 footer
```

### 3.5 命令选项关键决策

| 选项 | 选择 | 拒绝项 | 理由 |
|---|---|---|---|
| time 格式 | `%ct` (committer time) | `%at` (author time) | rebase/cherry-pick 保留 author time 但更新 committer time。索引建于 rebase 之前 → 相对 rebased HEAD 是 stale。`%ct` 才是"代码进 repo 的时刻"。 |
| pager | `--no-pager` | 默认 | 某些终端下 git 试图调 less 卡住 stdout |
| untracked-files | `=normal` | `=no` / `=all` | 见 §二.方案 B' 详表 |
| stderr | `stdio: ['ignore', 'pipe', 'ignore']` | 默认继承 | 吞掉 "fatal: not a git repository" 噪声 |
| git status timeout | `timeout: 2000` | 无 timeout | 病态 repo（百万文件无 fsmonitor）兜底 |
| git log timeout | 无 | — | `git log -1` 极快 < 50ms，加 timeout 反而增加错误码歧义 |
| isGitRepo 预检 | **不预检** | 先 `git rev-parse` | 节省一次 syscall。git log 失败 → catch → null 效果等价 |

---

## 四、风险清单

| 风险 | 触发条件 | 降级行为 |
|---|---|---|
| git 未安装 | execFileSync ENOENT | catch → null → 走 P0 timer |
| 项目非 git repo | "fatal: not a git repository" | catch → null → 走 P0 timer |
| 空 repo（无 commit） | "fatal: your current branch has no commits yet" | catch → null → 走 P0 timer |
| detached HEAD 指向无效 ref | git log 失败 | catch → null → 走 P0 timer |
| git submodule 嵌套 | git log 用外层 HEAD | 外层 HEAD 时间，submodule 自身有 .codegraph |
| 时钟回拨 | gitHeadTime > Date.now() | 渲染 "Git has commits newer"（future commit 也合理） |
| `git status` 超时 | 病态大 repo + 无 fsmonitor | timeout 2s → hasUncommitted=false → 只用 git HEAD 单信号 |
| 索引被 .gitignore 排除的文件 | 罕见配置 | **真实漏洞但不修复** — 接受边界，README 文档说明 |

---

## 五、文件改动总览

| 文件 | 改动 | 估算行数 |
|---|---|---|
| `src/index.ts` | 新增 `getProjectChangeSignal(): { lastCommitTime; hasUncommitted }`，新增 import | ~60 |
| `src/mcp/tools.ts` | 改 `_internal_formatIndexAgeFooter` 签名+决策；改 `ToolHandler.execute()` 调用点 | ~60 |
| `src/mcp/server-instructions.ts` | rule #5 中英双语扩为 3 种 footer 字面量 | ~15 |
| `__tests__/p0-index-age-footer.test.ts` | 单元 + 集成 case 扩到 ~16 条 | ~150 |
| `README.md` | 用户文档"~100% 检测"宣告 | ~30 |
| `changes/0002-p2-f4-smart-stale.md` | 变更记录 + 漏拦复盘 | 新建 |
| `changes/README.md` | 索引追加 1 行 | +1 |

---

## 六、测试用例覆盖（≥ 16）

### 单元（pure function with injectable changeSignal）

| # | case | 期望 |
|---|---|---|
| U1 | hasUncommitted=true → 不论 git/index 时间关系，都返回 uncommitted 警告 | 含 "Uncommitted changes" |
| U2 | hasUncommitted=true + lastCommitTime 新于 index → uncommitted 警告优先 | 不含 "Git has commits newer" |
| U3 | hasUncommitted=false + lastCommitTime ≤ index → ✓✓ 双验证 footer | 含 "✓ matches HEAD, no uncommitted changes" |
| U4 | hasUncommitted=false + lastCommitTime 新于 index → git-newer 警告 | 含 "Git has commits newer" |
| U5 | changeSignal === null（git 不可用） + ageMs=45min → P0 timer 警告 | 字节等同 P0 输出 |
| U6 | changeSignal === null + ageMs=2min → P0 fresh footer | 字节等同 P0 |
| U7 | maxIndexedAt === null → '' | 空串 |
| U8 | 边界：lastCommitTime === maxIndexedAt → ✓ 分支（用 ≤） | 含 "matches HEAD" |
| U9 | drift guard：SERVER_INSTRUCTIONS 含全部 3 种 footer 字面量 | 都 toContain |

### 集成（真实 git 操作 + ToolHandler.execute）

| # | 设置 | 期望 |
|---|---|---|
| I1 | git init + 1 commit + index → 修改 src/foo.ts 不 commit | footer 含 "Uncommitted changes" |
| I2 | git init + 1 commit + index → 新建 src/newfeature.ts 不 git add | footer 含 "Uncommitted changes"（**关键 — 新增文件场景**） |
| I3 | git init + 1 commit + .gitignore 含 dist/* + index → 修改 dist/foo.js | footer **不**警告（验证 .gitignore 尊重） |
| I4 | git init + 1 commit + index + 第二次 commit | footer 含 "Git has commits newer" |
| I5 | git init + 1 commit + index 之后无任何变化 | footer 含 "✓ matches HEAD" |
| I6 | 非 git repo（tmpDir 无 .git） | footer 走 P0 路径，不含任何"Git/Uncommitted"字面量 |
| I7 | codegraph_status 无论何种 git 状态 | footer 全部豁免 |

---

## 七、漏拦复盘（事前预防）

| 漏拦风险 | 预防措施 |
|---|---|
| 红线 #1 TODO 残留 | 实施完 grep 全 src/ 验证 |
| 红线 #4 吞异常 | `getProjectChangeSignal` try/catch 故意吞 — footer 是信息性，git glitch 不能阻塞查询；jsdoc 写明语义 |
| 红线 #5 any | 全程显式类型 `{ lastCommitTime: number \| null; hasUncommitted: boolean }` |
| 红线 #9 console.log | 不打印任何东西 |
| 红线 #10 硬编码 | `--format=%ct` 是 git 协议字面量；30min 阈值复用 `_internal_INDEX_AGE_STALE_MS` 常量 |
| 红线 #18 字符级正则代替 parser | 单测用 `toMatch(/⚠️ Uncommitted changes/)` 而非 `toContain('Uncommitted')` |
| 红线 #19 凭直觉判定未实测 | "目录 mtime 是否递归"特意做过查证（见 §二 方案 B 表格） |
| 红线 #20 不精确否定断言 | `not.toContain` 用精确 anchor 字面量 |

---

## 八、不做的事（明确边界）

- ❌ 不通过监听 inotify/FSEvents 兜底（成本 ≠ 收益，文件系统 watcher 在 stale 场景本身就失效）
- ❌ 不解析 .gitignore 自己写 ignore 逻辑（git 已内置）
- ❌ 不修复"索引了被 .gitignore 排除的文件"的 niche case
- ❌ 不阻塞查询、不拒绝调用 — F-4 只强化 footer 文案，靠 LLM 自己根据 instructions 决定 sync
- ❌ 不引入新依赖

---

## 九、实施总结

待批次完成后追加，含：实施批次清单 / 测试规模变化 / 漏拦复盘汇总 / 遗留 backlog。
