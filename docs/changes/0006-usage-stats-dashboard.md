# 0006: 使用统计、缓存命中率与 Dashboard

> **日期**：2026-05-28
> **类型**：新功能
> **影响范围**：MCP Server、CLI、新增 Dashboard

---

## 概述

为 CodeGraph 添加运行时使用统计系统，包含：

1. **内存统计采集** — 每次 tool 调用记录计数、延迟、错误数
2. **Node 缓存命中率** — 在 `QueryBuilder.getNodeById()` 层追踪 hits/misses
3. **Stats 持久化** — 写入 `~/.codegraph/stats/` 供跨 session 查看
4. **`codegraph_usage` MCP tool** — AI Agent 可直接查询使用统计
5. **`codegraph dashboard` CLI 命令** — 启动 HTTP 服务展示 Web 仪表盘
6. **`codegraph_status` 增强** — 末尾追加 Session Usage 段

## 变更文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/mcp/tools.ts` | 修改 | `ToolStats` 接口、`recordCall()`、`getSessionStats()`、`onStatsUpdate` 回调、`handleUsage()`、`handleStatus()` 追加输出 |
| `src/mcp/stats-writer.ts` | 新建 | `StatsWriter` 类：debounce 写入、原子写、归档、`readAllStats()`/`readProjectHistory()` |
| `src/mcp/index.ts` | 修改 | 导入 StatsWriter、`ensureStatsWriter()` 方法、`stop()` 中 flush、所有初始化路径覆盖 |
| `src/db/queries.ts` | 修改 | `cacheHits`/`cacheMisses` 计数器、`getCacheStats()` 方法 |
| `src/index.ts` | 修改 | `CodeGraph.getCacheStats()` 方法 |
| `src/dashboard/index.ts` | 新建 | `DashboardServer` HTTP 服务 |
| `src/dashboard/api.ts` | 新建 | API 路由处理 |
| `src/dashboard/html.ts` | 新建 | 自包含单文件 HTML 页面 |
| `src/bin/codegraph.ts` | 修改 | 注册 `dashboard` 子命令 |
| `__tests__/mcp-stats.test.ts` | 新建 | Session stats + cache stats 测试 |
| `__tests__/stats-writer.test.ts` | 新建 | StatsWriter 单元测试 |
| `__tests__/dashboard-api.test.ts` | 新建 | Dashboard API 测试 |

## 使用方式

```bash
# 查看 Dashboard
codegraph dashboard

# 通过 MCP tool
codegraph_usage                    # 所有项目汇总
codegraph_usage scope="current"    # 当前项目
codegraph_usage scope="history"    # 历史趋势

# 通过 status（自动追加）
codegraph_status
```

## 技术细节

- Stats 文件写入使用 5s debounce + tmp+rename 原子操作
- Dashboard 使用 Node 内置 `http` 模块，零外部依赖
- 前端为纯 HTML+CSS+JS 单文件，5s 轮询 API 自动刷新
- 历史数据自动按天归档，保留 30 天
- 缓存命中率公式：`hits / (hits + misses) × 100%`
