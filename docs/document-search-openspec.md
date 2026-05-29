# 文档分块搜索 — OpenSpec 任务拆分

> **关联设计文档**：`docs/document-search-architecture.md`
> **总预估**：~1470 行代码，2-2.5 天

---

## Task 1：Schema 定义

**文件**：`src/db/doc-schema.sql`（新建）

**要求**：
1. 创建 `doc_chunks` 表（字段：id, path, chunk_index, title, heading_level, content, start_line, end_line, content_hash, updated_at）
2. 创建唯一索引 `idx_doc_chunks_path_chunk (path, chunk_index)`
3. 创建索引 `idx_doc_chunks_path (path)`
4. 创建 FTS5 虚拟表 `doc_chunks_fts`（字段：title, content；tokenize=unicode61）
5. 创建触发器：INSERT/UPDATE/DELETE 时同步 FTS 索引

**验收标准**：
- SQL 可在 SQLite 中正确执行
- FTS5 触发器能正确同步增删改

**依赖**：无

---

## Task 2：排除规则模块

**文件**：`src/documents/excludes.ts`（新建）

**要求**：
1. 导出常量 `DOCS_DEFAULT_EXCLUDES: string[]`，包含所有需要排除的目录模式：
   - 通用：`.git/`, `.svn/`, `.hg/`, `.codegraph/`, `.DS_Store`
   - Node.js：`node_modules/`, `.next/`, `.nuxt/`, `.output/`, `.cache/`, `.parcel-cache/`, `coverage/`
   - Python：`.venv/`, `venv/`, `env/`, `.env/`, `__pycache__/`, `*.egg-info/`, `.eggs/`, `site-packages/`, `.tox/`, `.nox/`, `.mypy_cache/`, `.pytest_cache/`, `.ruff_cache/`
   - Java/Kotlin：`target/`, `.gradle/`, `.idea/`
   - Go：`vendor/`
   - Rust：`target/`
   - C/C++：`cmake-build-*/`, `.ccache/`
   - PHP：`vendor/`
   - Ruby：`vendor/bundle/`, `.bundle/`
   - Dart：`.dart_tool/`, `.pub-cache/`
   - .NET：`packages/`
   - 通用构建：`dist/`, `build/`, `out/`, `bin/`, `obj/`, `_build/`
2. 导出函数 `isDocExcluded(relativePath: string): boolean`
   - 检查路径中是否包含任何排除模式
   - 支持目录匹配（路径的任意一级命中即排除）
   - 支持通配符（如 `cmake-build-*`）
3. 导出常量 `DOCS_SUPPORTED_EXTENSIONS = ['.md', '.txt']`
4. 导出函数 `isDocFile(filePath: string): boolean`
   - 检查文件扩展名是否在 DOCS_SUPPORTED_EXTENSIONS 中
   - 特殊处理无扩展名的 `README`、`CHANGELOG`、`LICENSE` 文件

**验收标准**：
- `isDocExcluded('node_modules/lodash/README.md')` → true
- `isDocExcluded('.venv/lib/python3.11/METADATA.txt')` → true
- `isDocExcluded('docs/deploy.md')` → false
- `isDocFile('README.md')` → true
- `isDocFile('README')` → true
- `isDocFile('src/index.ts')` → false

**依赖**：无

---

## Task 3：Markdown 分块器

**文件**：`src/documents/chunker.ts`（新建）

**要求**：
1. 导出函数 `chunkMarkdown(content: string): DocChunk[]`
   - 按 heading（`#`, `##`, `###` ...）分割
   - 每个 heading 开始一个新 chunk（heading 行本身作为 chunk 的第一行）
   - heading 之前的内容（如果有）作为 chunk 0（heading_level = 0）
   - 返回 `DocChunk[]`：`{ title, headingLevel, content, startLine, endLine }`
2. 导出函数 `chunkPlainText(content: string): DocChunk[]`
   - 按连续空行分段
   - 若无空行，按每 50 行固定切割
3. 分块规则：
   - 最大块大小：200 行或 4000 字符（超过在段落边界二次切割）
   - 最小块大小：3 行（短块合并到上一块的 content 末尾）
4. 导出类型 `DocChunk`：
   ```typescript
   interface DocChunk {
     title: string | null;    // heading 文本（去掉 # 前缀）
     headingLevel: number;    // 0=无heading, 1-6
     content: string;         // 完整内容（含 heading 行）
     startLine: number;       // 1-indexed
     endLine: number;         // 1-indexed, inclusive
   }
   ```

**验收标准**：
- 标准 Markdown 文件正确按 heading 分块
- 无 heading 的文件按段落分块
- 超大段落能二次切割
- 3 行以下的短块被合并

**依赖**：无

---

## Task 4：文档索引器

**文件**：`src/documents/indexer.ts`（新建）

**要求**：
1. 导出类 `DocumentIndexer`
   - 构造函数：`constructor(db: SqliteDatabase, projectRoot: string)`
   - 初始化方法：`initSchema(): void` — 执行 doc-schema.sql 创建表
2. 方法 `indexAll(): DocIndexResult`
   - 递归扫描 projectRoot 下的所有 .md/.txt 文件
   - 对每个文件调用 `isDocExcluded()` 过滤
   - 对每个文件调用 chunker 分块
   - 计算 content_hash（文件内容的 SHA-256 hex）
   - 批量插入 doc_chunks 表
   - 返回 `{ filesIndexed, chunksCreated, filesSkipped, durationMs }`
3. 方法 `sync(): DocSyncResult`
   - 扫描文件，对比 content_hash
   - hash 相同 → 跳过
   - hash 不同 → 删除旧 chunks + 重新分块插入
   - DB 有但文件已删除 → 删除对应 chunks
   - 返回 `{ filesUpdated, filesAdded, filesRemoved, chunksTotal }`
4. 方法 `getStatus(): DocStatus`
   - 返回 `{ fileCount, chunkCount, lastUpdatedAt }`

**注意事项**：
- 使用 `fs.readFileSync` 读取文件，处理 UTF-8 编码
- 使用事务批量写入（`db.exec('BEGIN')` ... `db.exec('COMMIT')`）
- 文件扫描使用递归 `readdirSync`，跳过排除目录（不进入排除目录递归）

**验收标准**：
- 能正确索引一个包含多个 .md 文件的项目
- 增量 sync 只更新变更的文件
- 排除规则正确生效

**依赖**：Task 1, Task 2, Task 3

---

## Task 5：文档查询层

**文件**：`src/documents/queries.ts`（新建）

**要求**：
1. 导出类 `DocumentQueries`
   - 构造函数：`constructor(db: SqliteDatabase)`
2. 方法 `search(query: string, limit?: number): DocSearchResult[]`
   - 使用 FTS5 BM25 搜索
   - SQL：`SELECT d.*, rank FROM doc_chunks_fts f JOIN doc_chunks d ON d.id = f.rowid WHERE doc_chunks_fts MATCH ? ORDER BY rank LIMIT ?`
   - 返回：`{ path, title, headingLevel, content, startLine, endLine, rank }`
   - 默认 limit = 5
3. 方法 `outline(path?: string): DocOutlineEntry[]`
   - 如果 path 指定：返回该文件的 heading 结构
   - 如果 path 为空：返回所有已索引文档的 heading 结构
   - SQL：`SELECT path, title, heading_level, start_line FROM doc_chunks WHERE heading_level > 0 ORDER BY path, chunk_index`
   - 返回：`{ path, title, headingLevel, startLine }`
4. 方法 `read(path: string, section?: string): DocReadResult | null`
   - 如果 section 指定：返回该 path 下 title 匹配的 chunk 内容（及其子级 chunks）
   - 如果 section 为空：返回该文件的所有 chunks 拼接
   - 子级判定：heading_level > 当前 chunk 的 heading_level，且在下一个同级/上级 heading 之前
   - 返回：`{ path, title, content, startLine, endLine }`
5. 方法 `isInitialized(): boolean`
   - 检查 doc_chunks 表是否存在

**验收标准**：
- search 返回按 BM25 排序的结果
- outline 正确展示文档的层级结构
- read 能正确返回 section 及其子级内容

**依赖**：Task 1

---

## Task 6：MCP 工具集成

**文件**：`src/mcp/tools.ts`（修改）

**要求**：
1. 在工具列表中新增 `codegraph_docs` 工具定义（name, description, inputSchema）
2. 在 `ToolHandler` 中新增 `handleDocs(args)` 方法
   - 解析 mode 参数，分发到 search/outline/read
   - 格式化输出为 Markdown 格式
   - 错误处理：文档未索引时返回友好提示（"Run `codegraph docs init` first"）
3. search 模式输出格式：
   ```
   ## Search Results for "{query}"
   
   ### {path} > {title} (lines {start}-{end})
   {content snippet}
   
   ---
   Found {n} results.
   ```
4. outline 模式输出格式：
   ```
   ## Document Structure
   
   ### {path}
   - # Title (line N)
     - ## Section (line M)
       - ### Subsection (line K)
   ```
5. read 模式输出格式：
   ```
   ## {path} > {title} (lines {start}-{end})
   
   {full content}
   ```

**验收标准**：
- 三种 mode 都能正确执行并返回格式化结果
- 未索引时给出明确指引
- 参数校验（search 模式必须有 query）

**依赖**：Task 5

---

## Task 7：CLI 命令

**文件**：`src/bin/codegraph.ts`（修改）

**要求**：
1. 新增子命令 `docs`，下设子命令：
   - `codegraph docs init` — 执行全量文档索引
   - `codegraph docs sync` — 增量更新
   - `codegraph docs search <query>` — 命令行搜索（调试用）
   - `codegraph docs status` — 显示文档索引状态
2. 所有命令检查 `.codegraph/` 是否存在（复用 isInitialized）
3. `docs init` 输出：索引了多少文件、多少 chunks、耗时
4. `docs search` 输出：搜索结果（path + title + 内容片段前 3 行）

**验收标准**：
- CLI 命令正确执行，输出可读
- 错误情况有友好提示

**依赖**：Task 4, Task 5

---

## Task 8：server-instructions 更新

**文件**：`src/mcp/server-instructions.ts`（修改）

**要求**：
1. 在 MCP server instructions 中新增 `codegraph_docs` 工具的使用指引
2. 明确告诉 LLM：
   - 查阅项目文档时，优先使用 `codegraph_docs` 而非 `Read`
   - 先用 outline 查看结构，再用 search/read 获取具体内容
   - 只有当 codegraph_docs 未初始化时，才 fallback 到 Read
3. 保持与现有工具指引的风格一致

**验收标准**：
- instructions 清晰、简洁
- 与现有 tool 指引风格统一

**依赖**：Task 6

---

## Task 9：测试

**文件**：`__tests__/documents.test.ts`（新建）

**测试用例**：

1. **分块器测试**：
   - Markdown 按 heading 正确分块
   - 无 heading 的 Markdown 按段落分块
   - 纯文本按空行分段
   - 超大块二次切割
   - 短块合并

2. **排除规则测试**：
   - node_modules 下的 .md 被排除
   - .venv 下的文件被排除
   - vendor/ 下的文件被排除
   - target/ 下的文件被排除
   - cmake-build-*/ 匹配被排除
   - 正常项目文档不被排除
   - 无扩展名 README/CHANGELOG 被识别为文档

3. **索引器测试**：
   - indexAll 正确索引多个文件
   - sync 增量更新只处理变更文件
   - sync 删除已移除的文件
   - 排除规则在索引时生效

4. **查询测试**：
   - search 返回 BM25 排序的结果
   - search 的 limit 参数生效
   - outline 返回正确的层级结构
   - outline 按 path 过滤
   - read 返回完整 section 内容
   - read 包含子级 chunks

5. **集成测试**：
   - init → search 全流程
   - 文件变更后 sync → 搜索返回新内容
   - 未初始化时给出友好错误

**依赖**：Task 1-6

---

## Task 10：构建与验证

**操作**：
1. `npm run build` — 确保编译通过
2. 确保 `doc-schema.sql` 被 `copy-assets` 脚本复制到 `dist/`
3. `npm test` — 所有测试通过（含新增测试）
4. 在 CodeGraph 自身项目中执行 `codegraph docs init`，验证实际效果
5. 使用 `codegraph docs search` 测试搜索质量

**依赖**：Task 1-9

---

## 任务依赖图

```
Task 1 (Schema) ─────────────────┐
                                  │
Task 2 (排除规则) ──┐              ├──▶ Task 5 (查询层) ──▶ Task 6 (MCP) ──▶ Task 8 (instructions)
                    │              │                        │
Task 3 (分块器) ──┐ │              │                        ├──▶ Task 7 (CLI)
                  ▼ ▼              │                        │
              Task 4 (索引器) ─────┘                        │
                                                            ▼
                                                     Task 9 (测试)
                                                            │
                                                            ▼
                                                     Task 10 (验证)
```

**关键路径**：Task 1 → Task 4 → Task 5 → Task 6 → Task 9 → Task 10

**可并行**：
- Task 1, 2, 3 无依赖，可并行开发
- Task 7, 8 可在 Task 6 之后并行

---

## 自检清单

### 正确性

| 检查项 | 结果 |
|--------|------|
| 每个 Task 的输入/输出是否明确 | ✅ 明确了文件、函数签名、返回类型 |
| 依赖关系是否正确 | ✅ 依赖图无环，关键路径清晰 |
| 是否有遗漏的模块 | ✅ Schema → 分块 → 索引 → 查询 → MCP → CLI → 测试 全覆盖 |
| 是否与代码索引解耦 | ✅ 独立表、独立模块（src/documents/）、独立 CLI 命令 |

### 完整性

| 检查项 | 结果 |
|--------|------|
| 需求中的每个功能点是否都有 Task 覆盖 | ✅ search/outline/read 三种模式均有 |
| 排除规则是否覆盖了所有提到的语言生态 | ✅ Node/Python/Java/Go/Rust/C++/PHP/Ruby/Dart/.NET |
| 测试是否覆盖了核心路径和边界情况 | ✅ 分块/排除/索引/查询/集成 5 类测试 |
| copy-assets 是否考虑了新的 SQL 文件 | ✅ Task 10 中明确要求 |

### 合理性

| 检查项 | 结果 |
|--------|------|
| 每个 Task 的粒度是否合理（不过大不过小） | ✅ 最大的 Task 4（索引器）~200 行，可在 2-3 小时完成 |
| 依赖关系是否最小化 | ✅ Task 1/2/3 无依赖可并行，减少阻塞 |
| 是否有风险点未覆盖 | ⚠️ 已在设计文档 §5 中列出遗留问题和风险 |
| 投入产出比是否合理 | ✅ ~1470 行代码换取文档场景 85%+ token 节省 |
