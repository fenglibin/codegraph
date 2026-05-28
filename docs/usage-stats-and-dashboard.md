# 使用统计与 Dashboard

> **日期**：2026-05-28
> **关联**：Session Stats + Dashboard + `codegraph_usage` tool
> **变更文件**：`src/mcp/tools.ts`、`src/mcp/stats-writer.ts`、`src/mcp/index.ts`、`src/dashboard/`、`src/bin/codegraph.ts`

---

## 背景与动机

用户安装 CodeGraph 后，无法直观了解 CodeGraph 在各项目中的使用效果——工具被调用了多少次？查询延迟如何？Node 缓存命中率是否健康？这些信息对于：

1. **评估 CodeGraph 的实际价值** — 是否真的减少了 grep/Read
2. **诊断性能问题** — 某个工具异常慢？缓存命中率低？
3. **多项目管理** — 哪些项目活跃在用 CodeGraph？

---

## 实现方案

### 架构

```
┌─────────────────┐   每5s写入   ┌──────────────────────┐
│ MCP Server (A)  │────────────▶│ ~/.codegraph/stats/  │
│ MCP Server (B)  │────────────▶│   <hash-a>.json      │
│ MCP Server (C)  │────────────▶│   <hash-b>.json      │
└─────────────────┘             │   history/           │
                                │     <hash>_日期.json  │
                                └──────────┬───────────┘
                                           │ read
                    ┌──────────────────────▼──────────────────┐
                    │                                          │
                    │  方式1: codegraph_usage (MCP tool)       │
                    │  方式2: codegraph dashboard (HTTP 页面)   │
                    │  方式3: codegraph_status (追加在末尾)     │
                    │                                          │
                    └──────────────────────────────────────────┘
```

### 三层数据流

1. **采集**：`ToolHandler.execute()` 每次调用后用 `performance.now()` 记录延迟，累加到内存 Map
2. **持久化**：`StatsWriter` 以 5s debounce 写入 `~/.codegraph/stats/<hash>.json`（原子写入：tmp + rename）
3. **展示**：三种查看方式（MCP tool / Dashboard 网页 / status 追加）

### 缓存命中率

Node 缓存是 `QueryBuilder` 中的 LRU Map（最大 1000 条）：

```
命中率 = hits / (hits + misses) × 100%
```

- **hits**：`getNodeById(id)` 在缓存中找到节点（亚微秒返回）
- **misses**：需要走 SQLite prepared statement 查询，结果再写入缓存

健康标准：
- **≥ 70%** 🟢 — 正常（图遍历操作如 callers/impact 会多次访问同一节点）
- **40-70%** 🟡 — 一般（可能项目较小或查询模式分散）
- **< 40%** 🔴 — 不健康（可能 maxCacheSize=1000 对超大项目不够）

---

## 如何查看统计

### 方式 1：MCP Tool `codegraph_usage`（推荐）

在 AI 对话中直接调用：

```
调用 codegraph_usage，scope 设为 "all"
```

支持三种 scope：

| scope | 说明 |
|-------|------|
| `all` | 所有项目汇总 + 各项目概览 + 全局 tool 排行 |
| `current` | 当前（最近活跃）项目的详细统计 |
| `history` | 当前项目的每日历史趋势 |

### 方式 2：Dashboard 网页

```bash
codegraph dashboard              # 默认端口 7890
codegraph dashboard --port 8080  # 自定义端口
```

浏览器自动打开，提供：
- 全量汇总卡片（总调用、总错误、平均延迟、缓存命中率）
- 分项目卡片（工具调用柱状图、Cache 详情）
- 5 秒自动刷新
- 历史数据查看
- 暗色模式支持

### 方式 3：`codegraph_status` 输出

调用 `codegraph_status` 时，输出末尾自动追加：

```
### Session Usage (since server start)

| Tool | Calls | Errors | Avg (ms) | Min (ms) | Max (ms) |
|------|-------|--------|----------|----------|----------|
| codegraph_context | 12 | 0 | 3.2 | 1.1 | 8.4 |
| codegraph_search  |  8 | 0 | 0.8 | 0.3 | 1.5 |
| **Total** | **20** | **0** | — | — | — |

**Node cache:** 156 hits / 42 misses (78.8% hit rate) | capacity: 234/1000

**Uptime:** 47m 12s
```

---

## Stats 文件格式

`~/.codegraph/stats/<hash>.json`：

```json
{
  "version": 1,
  "project": "/Users/x/my-app",
  "projectName": "my-app",
  "startedAt": 1716800000000,
  "updatedAt": 1716803600000,
  "tools": {
    "codegraph_context": {
      "count": 12,
      "errors": 0,
      "totalMs": 38.4,
      "minMs": 1.1,
      "maxMs": 8.4
    }
  },
  "cache": {
    "hits": 156,
    "misses": 42,
    "size": 198,
    "maxSize": 1000
  }
}
```

`<hash>` = 项目绝对路径 SHA-256 的前 12 位 hex。

### 历史归档

- 每日自动归档：MCP Server 重启时如果发现旧日期的 stats 文件，移到 `history/`
- 保留 30 天，dashboard 启动时自动清理过期文件
- 历史文件命名：`<hash>_YYYY-MM-DD.json`
