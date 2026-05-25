#!/usr/bin/env bash
set -euo pipefail

# 推送到 GitHub (origin)
# 用法: ./scripts/push-to-origin.sh [branch]

BRANCH="${1:-main}"

echo "==> 推送到 GitHub (origin) 分支: $BRANCH"
git push origin "$BRANCH"
