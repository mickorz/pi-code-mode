# Windows git clone 报 Filename too long

- 日期：2026-11-19
- 环境：Windows + WSL/MSYS git，向 `thirdparties/` 添加 submodule（ak-pi-workflow-roles，含超长测试 fixture 路径）

## 问题现象

`gh repo clone`（或 `git clone`）拉取 ak-pi-workflow-roles 时，4 个深层 fixture 文件报错：

```
error: unable to create file test/fixtures/.../session/2026-08-05T10-08-31-568Z_019fd165-....jsonl: Filename too long
fatal: unable to checkout working tree
warning: Clone succeeded, but checkout failed.
```

仓库对象下载完成，仅工作树 checkout 部分失败。

## 排查过程

1. 先在**主仓库**设置 `git config core.longpaths true`（写入主仓库 `.git/config`），重新 clone 仍报同样错误。
2. 原因：clone 目标是一个全新目录，git 读取配置的顺序是「命令行 `-c` > 全局 > 系统」，**主仓库的 local config 对 clone 进新目录的进程不生效**——clone 时目标还不属于主仓库工作树，git 不会加载主仓库 `.git/config`。

## 根因

Windows 默认 MAX_PATH 260 字符限制；且 git 的 local 配置只对已存在于该仓库工作树内的操作生效，fresh clone 读不到它。

## 解决方案

把 `core.longpaths=true` 以命令行参数透传给 git clone：

```bash
gh repo clone <owner>/<repo> <dir> -- -c core.longpaths=true -b <branch> --depth 50
# 或纯 git：
git -c core.longpaths=true clone <url> <dir>
```

已同时在主仓库保留 `core.longpaths true`（local），使后续该子模块的 checkout / `submodule update` 等在仓库内的操作也走长路径。

## 预防与注意事项

- 向 `thirdparties/` 添加含深层路径的仓库时，clone 命令默认带上 `-c core.longpaths=true`（成本为零，无副作用）。
- `git submodule add` 的注册与后续 checkout 发生在主仓库工作树内，会读取主仓库 local config，主仓库已开启 longpaths 即可。
- 不建议改全局配置（`--global`），避免影响其他项目的工作习惯；本仓库 local + 命令行 `-c` 已覆盖全部场景。
