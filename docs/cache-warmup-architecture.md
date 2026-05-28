# 缓存架构升级：Per-Project 预热缓存

> **日期**：2026-05-28
> **状态**：方案已确定，待实现
> **影响范围**：`src/db/queries.ts`、`src/index.ts`、缓存命中率全局提升

---

## 1. 现状

### 当前缓存设计

CodeGraph 的 `QueryBuilder`（位于 `src/db/queries.ts`）维护一个 **内存 LRU Map** 用于加速 `getNodeById()` 查询：

```typescript
private nodeCache: Map<string, Node> = new Map();
private readonly maxCacheSize = 1000;
```

**工作方式**：
- `getNodeById(id)` 先查内存 Map，命中则跳过 SQLite 查询（节省 ~0.1-0.5ms）
- 未命中则走 SQLite prepared statement，结果写入 Map
- Map 满时淘汰最早的 entry（LRU 语义）

**缓存生命周期**：与 MCP Server 进程绑定 — 进程启动时空缓存，进程退出时缓存丢失。

### 存在的问题

1. **每次新 session 冷启动**：用户每次打开 IDE、重启 AI Agent，MCP Server 进程重新创建，缓存从零开始
2. **首次调用命中率极低**：实测在 CodeMate 项目中，新 session 的前 7 次 tool 调用命中率仅 6.6%（11 hits / 156 misses）
3. **用户感知差**：即使项目结构没变、同一个工程反复使用，每次都要经历"升温期"
4. **图遍历操作受影响最大**：`codegraph_context`、`codegraph_impact`、`codegraph_callers` 等调用会 BFS/DFS 遍历大量节点，冷缓存下全是 miss

### 数据验证

实际数据（CodeMate 项目，7 次 tool 调用后）：
```json
{
  "cache": {
    "hits": 11,
    "misses": 156,
    "size": 156,
    "maxSize": 1000
  }
}
```
命中率 = 11 / (11 + 156) = **6.6%**

---

## 2. 需求

> 用户诉求：缓存应以**项目**为依据，而非以 session 为依据。同一项目中开启的任何新 session 都应有较高的缓存命中率。

具体要求：
- 新 session 启动时不再从空缓存开始
- 首次 tool 调用即可享受较高的命中率（目标 ≥ 60%）
- 不显著增加启动时间（目标 < 200ms）
- 不引入外部依赖
- 缓存失效要自然正确（代码变更后不返回过期数据）

---

## 3. 可能的实现方案

### 方案 A：启动时自动预热高频节点

```
CodeGraph.open() / openSync()
    ↓
查询数据库中连接数（边数）最多的 Top N 个节点
    ↓
批量加载到内存 nodeCache
    ↓
Session 从"温"状态开始
```

**实现核心**：一次 SQL 查询获取高连接度节点，批量预热到 LRU Map。

**优点**：
- 无需额外持久化文件
- 无需记录上次 session 状态
- 确定性预热，结果可复现
- 代码变更后 `sync` 更新节点 → 下次 open 自然拿到新数据
- 对所有用户、所有 session 一视同仁

**缺点**：
- 预热的是"结构上重要的节点"而非"用户实际常查的节点"
- 对非常大的项目有一定启动开销

### 方案 B：持久化上次 session 的热缓存 ID

在 session 结束时把当前缓存的 node IDs 写入 `.codegraph/cache-warm.json`，下次启动时读取并批量加载。

**优点**：精确学习用户的实际使用模式
**缺点**：额外文件管理、代码变更后 node ID 变化导致失效、需要处理文件损坏等边界情况

### 方案 C：A + B 组合

启动时先用高频节点预热（A），再用上次 session 的热 ID 补充（B）。

**优点**：兼顾确定性和个性化
**缺点**：复杂度高

---

## 4. 选择的方案：方案 A

### 理由

1. **简单可靠** — 不依赖外部文件，不存在过期/损坏问题
2. **符合直觉** — 项目中被最多代码引用的核心类/函数自然是最常被图遍历访问的
3. **成本可控** — 启动时一次 SQL 查询，后续无额外开销
4. **自然失效** — CodeGraph `sync` 会更新/删除变更的节点，下次 open 时预热的是最新数据
5. **覆盖面广** — 高连接度节点恰好是 BFS/DFS 遍历中最常被多次访问的节点

### 实现策略

**预热查询 SQL**：
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

**预热数量决策**：
| 项目节点数 | 预热数量 | 说明 |
|-----------|---------|------|
| ≤ 500 | 全部 | 小项目直接全量预热 |
| 500 - 2000 | 500 | 中型项目取 Top 500 |
| > 2000 | 500 | 大项目也只取 Top 500（受 maxCacheSize=1000 限制） |

**触发时机**：`CodeGraph.open()` 和 `CodeGraph.openSync()` 中，数据库打开后立即预热。

---

## 5. 预期收益

| 指标 | 预热前 | 预热后（预期） |
|------|--------|--------------|
| 首次 context 调用命中率 | 5-10% | 60-80% |
| 多次调用后稳定命中率 | 70-85% | 85-95% |
| 启动时间增加 | — | +50-150ms（取决于项目大小） |
| 内存增加 | — | 可忽略（Node 对象已经在 SQLite 读入） |

### 不足

1. **预热的不一定是用户最需要的节点** — 高连接度 ≠ 用户当前工作区域。但由于图遍历必经核心节点，实际命中率仍会大幅提升。
2. **启动有少许延迟** — 对于超大项目（>10k 节点），查询 + 加载可能到 150-200ms。可接受。
3. **maxCacheSize 限制** — 缓存上限 1000，预热 500 后只剩 500 个位置给运行时新节点。可通过扩大 maxCacheSize 缓解（后续优化）。

---

## 6. 涉及文件

| 文件 | 变更 |
|------|------|
| `src/db/queries.ts` | 新增 `warmCache()` 方法：执行预热 SQL、批量 `cacheNode()` |
| `src/index.ts` | 在 `open()` / `openSync()` 中调用 `queries.warmCache()` |
| `__tests__/cache-warmup.test.ts` | 新建：验证预热后命中率提升、预热数量正确 |

---

## 7. 验证方式

1. **单元测试**：创建测试项目 → index → open → 验证 `getCacheStats().size > 0` 且首次 `getNodeById` 命中
2. **集成测试**：对比预热前后的命中率（同一项目同样的 tool 调用序列）
3. **启动性能**：计时 `open()` 前后对比，确保增量 < 200ms
4. **实际验证**：在 CodeMate 项目中重启 session，首次 `codegraph_context` 调用后检查命中率
