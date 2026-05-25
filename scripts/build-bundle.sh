#!/usr/bin/env bash
#
# 构建自包含的 CodeGraph bundle：包含官方 Node 运行时 +
# 编译后的应用 + 生产环境依赖，使 CodeGraph 无需系统 Node 即可运行，
# 且无需原生构建 — node:sqlite 已内置到 bundled Node 中。每个平台一个归档文件。
#
# 由于移除了 better-sqlite3 后已无原生插件，此方案为纯文件打包
# （下载目标平台的 Node、复制应用、打包归档）— 因此任何平台的 bundle
# 都可以在任何操作系统上构建。无需交叉编译，无需原生运行器。
#
# 用法:
#   scripts/build-bundle.sh <target> [node-version]
#     target:        darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
#                  | win32-x64 | win32-arm64
#     node-version:  例如 v24.16.0（默认值如下；固定版本以确保可复现构建）
#
# 输出:
#   unix:    release/codegraph-<target>.tar.gz   (启动器: bin/codegraph)
#   windows: release/codegraph-<target>.zip      (启动器: bin/codegraph.cmd)
set -euo pipefail

TARGET="${1:?用法: build-bundle.sh <target> [node-version]}"
NODE_VERSION="${2:-v24.16.0}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ARCH="${TARGET##*-}"   # x64 | arm64
OSFAM="${TARGET%-*}"   # darwin | linux | win32

echo "[bundle] target=${TARGET} node=${NODE_VERSION}"

# 1. 下载并解压目标平台的官方 Node 运行时。
if [ "$OSFAM" = "win32" ]; then
  NODE_DIST="node-${NODE_VERSION}-win-${ARCH}"
  NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.zip"
  echo "[bundle] downloading ${NODE_URL}"
  curl -fsSL "$NODE_URL" -o "$WORK/node.zip"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$WORK/node.zip" -d "$WORK"
  else
    tar -xf "$WORK/node.zip" -C "$WORK"   # bsdtar 可以读取 zip
  fi
  NODE_BIN="$WORK/${NODE_DIST}/node.exe"
else
  NODE_DIST="node-${NODE_VERSION}-${TARGET}"
  NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.gz"
  echo "[bundle] downloading ${NODE_URL}"
  curl -fsSL "$NODE_URL" -o "$WORK/node.tar.gz"
  tar -xzf "$WORK/node.tar.gz" -C "$WORK"
  NODE_BIN="$WORK/${NODE_DIST}/bin/node"
fi
[ -f "$NODE_BIN" ] || { echo "[bundle] error: node binary not found ($NODE_BIN)" >&2; exit 1; }

# 2. 构建应用（编译后的 JS + 复制的 wasm/schema 资源）。
echo "[bundle] building app"
( cd "$ROOT" && npm run build >/dev/null )

# 3. 暂存：应用 + 仅生产依赖（纯 JS/wasm → 跨平台可移植）。
STAGE="$WORK/codegraph-${TARGET}"
mkdir -p "$STAGE/lib" "$STAGE/bin"
cp -R "$ROOT/dist" "$STAGE/lib/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/lib/"
echo "[bundle] installing production dependencies"
( cd "$STAGE/lib" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1 )
rm -f "$STAGE/lib/package-lock.json"

# 4. 内置 Node + 启动器（启动器通过相对路径使用内置 Node，
#    因此无需系统 Node）。
if [ "$OSFAM" = "win32" ]; then
  cp "$NODE_BIN" "$STAGE/node.exe"
  printf '@"%%~dp0..\\node.exe" "%%~dp0..\\lib\\dist\\bin\\codegraph.js" %%*\r\n' \
    > "$STAGE/bin/codegraph.cmd"
else
  cp "$NODE_BIN" "$STAGE/node"
  cat > "$STAGE/bin/codegraph" <<'LAUNCH'
#!/bin/sh
# 解析符号链接（例如 install.sh 创建的 ~/.local/bin/codegraph 链接），
# 以便找到真正的 bundle 目录，而不是符号链接的位置。
SELF="$0"
while [ -L "$SELF" ]; do
  target="$(readlink "$SELF")"
  case "$target" in
    /*) SELF="$target" ;;
    *) SELF="$(dirname "$SELF")/$target" ;;
  esac
done
DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
exec "$DIR/node" "$DIR/lib/dist/bin/codegraph.js" "$@"
LAUNCH
  chmod +x "$STAGE/bin/codegraph"
fi

# 5. 打包（Windows 用 .zip，其他用 .tar.gz）。
mkdir -p "$OUT"
if [ "$OSFAM" = "win32" ]; then
  ARCHIVE="$OUT/codegraph-${TARGET}.zip"
  rm -f "$ARCHIVE"
  ( cd "$WORK" && zip -rqX "$ARCHIVE" "codegraph-${TARGET}" )
else
  ARCHIVE="$OUT/codegraph-${TARGET}.tar.gz"
  # --no-xattrs：不要嵌入 macOS 扩展属性，否则 GNU tar 在 Linux 上会警告。
  tar --no-xattrs -czf "$ARCHIVE" -C "$WORK" "codegraph-${TARGET}"
fi
echo "[bundle] wrote ${ARCHIVE} ($(du -h "$ARCHIVE" | cut -f1))"
