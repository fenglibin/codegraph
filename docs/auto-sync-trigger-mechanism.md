# 自动索引更新（Auto Sync）触发机制

> 本文整理 CodeGraph 在代码 / 文件发生变更时，如何**自动**保持索引（`.codegraph/` SQLite 知识图谱）与工作区同步：触发源、触发时间点、debounce 行为、禁用条件以及兜底路径。
>
> 关键源码：
> - `src/sync/watcher.ts` — `FileWatcher`、订阅者机制、debounce
> - `src/sync/watch-policy.ts` — `watchDisabledReason`，watcher 是否可启用
> - `src/sync/git-hooks.ts` — git 钩子兜底路径
> - `src/index.ts` — `CodeGraph.watch()` / `CodeGraph.unwatch()`，把上述三块串起来

---

## TL;DR

CodeGraph 在两条路径上"自动"更新索引：

| 路径 | 触发源 | 何时启用 |
|---|---|---|
| **文件 watcher（实时）** | OS 原生文件事件（FSEvents / ReadDirectoryChangesW / inotify） | MCP 服务运行中、平台支持递归 watch、未被策略禁用时 |
| **git hooks（兜底）** | `git commit` / `git pull` / `git checkout` | `codegraph init` 在 git 仓库里安装；watcher 不可用的环境下唯一的自动路径 |
| 手动 `codegraph sync` | 用户/脚本显式调用 | 永远可用（非自动） |

两条路径**互不替代**，可以同时存在；watcher 是主路径，git hooks 是当 watcher 因平台原因失效（典型：WSL2 `/mnt/`）时的保底。

---

## 1. 文件 watcher —— 主路径

### 1.1 入口

入口是 `CodeGraph.watch()` (`src/index.ts:484`)，它创建一个 `FileWatcher`(`src/sync/watcher.ts:100`) 并注册两个订阅者：

```text
FileWatcher
  ├── legacy code-sync subscriber  → CodeGraph.sync()           (debounce 2000ms)
  └── doc-sync subscriber          → DocumentIndexer.sync()     (debounce 500ms)
```

`unwatch()` (`src/index.ts:526`) 关闭 watcher 并清空所有 debounce 定时器。

实际谁去调 `watch()`：**MCP 服务进程**（`codegraph serve --mcp`）启动时打开 watcher。CLI 一次性命令（`query` / `context` / `affected` 等）不会启用 watcher——它们是短命进程。

### 1.2 实现机制

```typescript
fs.watch(projectRoot, { recursive: true }, callback)
```

- 单个 OS 级 watcher，**不轮询**——依赖：
  - macOS：FSEvents
  - Windows：ReadDirectoryChangesW
  - Linux：inotify（需要 Node ≥ 19，否则 recursive 不支持）
- 事件回调里做 3 件事（`watcher.ts:166–204`）：
  1. **过滤** `.codegraph/` 自身的写入（避免自激循环）
  2. **分类**：`isSourceFile` → `source`、`isDocFile && !isDocExcluded` → `doc`，其余 `other`
  3. **投递**给关心该 kind 的订阅者，重置该订阅者的 debounce 定时器

### 1.3 触发时间点（debounce）

| 订阅者 | debounce | 同步函数 | 工作量 |
|---|---|---|---|
| **code sync** | **2000ms** | `CodeGraph.sync()` → tree-sitter 增量重抽 + 关系解析 | 重 |
| **doc sync** | **500ms** | `DocumentIndexer.sync()` → hash + chunk + FTS | 轻 |

每收到一个事件就 `clearTimeout` + 重设；**最后一个事件后等满 debounce 时间才真正触发同步**。两个订阅者**完全独立**——doc 同步不会被 code 同步阻塞，反之亦然，错误也彼此隔离。

> ⚠️ 项目根目录 `CLAUDE.md` 里说的"watcher 去抖 ~500ms"是描述 doc sync；**code sync 是 2000ms**。所以"刚改完代码立刻查 codegraph"应至少等 2s 后再查。

### 1.4 串行保护

`flushSubscriber` / `flushLegacy` (`watcher.ts:289–348`) 里有 `syncing` 标志：

- 当前同步未结束时，**不会并发触发**第二次同步。
- 期间到来的新事件会把 `hasChanges = true` 留下，本轮同步结束的 `finally` 块里再排一次。

这样保证："变更连续不断时，索引是最终一致的；不会因为同步慢而丢事件"。

### 1.5 watcher 是否启用：`watchDisabledReason`

`FileWatcher.start()` (`watcher.ts:152`) 第一件事是询问 `watchDisabledReason(projectRoot)` (`src/sync/watch-policy.ts:82`)：

| 条件 | 行为 |
|---|---|
| `CODEGRAPH_NO_WATCH=1` | 禁用，返回原因字符串 |
| `CODEGRAPH_FORCE_WATCH=1` | 强制启用，跳过 WSL2 检测 |
| WSL2 + 项目位于 Windows 盘 `/mnt/...` | 禁用（递归 watch 在 `/mnt/` 上太慢，会挡住 MCP 启动握手 —— issue #199） |
| 其它 | 允许尝试启动 |

即便允许启动，平台层面仍可能失败（如 Linux + Node < 19 不支持 recursive）；`try/catch` 兜底，`logWarn` 后返回 `false`，调用方据此决定是否提示安装 git hooks。

### 1.6 流程图

```
源码文件保存
    │
    ▼
fs.watch 回调（即时，OS 事件）
    │
    ├─ source → 重置 2000ms 定时器 ──→ 2s 后 → CodeGraph.sync()       → 更新 nodes/edges/files
    └─ doc    → 重置  500ms 定时器 ──→ 500ms 后 → DocumentIndexer.sync() → 更新 docs FTS
```

---

## 2. Git hooks —— 兜底路径

当 watcher 不可用（典型：WSL2 `/mnt/`、不支持 recursive、显式禁用），`codegraph init` 会通过 `installGitSyncHook` (`src/sync/git-hooks.ts:121`) 把 `codegraph sync` 注入到下列 git 钩子：

```ts
DEFAULT_SYNC_HOOKS: GitHookName[] = ['post-commit', 'post-merge', 'post-checkout'];
```

### 2.1 触发时机

| Hook | 触发动作 |
|---|---|
| `post-commit` | 本地提交完成后 |
| `post-merge` | `git pull` / `git merge` 完成后 |
| `post-checkout` | `git checkout` / 切分支 / clone 之后 |

### 2.2 注入的脚本片段

```bash
# >>> codegraph sync hook >>>
# Keeps the CodeGraph index fresh while the live file watcher is off
# (e.g. WSL2 /mnt drives). Runs in the background so it never blocks git.
# Managed by codegraph; remove with `codegraph uninit` or delete this block.
if command -v codegraph >/dev/null 2>&1; then
  ( codegraph sync >/dev/null 2>&1 & ) >/dev/null 2>&1
fi
# <<< codegraph sync hook <<<
```

后台运行、丢弃输出，**不阻塞 git**；如果机器上没有 `codegraph` 可执行文件，hook 是 no-op。

### 2.3 幂等与可逆

- 通过 `# >>> codegraph sync hook >>>` / `# <<< ... <<<` 一对 marker 管理。
- 重复 `install` 会先 `stripMarkerBlock` 再追加新版本——**不会重复堆叠**。
- `codegraph uninit` 调 `removeGitSyncHook` 删除该 marker block；如果剩下的 hook 内容只剩 shebang/空行（`isEffectivelyEmpty`），整个 hook 文件会被删除；否则保留用户自写的内容。
- 尊重 `core.hooksPath` 和 git worktrees（`gitHooksDir` 用 `git rev-parse --git-path hooks` 解析，而不是硬编码 `.git/hooks`）。

---

## 3. 选哪条路径？

`init` 时的决策大致是：

1. 是 git 仓库 → 安装 git hooks（即使 watcher 也能用，hooks 也作为额外保险）。
2. 不是 git 仓库 → 只能依赖 watcher。
3. WSL2 `/mnt/` 等 watcher 不可用环境 → `offerWatchFallback` (`src/installer/index.ts:421`) 提示用户安装 git hooks 作为唯一自动路径。

`codegraph status` 会展示 watcher 状态和 hook 安装情况，便于排查"为什么我的索引不更新"。

---

## 4. 实务注意点

1. **MCP 服务必须在跑**，watcher 才工作。只用 `codegraph query` / `codegraph context` 等一次性 CLI 命令时不会触发自动同步——这些短命进程开 watcher 没意义。
2. **同一轮里编辑文件后立刻查 codegraph 可能读到旧索引**——code sync 至少要等 2s 才会 flush。系统提示里写的"index lag ~500ms"对应 doc sync；代码索引是 2s。
3. **`.codegraph/` 自身的写入被显式过滤**，不会触发自激循环。
4. **过滤规则**：source 文件由 `isSourceFile` 决定（依赖语言扩展名注册表）；doc 文件由 `isDocFile` + `isDocExcluded` 决定。其它文件归 `other`，目前无人订阅，但保留语义供未来扩展。
5. **WSL2 性能坑**：在 `/mnt/c/...` 这类 Windows 盘上，递归 fs.watch 启动就要数秒，会让 MCP `initialize` 握手超时 —— 所以策略层直接禁用，强制走 git hooks。
6. **强制开关**：调试时可用 `CODEGRAPH_NO_WATCH=1` 关掉 watcher、`CODEGRAPH_FORCE_WATCH=1` 越过 WSL2 检测强行启用。

---

## 5. 关键源码索引

| 主题 | 位置 |
|---|---|
| `FileWatcher` 类 | `src/sync/watcher.ts:100` |
| `FileWatcher.start()` / `stop()` | `src/sync/watcher.ts:152, 228` |
| `addSubscriber()` | `src/sync/watcher.ts:139` |
| `scheduleSubscriberSync` / `flushSubscriber` | `src/sync/watcher.ts:316, 327` |
| `scheduleLegacySync` / `flushLegacy` | `src/sync/watcher.ts:279, 289` |
| `classifyFile`（source/doc/other） | `src/sync/watcher.ts:265` |
| `watchDisabledReason` | `src/sync/watch-policy.ts:82` |
| `installGitSyncHook` / `removeGitSyncHook` | `src/sync/git-hooks.ts:121, …` |
| `DEFAULT_SYNC_HOOKS` | `src/sync/git-hooks.ts:26` |
| `CodeGraph.watch()` / `unwatch()` | `src/index.ts:484, 526` |
| `offerWatchFallback`（init 时的兜底提示） | `src/installer/index.ts:421` |
