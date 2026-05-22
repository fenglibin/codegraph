#!/usr/bin/env bash
#
# CodeGraph npm 发布脚本
#
# 功能：
#   1. 自动切换至 npm 官方 registry（如当前为镜像源）
#   2. 编译构建
#   3. 运行测试
#   4. 发布到 npm（@xuefadevdev/codegraph）
#   5. 恢复原始 registry
#
# 用法：
#   ./scripts/publish.sh              # patch 版本号自动 +1，交互确认后发布
#   ./scripts/publish.sh minor        # minor 版本号 +1
#   ./scripts/publish.sh major        # major 版本号 +1
#   ./scripts/publish.sh 0.11.0       # 指定版本号
#   ./scripts/publish.sh --skip-test  # 跳过测试
#   ./scripts/publish.sh --dry-run    # 预演模式，不实际发布
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ---- 参数解析 ----
SKIP_TEST=false
DRY_RUN=false
VERSION_ARG=""

for arg in "$@"; do
    case "$arg" in
        --skip-test) SKIP_TEST=true ;;
        --dry-run)   DRY_RUN=true ;;
        patch|minor|major) VERSION_ARG="$arg" ;;
        [0-9]*.[0-9]*.[0-9]*) VERSION_ARG="$arg" ;;
        *) echo -e "${RED}[ERROR] 未知参数: $arg${NC}"; exit 1 ;;
    esac
done

# ---- 1. 切换 registry 到 npm 官方源 ----
ORIGINAL_REGISTRY=$(npm config get registry)
OFFICIAL_REGISTRY="https://registry.npmjs.org/"

if [ "$ORIGINAL_REGISTRY" != "$OFFICIAL_REGISTRY" ]; then
    echo -e "${YELLOW}[registry] 当前源: $ORIGINAL_REGISTRY${NC}"
    echo -e "${YELLOW}[registry] 切换至官方源: $OFFICIAL_REGISTRY${NC}"
    npm config set registry "$OFFICIAL_REGISTRY"
    REGISTRY_CHANGED=true
else
    echo -e "${GREEN}[registry] 已是官方源: $OFFICIAL_REGISTRY${NC}"
    REGISTRY_CHANGED=false
fi

# 退出时恢复 registry
restore_registry() {
    if [ "$REGISTRY_CHANGED" = true ]; then
        echo -e "${YELLOW}[registry] 恢复原始源: $ORIGINAL_REGISTRY${NC}"
        npm config set registry "$ORIGINAL_REGISTRY"
    fi
}
trap restore_registry EXIT

# ---- 2. 确认登录状态 ----
echo -e "\n${GREEN}[check] 检查 npm 登录状态...${NC}"
NPM_USER=$(npm whoami 2>/dev/null || echo "")
if [ -z "$NPM_USER" ]; then
    echo -e "${RED}[ERROR] 未登录 npm，请先执行: npm login${NC}"
    exit 1
fi
echo -e "${GREEN}[check] 已登录为: $NPM_USER${NC}"

# ---- 3. 版本号管理 ----
CURRENT_VERSION=$(node -p "require('./package.json').version")

if [ -n "$VERSION_ARG" ]; then
    case "$VERSION_ARG" in
        patch|minor|major)
            NEW_VERSION=$(node -e "
                const v = '${CURRENT_VERSION}'.split('.');
                if ('${VERSION_ARG}' === 'patch')   v[2] = Number(v[2]) + 1;
                if ('${VERSION_ARG}' === 'minor')   { v[1] = Number(v[1]) + 1; v[2] = 0; }
                if ('${VERSION_ARG}' === 'major')   { v[0] = Number(v[0]) + 1; v[1] = 0; v[2] = 0; }
                console.log(v.join('.'));
            ")
            ;;
        *)
            NEW_VERSION="$VERSION_ARG"
            ;;
    esac
    echo -e "${YELLOW}[version] $CURRENT_VERSION → $NEW_VERSION${NC}"
    node -e "
        const fs = require('fs');
        const pkg = require('./package.json');
        pkg.version = '${NEW_VERSION}';
        fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
else
    NEW_VERSION="$CURRENT_VERSION"
    echo -e "${YELLOW}[version] 当前版本: $NEW_VERSION (未变更，使用 --dry-run 外需手动指定版本号)${NC}"
    if [ "$DRY_RUN" = false ]; then
        echo -e "${RED}[ERROR] 发布时必须指定版本号，如: ./scripts/publish.sh patch${NC}"
        exit 1
    fi
fi

# ---- 4. 构建 ----
echo -e "\n${GREEN}[build] 编译构建...${NC}"
npm run build
echo -e "${GREEN}[build] 构建完成${NC}"

# ---- 5. 测试（可选跳过） ----
if [ "$SKIP_TEST" = false ]; then
    echo -e "\n${GREEN}[test] 运行测试...${NC}"
    npm test || {
        echo -e "${RED}[test] 测试失败，取消发布${NC}"
        exit 1
    }
    echo -e "${GREEN}[test] 测试通过${NC}"
else
    echo -e "${YELLOW}[test] 跳过测试 (--skip-test)${NC}"
fi

# ---- 6. 发布 ----
PACKAGE_NAME=$(node -p "require('./package.json').name")
echo -e "\n${GREEN}[publish] 包名: ${PACKAGE_NAME}@${NEW_VERSION}${NC}"

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}[publish] DRY RUN — 不会实际发布${NC}"
    npm publish --access public --dry-run
else
    echo -e "${YELLOW}[publish] 确认发布 ${PACKAGE_NAME}@${NEW_VERSION} 到 npm? (y/N)${NC}"
    read -r CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
        echo -e "${RED}[publish] 已取消${NC}"
        exit 0
    fi
    npm publish --access public
    echo -e "${GREEN}[publish] ✅ ${PACKAGE_NAME}@${NEW_VERSION} 发布成功！${NC}"
fi

echo -e "\n${GREEN}用户可通过以下命令安装:${NC}"
echo -e "  npx ${PACKAGE_NAME}"
echo -e "  npm i -g ${PACKAGE_NAME}"