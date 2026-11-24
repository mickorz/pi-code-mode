# Git Bash 下 `/workflows` 命令被 MSYS 路径转换污染

## 问题现象

在 Git Bash（Windows）里执行：

```bash
pi -p "/workflows optimize worker.js --rules RETRY-001 ..."
```

参数中的 `/workflows` 被自动改写成 `C:/Program Files/Git/workflows`，命令找不到对应斜杠命令，直接失败。传给 pi 的字符串变成：

```
C:/Program Files/Git/workflows optimize worker.js --rules RETRY-001 --fresh --no-open
```

## 根因

Git Bash（MSYS2 运行时）对**看起来像 POSIX 绝对路径的参数**做自动路径转换（path conversion）：以 `/` 开头的参数会被改写为对应的 Windows 路径（`/workflows` → Git 安装目录下的 `workflows`）。这是 MSYS 层行为，与 pi 无关。

## 解决方案

两种任选：

1. **禁用转换**（推荐，保留 POSIX 风格 `-e` 路径时注意配合）：

   ```bash
   MSYS_NO_PATHCONV=1 pi -ne -e "E:/WorkProjects/pi-code-mode" -p "/workflows optimize worker.js --rules RETRY-001 --fresh --no-open"
   ```

   注意：设了 `MSYS_NO_PATHCONV=1` 后 `-e /e/WorkProjects/...` 这种 POSIX 路径**不再被转换**，所以 `-e` 要改用 Windows 风格（`E:/...`）。

2. **改写参数开头**避开转换判定（如 `//workflows` 或前置空格），hack 味重，不推荐。

## 预防/注意事项

- 自测清单里所有 `pi -p "/workflows ..."` 命令在 Windows Git Bash 下都要带 `MSYS_NO_PATHCONV=1`。
- PowerShell / CMD 无此问题。
- 记录时间：2026-11-24（optimize e2e 自测时撞上）。
