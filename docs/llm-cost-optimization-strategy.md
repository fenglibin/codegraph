# 降低 LLM 调用开销：策略分析与方案

> **日期**：2026-05-28
> **状态**：分析完成
> **目标**：降低 LLM 费用 + 提升工具响应质量

---

## 1. 需求

在使用 AI Agent（如 Claude Code）+ CodeGraph MCP 进行日常开发时，希望：

1. **降低 LLM API 调用的 token 费用**
2. **提升 CodeGraph 工具返回内容的精准度和质量**
3. 两个目标同时达成，互不冲突

---

## 2. LLM 费用构成分析

### 单次 API 调用的 token 组成

```
┌─────────── 一次 LLM API 调用的 input token 构成 ───────────┐
│                                                              │
│  System Prompt             ~2,000 tokens  (固定)             │
│  Conversation History      ~20,000-150,000 tokens (累积)     │ ← 真正的大头
│  本次 Tool Results          ~500-3,000 tokens               │
│  ────────────────────────────────────────────────────        │
│  Total Input               ~25,000-155,000 tokens            │
│                                                              │
│  Output                    ~200-2,000 tokens                 │
└──────────────────────────────────────────────────────────────┘
```

### 关键洞察

- **费用 = 每轮 input tokens × 轮次数**
- 每次交互，之前所有对话历史都要重新发送（累积计费）
- Tool 返回的内容一旦进入对话，**后续每一轮都作为 history 重复计费**
- 因此：减少进入对话的无效 token 量，有累积放大效应

---

## 3. 优化策略分层

### 三层优化模型

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: API 层面 — Prompt Caching                              │
│  ├── 机制: 重复前缀自动缓存，缓存命中 input 成本 -90%             │
│  ├── 状态: Claude Code 已自动生效，无需开发                       │
│  └── 效果: 对话历史中稳定部分的读取成本大幅降低                    │
│                                                                   │
│  Layer 2: 框架层面 — Context Compaction + Model Routing           │
│  ├── Compaction: 对话过长时摘要压缩旧轮次，token -60~80%          │
│  ├── Model Routing: 简单任务用小模型，成本 -50~70%                │
│  ├── 状态: Claude Code 内置 /compact + Agent model 参数          │
│  └── 效果: 减少长对话的累积成本 + 降低单 token 单价               │
│                                                                   │
│  Layer 3: 工具层面 — 精准返回（CodeGraph 文档搜索）               │
│  ├── 机制: 只返回相关段落而非全文，减少进入对话的 token 量         │
│  ├── 状态: 待实现（codegraph_docs）                              │
│  └── 效果: 文档相关 token -85%，总开销额外 -5~10%                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 各策略详细分析

### 4.1 Prompt Caching（提示词缓存）

| 维度 | 说明 |
|------|------|
| **原理** | Anthropic API 自动缓存对话前缀（system prompt + 稳定的历史消息），缓存命中时 input token 费用降低 90% |
| **TTL** | 5 分钟不活跃后失效 |
| **触发条件** | 连续请求的消息前缀相同（即 system prompt 和历史消息没变） |

**当前状态**：

| 使用方式 | 是否生效 | 需要做什么 |
|---------|---------|-----------|
| Claude Code CLI | ✅ 自动生效 | 无需操作 |
| 自建 Agent 调 Anthropic API | 需手动标记 | 在 system prompt 末尾加 `cache_control` |
| OpenRouter / AWS Bedrock | 取决于平台 | 查阅平台文档 |

**自建 Agent 时的关键代码**：
```python
# Anthropic Python SDK
response = client.messages.create(
    model="claude-sonnet-4-20250514",
    system=[{
        "type": "text",
        "text": "很长的 system prompt 和项目上下文...",
        "cache_control": {"type": "ephemeral"}  # ← 标记缓存断点
    }],
    messages=[...]
)
```

**收益**：稳定前缀部分的 token 读取成本 **-90%**。对于 50-turn 对话，前 40 turn 的历史在 turn 41 读取时大概率缓存命中。

---

### 4.2 Context Compaction（上下文压缩）

| 维度 | 说明 |
|------|------|
| **原理** | 当对话历史过长时，将旧的 turn 摘要化（保留语义、减少 token） |
| **效果** | 历史 token 减少 60-80%，且对话可以持续更久不丢上下文 |

**可用工具**：

| 工具 | 说明 | 如何使用 |
|------|------|---------|
| `/compact` 命令 | Claude Code 内置，手动触发压缩 | 在对话中输入 `/compact` |
| 自动 compaction | context window 快满时自动触发 | 内置，无需配置 |
| `--max-turns` | 限制单次 session 长度 | `claude --max-turns 30` |
| CLAUDE.md 记忆 | 跨 session 保持项目知识 | 编辑 CLAUDE.md |

**最佳实践**：
- 长 session 中每 30-50 轮手动 `/compact` 一次
- 关键项目知识写入 CLAUDE.md（不占对话 token，走 system prompt）
- 复杂任务拆分为多个短 session 而非一个超长 session

**收益**：长对话的累积 token 量 **-60~80%**

---

### 4.3 Model Routing（模型选择）

| 任务类型 | 推荐模型 | 相对 Opus 成本 | 质量 |
|---------|---------|---------------|------|
| 简单查找、格式化、小改动 | Haiku | **1/60** | 足够 |
| 常规编码、代码分析 | Sonnet | **1/5** | 良好 |
| 复杂架构、多文件重构、深度推理 | Opus | 基准 | 最佳 |

**Claude Code 中的控制方式**：

```bash
# 全局默认
claude config set model sonnet

# 启动时指定
claude --model haiku

# 子 Agent 使用不同模型
Agent({ model: "haiku", prompt: "简单搜索任务..." })
Agent({ model: "opus", prompt: "复杂架构设计..." })
```

**自动路由方案**：

| 方案 | 说明 | 状态 |
|------|------|------|
| Claude Code Agent `model` 参数 | 手动为子任务选择模型 | ✅ 可用 |
| Anthropic 官方 Router | 根据复杂度自动选模型 | 未公开发布 |
| OpenRouter model routing | 支持模型 fallback 链 | ✅ 第三方 |
| 自建 Router | query 复杂度评分 → 分发 | 需开发 |

**收益**：平均单 token 成本 **-50~70%**（假设 70% 任务可用 Sonnet/Haiku）

---

### 4.4 工具层面：精准返回（CodeGraph 文档搜索）

| 维度 | 说明 |
|------|------|
| **原理** | LLM 查阅文档时，只返回 FTS5 匹配的相关段落，而非全文 |
| **实现** | 新增 `codegraph_docs` MCP 工具，支持 search/outline/read 三种模式 |
| **详细方案** | 见 `docs/document-search-architecture.md` |

**Token 节省示例**：

| 场景 | Read 全文 | codegraph_docs | 节省 |
|------|-----------|---------------|------|
| 查看 README (500行) | ~3000 tokens | 相关段落 ~400 tokens | 87% |
| 查找部署流程 | 读 2-3 文件 ~6000 tokens | 搜索命中 ~500 tokens | 92% |
| 了解项目结构 | 全文 ~3000 tokens | outline ~200 tokens | 93% |

**累积效应**：在 50-turn 的 session 中：
- 文档 token 减少量：~85,000 tokens
- 占总 session 开销的：5-10%

**收益**：文档相关 token **-85%**，总 session 开销 **额外 -5~10%**

---

## 5. 综合收益预估

### 场景假设

- 50-turn 对话 session
- 使用 Claude Sonnet 模型
- 涉及代码编写 + 文档查阅
- 不使用任何优化时总消耗约 500,000 input tokens

### 各策略叠加效果

| 优化策略 | 节省比例 | 节省 token | 备注 |
|---------|---------|-----------|------|
| Prompt Caching (Layer 1) | ~40% 的 input 成本 | 成本层面降 40% | 不减 token 数，减单价 |
| Context Compaction (Layer 2) | token 量 -60% | ~300,000 tokens | `/compact` 在第 25 轮触发 |
| Model Routing (Layer 2) | 单价 -50% | 成本层面再降 50% | 70% 子任务用 Sonnet |
| codegraph_docs (Layer 3) | 文档 token -85% | ~25,000 tokens | 新增工具 |

### 成本对比

```
━━━ 无优化 ━━━
50 turns × 平均 10K input tokens = 500K tokens
费用(Opus): 500K × $15/M = $7.50

━━━ 全部优化后 ━━━
Compaction: 500K → 200K tokens (压缩旧历史)
codegraph_docs: 再减 25K → 175K tokens
Prompt Caching: 175K × 60% 缓存命中 × 90% 折扣 → 有效付费约 80K token 当量
Model Routing: 70% 用 Sonnet ($3/M), 30% 用 Opus ($15/M)
加权单价: ~$5.6/M
费用: 80K × $5.6/M = $0.45

节省: ($7.50 - $0.45) / $7.50 = 94%
```

> **注**：以上为理想场景估算。实际节省取决于对话模式、compaction 频率、缓存命中率等。保守估计综合节省 **70-85%**。

---

## 6. 优先级建议

| 优先级 | 策略 | 投入 | 收益 | 建议 |
|--------|------|------|------|------|
| **P0** | Prompt Caching | 零（已自动生效） | 高 | ✅ 无需行动 |
| **P0** | Context Compaction | 零（使用 /compact） | 高 | ✅ 养成习惯即可 |
| **P1** | Model Routing | 低（配置层面） | 高 | 为子 Agent 指定 model 参数 |
| **P2** | codegraph_docs | 中（2-2.5 天开发） | 中 | 提升文档响应质量 + 节省 token |

### 立即可做的事（零开发成本）

1. **确认 Prompt Caching 已生效**：对于 Claude Code 用户，无需操作
2. **定期使用 `/compact`**：长对话每 30 轮执行一次
3. **子 Agent 用小模型**：搜索、格式化等任务用 `model: "haiku"`
4. **项目知识写入 CLAUDE.md**：避免每次对话中重复解释项目背景

### 需要开发的事

1. **codegraph_docs 文档搜索**（见 `docs/document-search-openspec.md`）
   - 投入：2-2.5 天
   - 收益：文档场景 token -85%，响应质量显著提升

---

## 7. 与 CodeGraph 现有优化的关系

```
┌─────────────────────────────────────────────────────────────┐
│              CodeGraph 缓存/优化 全景图                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  已实现:                                                      │
│  ├── Node Cache Warmup (warmCache)                           │
│  │   └── 效果: 加速 getNodeById() → 工具响应延迟 -80%        │
│  │   └── 对 LLM 成本: 无直接影响（只减延迟不减 token）        │
│  │                                                           │
│  待实现:                                                      │
│  ├── codegraph_docs (文档分块搜索)                            │
│  │   └── 效果: 只返回相关段落 → 进入对话的 token -85%         │
│  │   └── 对 LLM 成本: ✅ 直接降低（减少无效 token）           │
│  │                                                           │
│  外部（无需开发）:                                             │
│  ├── Prompt Caching → token 单价 -90%（缓存命中部分）         │
│  ├── /compact → 历史 token 量 -60~80%                        │
│  └── Model Routing → token 单价 -50~70%（小模型替代）         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 8. 局限性说明（诚实评估）

| 局限 | 说明 |
|------|------|
| **Prompt Caching 不是万能的** | 5 分钟 TTL，长时间不活跃后失效；对话前缀变化时失效 |
| **Compaction 有信息损失** | 摘要化会丢失部分细节，可能影响后续对话质量 |
| **Model Routing 需要判断力** | 错误地用小模型处理复杂任务会导致返工（反而更贵） |
| **codegraph_docs 无法强制 LLM 使用** | 只能通过 instructions 引导，LLM 仍可能选择 Read |
| **FTS5 是关键词匹配** | 对语义模糊查询（如"怎么发布"vs"deploy"）效果有限 |
| **节省比例因场景而异** | 纯编码 session 几乎不查文档 → codegraph_docs 收益趋近于零 |
