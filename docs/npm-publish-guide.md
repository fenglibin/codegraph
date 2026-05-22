# npm 发布与源切换指南

> 维护者文档 · 最后更新：2026-05-22

## 快速发布

```bash
# patch 版本号自动 +1（如 0.10.1 → 0.10.2）
./scripts/publish.sh patch

# minor 版本号 +1（如 0.10.1 → 0.11.0）
./scripts/publish.sh minor

# 指定版本号
./scripts/publish.sh 0.12.0

# 预演模式（不实际发布）
./scripts/publish.sh patch --dry-run

# 跳过测试（紧急修复场景，不推荐）
./scripts/publish.sh patch --skip-test
```

脚本会自动完成：
1. 临时切换至 npm 官方源（发布完成后恢复原源）
2. 检查 npm 登录状态
3. 更新 `package.json` 版本号
4. 执行 `npm run build` 编译
5. 执行 `npm test` 测试
6. 交互确认后 `npm publish --access public`
7. 恢复原始 registry 设置

---

## npm 源（registry）切换

### 查看当前源

```bash
npm config get registry
```

### 切换到 npm 官方源（发布时必须）

```bash
npm config set registry https://registry.npmjs.org/
```

### 切换到淘宝镜像源（日常安装加速）

```bash
npm config set registry https://registry.npmmirror.com/
```

### 临时使用指定源（不修改全局配置）

```bash
# 用官方源发布
npm publish --registry=https://registry.npmjs.org/

# 用镜像源安装
npm install --registry=https://registry.npmmirror.com
```

### 使用 nrm 快速切换（推荐）

```bash
# 安装 nrm
npm install -g nrm

# 列出所有可用源
nrm ls

# 切换源
nrm use npm        # 官方源
nrm use taobao     # 淘宝镜像

# 测速
nrm test
```

---

## 手动发布步骤（不使用脚本时）

### 1. 确保登录正确

```bash
# 检查当前登录用户
npm whoami

# 未登录则先登录
npm login
```

### 2. 切换到官方源

```bash
npm config set registry https://registry.npmjs.org/
```

> ⚠️ 淘宝镜像（`registry.npmmirror.com`）是只读的，不能用于发布。

### 3. 更新版本号

```bash
# 手动编辑 package.json 的 version 字段
# 或使用 npm version 命令
npm version patch    # 0.10.1 → 0.10.2
npm version minor    # 0.10.1 → 0.11.0
npm version major    # 0.10.1 → 1.0.0
```

`npm version` 命令会自动创建 git tag，如果不需要可以加 `--no-git-tag-version`。

### 4. 构建 + 测试

```bash
npm run build
npm test
```

### 5. 发布

```bash
npm publish --access public
```

> `--access public` 是 scoped 包（`@xuefadevdev/codegraph`）首次发布时必需的，后续发布可省略。

### 6. 恢复国内源（可选）

```bash
npm config set registry https://registry.npmmirror.com/
```

---

## 常见问题

### "Public registration is not allowed"

当前 registry 是淘宝镜像（只读），需要切到官方源：

```bash
npm config set registry https://registry.npmjs.org/
```

### "You cannot publish over the previously published versions"

版本号已存在。每个版本号只能发布一次，需要更新版本号：

```bash
npm version patch --no-git-tag-version
npm publish --access public
```

### "ENEEDAUTH" / "need auth"

未登录或登录过期：

```bash
npm login
```

### 发布后用户安装不到最新版

确认 registry 指向正确源：

```bash
npm config get registry
# 淘宝镜像有同步延迟，可临时用官方源安装
npm install -g @xuefadevdev/codegraph --registry=https://registry.npmjs.org/
```