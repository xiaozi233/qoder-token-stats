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

聊天里那行是模型自己打出来的，偶尔会漏。想要一个完全不依赖模型的显示，开桌面悬浮条——
它读的就是同一份归档结果：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay.ps1   # 或双击 dashboard\overlay.cmd
```

## 安装 / 卸载

```bash
node scripts/install.mjs                        # 只装插件，token 数为估算
node scripts/install.mjs --expose-token-usage   # 同时设 QODERCN_EXPOSE_TOKEN_USAGE=1
node scripts/install.mjs --uninstall            # 移除插件并清掉该环境变量
node scripts/install.mjs --uninstall --keep-env # 保留环境变量
```

已设过该变量时重复执行不会覆盖。卸载会**删除**这个值（而不是像早先那样写成 `0`），并回读注册表确认已清掉。

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
| `hooks/hooks.json` | 注册 `UserPromptSubmit` 和 `Stop` 两个钩子 |
| `bin/token-stats.cmd` | Windows 包装脚本，先解析 JS 运行时再执行 `runtime/*.mjs` |
| `runtime/schema.mjs` | **所有借用自 Qoder 的名字集中在这一处**：事件类型、payload 字段、目录命名规则，以及检测格式变化的探测层 |
| `runtime/stats.mjs` | 解析 Qoder 会话日志、计算各项指标（唯一的实现） |
| `runtime/archive.mjs` | 插件自己的归档：原子写、咨询锁、`state.json`/`latest.json`/`history.jsonl`/`errors.jsonl` |
| `runtime/prompt-submit.mjs` | `UserPromptSubmit` 钩子：给本轮打时间戳，并注入显示指令 |
| `runtime/stop-stats.mjs` | `Stop` 钩子：归档本轮统计行 |
| `runtime/token-stats.mjs` | CLI（`--current --key <k>` 给模型收尾用，`--session` 查历史） |
| `scripts/test.mjs` | `node scripts/test.mjs` —— 25 个测试，零依赖 |
| `scripts/make-fixtures.mjs` | 从真实的 `~/.qoder-cn` 重新生成 `tests/fixtures/` |
| `skills/token-stats/SKILL.md` | 教会 agent 怎么跑、怎么解释这些数字 |
| `docs/agent-prompt.md` | 交接提示词：让 Qoder 里的 agent 接手本仓库，含只有在 Qoder 内部才能跑的验收步骤 |
| `dashboard/overlay.ps1` | 可选的桌面置顶悬浮条（完全不经过模型） |
| `dashboard/overlay.cmd` | 上面那个脚本的双击入口 |
| `scripts/install.mjs` | 写入用户插件注册表（改前留 `.bak` 备份） |

## 测试

```bash
node scripts/test.mjs
```

跑的是从真实会话日志脱敏裁出来的 fixture，覆盖：会话第一轮、纯文字无工具轮、
含网络重试轮、估算与实测混合的会话、一个 `turn_id` 跨三条用户消息、损坏/半行日志，
以及失败路径：认不出的事件类型、会话不存在、state 并发写、归档与引用是否一致。
不引第三方包，`git clone` 就是完整安装。

## 那行数字从哪来、排除了什么

统计从 Qoder 自己的事件日志里量出来，**量到模型运行 `--current` 命令的那一刻为止**——
注入的指令要求把这条命令放在最后，也就是总结写完、正文打完之后。所以这一行描述的是
整轮减去「引用它自己的那句话」。

这个边界很要紧。早先的版本要求**先**运行命令再写总结，于是把总结本身悄悄排除掉了：
在作者的日志上那是**平均 32% 的一轮**，30 轮实测里 30 轮都和归档数字对不上。现在聊天行
和归档行由同一个函数、同一个边界算出来，两者完全一致。

如果模型还是提前运行了命令（回答没写完就跑了），这一轮会被**标记**而不是当成完整轮汇报：
CLI 往 stderr 写 `warning: 统计命令在本轮结束前 Ns 就被调用，漏掉 M tok（约 P%）`，
归档把警告记进 `warnings`，悬浮条追加 `⚠ 数字偏小（统计早于回答结束）` 并把整行显示成琥珀色。

## 这个插件不会做的事

- **不会为读不懂的日志打印 0。** 如果 Qoder 改了事件名，CLI 以退出码 2 结束并在 stderr
  写明 `Qoder's log format has changed`，`Stop` 钩子把失败记进 `errors.jsonl`。这替换掉了
  原来那个静默 `exit 0`——它让「日志读不懂」和「这一轮没数据」变得无法区分。
- **不会把上一轮当成本轮。** 只要本轮的 model 请求全部早于本轮自己的时间戳，就一律不输出。

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

`turn_id` **不等于**一条用户消息：同一个 `turn_id` 下 `turn.started` 和
`input.prompt.submitted` 都可能重复出现（作者日志里就有一轮各出现三次）。所以测量窗口
从「边界时刻之前的最后一次 prompt」开始，而不是从 `turn_id` 的第一个事件开始。

各段的 token 数来自会话 transcript（`~/.qoder-cn/projects/<项目>/<会话>.jsonl`），
按 assistant 的 `message.id` 分组，再用时间戳最近邻配对到各个段——因为存在重试和失败请求，
两边的数量会不相等，按位置硬对齐会漂移。`model.request.attempt_failed` 本身不算一段。

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

跨越开关的会话会报 `token 来源: 混合`，并把**整条累计**加 `~`，而不是把两种来源混成一个不带标记的数。

`首字` 同理：Qoder 并不记录「首 token」事件，取的是「轮开始 → 第一次工具调用或整段响应完成」，
所以它是首字耗时的**上界**，不是实测值——对单段轮次它整好等于整段生成时间（作者归档的 43 轮里有
16 轮如此）。行上不做标记，请按「不会早于此」理解。

## 统计行是怎么显示出来的

Qoder 插件没有 UI 扩展点。客户端只认 `hook_started` / `hook_progress` / `hook_response`
三种钩子事件，画出来的 part 只有 `{id, event, status, exitCode, startedAt, completedAt}`——
**没有文字字段**——所以钩子往 stdout 写什么都进不了聊天面板（已在 Qoder CN 0.3.4 的
`app.asar` 里核实）。那行可见的文字因此是**让模型自己打出来的**：

```
UserPromptSubmit ──为本轮生成 key，写入 state.json──┐
                                                     └─additionalContext：
                                「先写完总结，然后运行 token-stats --current
                                  --key <本轮 key>，把它作为最后一个动作，
                                  把输出原样引用到回复末尾」
模型做完工具 → 写完总结 → 运行 CLI → 用引用块贴出这一行
Stop          → 把同一行归档到 history.jsonl / latest.md
```

每轮一个 12 位十六进制 key，模型读回的是自己那条记录，不再和别的会话抢同一个槽位。
之前正是这个抢槽位让**会话的第一轮永远不显示**：那一轮 transcript 还没落盘，旧的
「这是不是真实会话」探测判定失败，指令根本没注入。不带 key 的 `--current` 仍然可用——
它回落到「最近一次拥有 transcript 的会话」记录的轮次。两种情况下，只要本轮还没有属于自己的
model 请求，就一律不输出，绝不会把上一轮的数字当本轮显示。

这套设计直接来自 [zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor)——
它面对的是同一个「钩子画不了 UI」的问题，用的是同一个解法。

`Stop` 钩子仍是可靠的归档来源。它算的是**和 CLI 完全相同的窗口**——两者都停在模型自己那次
`--current` 调用上，而这个边界是从日志里查出来的、不是互相传递的——所以归档的那行和引用的
那行永远是同一个数。归档按轮幂等；后台子会话（没有 transcript）会记进历史，但绝不覆盖
`latest.json`。

## 出问题了看哪

失败会被记下来，不再被吞掉。三个地方：

| 文件 | 内容 |
| --- | --- |
| `errors.jsonl` | 每次失败，带 `kind`：`unknown-log-format`、`no-session-log`、`state-write-failed`、`archive-failed` … |
| `history.jsonl` | 每一轮一行归档，含 `warnings` 数组 |
| `latest.json` | 最新那一行，附带它的 `warnings` |

读得懂但解析不了的日志绝不会被报成 0。CLI 以退出码 2 结束，并把原因写到 stderr：

```
$ token-stats --session <id>
token-stats: unrecognised model event type(s): llm.request.begin, llm.response.done — Qoder's log format has changed
```

只想关掉注入指令、保留归档：在 `~/.qoder-cn/token-stats.config.json` 写入
`{ "tokenRateLine": false }`。

## 桌面悬浮条（可选）

上面那行引用终究还是要模型自己去打——它一般会打，但偶尔不打。`dashboard/overlay.ps1`
把模型从链路里彻底拿掉：它每秒读一次 `latest.json`（`Stop` 钩子每轮都会重写），
把里面的 `line` 画到一条透明、置顶的悬浮条上。不用配置，也不用提示。

```powershell
# 启动（或直接双击 dashboard\overlay.cmd）
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay.ps1
powershell -NoProfile -File dashboard\overlay.ps1 -Status   # 在不在跑？
powershell -NoProfile -File dashboard\overlay.ps1 -Stop     # 关掉
```

按住可以直接拖到任意位置，位置会被记住；右键有关闭菜单。首次启动它会贴在 Qoder
窗口右下角，并且通过采样那个窗口的边缘亮度在深/浅两套配色间自动切换，两种主题下都看得清。
它默认找 `Qoder CN` 这个进程名，可用 `-ProcessName` 改。数据目录按
`$env:QODER_PLUGIN_DATA` → `$env:QODER_HOME\plugins\data\token-stats-local` →
`~/.qoder-cn/...` 的顺序取默认值，也可用 `-DataDir` 指。

归档行带警告时（模型在总结之前就量了数），悬浮条会追加琥珀色的
`⚠ 数字偏小（统计早于回答结束）`，而不是把偏小的数字当成完整值显示。

条上写的是 `(上一轮)` 而不是 `(本轮)`：归档是在一轮**结束**时才写的，所以回答正在往外吐的
时候，条上显示的还是上一轮那一行。拖到第二块显示器时，悬浮条会跟随它所在的那块屏。

## 改了代码不想重装

`install.mjs` 是往 `plugins/cache/local/` 里拷一份**快照**，并在 `SOURCE` 文件里记下源码目录。
改完之后二选一：

```bash
node scripts/install.mjs                                  # 重新同步快照
set TOKEN_STATS_SOURCE=<本仓库的绝对路径>                  # 或直接跑源码目录
```

设置了 `TOKEN_STATS_SOURCE` 之后，`bin/token-stats.cmd` 会执行源码目录里的 `runtime/*.mjs`
而不是安装副本。日常使用记得把这个变量去掉。

## 实测数据

在作者机器上的真实会话上跑出来的结果：224 个会话日志目录、27 个有完整轮次的会话、
55 次 `Stop` 触发、51 次 `UserPromptSubmit` 触发。下表由 CLI 在审计时输出；驱动这次重构的
那些数字（调用窗口少算、归档丢失、用户消息复用、重试轮）都记录在本仓库的提交历史里。

| 会话 | tok/s | 首字 | 输出 | 生成 | 段 | 峰 |
| --- | --- | --- | --- | --- | --- | --- |
| `9762dfc7`（本仓库） | 33.3 | 4.5s | ~18,820 | 565.2s | 81 | 60.9 |
| `c1f7d924` | 22.1 | 6.8s | ~2,857 | 129.3s | 11 | 38.3 |
| `093d9f7a` | 21.9（两轮均值） | — | ~9,737 | 445.5s | 21 | 28.0 |

## 已知限制

- **聊天里那行统计依赖模型配合。** 那是一串注入指令，不是渲染出来的控件——模型忽略它，这一行就不出现。
  作者日志上的实测：指令覆盖到的轮次里 80% 真的跑了 CLI，57% 的回答里出现了那段引用块。
  绕开办法就是 `dashboard/overlay.ps1`：一条桌面悬浮条，直接读归档好的那一行。
- **这一行排除了模型在命令之后写的内容。** 指令要求把命令放最后，于是只有那句引用被排除——
  在作者日志上约占一轮的 7%。模型提前运行会被标记，但数字仍然偏小。
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
  13 轮汇总实测低估 37.5%。

  在那之前按字符估算：中日韩 1 字/token、拉丁词 1 词/token（含正文+thinking+工具参数），结果加 `~`。
  代码密集的轮次估算会偏——分词器对标点、缩进、标识符的计法与词数启发式差别较大。
- **`首字` 是上界**，对单段轮次它整好等于整段生成时间。Qoder 不记录首 token 事件。
- **会话第一轮最脆弱。** 它的 transcript 要到回答开始才落盘，而且后台子会话会在同一目录触发
  `UserPromptSubmit`。每轮独立 key 和锁覆盖了这一点，但真要是少了一行，先查这个场景。
- **少一行不等于数字错，先确认钩子到底跑没跑。** 在 Qoder 运行时替换插件的版本目录，钩子会以
  `Plugin directory does not exist` 失败，而那一轮**根本不会归档**——结果是聊天有行、归档没有行。
  `errors.jsonl` 报不了这种失败：进程没启动，自然写不出日志。要查只能筛 Qoder 自己的
  `hook.finished` 事件（`hook_name` 存在且 `success === false`），别按错误文本 grep——
  本仓库那份提示词的正文会被回写进同样的日志，一搜就命中自己。

## 许可证

MIT，见 [LICENSE](LICENSE)。
