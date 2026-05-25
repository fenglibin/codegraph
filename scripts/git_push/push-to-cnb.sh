#!/usr/bin/env bash
set -euo pipefail

# 推送到 CNB (cnb.cool)
# 用法: ./scripts/push-to-cnb.sh [branch]

BRANCH="${1:-main}"

echo "==> 推送到 CNB (cnb.cool) 分支: $BRANCH"
git push cnb "$BRANCH"
