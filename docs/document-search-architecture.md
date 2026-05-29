# 文档分块搜索功能设计

> **日期**：2026-05-28
> **状态**：方案已确定，待确认
> **影响范围**：新增独立的文档索引/搜索模块，新增 MCP 工具 `codegraph_docs`

---

## 1. 需求背景

### 问题

LLM（AI Agent）在理解项目时，除了代码外还需要频繁阅读项目文档（README、设计文档、CHANGELOG 等）。当前的做法是：

1. LLM 调用 `Read` 工具读取文档全文
2. 完整文档内容（通常 1000-5000 tokens）进入对话历史
3. 后续每一轮对话都要重复发送这些 token（累积计费）
4. 大部分内容与当前问题无关，造成 token 浪费 + 信息噪声

### 目标

1. **降低 LLM 费用**：只返回文档中与查询相关的段落，减少进入对话的 token 量
2. **提升响应质量**：LLM 拿到的是精准的相关内容，而非充满噪声的全文
3. **保持独立性**：与现有代码索引/搜索完全解耦，互不依赖

### 约束

- 不与代码符号建立关联（避免增加复杂度和耦合）
- 不引入外部依赖（复用 SQLite FTS5）
- 独立的入口和逻辑（独立 CLI 命令、独立表）
- 第一版只支持 `.md` 和 `.txt` 格式

---

## 2. 方案设计

### 2.1 架构总览

```
项目文档文件 (.md, .txt)
    │
    ▼  扫描 + 过滤（排除 node_modules/vendor 等）
    │
    ▼  分块（按 heading 拆分）
    │
    ▼  写入 SQLite
┌─────────────────────────────────────────┐
│  表: doc_chunks                          │
│  ┌─────────────────────────────────────┐│
│  │ id | path | chunk_index | title     ││
│  │ heading_level | content | lines...  ││
│  └─────────────────────────────────────┘│
│                                          │
│  虚拟表: doc_chunks_fts (FTS5 全文索引)  │
└─────────────────────────────────────────┘
    │
    ▼  MCP 工具 codegraph_docs (search/outline/read)
    │
    ▼  返回精准段落给 LLM
```

### 2.2 数据模型

```sql
-- 文档块表
CREATE TABLE IF NOT EXISTS doc_chunks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    path          TEXT NOT NULL,            -- 相对路径: docs/deploy.md
    chunk_index   INTEGER NOT NULL,         -- 块在文件中的顺序: 0, 1, 2...
    title         TEXT,                     -- heading 文本: "部署流程"
    heading_level INTEGER NOT NULL DEFAULT 0, -- 0=无heading, 1=h1, 2=h2, 3=h3...
    content       TEXT NOT NULL,            -- 块的正文内容
    start_line    INTEGER NOT NULL,
    end_line      INTEGER NOT NULL,
    content_hash  TEXT NOT NULL,            -- 文件级 hash，用于增量更新
    updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_chunks_path_chunk
    ON doc_chunks(path, chunk_index);

CREATE INDEX IF NOT EXISTS idx_doc_chunks_path
    ON doc_chunks(path);

-- FTS5 全文搜索索引
CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
    title,
    content,
    content='doc_chunks',
    content_rowid='id',
    tokenize='unicode61'
);

-- 触发器：保持 FTS 同步
CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
    INSERT INTO doc_chunks_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
    INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
    INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO doc_chunks_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;
```

### 2.3 分块策略

**Markdown 文件**：按 heading 分割

```
输入: deploy.md
━━━━━━━━━━━━━━━━━━━━━━━━
# 部署指南                    → chunk 0 (h1, 包含到下一个 heading 之前的正文)
简介文字...

## 前置条件                   → chunk 1 (h2)
- Node >= 18
- Docker

## 部署步骤                   → chunk 2 (h2)
1. 构建镜像
2. 推送到 registry

### 回滚                     → chunk 3 (h3)
kubectl rollout undo...

## 监控                       → chunk 4 (h2)
Grafana dashboard...
━━━━━━━━━━━━━━━━━━━━━━━━
```

**纯文本文件 (.txt)**：按空行分段，若无空行则按固定行数（每 50 行）

**分块规则**：

| 规则 | 值 | 说明 |
|------|-----|------|
| 最大块大小 | 200 行 或 4000 字符 | 超过则在段落边界二次切割 |
| 最小块大小 | 3 行 | 避免碎片化，短内容合并到上一块 |
| 无 heading 的 .md | 按空行分段 | 退化为 txt 策略 |

### 2.4 文件排除规则

以下目录/模式在文档索引时**默认硬排除**（不可通过配置覆盖）：

#### 通用排除

| 模式 | 说明 |
|------|------|
| `.git/` | Git 内部 |
| `.svn/`, `.hg/` | 其他 VCS |
| `.codegraph/` | CodeGraph 自身数据 |
| `.DS_Store` | macOS 系统文件 |

#### Node.js / JavaScript / TypeScript

| 模式 | 说明 |
|------|------|
| `node_modules/` | npm 依赖 |
| `.next/`, `.nuxt/`, `.output/` | 框架构建产物 |
| `.cache/`, `.parcel-cache/` | 构建缓存 |
| `coverage/` | 测试覆盖率报告 |

#### Python

| 模式 | 说明 |
|------|------|
| `.venv/`, `venv/`, `env/`, `.env/` | 虚拟环境 |
| `__pycache__/` | 字节码缓存 |
| `*.egg-info/`, `.eggs/` | 包构建产物 |
| `site-packages/` | 已安装的包 |
| `.tox/`, `.nox/` | 测试环境 |
| `.mypy_cache/`, `.pytest_cache/`, `.ruff_cache/` | 工具缓存 |

#### Java / Kotlin

| 模式 | 说明 |
|------|------|
| `target/` | Maven 构建产物 |
| `.gradle/` | Gradle 缓存 |
| `.idea/` | IntelliJ 项目文件 |

#### Go

| 模式 | 说明 |
|------|------|
| `vendor/` | Go modules vendor |

#### Rust

| 模式 | 说明 |
|------|------|
| `target/` | Cargo 构建产物 |

#### C / C++

| 模式 | 说明 |
|------|------|
| `cmake-build-*/` | CMake 构建目录 |
| `.ccache/` | 编译缓存 |

#### PHP

| 模式 | 说明 |
|------|------|
| `vendor/` | Composer 依赖 |

#### Ruby

| 模式 | 说明 |
|------|------|
| `vendor/bundle/`, `.bundle/` | Bundler 依赖 |

#### Dart / Flutter

| 模式 | 说明 |
|------|------|
| `.dart_tool/` | Dart 工具缓存 |
| `.pub-cache/` | Pub 包缓存 |

#### .NET / C#

| 模式 | 说明 |
|------|------|
| `packages/` | NuGet 包 |

#### 通用构建产物

| 模式 | 说明 |
|------|------|
| `dist/`, `build/`, `out/` | 构建输出 |
| `bin/`, `obj/` | 编译输出 |
| `_build/` | 通用构建目录 |

**完整排除列表实现为一个常量数组** `DOCS_DEFAULT_EXCLUDES`，硬编码在源文件中。

### 2.5 MCP 工具设计

```typescript
// 工具名: codegraph_docs
// 参数:
{
  name: "codegraph_docs",
  description: "Search and browse project documentation (.md, .txt files). "
    + "Use this instead of Read when you need information from project docs. "
    + "Three modes: 'search' finds relevant sections by keyword; "
    + "'outline' shows document structure (headings tree); "
    + "'read' retrieves a specific section by path and title.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["search", "outline", "read"],
        description: "search: FTS keyword search across all docs. "
          + "outline: show heading structure of one or all docs. "
          + "read: get full content of a specific section."
      },
      query: {
        type: "string",
        description: "Search keywords (required for mode=search)"
      },
      path: {
        type: "string",
        description: "Document path filter (optional for outline/read, e.g. 'docs/deploy.md')"
      },
      section: {
        type: "string",
        description: "Section heading to read (for mode=read, e.g. '部署步骤')"
      },
      limit: {
        type: "number",
        description: "Max results for search mode (default: 5)"
      }
    },
    required: ["mode"]
  }
}
```

**返回格式**：

```markdown
# mode=search 返回示例

## Search Results for "部署 rollback"

### docs/deploy.md > 部署步骤 > 回滚 (lines 45-62)
kubectl rollout undo deployment/app
kubectl rollout status deployment/app
...

### docs/ops-runbook.md > 紧急操作 > 回滚流程 (lines 12-28)
1. 确认当前版本号
2. 执行回滚命令
...

---
# mode=outline 返回示例

## Document Structure

### docs/deploy.md
- # 部署指南 (line 1)
  - ## 前置条件 (line 5)
  - ## 部署步骤 (line 12)
    - ### 回滚 (line 45)
  - ## 监控 (line 63)

### README.md
- # CodeGraph (line 1)
  - ## Installation (line 8)
  - ## Usage (line 25)

---
# mode=read 返回示例

## docs/deploy.md > 部署步骤 (lines 12-60)

1. 构建镜像
   ```bash
   docker build -t app:latest .
   ```
2. 推送到 registry
   ...

### 回滚
kubectl rollout undo...
```

### 2.6 CLI 命令

```bash
codegraph docs init          # 扫描并索引项目文档
codegraph docs sync          # 增量更新（只处理变更的文件）
codegraph docs search <query> # 命令行搜索（调试用）
codegraph docs status        # 显示索引状态（文件数、块数、最后更新）
```

### 2.7 增量更新策略

```
sync 流程:
1. 扫描所有 .md/.txt 文件（排除 DOCS_DEFAULT_EXCLUDES）
2. 对每个文件计算 content_hash (SHA-256 of file content)
3. 对比 DB 中已有的 content_hash:
   - hash 相同 → 跳过（文件未变）
   - hash 不同 → 删除该文件的旧 chunks，重新分块插入
   - DB 中有但文件已删除 → 删除对应 chunks
4. FTS5 索引通过触发器自动同步
```

### 2.8 与代码索引的隔离

| 维度 | 代码索引 | 文档索引 |
|------|---------|---------|
| 存储 | `nodes`, `edges`, `files` 表 | `doc_chunks`, `doc_chunks_fts` 表 |
| 触发 | `codegraph init -i` / `codegraph index` | `codegraph docs init` / `codegraph docs sync` |
| 查询 | `codegraph_context/search/explore/...` | `codegraph_docs` |
| 文件类型 | 代码文件 (.ts/.py/.go/...) | 文档文件 (.md/.txt) |
| 解析方式 | tree-sitter AST | 纯文本/正则（heading 识别） |
| 关联 | 符号间的边关系 | 无关联，独立 chunks |

**同一个 `codegraph.db` 文件**，但逻辑完全独立。

---

## 3. 投入成本

### 开发工作量

| 模块 | 工作内容 | 预估代码量 | 复杂度 |
|------|---------|-----------|--------|
| Schema | doc_chunks 表 + FTS5 + 触发器 | ~40 行 SQL | 低 |
| 分块器 (`src/documents/chunker.ts`) | Markdown heading 拆分 + txt 分段 + 大块二次切割 | ~250 行 | 低 |
| 索引器 (`src/documents/indexer.ts`) | 文件扫描、排除过滤、分块写入、增量更新 | ~200 行 | 低 |
| 查询层 (`src/documents/queries.ts`) | FTS5 搜索、outline 查询、section 读取 | ~200 行 | 中 |
| MCP 工具 (`src/mcp/tools.ts` 扩展) | codegraph_docs 三种 mode 处理 | ~200 行 | 中 |
| CLI 命令 (`src/bin/codegraph.ts` 扩展) | docs init/sync/search/status | ~120 行 | 低 |
| 排除规则 (`src/documents/excludes.ts`) | DOCS_DEFAULT_EXCLUDES 常量 + 匹配逻辑 | ~80 行 | 低 |
| server-instructions 更新 | 指引 LLM 使用 codegraph_docs | ~30 行 | 低 |
| 测试 (`__tests__/documents.test.ts`) | 分块、索引、搜索、增量、排除规则 | ~350 行 | 中 |
| **合计** | | **~1470 行** | |

### 时间预估

| 阶段 | 时间 |
|------|------|
| 编码实现 | 1.5-2 天 |
| 测试 + 调试 | 0.5 天 |
| **总计** | **2-2.5 天** |

### 运行时成本

| 维度 | 值 |
|------|-----|
| 索引时间（100 个 .md） | < 500ms |
| 存储增长 | 原文大小 × 2 (FTS 索引开销) |
| 查询延迟 | < 5ms (FTS5 BM25) |
| 内存占用 | 可忽略（查询走 SQLite） |

---

## 4. 收益

### Token 节省

| 场景 | 当前（Read 全文） | 改进后（codegraph_docs） | 节省 |
|------|-----------------|------------------------|------|
| 读取 README (500 行) | ~3000 tokens | 相关段落 ~400 tokens | **87%** |
| 查找部署流程 | 读 2-3 个文件 ~6000 tokens | 搜索命中 ~500 tokens | **92%** |
| 了解项目结构 | 读 README 全文 | outline 模式 ~200 tokens | **93%** |
| 单个 50-turn session 累积 | 文档 token 约 100,000 | 约 15,000 | **85%** |

### 响应质量

| 维度 | 改进 |
|------|------|
| 精准度 | 只返回 FTS 匹配的段落，排除无关内容 |
| 减少幻觉 | LLM 基于文档事实回答，而非猜测 |
| 减少 tool call 次数 | 一次搜索 vs 多次 Read 试错 |
| 决策效率 | outline 模式让 LLM 先看结构再精确读取 |

---

## 5. 遗留问题 & 后续迭代

### 第一版不做（明确范围）

| 项目 | 原因 | 后续版本考虑 |
|------|------|------------|
| `.rst` / `.adoc` 支持 | 复杂度高，用户少 | v2 按需添加 |
| 文档 ↔ 代码符号关联 | 增加耦合、成本高 | 评估后决定 |
| 语义向量搜索 | 需要 embedding 模型，违反"无外部依赖" | 长远可选 |
| 自动 file watcher | 增加 watcher 复杂度 | v2 评估复用现有 watcher |
| 搜索结果返回相邻 chunk | 增加 token 返回量 | 观察实际使用后决定 |
| 文档预热缓存 | FTS5 查询已经很快(<5ms)，预热无必要 | 不需要 |

### 已知限制

1. **LLM 不一定用 codegraph_docs**：通过 server-instructions 引导，但无法强制
2. **FTS5 是关键词匹配**：对模糊语义查询效果有限（如"怎么发布"匹配不到"deploy"）
3. **中文分词质量**：FTS5 unicode61 tokenizer 按 Unicode 分词，中文效果可接受但非最优
4. **大文件性能**：单个 > 10,000 行的文档，分块后 chunk 数量多，outline 输出可能较长

### 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| FTS5 搜索质量不达预期 | 中 | 后续可加同义词扩展或 BM25 调参 |
| 排除规则遗漏某些生态 | 低 | 排除列表可持续补充 |
| 与现有测试冲突 | 低 | 独立模块 + 独立测试文件 |

---

## 6. 验证方式

1. **单元测试**：分块器对各种 Markdown 结构的正确处理
2. **集成测试**：index → search 全流程，验证 FTS5 命中
3. **排除规则测试**：验证各语言生态的排除模式正确生效
4. **性能测试**：100+ 文档的索引时间 < 1s
5. **实际验证**：在 CodeGraph 自身项目中运行 `codegraph docs init`，使用 `codegraph_docs` 搜索
