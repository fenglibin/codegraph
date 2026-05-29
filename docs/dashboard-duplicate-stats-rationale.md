# Dashboard 同项目双条记录 — 根因分析与修复方案

> **背景**：用户在 dashboard 上看到同一个项目（"CodeMate"）出现两条记录，且统计数字（如 `search` 调用次数）不一致。
>
> **TL;DR**：不是路径规范化、不是 symlink、也不是哈希碰撞。是 0.10.8 引入的"per-session 文件布局"加上对 pre-0.10.8 legacy `<hash>.json` 的兼容读取，使得 `readAllStats()` 内部的两个分支（目录分支 + legacy 文件分支）针对同一个 hash 各自独立发出一条记录。
>
> 本文档记录现场证据、定位过程、修复方案，以及后续的回归测试设计。

---

## 一、现场证据

### 第一次采样 `~/.codegraph/stats/`

```
2dbcd52bd9d0/        ...其它项目（略）
6e7ab5120919/
674a5c11e77a/        ← 新布局：目录
└── 1780025820265_legacy.json
674a5c11e77a.json    ← 旧布局：legacy 文件，与上面同一个 hash！
...
history/
```

`674a5c11e77a/` 目录与 `674a5c11e77a.json` 文件 hash 完全一致，对应同一个项目：

```
project    = '/Users/fenglibin/data/code/tencent/learn-common-service/docs/CodeMate'
projectName = CodeMate
```

### 几分钟后再采样

```
674a5c11e77a/
├── 1780022557422_legacy.json  ← 刚被迁移进来！原来的顶层 674a5c11e77a.json
├── 1780025820265_legacy.json
└── 1780040964296_45168.json   ← 当前 MCP session（今天新写）
（顶层 674a5c11e77a.json 已不存在）
```

期间发生了 `runStartupMaintenance()`——把顶层 `674a5c11e77a.json` 重命名为 `674a5c11e77a/1780022557422_legacy.json`（文件名前缀 `1780022557422` 正是它的 `startedAt`）。证据闭环：**原顶层 legacy 文件确实和目录里的 session 文件指向同一个 hash 同一个项目**。

---

## 二、为什么 dashboard 会显示两条

`src/mcp/stats-writer.ts` 中 `readAllStats()` 的核心循环：

```typescript
for (const entry of entries) {
  if (entry === HISTORY_DIR_NAME) continue;
  const full = join(statsDir, entry);
  let st;
  try { st = statSync(full); } catch { continue; }

  if (st.isDirectory() && HASH_RE.test(entry)) {
    // ① 目录分支：聚合目录里今天的 session 文件 → 推一条
    const todaysSessions = allSessions.filter(s => toDateString(s.startedAt) === today);
    if (todaysSessions.length === 0) continue;
    const agg = aggregateSessions(todaysSessions);
    out.push({ ...agg, hash: entry, sessionCount: todaysSessions.length });
  } else if (st.isFile() && entry.endsWith('.json') && !entry.endsWith('.tmp')) {
    // ② legacy 文件分支：把今天的顶层 legacy 文件单独推一条
    if (toDateString(parsed.startedAt) !== today) continue;
    out.push({ ...parsed, hash, sessionCount: 1 });
  }
}
```

两个分支彼此不感知 hash —— 当顶层 `<hash>.json` 与 `<hash>/` 目录 **同时存在**、且二者的 `startedAt` 都是今天时，`out` 数组里会出现两个 `hash` 相同、`projectName` 相同、但 `tools` 不同的记录。前端按列表渲染，于是看到两个 CodeMate。

---

## 三、为什么统计数字（`search` 等）不一致

两条记录采集的是**同一个项目下不同 session 的子集**，永远不会一致：

| 来源 | 包含的 session | search count |
|---|---|---|
| ② legacy 文件分支：顶层 `674a5c11e77a.json`（startedAt=1780022557422） | 单一 session | 11 |
| ① 目录分支：聚合目录中今天的 session 文件 | `1780025820265_legacy.json` (search=10) + `1780040964296_45168.json` (search=4) + ... | 14（聚合） |

每条记录的"事实"都对——只是覆盖的 session 范围不同。

---

## 四、为什么 legacy 文件会残留

按 0.10.8 设计，legacy `<hash>.json` → `<hash>/<startedAt>_legacy.json` 的迁移**只在两个时机发生**：

1. `DashboardServer.start()` → `runStartupMaintenance()`：dashboard 进程启动时跑一次。
2. `new StatsWriter(projectPath)` → `migrateLegacyFile()`：MCP server 为该项目首次构造 writer 时，只处理自己那个 hash。

漏洞：dashboard 是常驻进程，期间 `readAllStats` 不做迁移，只读。所以下面这种时序就会触发症状：

```
旧版 codegraph 跑过  → 写下顶层 ~/.codegraph/stats/<hash>.json
↓
dashboard 启动（runStartupMaintenance 跑过；但若那一刻 legacy 文件还不存在或迁移瞬间失败）
↓
新版 MCP 写入 <hash>/<startedAt>_<pid>.json  → 目录里有今天的 session
↓
顶层 <hash>.json 仍残留（未被本进程的 maintenance 处理过）
↓
readAllStats 同时命中两个分支 → dashboard 出双条
```

实际验证：我第一次 `ls` 看到双布局共存，几分钟后再看顶层 legacy 已被自动清掉——原因是期间又有一个 MCP server 进程构造了 `StatsWriter`，触发其构造函数里的 `migrateLegacyFile()`。**说明它是自愈的瞬态 bug**，但 dashboard 在自愈窗口内就是会出双条。

---

## 五、排除掉的其它假设

- ❌ **路径规范化（trailing slash / symlink / case）**：4 个 CodeMate session 文件的 `project` 字段完全一致，同一个 hash。
- ❌ **多 hash 同名**：扫遍 `~/.codegraph/stats/`，没有第二个 `projectName=CodeMate` 的 hash。
- ✅ **legacy 文件 + 新目录布局并存** 是唯一原因。

---

## 六、修复方案

### 选定：在 `readAllStats` 内部按 hash 合并两个分支

在两次 disk 扫描之后做一次按 hash 的 merge，每个 hash 只产出一条记录。复用现有 `aggregateSessions` 聚合逻辑——目录与 legacy 文件中的 `StatsFile` 形状完全一致，可以直接喂给同一个聚合函数。

伪代码：

```typescript
export function readAllStats(): AggregatedStats[] {
  const today = toDateString(Date.now());

  // 按 hash 收集本次要纳入"今天"统计的 StatsFile 数组
  const sessionsByHash = new Map<string, StatsFile[]>();

  for (const entry of readdirSync(statsDir)) {
    if (entry === HISTORY_DIR_NAME) continue;
    const full = join(statsDir, entry);
    const st = safeStat(full);
    if (!st) continue;

    if (st.isDirectory() && HASH_RE.test(entry)) {
      const todays = readSessionFiles(full)
        .filter(s => toDateString(s.startedAt) === today);
      if (todays.length) push(sessionsByHash, entry, todays);
    } else if (st.isFile() && entry.endsWith('.json') && !entry.endsWith('.tmp')) {
      const hash = entry.replace(/\.json$/, '');
      if (!HASH_RE.test(hash)) continue;
      const parsed = safeReadStatsFile(full);
      if (!parsed) continue;
      if (toDateString(parsed.startedAt) !== today) continue;
      push(sessionsByHash, hash, [parsed]);
    }
  }

  return [...sessionsByHash.entries()].map(([hash, sessions]) => {
    const agg = aggregateSessions(sessions);
    return { ...agg, hash, sessionCount: sessions.length };
  });
}
```

**关键点**：
- legacy 文件以"单 session"身份并入同 hash 的 sessions 数组，再走一次 `aggregateSessions`——和把它当独立来源是 idempotent 的。
- 不依赖 disk 状态自愈，dashboard 任何时刻都不会出双条。
- 不影响 `runStartupMaintenance` / `migrateLegacyFile` 的物理迁移逻辑（残留 legacy 文件最终仍会被搬走，只是不再可见地产生重复显示）。

### 备选方案（不采纳）

| 方案 | 不采纳原因 |
|---|---|
| dashboard 每次 `/api/stats` 前跑 `runStartupMaintenance` | 解决了根因但 IO 成本随项目数线性增长；且依赖 maintenance 不抛错——保险性弱于纯读端去重。 |
| 让 `readAllStats` 直接跳过 legacy 文件，依赖 maintenance 清理 | 牺牲了"dashboard 在 MCP 没跑前也能看到老数据"的能力（CHANGELOG 0.10.8 的承诺）。 |
| 保持现状，文档说明 | 用户体验差，且自愈时间不可控（取决于该项目 MCP 何时启动）。 |

---

## 七、回归测试设计

新增测试用例 `readAllStats: dedupes legacy <hash>.json against same-hash directory`，放在 `__tests__/stats-writer.test.ts`。

骨架：

```typescript
it('readAllStats merges legacy <hash>.json with same-hash <hash>/ directory', () => {
  // 模拟 ~/.codegraph/stats/ 下同时存在：
  //   <hash>/<startedAt1>_<pid>.json   {tools.search.count = 4}
  //   <hash>.json                       {tools.search.count = 11}
  // 二者 startedAt 都是今天

  const all = readAllStats();
  const matching = all.filter(s => s.hash === testHash);

  // 关键：只剩一条
  expect(matching).toHaveLength(1);

  // 关键：合并后 search.count = 4 + 11 = 15
  expect(matching[0]!.tools.codegraph_search.count).toBe(15);
  expect(matching[0]!.sessionCount).toBe(2);
});
```

测试通过 `process.env.HOME` 重定向（或既有 helper）把 stats 目录指向 `mkdtempSync` 创建的临时目录，afterEach 清理。

---

## 八、CHANGELOG 条目（写在修复 PR 里）

```markdown
### Fixed
- **Dashboard no longer shows duplicate rows for the same project during the
  legacy-layout transition window.** When a pre-0.10.8 `<hash>.json` file
  hadn't been migrated yet but a fresh per-session `<hash>/<...>.json`
  already existed, `readAllStats` emitted two records for the same project
  hash with diverging session counts. It now merges by hash before returning,
  so the dashboard always shows one row per project even mid-migration.
```

---

## 九、关键源码位置

| 主题 | 位置 |
|---|---|
| `readAllStats`（双分支根因所在） | `src/mcp/stats-writer.ts:545` |
| `aggregateSessions`（聚合工具） | `src/mcp/stats-writer.ts:363` |
| `readSessionFiles`（目录读 helper） | `src/mcp/stats-writer.ts:602` |
| `migrateLegacyFile`（StatsWriter 构造时迁移） | `src/mcp/stats-writer.ts:244` |
| `runStartupMaintenance`（dashboard 启动迁移） | `src/mcp/stats-writer.ts:456` |
| Dashboard API 路由 | `src/dashboard/api.ts:18` |
| 现有测试（参考布局/helper） | `__tests__/stats-writer.test.ts` |
