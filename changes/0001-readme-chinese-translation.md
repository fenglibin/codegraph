# 0001 — README 中文化与三份文档信息整合

> 完成时间：2026-05-22

## 背景与动机

codegraph 项目的 `README.md` 原为全英文，且缺失近期完成的三个重要特性的信息：
1. **P0 LLM Trust Signals**（`docs/p0-llm-trust-signals-summary.md`）— provenance / confidence / 索引时效 / 双语强制规则
2. **CodeBuddy IDE 安装目标**（`docs/add-codebuddy-installer-target-rationale.md`）— 新增的 Agent 支持
3. **CodeGraph 深度分析**（`docs/codegraph-analysis-report.md`）— 架构拆解 / 8 类隐患 / 国产模型适配

为让中文用户（尤其是使用 CodeBuddy IDE + 国产模型场景）能完整了解项目全貌，需将 README 翻译为中文并整合上述三份文档的核心信息。

## 设计要点

1. **结构保留**：维持原英文 README 的整体章节结构（标题 → 快速开始 → 为什么选 → 特性 → 框架路由 → 安装 → 原理 → CLI → MCP → 库用法 → 配置 → 语言 → 故障排查 → Star History → License）
2. **新增章节**：
   - "适用场景与已知限制"（来自分析报告第三部分：8 类隐患摘要 + 场景决策）
   - "国产模型适配（DeepSeek / Qwen / GLM）"（来自分析报告第四部分：7 类技术方案 + 预估收益表）
   - "技术架构说明"（来自 CodeBuddy 方案文档：AgentTarget 插件化接口）
3. **增强章节**：
   - "核心特性"新增 🔴 标记的三条 P0 信任信号特性
   - "MCP 工具"表新增 provenance + confidence 标签说明
   - "支持的语言"表新增"质量"列（⭐ 评级）
   - "故障排查"新增 watcher 失效场景
   - Benchmark 数据旁补充说明（成本节省 ≠ Token 节省的原因）
4. **翻译策略**：代码块、命令、技术术语（MCP/SQLite/FTS5 等）保持原文；描述性文本全部中文化

## 变更文件

| 文件 | 操作 | 说明 |
|---|---|---|
| `README.md` | 重写 | 英文→中文，+~110 行净增（信息密度大幅提升） |
| `changes/0001-readme-chinese-translation.md` | 新增 | 本变更记录 |
| `changes/README.md` | 新增 | 变更索引 |

## 三份 docs 的映射关系

| docs 文档 | README 中对应的章节 |
|---|---|
| `add-codebuddy-installer-target-rationale.md` | CodeBuddy IDE 专属配置子章节 + 技术架构说明章节 |
| `codegraph-analysis-report.md` | 为什么选择（Benchmark 数据补充说明）+ 工作原理（五层 Pipeline 图）+ 适用场景与已知限制 + 国产模型适配 |
| `p0-llm-trust-signals-summary.md` | 核心特性（3 条 🔴 特性）+ MCP 工具（信任信号标签）+ 全局指令参考（双语规则）+ 故障排查（watcher 失效） |

## 验证

| 检查项 | 结果 |
|---|---|
| 文件中无残留英文段落（代码块/命令/术语除外） | ✅ |
| 所有 badge 和链接保持原样 | ✅ |
| 代码示例无语法错误 | ✅ |
| 三份 docs 的核心信息已全部体现 | ✅ |
| 新增的"质量"列与 doc 分析报告中数据一致 | ✅ |

## 漏拦复盘

本次为纯文档变更，无代码变动。但有一个值得记录的点：

- **翻译完整性自检**：初次写完"支持的语言"表后遗漏了 Lua/Luau 两行。补充检查 docs 中所有语言列表后补齐。教训：翻译时应逐一对照原文和所有关联文档，不能凭记忆写。

## 后续工作

- 若后续有新特性（如 SCIP importer / DI 容器解析 / 国产模型微调），需同步更新 README 中"适用场景与已知限制"和"国产模型适配"章节
- `README.md` 的中文版应保持与项目实际功能同步，建议每次发版前 review 一次新增/修改的章节