# 0004 – Fix Worker OOM during `codegraph sync`

## 背景

用户在 AutoMate 项目（260 个文件）运行 `codegraph install` 时，在解析阶段（53%，约第 138/260 个文件）发生 `Fatal process out of memory: Zone` 错误。崩溃栈顶是 V8 后台 WASM 编译线程的 Turboshaft `Zone::Expand`，发生在 tree-sitter WASM 解析器编译期间。

## 根因分析

1. **WASM 线性内存只增不减**（WebAssembly 规范限制）。tree-sitter 的 parser 跑在一个 worker 线程里，每次解析都向其 WASM 堆追加内存，直到 V8 isolate 销毁时才释放。
2. **`WORKER_RECYCLE_INTERVAL = 250` 过大** —— 250 个文件的 WASM 堆累积足以让 V8 的后台 Turboshaft 编译器在做新 WASM 模块优化时分配不出 Zone。
3. **`PARSER_RESET_INTERVAL = 5000` 太大** —— 在 worker 内部，`resetParser()` 调用频率远小于 worker 回收频率，几乎从不触发，等同于摆设。
4. **`recycleWorker()` 不等 `terminate()` 完成** —— 旧 worker 还在占用 WASM 内存，新 worker 已经被 `ensureWorker()` 启动并加载 grammar，**两个 worker 短暂并存**。把回收周期从 250 降到 50 后，回收频次提升 5 倍，并存窗口的频次也提升 5 倍，把"修复"反向放大成新的内存峰值风险。

## 修改内容

### 1. `src/extraction/index.ts` — 减小 Worker 回收周期

```diff
- const WORKER_RECYCLE_INTERVAL = 250;
+ const WORKER_RECYCLE_INTERVAL = 50;
```

注释里诚实标注："50 是基于推算的保守值（约 5 倍安全边际），未在受限环境精确测过；如仍 OOM，建议同时通过 `NODE_OPTIONS="--max-old-space-size=4096"` 提升堆，或继续降到 25。"

### 2. `src/extraction/index.ts` — 修复 `recycleWorker()` 双 worker 并存

```diff
-    function recycleWorker(): void {
+    async function recycleWorker(): Promise<void> {
       if (!parseWorker) return;
       log(`Recycling worker after ${workerParseCount} parses ...`);
       const w = parseWorker;
       parseWorker = null;
       workerParseCount = 0;
-      // Fire-and-forget: worker.terminate() can hang if WASM is stuck
-      w.terminate().catch(() => {});
+      // Await terminate so the OS reclaims the V8 isolate (and its
+      // WASM heap) BEFORE ensureWorker() spawns the next worker.
+      // Race against a 2s timeout to defend against WASM hangs —
+      // on timeout we drop the reference and let the OS clean up
+      // the orphan in the background.
+      await Promise.race([
+        w.terminate().catch(() => {}),
+        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
+      ]);
     }
```

调用点已经写的是 `await recycleWorker()`，所以无需调整。

### 3. `src/extraction/parse-worker.ts` — 减小 Parser 重置周期

```diff
- const PARSER_RESET_INTERVAL = 5000;
+ const PARSER_RESET_INTERVAL = 500;
```

让 worker 内部的 parser 重置真正发挥作用 —— 回收周期 50 文件 / 重置周期 500 次解析，仍能在 worker 生命周期内被触发若干次（按多语言计 parser 数）。

### 4. `src/bin/codegraph.ts` — **撤回** `v8.setFlagsFromString`

最初本想用 `v8.setFlagsFromString('--max-old-space-size=4096')` 提升堆内存上限，**但实测确认这一调用对 `--max-old-space-size` 完全无效**：

```bash
$ node -e "
  const v8 = require('v8');
  console.log('before:', Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024), 'MB');
  v8.setFlagsFromString('--max-old-space-size=512');
  console.log('after :', Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024), 'MB');
"
before: 4144 MB
after  : 4144 MB    ← 没变

$ node --max-old-space-size=512 -e "
  console.log('cmdline:', Math.round(require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024), 'MB');
"
cmdline: 560 MB     ← 命令行才生效
```

原因：`--max-old-space-size` 是 V8 的**启动期标志**，必须在 isolate 创建时（命令行 / `NODE_OPTIONS`）传入；`setFlagsFromString` 只能改"运行时可调"的标志，对老生代上限不生效。

而且——崩溃的并不是老生代堆。原始栈顶 `Zone::Expand` 来自 V8 的 **WASM 编译 worker 线程**，使用独立的 Zone 分配器。崩溃机器的默认堆 ≈ 4GB（与我设的 4096 一致）。**真正解决 OOM 的有效手段只有降低 WASM 内存峰值**（即修改 1 + 2 + 3）。

文件头注释里改写为指导用户在 `NODE_OPTIONS` 里设置：

```text
If you still hit OOM during indexing on a memory-constrained machine,
raise the heap with:
  NODE_OPTIONS="--max-old-space-size=4096" codegraph sync
```

## 验证

| 检查项 | 结果 |
|---|---|
| `npm run build` 编译 | ✅ 0 类型错误 |
| `npm run test` 全量测试 | ✅ 40 文件，867 用例全部通过 |
| `setFlagsFromString` 实测无效（before/after 都 4144MB） | ✅ 已撤回 |
| 命令行 `--max-old-space-size` 实测有效（560MB） | ✅ 改写为文档化指导 |

未做的验证（受环境限制）：
- 在 AutoMate 真实项目重跑 `codegraph install`（需要用户协助）
- 在 4GB 内存受限容器里跑大仓 indexing 回归（无现成 CI 矩阵）

## 漏拦复盘

**为什么第一版"修复"放出去了？**

1. **触发了 dev-baseline 红线 #19（凭文档判定未实测）**：我直接相信"`v8.setFlagsFromString('--max-old-space-size=N')` 可以提升堆"这个常见误传，没在加进去前先实测。如果第一版加之前就跑 `node -e "v8.setFlagsFromString(...); console.log(v8.getHeapStatistics().heap_size_limit)"`，5 秒就能发现它无效。
2. **没有内存受限测试矩阵**：本地 16GB+ 机器、CI 默认 7GB 容器都不会触发 Zone OOM，单测全绿不能证明修复有效。
3. **混淆了崩溃位置**：原始崩溃栈顶 `Zone::Expand` 在 WASM **编译**线程，与老生代堆无关；我误以为是堆不够。如果一开始就细看栈帧（特别是 `BackgroundCompileJob::Run`），就能识别这是 WASM 编译期内存而非用户代码内存。
4. **`recycleWorker` 的"双 worker 并存"窗口** —— 第一版只想减小回收周期，没回头读一遍 `recycleWorker` 的实现，没发现它是 fire-and-forget 的。这是典型的"只看常量、不看上下文"的偷懒。

**改进措施**：
1. 任何"宣称改了内存上限"的修改，**加之前必须用一行 node -e 实测**，把 before/after 截出来贴进 PR。
2. 内存类问题第一步是看完整崩溃栈，**特别是栈顶以下的 5-10 帧**（识别是哪个 V8 子系统在分配），不能只看错误名 `out of memory` 就猜。
3. 改资源生命周期相关常量（回收周期、超时、batch size）时，**必须读一遍生命周期管理函数全文**（spawn / cleanup / terminate），确认改了周期后是否引入新的并发窗口。
4. 后续工作建议加一个 Vitest 集成测试：mock 一个会快速增长 `process.memoryUsage().rss` 的 worker，验证 `recycleWorker` 真的等到 terminate 完成（监听 `exit` 事件触达后再 spawn 新 worker）。

## 后续工作

- [ ] 在 `README.md` "Troubleshooting" 节加一段"OOM during indexing → set NODE_OPTIONS"
- [ ] 给 `cg.indexAll()` 加 `signal.aborted` 后真正 `await terminate()`（目前是 fire-and-forget，与 recycle 同样问题）
- [ ] 加 `--max-memory` CLI 参数：检测到内存不足时自动 spawn 自己的子进程并加 `--max-old-space-size`
- [ ] 在 CI 中加一个 `NODE_OPTIONS="--max-old-space-size=512"` 的 indexing smoke test，扫一个 ≥ 200 文件的 fixture 仓
- [ ] 探索 PARSER_RESET_INTERVAL 跟 WORKER_RECYCLE_INTERVAL 是否可以合并（前者已被后者完全覆盖）

## 四向追溯矩阵

| 需求 | 代码位置 | 测试用例 |
|---|---|---|
| 减小 Worker 回收周期 | `src/extraction/index.ts:49` | （现有 867 测试全绿；未加 OOM 回归测试 — 列入后续工作） |
| 修复 recycleWorker 双 worker 并存 | `src/extraction/index.ts:660-685` | （同上） |
| 减小 Parser 重置周期 | `src/extraction/parse-worker.ts:55` | （同上） |
| 文档化 NODE_OPTIONS 引导（取代无效的 setFlagsFromString） | `src/bin/codegraph.ts:1-32` | N/A（文档变更） |
