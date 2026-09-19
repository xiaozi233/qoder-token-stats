# Qoder Token Stats

[English](README.md) | 简体中文

一个 Qoder 插件，在每轮回答结束后打印本轮的 token 吞吐统计，格式对齐主界面那条状态栏：

```
⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 3,389 tok / 生成 60.6s · 45 段 / 峰 84.6 · ⏱ 19:24:51
```

这一行**不带会话累计**：跨越 `--expose-token-usage` 开关前后，累计会把估算值和实测值
混成同一个数字。需要看累计时用 `token-stats --session <id>`，那条 CLI 输出里仍然有。

## 快速开始

```bash
git clone https://github.com/xiaozi233/qoder-token-stats.git
cd qoder-token-stats
node scripts/install.mjs --expose-token-usage   # 注册插件 + 让 Qoder 输出真实 token 数
```

`--expose-token-usage` 会把 `QODERCN_EXPOSE_TOKEN_USAGE=1` 写进 `HKCU\Environment`。
不加这个开关，Qoder 会在写会话日志前把所有 token 计数清零，数字就只能是估算。

**但只重开 Qoder 是不够的。** 快捷方式、任务栏、双击 exe 启动的程序，环境全部继承自
`explorer.exe`，而它只在登录时读一次 `HKCU\Environment`，之后不再重读——所以登录后
新增的变量对它们全都不可见。三选一：

- 重启资源管理器（任务管理器 → Windows 资源管理器 → 重新启动，或
  `Stop-Process -Name explorer -Force`）——一次性，之后点图标永远正常；
- 注销再登录；
- 或者不刷新，改用 `scripts/launch-with-usage.ps1` 启动 Qoder，它会在自己的进程里
  先把变量设好。

做完之后再**完全退出并重开 Qoder**（变量在进程启动时读取，插件注册表也同时 reconcile）。
之后每轮回答结束，
你会在回复末尾看到：

```
⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 3,389 tok / 生成 60.6s · 45 段 / 峰 84.6
```

同时 `token-stats` skill 会注册进来，可以直接问 agent「本轮多少 tok/s」。

## 安装 / 卸载

```bash
node scripts/install.mjs                        # 只装插件，token 数为估算
node scripts/install.mjs --expose-token-usage   # 同时设 QODERCN_EXPOSE_TOKEN_USAGE=1
node scripts/install.mjs --uninstall            # 移除插件并清掉该环境变量
node scripts/install.mjs --uninstall --keep-env # 保留环境变量
```

已设过该变量时重复执行不会覆盖。卸载时把它写成 `0` 而不是删除条目，方便你在注册表里看到改动痕迹。

### 重启后 `~` 前缀没消失

`setx` 只写 `HKCU\Environment`，对正在跑的进程仅发一次 `WM_SETTINGCHANGE` 广播；
而**启动 Qoder 的那个进程往往根本不重读环境**（实测过：launcher 自己已退出、Qoder
被系统收养，于是变量始终没进到 Qoder 的 env 里），token 数就仍被清零。用自带的启动脚本：

```powershell
powershell -File scripts/launch-with-usage.ps1 -CheckOnly   # 看 Qoder 现在能看到什么
# 完全退出 Qoder，然后：
powershell -File scripts/launch-with-usage.ps1              # 带着该变量启动它
```

Qoder 还在运行时该脚本会拒绝执行——因为第二个实例只会把请求转交给第一个，什么环境变量都继承不到。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `.qoder-plugin/plugin.json` | 插件清单 |
| `hooks/hooks.json` | 注册 `Stop` 钩子 |
| `bin/token-stats.cmd` | Windows 包装脚本，先解析 JS 运行时再执行 `runtime/*.mjs` |
| `runtime/stats.mjs` | 解析 Qoder 会话日志、计算各项指标 |
| `runtime/prompt-submit.mjs` | `UserPromptSubmit` 钩子：给本轮打时间戳，并注入显示指令 |
| `runtime/stop-stats.mjs` | `Stop` 钩子：归档本轮统计行 |
| `runtime/token-stats.mjs` | CLI（`--current --key <k>` 给模型收尾用，`--session` 查历史） |
| `skills/token-stats/SKILL.md` | 教会 agent 怎么跑、怎么解释这些数字 |
| `scripts/install.mjs` | 写入用户插件注册表（改前留 `.bak` 备份） |

## 改了代码不想重装

`install.mjs` 是往 `plugins/cache/local/` 里拷一份**快照**，并在 `SOURCE` 文件里记下源码目录。
改完之后二选一：

```bash
node scripts/install.mjs                                  # 重新同步快照
set TOKEN_STATS_SOURCE=<本仓库的绝对路径>                  # 或直接跑源码目录
```

设置了 `TOKEN_STATS_SOURCE` 之后，`bin/token-stats.cmd` 会执行源码目录里的 `runtime/*.mjs`
而不是安装副本。日常使用记得把这个变量去掉。

## 各项数字是怎么算出来的

Qoder 会把结构化事件追加到 `~/.qoder-cn/logs/sessions/<项目>/<会话>/segments/*.jsonl`。
一个「轮」= 共享同一个 `turn_id` 的事件集合；一个「段」= 一对
`model.request.started` → `model.response.completed`。生成秒数是所有段时长之和，
所以工具执行和权限等待的时间**不计入**。

各段的 token 数来自会话 transcript（`~/.qoder-cn/projects/<项目>/<会话>.jsonl`），
按 assistant 的 `message.id` 分组，再用时间戳最近邻配对到各个段——因为存在重试和失败请求，
两边的数量会不相等，按位置硬对齐会漂移。

| 字段 | 含义 |
| --- | --- |
| `tok/s(本轮)` | 本轮 token 数 ÷ 本轮模型生成总秒数 |
| `首字` | 轮开始 → 第一个 `tool.requested` 或 `model.response.completed` 事件 |
| `输出 tok` | assistant 的正文 + thinking + 工具调用参数 |
| `生成` | 各段时长之和（不含工具执行时间） |
| `段` | 本轮完成的大模型请求数 |
| `峰` | 本轮所有段里最高的单段速率 |

**token 总量是估算值，不是实测值。** 目前网关在每条 `model.response.completed` 上返回的
`output_tokens` 都是 0，所以插件改用字符估算：中日韩字符按 1 token/字、拉丁词按 1 token/词
计数，结果前面加 `~` 标记。一旦网关开始返回真实 usage，插件会自动改用真实值，`~` 也随之消失，
不需要任何配置。

`首字` 同理：Qoder 并不记录「首 token」事件，取的是「轮开始 → 第一次工具调用或整段响应完成」，
所以它是首字耗时的**上界**，不是实测值。

## 统计行是怎么显示出来的

Qoder 插件没有 UI 扩展点，而 `Stop` 钩子的 stdout 会被包成 SDK 的 `hook_response` 消息，
客户端并不渲染。所以那行可见的文字是**让模型自己打出来的**：

```
UserPromptSubmit ──为本轮生成 key，写入 state.json──┐
                                                     └─additionalContext：
                                「收尾时运行 token-stats --current --key <本轮 key>，
                                  把输出原样引用到回复末尾」
模型做完工具 → 运行 token-stats --current --key … → 用引用块贴出这一行
Stop          → 把同一行归档到 history.jsonl / latest.md
```

每轮一个 12 位十六进制 key，模型读回的是自己那条记录，不再和别的会话抢同一个槽位。
之前正是这个抢槽位让**会话的第一轮永远不显示**：那一轮 transcript 还没落盘，旧的
「这是不是真实会话」探测判定失败，指令根本没注入。不带 key 的 `--current` 仍然可用——
它回落到「最近一次拥有 transcript 的会话」记录的轮次，后台子会话动不了这个槽位。
两种情况下，只要本轮还没有属于自己的 model 请求，就一律不输出，绝不会把上一轮的数字当本轮显示。

这套设计直接来自 [zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor)——
它面对的是同一个「钩子画不了 UI」的问题，用的是同一个解法。

`Stop` 钩子仍是可靠的归档来源：它从 payload 里读 `session_id`、`transcript_path` 和
`parent_business_info.begin_at` 来锁定刚结束的那一轮，写出 `history.jsonl`、`latest.md`、
`latest.json`。

关闭注入：在 `~/.qoder-cn/token-stats.config.json` 写入 `{ "tokenRateLine": false }`。

## 实测数据

在作者机器上的真实会话跑出来的结果，包含两个历史 Bedrock mod 会话：

| 会话 | tok/s | 首字 | 输出 | 生成 | 段 | 峰 |
| --- | --- | --- | --- | --- | --- | --- |
| `9762dfc7`（本仓库） | 33.3 | 4.5s | ~18,820 | 565.2s | 81 | 60.9 |
| `c1f7d924` | 22.1 | 6.8s | ~2,857 | 129.3s | 11 | 38.3 |
| `093d9f7a` | 21.9（两轮均值） | — | ~9,737 | 445.5s | 21 | 28.0 |

## 已知限制

- **统计行依赖模型配合。** 那是一串注入指令，不是渲染出来的控件——模型忽略它，这一行就不出现。
  Qoder 插件只能提供 hooks、MCP server 和 skill，没有 UI 扩展点，插件内部无法绘制常驻控件。
- **token 总量目前是估算值，但原因是 Qoder 主动隐藏，不是网关没给。** 客户端源码实证：

  ```js
  function ror(A) { return l7() ? A : 0 }                 // 真值 → 0
  l3s = new Set(["input_tokens", "output_tokens", "completion_tokens",
               "total_tokens", "cache_read_input_tokens", …])  // 字段名黑名单
  // 写日志时：preserveSessionTokenUsage ? 原文 : 脱敏后的数据
  //   而 preserveSessionTokenUsage = (provider === "custom")
  ```

  `preserveSessionTokenUsage` 只在 BYOK 的 `custom` provider 下为真，所以走 Qoder 自家网关时
  每条 `model.response.completed` 落盘都是 0。在启动 Qoder 前设好 SDK 的官方环境变量
  `QODERCN_EXPOSE_TOKEN_USAGE=1`（接受 `1`/`true`/`yes`/`on`），真实数值就会原样进日志；
  本插件会**自动**切到真值，`~` 前缀消失，插件侧无需任何配置。
  **2026-09-20 实测已验证**：打开开关后同一轮真实输出 976 tok、字符估算只有 565，即低估约 42%。

  在那之前按字符估算：中日韩 1 字/token、拉丁词 1 词/token（含正文+thinking+工具参数），结果加 `~`。
  代码密集的轮次估算会偏——分词器对标点、缩进、标识符的计法与词数启发式差别较大。
- **`首字` 是上界。** Qoder 不记录首 token 事件，取的是「轮开始 → 首次工具调用或整段响应完成」。

## 许可证

MIT，见 [LICENSE](LICENSE)。
