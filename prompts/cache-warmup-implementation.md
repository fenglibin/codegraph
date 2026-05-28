# 缓存预热实现提示词

## 背景

你正在实现 CodeGraph 的**缓存预热功能**。这是一个缓存架构升级，目的是解决"每次新 session 冷启动导致缓存命中率极低"的问题。

### 完整设计文档

`docs/cache-warmup-architecture.md` — 包含现状分析、问题描述、方案对比和最终选定的方案细节。请先阅读该文件。

### 已经完成的工作

在此之前的 session 中已完成以下工作（都是本次缓存升级的前置准备）：

1. **内存 Session Stats**（`src/mcp/tools.ts`）— 每次 tool 调用记录计数、延迟
2. **Node 缓存命中率追踪**（`src/db/queries.ts`）— `cacheHits`/`cacheMisses` 计数器、`getCacheStats()` 方法
3. **Stats 持久化**（`src/mcp/stats-writer.ts`）— 写入 `~/.codegraph/stats/` 供 Dashboard 读取
4. **Dashboard HTTP 服务**（`src/dashboard/`）— `codegraph dashboard` 命令启动的 Web 仪表盘
5. **`codegraph_usage` MCP tool**（`src/mcp/tools.ts`）— AI Agent 直接查询使用统计
6. **Debug 日志系统**（`src/mcp/debug-log.ts`）— 写入 `~/.codegraph/logs/mcp-debug.log`

### 还没有做的事

**缓存预热本身还未实现**。需要你来完成。

---

## 任务拆分（OpenSpec）

### Task 1：实现 `QueryBuilder.warmCache()` 方法

**文件**：`src/db/queries.ts`

**要求**：
1. 在 `QueryBuilder` 类中新增 `warmCache(limit?: number): number` 方法
2. 执行 SQL 查询获取连接数（入边+出边）最多的 Top N 个节点
3. 将查询结果批量调用现有的 `cacheNode()` 加入 LRU Map
4. 返回实际预热的节点数
5. limit 参数默认值逻辑：
   - 先通过 `SELECT COUNT(*) FROM nodes` 获取总节点数
   - 如果 ≤ 500，则预热全部（`SELECT * FROM nodes`）
   - 如果 > 500，则按连接数排序取 Top 500

**预热 SQL（大项目）**：
```sql
SELECT n.* FROM nodes n
LEFT JOIN (
  SELECT source AS node_id, COUNT(*) AS cnt FROM edges GROUP BY source
  UNION ALL
  SELECT target AS node_id, COUNT(*) AS cnt FROM edges GROUP BY target
) e ON n.id = e.node_id
GROUP BY n.id
ORDER BY COALESCE(SUM(e.cnt), 0) DESC
LIMIT ?
```

> **已验证**：在 CodeGraph 自身项目（2250 节点、4357 条边）上测试，查询 Top 500 耗时仅 14ms。

**小项目（≤500 节点）直接全量加载**：
```sql
SELECT * FROM nodes
```

**注意事项**：
- 使用 `this.db.prepare().all()` 执行查询
- 使用现有的 `rowToNode()` 转换行数据
- 使用现有的 `cacheNode()` 写入缓存
- 不要重置 `cacheHits`/`cacheMisses` 计数器（预热不计入命中率统计）
- 方法需要 try/catch 包裹，预热失败不应阻断 open 流程

### Task 2：在 `CodeGraph.open()` 和 `openSync()` 中调用预热

**文件**：`src/index.ts`

**要求**：
1. 在 `CodeGraph.open()` 方法中，`new CodeGraph(db, queries, resolvedRoot)` 之后调用 `queries.warmCache()`
2. 在 `CodeGraph.openSync()` 方法中同样处理
3. 添加 debug 日志记录预热结果（预热了多少个节点、耗时）
4. 预热失败不影响正常 open 流程（已在 Task 1 中通过 try/catch 保证）

**代码位置参考**：
- `open()` 方法在 `src/index.ts:234`
- `openSync()` 方法在 `src/index.ts:267`
- 两者都在最后 `return new CodeGraph(...)` 之前执行预热

### Task 3：编写测试

**文件**：`__tests__/cache-warmup.test.ts`（新建）

**测试用例**：
1. `warmCache() pre-loads nodes into cache`
   - 创建临时项目 → init → index（写入多个文件产生节点和边）
   - 调用 `warmCache()`
   - 验证 `getCacheStats().size > 0`

2. `getNodeById hits cache after warmup`
   - 预热后，对某个已知 node ID 调用 `getNodeById`
   - 验证 `getCacheStats().hits > 0`（而非 miss）

3. `warmCache respects limit for large projects`
   - 创建一个有 > 500 节点的临时项目（或 mock）
   - 调用 `warmCache(100)`
   - 验证 `getCacheStats().size <= 100`

4. `warmCache loads all nodes for small projects`
   - 创建一个只有 10 个节点的项目
   - 调用 `warmCache()`
   - 验证 `getCacheStats().size === 10`

5. `open() pre-warms cache automatically`
   - 创建项目 → init → index → close
   - 重新 `CodeGraph.open()` 
   - 验证 `getCacheStats().size > 0`（无需手动调用 warmCache）

6. `warmCache failure does not break open()`
   - 验证即使 warmCache 内部抛异常，open() 仍成功返回

### Task 4：验证 & 性能基线

**操作**：
1. `npm run build` — 编译通过
2. `npm test` — 所有测试通过
3. 在 CodeMate 项目中实际测试：
   - 重启 MCP Server session
   - 查看 `~/.codegraph/logs/mcp-debug.log` 确认预热日志
   - 首次调用 `codegraph_context` 后检查命中率
   - 与之前的 6.6% 对比

---

## 关键文件位置

| 文件 | 作用 | 关键行号 |
|------|------|---------|
| `src/db/queries.ts` | `QueryBuilder` 类，含 `nodeCache`、`cacheNode()`、`getNodeById()`、`getCacheStats()` | 类定义 ~146 行 |
| `src/index.ts` | `CodeGraph` 类，`open()` ~234 行，`openSync()` ~267 行 | |
| `src/mcp/debug-log.ts` | `debugLog()` 日志工具 | |
| `docs/cache-warmup-architecture.md` | 完整设计文档 | |

## 构建与测试命令

```bash
npm run build              # TypeScript 编译
npm test                   # 全量测试
npx vitest run __tests__/cache-warmup.test.ts  # 只跑缓存预热测试
```

## 注意事项

1. **不要修改现有的 `cacheHits`/`cacheMisses` 计数逻辑** — 预热不应影响命中率统计的准确性。预热通过 `cacheNode()` 写入缓存，`cacheNode()` 不触发 hits/misses 计数。
2. **`rowToNode()` 函数**在 `src/db/queries.ts` 中已存在（约第 80 行），直接复用。
3. **预热时间记录**：使用 `performance.now()` 计时，通过 `debugLog` 输出。
4. **兼容 `clearCache()`**：`clearCache()` 方法现有逻辑（只清 Map）不需要改动——如果缓存被清了，下次 `getNodeById` 会自然 miss 并重新从 SQLite 加载。
5. **不需要修改 `maxCacheSize`**：保持 1000 不变。预热 500 个节点后还有 500 个位置供运行时使用。
