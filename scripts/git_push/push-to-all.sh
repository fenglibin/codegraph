#!/usr/bin/env bash
set -euo pipefail

# 同时推送到所有 remote (origin, cnb, upstream)
# 用法: ./scripts/push-to-all.sh [branch]

BRANCH="${1:-main}"

echo "==> 推送分支 '$BRANCH' 到所有 remote..."

echo ""
echo "==> [1/3] 推送到 GitHub (origin)..."
git push origin "$BRANCH" || echo "    ⚠️  origin 推送失败，继续..."

echo ""
echo "==> [2/3] 推送到 CNB (cnb.cool)..."
git push cnb "$BRANCH" || echo "    ⚠️  cnb 推送失败，继续..."

echo ""
echo "==> [3/3] 推送到 upstream (colbymchenry)..."
git push upstream "$BRANCH" || echo "    ⚠️  upstream 推送失败，继续..."

echo ""
echo "==> ✅ 推送完成"
