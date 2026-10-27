# codex-usage

只读的 Codex 额度工具集：OpenCode TUI 状态栏 + `codex_usage` 工具 + 独立命令行脚本。

## 三种用法

| 入口 | 用途 |
|---|---|
| TUI 状态栏 | 使用 `openai/*` 模型时，输入框下方显示 `5h 22% · 7d 79%` |
| `ctrl+u` / `/codex-usage` | 弹窗查看重置时间、credits、重置券，并强制刷新 |
| `codex_usage` 工具 | agent 读取，附带账号和 OpenCode 连接诊断 |
| `codex-usage` 命令 | 不依赖 OpenCode，终端直接查 |

## 独立脚本（不依赖 OpenCode）

`bin/codex-usage` 已软链到 `~/.local/bin/codex-usage`：

```sh
codex-usage             # 5h 7% · 7d 77%
codex-usage --detail    # 重置时间、credits、重置券
codex-usage --json      # 接口原始返回
codex-usage --no-color  # 管道输出时自动禁用颜色
```

只依赖 Python 3 和 `~/.codex/auth.json`。OpenCode 升级或插件失效时，这个脚本仍然可用。

## 显示与刷新

- 只在当前会话模型属于 `providers`（默认 `["openai"]`）时显示；其他 provider 不消耗这份额度。
- 刷新时机：启动、每轮助手结束（去抖 5s）、切到 `openai` 模型、手动 `ctrl+u`。**没有定时轮询**。
- 标记：`⟳` 刷新中，`!` 刷新失败（显示上次值），`*` 数据超过 15 分钟。
- 冷启动先读磁盘缓存，再后台刷新，不会出现空白等待。

可选配置（在 `opencode.json` 的 `plugins` 里以对象形式声明时生效）：

```json
{
  "plugins": [
    {
      "package": "/Users/you/.config/opencode/plugins/codex-usage",
      "options": { "providers": ["openai"], "alwaysShow": false, "debounceMs": 5000 }
    }
  ]
}
```

## 数据来源

1. `https://chatgpt.com/backend-api/wham/usage`：Codex CLI 自己使用的额度接口，
   带 `Authorization: Bearer <~/.codex/auth.json>` 和 `chatgpt-account-id`，约 1–2s。
2. 401、超时或 5xx：回退 `codex app-server` 的 `account/rateLimits/read`，
   真实 `~/.codex` 下会顺带刷新 token。
3. 60s 进程内缓存 + `~/.cache/opencode/codex-usage.json` 冷启动缓存。
4. `codex_usage` 工具额外读取 `~/.config/opencode-multi-auth/accounts.json`
   和 OpenCode OpenAI 连接，用于诊断账号归属。

User-Agent 跟随本机 codex 版本（`~/.codex/version.json` → `codex --version` → 兜底），
可用 `CODEX_CLI_USER_AGENT` 覆盖。

## 升级兼容

- 状态栏依赖 OpenCode V2 CLI 插件 API。升级后若不再显示，只影响 UI：
  `codex_usage` 工具和独立脚本仍然可用。
- TUI `setup` 做了能力检测和 `try/catch`：缺 slot、dialog、事件或 keymap 时自动降级
  （弹窗缺失改用 toast，状态栏缺失只记录日志），不会影响 TUI 启动。
- 渲染函数也有 `try/catch`，单帧异常返回 `null`，不会让界面崩掉。
- 升级后检查：

```sh
opencode plugin list
opencode reload
grep -i "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail
codex-usage            # 独立脚本仍可用
```

## 版本管理

本目录是独立 git 仓库。升级 OpenCode 前后可用 `git diff`、`git log` 对照改动；

```sh
cd ~/.config/opencode/plugins/codex-usage
git status
git diff
```

## 只读保证

插件不会：

- 切换 active 账号
- 修改 Authorization/header
- 修改 provider 或 model 配置
- 修改 OpenAI 凭据

只调用本地 `codex app-server` 或读取本地 JSON/SQLite；写操作仅限自己的缓存文件。

## 依赖

- OpenCode 2.1.x
- 本机安装 `codex` CLI（HTTP 失败时兜底）
- Python 3（仅独立脚本）

## 排错

```sh
opencode plugin list
opencode reload
```

TUI 插件加载标记（仅调试时）：

```sh
CODEX_USAGE_TUI_DEBUG=/tmp/codex-usage-tui.log opencode
```

查看日志：

```sh
tail -f ~/.local/share/opencode/log/opencode.log
```
