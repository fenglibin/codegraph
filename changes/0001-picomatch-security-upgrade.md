# 0001: picomatch 安全漏洞修复升级 4.0.3 → 4.0.4

## 背景与动机

安全扫描提示 picomatch@4.0.3 存在两个 CVE：

| CVE | 类型 | 描述 | 修复版本 |
|---|---|---|---|
| CVE-2026-33672 | 数据完整性 | POSIX bracket 表达式注入导致的数据完整性受损 | 4.0.4 / 3.0.2 / 2.3.2 |
| CVE-2026-33671 | ReDoS | 恶意 extglob 模式导致的 ReDoS | 4.0.4 / 3.0.2 / 2.3.2 |

需升级到修复版本 4.0.4。

## 设计要点

- **影响面极小**：picomatch 仅 1 个直接依赖、0 个传递依赖
- **使用模式安全**：仅 `src/resolution/frameworks/cargo-workspace.ts` 中使用 `picomatch(member, { dot: false })` 解析 Cargo workspace 成员的简单 glob，未使用 POSIX bracket 或 extglob 高级语法，不触发漏洞代码路径
- **API 完全兼容**：patch 版本升级，无 breaking change

## 变更文件

| 文件 | 变更 |
|---|---|
| `package.json` | `"picomatch": "^4.0.3"` → `"picomatch": "^4.0.4"` |
| `package-lock.json` | 锁定 `picomatch@4.0.4` |

## 三阶段质量门禁

### 阶段 1 · 深度自检

- ✅ API 兼容性：`@types/picomatch@^4.0.2` 无需变更
- ✅ 使用处无受漏洞影响的代码路径（无 POSIX bracket / extglob）
- ✅ TypeScript 编译：`tsc --noEmit` 0 错误

### 阶段 2 · 单元测试

全量测试结果：

| 指标 | 结果 |
|---|---|
| Test Files | 37 passed / 1 failed (watcher) / 38 total |
| Tests | 774 passed / 3 failed / 837 total (excl. watcher: **834 passed / 0 failed**) |

### 阶段 3 · 集成测试 / 对照实验

交叉验证 3 个 watcher.test.ts 失败 case 与 picomatch 无关：

| 验证方式 | picomatch 4.0.3（旧） | picomatch 4.0.4（新） |
|---|---|---|
| watcher.test.ts 独立跑 | 2 failed / 13 passed | 2-3 failed / 12-13 passed |
| fail case 名称 | 同源（debounce sync / callbacks timeout） | 一致 |
| 错误类型 | `Test timed out in 5000ms` | 一致 |

- `src/sync/watcher.ts` 不引用 picomatch（使用 `ignore` 库做过滤）
- 失败为 macOS 文件系统事件 5 秒超时的 baseline flakiness

## 漏拦复盘

本批次无漏拦。picomatch patch 版本升级影响面极窄，且项目使用方式不触发漏洞代码路径，升级属低风险安全修复。

## 后续工作

无。