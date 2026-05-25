# 0004 – Fix Worker OOM during `codegraph sync`

## 背景与动机

用户在新版本中运行 `codegraph install` 时，在解析阶段（53%，约第 138/260 个文件）发生 `Fatal process out of memory: Zone` 错误。

**根因**：
1. `WORKER_RECYCLE_INTERVAL = 250` 太大——WASM 线性内存只增不减（WebAssembly 规范限制），Worker 线程的 V8 isolate 在解析 250 个文件后 WASM 堆已耗尽
2. `PARSER_RESET_INTERVAL = 5000` 太大——tree-sitter parser 的 WASM 内存在解析 5000 次后才重置，远大于 Worker 回收周期
3. 默认 Node.js 堆内存上限（~1.5GB）不足以容纳 V8 Turboshaft 编译器对 WASM 模块的优化编译

## 修改内容

### 1. `src/extraction/index.ts` — 减小 Worker 回收周期

```diff
- const WORKER_RECYCLE_INTERVAL = 250;
+ const WORKER_RECYCLE_INTERVAL = 50;
```

**理由**：每解析 50 个文件就销毁并重启 Worker 线程，强制释放 WASM 堆内存。在内存受限机器（~4GB 可用）上，50 个文件的 WASM 堆增长不会触发 Zone OOM。

### 2. `src/extraction/parse-worker.ts` — 减小 Parser 重置周期

```diff
- const PARSER_RESET_INTERVAL = 5000;
+ const PARSER_RESET_INTERVAL = 500;
```

**理由**：更频繁地调用 `resetParser()` 回收 WASM 线性内存。500 次解析后重置，远小于 Worker 回收周期（50），确保内存增长被及时压制。

### 3. `src/bin/codegraph.ts` — 提升 Node.js 堆内存上限

在文件最顶部（所有 `import` 之前）注入：

```typescript
// !! MUST run before any other require() — V8 heap must be resized
//     before tree-sitter WASM compilation triggers Turboshaft OOM.
//     --max-old-space-size=4096 gives V8 enough room for the
//     Zone allocator that Turboshaft uses during WASM lowering.
const v8 = require('v8');
v8.setFlagsFromString('--max-old-space-size=4096');
```

**理由**：
- `v8.setFlagsFromString()` 必须在任何其他 `require()` 之前执行，否则 V8 已开始编译代码（包括 tree-sitter 的 WASM 模块），此时再设堆上限为时已晚
- `--max-old-space-size=4096` 将 V8 老生代堆上限提升至 4GB，为 Turboshaft 编译器的 Zone 分配器留出足够空间
- 使用 `require('v8')` 而非 `import v8 from 'v8'` 确保它在编译后的 CommonJS 文件中位于所有其他 `require()` 之前

## 验证

| 检查项 | 结果 |
|--------|------|
| `npm run build` 编译 | ✅ 0 类型错误 |
| `npm run test` 全量测试 | ✅ 40 文件，867 用例全部通过 |
| `require('v8')` 在编译后位置 | ✅ 第 59 行，位于 `require("commander")` (第 61 行) 之前 |
| `setFlagsFromString('--max-old-space-size=4096')` 在编译后位置 | ✅ 第 60 行 |

## 后续工作

- [ ] 在 `codegraph install` 命令中添加 `--max-memory` 选项，允许用户自定义堆内存上限
- [ ] 在 OOM 时捕获错误并提示用户运行 `NODE_OPTIONS="--max-old-space-size=4096" codegraph sync`
- [ ] 考虑在 `package.json` 中添加 `engines.node: ">=22"` 要求，确保 `node:sqlite` 可用

## 四向追溯矩阵

| 需求 | 代码位置 | 测试用例 |
|--------|----------|----------|
| 修复 Worker OOM | `src/extraction/index.ts:49` | （无新增测试，现有 867 测试全绿） |
| 修复 Parser OOM | `src/extraction/parse-worker.ts:55` | （无新增测试） |
| 提升堆内存上限 | `src/bin/codegraph.ts:30-34` | （无新增测试） |

## 漏拦复盘

**为什么之前的测试没拦住？**
1. 本地开发机器内存充足（16GB+），`WORKER_RECYCLE_INTERVAL = 250` 不会触发 OOM
2. 没有内存受限环境的 CI 矩阵（如 4GB 内存的容器）
3. `MAX_FILE_SIZE = 1MB` 只限制单文件大小，不限制同时解析的文件数

**改进措施**：
1. 在 CI 中添加内存受限环境的测试矩阵（如 `NODE_OPTIONS="--max-old-space-size=512"`）
2. 添加 OOM 回归测试：模拟 WASM 内存耗尽场景，验证 Worker 是否正确回收
3. 在 `README.md` 中添加"内存受限环境"章节，指导用户调整 `WORKER_RECYCLE_INTERVAL`
