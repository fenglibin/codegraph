/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Tool selection by intent (which tool for which question)
 *   - Common chains (refactor planning = X then Y)
 *   - Anti-patterns (don't grep when codegraph_search is faster)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. Reference only tools that exist on `main`; gate any
 * conditional tools behind feature checks if/when they ship.
 */

import { watchDisabledReason } from '../sync/watch-policy';

/**
 * Static base instructions — the agent-facing playbook that doesn't
 * depend on runtime state. Kept as a separate constant so tests and
 * tools can compare against the canonical baseline.
 *
 * Exported under the legacy name for backward compatibility — callers
 * that previously imported `SERVER_INSTRUCTIONS` still work, they just
 * don't get the runtime watch-health diagnostic.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — code intelligence over an indexed knowledge graph

Codegraph is a SQLite knowledge graph of every symbol, edge, and file
in the workspace. Reads are sub-millisecond; the index lags writes by
about a second through the file watcher. Consult it BEFORE writing or
editing code, not during.

## 🚫 Mandatory Rules / 强制规则

These rules are **mandatory**, not suggestions. Models that have not
been fine-tuned on codegraph (DeepSeek, Qwen, GLM, …) frequently fall
back to grep/Read by training-data habit even when codegraph is faster
and cheaper. Do not.

1. **NEVER grep / find / Read to look up a symbol by name.** Always use
   \`codegraph_search\` or \`codegraph_context\` first. Grep returns text
   matches; codegraph returns the symbol's kind, location, signature,
   and edges in one call.
2. **NEVER chain Read + grep to "trace how X works".** Use
   \`codegraph_context\` (one call) and then ONE \`codegraph_explore\`.
   Manual trace loops over many files burn 10-30× more tokens for the
   same answer.
3. **NEVER call \`codegraph_node\` more than 3 times in a row.** If you
   need source for ≥3 symbols, switch to \`codegraph_explore\` — it
   returns them all grouped by file in a single capped call.
4. **NEVER trust an edge with confidence < 0.7 without verifying.**
   Edges tagged \`[heur 0.NN ⚠️]\` come from heuristic name matching, not
   AST analysis. Open the call site (codegraph_node / Read the line) to
   confirm before relying on the relationship.
5. **NEVER answer when the response footer carries any of these stale
   signals**:
   - \`⚠️ Uncommitted changes (modified or new files outside .gitignore)\`
   - \`⚠️ Git has commits newer than this index\`
   - \`⚠️ Index age: ... older than 30m ... stale\`

   All three mean the graph predates current code. Run \`codegraph sync\`
   first (or ask the user to), or call \`codegraph_status\` to confirm
   the watcher's state. The two git-derived signals are stronger than
   the time-based one: they're git's own verdict that code changed
   since the index was built. Conversely, a footer ending in
   \`(✓ matches HEAD, no uncommitted changes)\` is the highest-trust
   signal we emit — git has confirmed the index reflects the current
   working tree.

以下规则为**强制要求**，不是建议。未经 codegraph 微调的模型（DeepSeek、
Qwen、GLM 等）常因训练习惯而退回 grep / Read，即使 codegraph 更快更省。
请严格遵守：

1. **绝不**用 grep / find / Read 按名查找符号。优先调用
   \`codegraph_search\` 或 \`codegraph_context\`。grep 只能给你文本匹配，
   codegraph 一次返回符号的种类、位置、签名和关系。
2. **绝不**用 Read + grep 串联来"追踪 X 是怎么工作的"。用一次
   \`codegraph_context\` 加一次 \`codegraph_explore\` 即可。手动遍历多文件
   会让 token 多花 10-30 倍。
3. **绝不**连续调用 \`codegraph_node\` 超过 3 次。如需查看 ≥3 个符号源码，
   切换到 \`codegraph_explore\` —— 它一次按文件聚合返回全部源码。
4. **绝不**信任置信度 < 0.7 的关系边。被标 \`[heur 0.NN ⚠️]\` 的边来自启发
   式名字匹配，不是 AST 分析；先用 \`codegraph_node\` 或 Read 该行确认调用
   关系，再做出依赖性判断。
5. **绝不**在响应底部出现以下任一过期信号时直接回答：
   - \`⚠️ Uncommitted changes (modified or new files outside .gitignore)\`
   - \`⚠️ Git has commits newer than this index\`
   - \`⚠️ Index age: ... older than 30m ... stale\`

   这三种都说明索引落后于当前代码。先让用户执行 \`codegraph sync\`，
   或用 \`codegraph_status\` 确认 watcher 状态。两种基于 git 的信号比
   定时器信号更强：它们是 git 自己验证过"代码自索引后已变更"。反之，
   底部出现 \`(✓ matches HEAD, no uncommitted changes)\` 是我们能输出
   的最高可信度信号 —— git 已确认索引匹配当前工作目录。

## Answer directly — don't delegate exploration

For "how does X work", architecture, trace, or where-is-X questions,
answer DIRECTLY using 2-3 codegraph calls: \`codegraph_context\` first,
then ONE \`codegraph_explore\` for the source of the symbols it surfaces.
Codegraph IS the pre-built search index — so delegating the lookup to a
separate file-reading sub-task/agent, or running your own grep + read
loop, repeats work codegraph already did and costs more for the same
answer. Reach for raw Read/Grep only to confirm a specific detail
codegraph didn't cover. A direct codegraph answer is typically a handful
of calls; a grep/read exploration is dozens.

## Tool selection by intent

- **"What is the symbol named X?"** → \`codegraph_search\`
- **"What's the deal with this task / feature / area?"** → \`codegraph_context\` (PRIMARY — composes search + node + callers + callees in one call)
- **"What calls this?"** → \`codegraph_callers\`
- **"What does this call?"** → \`codegraph_callees\`
- **"What would changing this break?"** → \`codegraph_impact\`
- **"Show me this symbol's source / signature / docstring."** → \`codegraph_node\`
- **"Show me several related symbols' source / survey an area."** → \`codegraph_explore\` (ONE capped call; prefer over many codegraph_node/Read)
- **"What's in directory X?"** → \`codegraph_files\`
- **"Is the index ready / what's its size?"** → \`codegraph_status\`

## Common chains

- **Onboarding**: \`codegraph_context\` first. If still unclear, \`codegraph_explore\` for breadth, then \`codegraph_node\` on specific symbols.
- **Refactor planning**: \`codegraph_search\` → \`codegraph_callers\` → \`codegraph_impact\`. The blast-radius answer comes from impact, not from walking callers manually.
- **Debugging a regression**: \`codegraph_callers\` of the suspected symbol; widen with \`codegraph_impact\` if an unexpected call appears.

## Anti-patterns

- **Don't grep first** when looking up a symbol by name — \`codegraph_search\` is faster and returns kind + location + signature.
- **Don't chain \`codegraph_search\` + \`codegraph_node\`** when you just want context — \`codegraph_context\` is one round-trip.
- **Don't loop \`codegraph_node\` over many symbols** — one \`codegraph_explore\` call returns them all grouped by file, while each separate call re-reads the whole context and costs far more. Use \`codegraph_node\` for a single symbol.
- **Don't query the index immediately after editing a file** — the watcher needs ~500ms to debounce + sync. Wait for the next turn.

## Limitations

- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
`;

/**
 * Options for {@link buildServerInstructions}. Both fields are optional
 * so callers without the relevant info still get a valid (warning-free)
 * playbook back.
 */
export interface BuildServerInstructionsOptions {
  /**
   * Project root path, when known at the time of the `initialize` call.
   * Used to consult `watchDisabledReason()` so the agent knows up-front
   * whether live file-watching is active for this project.
   *
   * When `undefined`, no project-specific watch warning is appended;
   * the agent can still call `codegraph_status` mid-session to check.
   */
  projectRoot?: string | undefined;

  /**
   * Test / advanced override: explicit "watch is disabled because X"
   * reason to inject. When omitted, the function consults
   * `watchDisabledReason(projectRoot)` directly. Used by unit tests so
   * the watch policy logic doesn't have to be mocked end-to-end.
   */
  watchReasonOverride?: string | null | undefined;
}

/**
 * Build the SERVER_INSTRUCTIONS text for a specific MCP session — P0/T4.
 *
 * Always returns the static playbook unchanged at the top, so existing
 * agent behaviors don't shift. When the project's file-watcher is
 * disabled (WSL2 `/mnt/*` drive, explicit `CODEGRAPH_NO_WATCH=1`, etc.)
 * we append a short ⚠️ section so the agent knows the index won't
 * auto-refresh and can either ask the user to run `codegraph sync` or
 * lower its trust in the staleness of any answer.
 *
 * Why dynamic instead of a static "watch may be disabled" note:
 *   • False alarms erode the agent's trust in warnings; we only want
 *     ⚠️ when watch is actually off for this session.
 *   • The disabled reason is informative ("WSL2 /mnt drive" vs an env
 *     var) and is worth surfacing verbatim — agents and humans both
 *     benefit from the exact root cause.
 */
export function buildServerInstructions(
  options: BuildServerInstructionsOptions = {}
): string {
  const { projectRoot, watchReasonOverride } = options;

  let watchReason: string | null;
  if (watchReasonOverride !== undefined) {
    watchReason = watchReasonOverride;
  } else if (projectRoot) {
    watchReason = watchDisabledReason(projectRoot);
  } else {
    // No project root resolved yet — defer the watch check to the first
    // tool call. We DON'T preemptively warn here: a default playbook
    // with a maybe-stale-watch ⚠️ on every session is exactly the kind
    // of false alarm that trains agents to ignore warnings.
    watchReason = null;
  }

  if (!watchReason) {
    return SERVER_INSTRUCTIONS;
  }

  // Append the warning section as the LAST block so the static playbook
  // above it stays cache-friendly across sessions (agents that key on
  // a hash of the prefix benefit when only the suffix varies).
  const warning = `

## ⚠️ Index Sync Status

Live file-watching is **disabled** for this project: ${watchReason}.

The index reflects the state at \`codegraph index\` / \`codegraph sync\`
time and **will not auto-update** when files change. Treat the index as
a snapshot. After the user edits files in this session, ask them to run
\`codegraph sync\` (or call \`codegraph_status\` to confirm whether the
watcher recovered) before relying on call graphs or impact analysis.
`;

  return SERVER_INSTRUCTIONS + warning;
}
