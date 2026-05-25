# 变更记录索引

| 编号 | 日期 | 主要内容 | 状态 |
|---|---|---|---|
| [0001](0001-picomatch-security-upgrade.md) | 2026-05-22 | picomatch 安全漏洞修复 4.0.3→4.0.4（CVE-2026-33671/33672） | ✅ 完成 |
| [0002](0002-p2-f4-smart-stale.md) | 2026-05-22 | P2/F-4 智能 Staleness 检测（Git-aware）— footer 从盲计时器升级为 git 双信号 4 分支决策，覆盖率 ~95%→~100% | ✅ 完成 |
| [0003](0003-auto-allow-single-target.md) | 2026-05-25 | shouldAskAutoAllow 只有 Claude 单独选中才返回 true；resolveTargets 默认不勾选任何项，让用户自己选择 | ✅ 完成 |
| [0004](0004-fix-worker-oom.md) | 2026-05-25 | 修复 Worker OOM（WORKER_RECYCLE_INTERVAL 250→50，PARSER_RESET_INTERVAL 5000→500，CLI 入口 v8.setFlagsFromString('--max-old-space-size=4096') 提升堆内存至 4GB） | ✅ 完成 |