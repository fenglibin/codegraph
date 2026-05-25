# Git Remote 配置与推送指南

## 当前 Remote 配置

| Remote | URL | 用途 |
|--------|-----|------|
| **origin** | `https://github.com/fenglibin/codegraph.git` | GitHub 主仓库（当前 tracking） |
| **cnb** | `https://cnb.cool/xuefengdev/codegraph` | CNB 镜像仓库 |
| **upstream** | `https://github.com/colbymchenry/codegraph.git` | 上游 fork 仓库 |

## 查看当前配置

```bash
git remote -v
git branch -vv --list main
```

## 推送方式

### 推送到 GitHub（默认）

```bash
git push                  # 推送到 origin/main（当前 tracking）
git push origin main      # 显式指定
```

### 推送到 CNB

```bash
git push cnb main        # 推送到 cnb.cool
```

### 推送到 upstream（fork 同步）

```bash
git push upstream main    # 推送到 colbymchenry/codegraph
```

### 一次性推送到所有 Remote

```bash
./scripts/push-to-all.sh
```

## 切换默认 Tracking

若想让 `git push` 默认推送到 CNB：

```bash
git branch --set-upstream-to=cnb/main main
```

恢复默认（GitHub）：

```bash
git branch --set-upstream-to=origin/main main
```

## 脚本说明

| 脚本 | 用途 |
|------|------|
| `scripts/push-to-cnb.sh` | 推送到 CNB |
| `scripts/push-to-origin.sh` | 推送到 GitHub |
| `scripts/push-to-all.sh` | 依次推送到所有 remote |

## 注意事项

- **默认 `git push` 推送目标**：当前 `main` 分支 tracking `origin/main`，所以默认推送到 GitHub
- **CNB 推送需显式指定**：`git push cnb main`
- **按规则，push 操作由你手动执行**，脚本仅提供便捷命令
