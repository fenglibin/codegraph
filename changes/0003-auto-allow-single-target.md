## 0003 – 修复 auto-allow 单目标提示 + 去掉默认勾选

**日期**：2026-05-25  
**作者**：fenglibin  
**关联批次**：P0 后续修复

---

### 背景与动机

1. **`shouldAskAutoAllow` 逻辑错误**  
   原实现用 `targets.some(t => AUTO_ALLOW_IDS.includes(t.id))` 判断是否提示 auto-allow。  
   这导致"只有 Codex 被选中"时也返回 `true`（因为 `codex` 在 `AUTO_ALLOW_IDS` 中），但产品需求是**只有 Claude 单独被选中才提示**。

2. **`resolveTargets` 默认勾选所有检测到的 targets**  
   原实现把 `initialValues` 设为所有已安装的 targets（包括 CodeBuddy，它不支持 auto-allow）。  
   这会导致用户直接按回车就配置了不想配的 agent。

---

### 修改内容

#### `src/installer/index.ts`

1. **修复 `shouldAskAutoAllow`（第 95-104 行）**  
   - 原逻辑：`return targets.some(t => AUTO_ALLOW_IDS.includes(t.id));`  
   - 新逻辑：只当 `targets.length === 1 && targets[0].id === 'claude'` 才返回 `true`  
   - 符合产品需求：只有 Claude 单独选中时才提示 auto-allow

2. **修复 `resolveTargets` 的 `initialValues`（第 313-327 行）**  
   - 原逻辑：`initialValues` 包含所有已安装的 targets → 默认全选  
   - 新逻辑：`initial` 设为 `[]`（空数组）→ 默认不勾选任何项，让用户自己选择  
   - 加空选择检查：如果 `choice.length === 0`，提示错误并递归让用户重新选择

---

### 测试

- **修复 `__tests__/installer-auto-allow.test.ts`**  
  - `extra: only codex selected → should NOT prompt` 现在通过（`shouldAskAutoAllow` 返回 `false`）  
  - 所有 10 个测试用例通过

- **运行完整测试套件**  
  - `npm run test` → 40 文件通过，867 测试用例通过

---

### 验证步骤

1. **编译检查**  
   ```bash
   cd /Users/fenglibin/data/code/opensource/codegraph
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   npm run build
   ```
   ✅ 编译成功，0 类型错误

2. **单元测试**  
   ```bash
   npm run test
   ```
   ✅ 40 文件通过，867 测试用例通过

3. **手动验证（可选）**  
   ```bash
   node dist/bin/codegraph.js install
   ```
   - 预期：multi-select 默认不勾选任何项  
   - 预期：如果直接按回车（不选任何项），提示错误并重新显示选择

---

### 后续工作

- [ ] 考虑把 `shouldAskAutoAllow` 的逻辑扩展到"支持 auto-allow 的 agent 只有 Claude"这个业务规则（目前硬编码 `=== 'claude'`）  
- [ ] 考虑在 `resolveTargets` 的 `options` 中把"已安装且支持 auto-allow"的 targets 标记为 "(recommended)"，引导用户选择

---

### 四向追溯矩阵

| 需求 | 代码位置 | 测试用例 |
|--------|----------|----------|
| `shouldAskAutoAllow` 只有 Claude 单独选中才提示 | `src/installer/index.ts` 第 95-104 行 | `__tests__/installer-auto-allow.test.ts` |
| `resolveTargets` 默认不勾选任何项 | `src/installer/index.ts` 第 313-327 行 | 待补充（交互式测试需要 mock clack） |

---

### 漏拦复盘

1. **为什么之前没发现 `shouldAskAutoAllow` 逻辑错误？**  
   - 原测试 `extra: only codex selected → should NOT prompt` 写错了期望（原来是 `expect(result).toBe(false)` 但函数返回 `true`，测试失败）  
   - 但之前的批次可能没运行测试，或者忽略了测试失败

2. **改进措施**  
   - 每个批次都要运行 `npm run test` 确保所有测试通过  
   - 新加的测试要覆盖边界情况（如 `codex` 在 `AUTO_ALLOW_IDS` 中但不该提示）

---

**变更文件清单**：
- `src/installer/index.ts`（修改）
- `__tests__/installer-auto-allow.test.ts`（修改）
- `changes/0003-auto-allow-single-target.md`（新增）
- `changes/README.md`（更新索引）
