/**
 * Agent-instructions template — the markdown body each agent target
 * writes into its conventional instructions file (CLAUDE.md /
 * AGENTS.md / codegraph.mdc / etc.).
 *
 * The body content is identical across agents because the codegraph
 * usage advice is agent-agnostic — only the destination filename and
 * any optional frontmatter (Cursor `.mdc`) varies per target.
 *
 * The legacy `claude-md-template.ts` re-exports these names for
 * backwards compatibility with downstream importers.
 */

/** Markers used by the marker-based section replacement. */
export const CODEGRAPH_SECTION_START = '<!-- CODEGRAPH_START -->';
export const CODEGRAPH_SECTION_END = '<!-- CODEGRAPH_END -->';

/**
 * The full marker-delimited block written into each agent's
 * instructions file. Includes the start/end markers so the section
 * can be detected and replaced on re-install.
 *
 * P0/T6 — The block now ships English first, then a Chinese mirror,
 * because non-Claude models (DeepSeek, Qwen, GLM, …) follow Chinese
 * imperative instructions noticeably more reliably than English ones —
 * a training-data distribution effect, not a model deficit. Keeping
 * English on top preserves Claude's existing behaviour; the Chinese
 * section is additive. Markers are deliberately unchanged so existing
 * installations re-install via section-replace, not append.
 */
export const INSTRUCTIONS_TEMPLATE = `${CODEGRAPH_SECTION_START}
## CodeGraph

This project has a CodeGraph MCP server (\`codegraph_*\` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### 🚫 Mandatory rules — do NOT skip

These are **rules**, not suggestions. Models that haven't been
fine-tuned on codegraph (DeepSeek, Qwen, GLM, …) often fall back to
grep/Read by training-data habit even when codegraph is faster.

1. **NEVER grep / find / Read to look up a symbol by name.** Use \`codegraph_search\` or \`codegraph_context\` first.
2. **NEVER chain Read + grep to trace how something works.** Use \`codegraph_context\` (one call) plus ONE \`codegraph_explore\`.
3. **NEVER call \`codegraph_node\` more than 3 times in a row.** Switch to \`codegraph_explore\` which batches by file in a single capped call.
4. **NEVER trust an edge tagged \`[heur 0.NN ⚠️]\` (confidence < 0.7) without verifying.** Open the call site to confirm before relying on the relationship.
5. **NEVER answer when the response footer shows \`⚠️ Index age:\` over 30 minutes.** Ask the user to run \`codegraph sync\`, or check \`codegraph_status\`.

### When to prefer codegraph over native search

Use codegraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | \`codegraph_search\` |
| "What calls function Y?" | \`codegraph_callers\` |
| "What does Y call?" | \`codegraph_callees\` |
| "What would break if I changed Z?" | \`codegraph_impact\` |
| "Show me Y's signature / source / docstring" | \`codegraph_node\` |
| "Give me focused context for a task/area" | \`codegraph_context\` |
| "See several related symbols' source at once" | \`codegraph_explore\` |
| "What files exist under path/" | \`codegraph_files\` |
| "Is the index healthy?" | \`codegraph_status\` |

### Rules of thumb

- **Answer directly — don't delegate exploration.** For "how does X work" / architecture / trace questions, answer with 2-3 codegraph calls: \`codegraph_context\` first, then ONE \`codegraph_explore\` for the source of the symbols it surfaces. Codegraph IS the pre-built index, so spawning a separate file-reading sub-task/agent — or running a grep + read loop — repeats work codegraph already did and costs more for the same answer.
- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. \`codegraph_search\` is faster and returns kind + location + signature in one call.
- **Don't chain \`codegraph_search\` + \`codegraph_node\`** when you just want context — \`codegraph_context\` is one call.
- **Don't loop \`codegraph_node\` over many symbols** — one \`codegraph_explore\` call returns several symbols' source grouped in a single capped call, while each separate node/Read call re-reads the whole context and costs far more.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### If \`.codegraph/\` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have CodeGraph initialized. Want me to run \`codegraph init -i\` to build the index?"*

---

## CodeGraph（中文）

本项目已配置 CodeGraph MCP 服务（\`codegraph_*\` 工具集）。CodeGraph 基于
tree-sitter 解析了项目中每一个符号、关系和文件，读取耗时亚毫秒级，能够返回
grep 无法提供的结构化信息。

### 🚫 强制规则 —— 必须遵守

以下是**强制规则**，不是建议。未经 codegraph 微调的模型（DeepSeek、Qwen、
GLM 等）常因训练习惯而退回 grep / Read，即使 codegraph 更快。请严格遵守：

1. **绝不**用 grep / find / Read 按名查找符号。优先调用 \`codegraph_search\` 或 \`codegraph_context\`。
2. **绝不**用 Read + grep 串联来追踪 X 是怎么工作的。一次 \`codegraph_context\` 加一次 \`codegraph_explore\` 即可。
3. **绝不**连续调用 \`codegraph_node\` 超过 3 次。切换到 \`codegraph_explore\` —— 它一次按文件聚合返回全部源码。
4. **绝不**信任置信度 < 0.7 的关系边（被标 \`[heur 0.NN ⚠️]\`）。先用 \`codegraph_node\` 或 Read 该行确认调用关系，再做出依赖性判断。
5. **绝不**在响应底部出现 \`⚠️ Index age:\` 且超过 30 分钟时直接回答。先让用户执行 \`codegraph sync\`，或用 \`codegraph_status\` 确认 watcher 状态。

### 何时优先用 codegraph 而非原生搜索

涉及**结构性**问题（谁调用谁、改了会破坏什么、X 在哪定义、X 的签名是什么）
请用 codegraph；只在查询**字面文本**（字符串内容、注释、日志消息）或已经
打开了具体文件时，才使用原生 grep/read。

### 经验法则

- **直接回答 —— 不要把探索委派给子任务/子代理**。对"X 是怎么工作的"/架构/追踪类问题，用 2-3 次 codegraph 调用即可：先 \`codegraph_context\`，再一次 \`codegraph_explore\` 拿涉及符号的源码。codegraph 本身就是预建好的索引，再去派生一个文件读取的子代理、或自己跑 grep + read 循环，是在重复 codegraph 已经做完的工作，且成本更高。
- **信任 codegraph 的结果**。它们来自完整的 AST 解析；不要再用 grep 二次验证 —— 那样更慢、不准、还浪费上下文。
- **按名查找符号时不要先 grep**：\`codegraph_search\` 一次返回种类、位置、签名。
- **不要串 \`codegraph_search\` + \`codegraph_node\`**：想要上下文就直接用 \`codegraph_context\`（一次调用搞定）。
- **不要对一堆符号循环调用 \`codegraph_node\`**：一次 \`codegraph_explore\` 就按文件聚合返回它们的源码；逐个 node/Read 会反复读取整段上下文，成本高得多。
- **索引延迟**：文件 watcher 会去抖约 500ms；编辑文件后不要在同一轮立刻再查询。

### 如果 \`.codegraph/\` 不存在

MCP 服务会返回 "not initialized."。请询问用户："*我注意到这个项目还没有初始化 CodeGraph，要我运行 \`codegraph init -i\` 来构建索引吗？*"
${CODEGRAPH_SECTION_END}`;

/**
 * Backwards-compat alias. Existing downstream code may import
 * `CLAUDE_MD_TEMPLATE` from this module via the re-export shim in
 * `claude-md-template.ts`.
 */
export const CLAUDE_MD_TEMPLATE = INSTRUCTIONS_TEMPLATE;
