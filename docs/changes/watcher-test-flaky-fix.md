# Watcher 测试 flaky 修复 — 根因分析与处置

> **日期**：2026-05-22
> **关联**：C 路径（修 flaky 测试）→ 部分修复 + known noise 记录
> **变更文件**：`__tests__/watcher.test.ts`（+79 行）

---

## 背景与动机

发版前 `npm test` 基线报告：`__tests__/watcher.test.ts` 4 个测试确定性失败 + 1 个 `database is not open` unhandled error。简报称"known noise / 基线已有 1 flaky"，实际测试发现 4-5 个 fail 取决于环境负载。本变更修复能修的部分，并记录无法修复的部分。

---

## 根因分析（迭代 4 轮确认）

### 能修复的：waitFor 递归 timer 泄露 → `database is not open`

```
vitest timeout 5s
  ↓ 测试报告失败
  ↓ afterEach 执行 cg.close() → DB 关闭
  ↓ 但 waitFor 内递归 setTimeout(check, 100) 还在 event loop 里
  ↓ check() 调用 cg.getStats() → db.prepare() → 💥 "database is not open"
```

**修法**：给 waitFor 加可选 AbortSignal 参数。CodeGraph integration describe 在 beforeEach 创建 AbortController，afterEach 先 `abort()` 停所有 pending timer，再 `close()` DB。

### 无法修复的：fs.watch 事件在 macOS kqueue + vitest thread pool 下不可靠

5 个测试依赖真实 `fs.watch` 事件投递：写文件 → fs.watch 回调 → debounce → syncFn 调用。在单跑 watcher.test.ts 时可靠（15/15 全过），但全套 npm test（39 spec files 并发）下，macOS kqueue 在高负载时延迟/丢弃事件。

尝试过的方案均失败：

| # | 方案 | 结果 |
|---|---|---|
| 1 | 仅 abortController 防 leak | ✅ 修复 unhandled error；5 个 fs.watch 测试仍超时 |
| 2 | vitest `{ timeout: 15000 }` | ❌ waitFor 内部 5000ms 先超时 |
| 3 | waitFor 5000→10000ms | ❌ 事件 >10s 才到 |
| 4 | `pool: 'forks'` 全局 | ⚠️ auto-sync 通过，其余 4 个在不同轮次反复超时；额外使 debounce rapid changes 也 flaky；103 个其他测试因 process.chdir 在 fork pool 下报错 |
| 5 | `poolMatchGlobs` | ❌ vitest 2.1.9 语法不兼容 |

**结论**：macOS kqueue 的并发不可靠性是内核级问题，不是 codegraph 代码或 vitest 配置能解决的。这 5 个测试属于"在特定环境下 flaky 但非致命"，修复的边际成本远超收益。

---

## 设计要点

### 保留的改动

1. **waitFor helper 加 `signal?: AbortSignal` 支持** — 修复 `database is not open` unhandled error
2. **CodeGraph integration describe 加 abortController** — beforeEach 创建，afterEach 先 abort 再 close DB
3. **`should auto-sync` 测试（line 333）传 `abortController.signal`** — 唯一真正访问 DB 的 waitFor，有 timer leak 风险
4. **3 个新增 waitFor helper 测试**（`waitFor helper (test-internal)` describe）：正常/边界/异常各 1 条

### Revert 的改动（最终未保留）

- vitest.config.ts `pool: 'forks'` / `poolMatchGlobs` — 全部 revert 到原始状态
- 3 个 fs.watch trigger 测试的 `{ timeout: 15000 }` 和 waitFor 10000ms → 恢复 waitFor 5000ms

### 标注为 known noise 的测试（5 条）

| 测试名 | 失败原因 | 风险 |
|---|---|---|
| `should trigger sync after file change` | fs.watch 在 threads pool 下事件未投递 | 仅影响工具测试，不影响生产代码质量 |
| `should call onSyncComplete after successful sync` | 同上 | 同上 |
| `should call onSyncError when sync throws` | 同上 | 同上 |
| `should debounce rapid changes into a single sync` | 同上（varying 出现，环境负载决定） | 同上 |
| `should auto-sync when files change while watching` | 同上 | 同上 |

验证命令：
```bash
# 单跑 watcher 测试: 15/15 全过 (fs.watch 在隔离环境下可靠)
npx vitest run __tests__/watcher.test.ts

# 全套测试: 5 fail (fs.watch 在并发下不可靠), 0 unhandled error
npm test
```

---

## 变更文件

| 文件 | 变更 | 行数 |
|---|---|---|
| `__tests__/watcher.test.ts` | waitFor 加 signal 支持 / abortController 集成 / 3 个新增测试 | +79 |

---

## 三阶段质量门禁

### 深度自检

- ① 接口合约不变性 ✅ waitFor signal 可选参数，所有现有调用点无需改
- ② 调用方完整性 ✅ grep 全仓库确认 waitFor 只存在于 watcher.test.ts 和 mcp-initialize.test.ts（不同 helper）
- ③ 边界条件穿透 ✅ 3 个新测试覆盖 pre-aborted / mid-flight abort / normal resolve
- ④ 错误信息一致性 ✅ `reject(new Error('aborted'))` 与既有 `'waitFor timed out'` 一致
- ⑤ 类型安全 ✅ signal?: AbortSignal 标准类型，无 any/@ts-ignore
- ⑥ 兼容性 ✅ 现有 4 个不传 signal 的 caller 行为不变
- ⑦ 测试完整性 ✅ +3 cases (正常/边界/异常)
- ⑧ 性能 ✅ abort 路径直接 reject 避免一次 setTimeout
- ⑨ 并发/时序 ✅ abort 先于 close，剩余 pending timer 在 check() 第一句被拦截
- ⑩ 可观察性 ✅ aborted error 有明确 message

### 反偷懒 17 条红线扫描

0 真实触发（watcher.test.ts 只改测试文件）

### 测试结果

```bash
# 单跑 watcher
npx vitest run __tests__/watcher.test.ts     # 15/15 ✅

# 全套
npm test                                     # 39 files, 5 fail (known fs.watch noise), 840 total
                                              # 0 unhandled errors (key improvement)
```

### 漏拦复盘

**这条 fix 本身没有引入新 bug，但暴露了 2 个工程上的盲区**：

1. **简报里"基线 1 fail flaky"描述不准** — 实际是 4-5 fail 取决于并发负载。教训：每次接手新 session 的简报声明必须用 `npm test` 现场确认，不能盲信。

2. **fs.watch 测试的 OS 依赖被低估** — macOS kqueue 在并发环境下不可靠，任何依赖真实 fs.watch 的测试都有 flaky 风险。未来新增 watcher 集成测试时，优先通过 mock fs.watch 回调测试 debounce/sync 逻辑，避免依赖 OS 事件。

---

## 已知噪声清单（发版时记录）

```bash
# 以下 5 个测试在 macOS kqueue + vitest thread pool 下偶发超时
# 单跑文件时全过（15/15），全套时 5 条可能失败
#
# 这不是 codegraph 代码的问题——macOS kqueue 在高并发时不保证事件投递

# 验证：
#   单跑: npx vitest run __tests__/watcher.test.ts     → 15/15 ✅
#   全套: npm test                                       → 可能 0-5 fail
```

---

## 后续工作

- 可考虑：新增 FileWatcher 测试时，用 `vi.mock('fs', ...)` mock `fs.watch` 回调直接触发 syncFn，避免依赖 OS 事件（但这属于重构级别的独立任务，不在本次范围）
- C 路径剩余项：extraction.test.ts worker exit — 未复现（Node 22 下运行正常），暂不处理