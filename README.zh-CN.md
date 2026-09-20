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
| `runtime/prompt-submit.mjs` | `UserPromptSubmit` 钩子：给本轮打时间戳，并注入关于这一行的预告 |
| `runtime/stop-stats.mjs` | `Stop` 钩子：归档本轮统计行，然后唤醒模型把它贴出来 |
| `runtime/wake.mjs` | 唤醒的决策，纯函数：引用检测、失败计数、静默窗口 |
| `runtime/token-stats.mjs` | CLI（`--current --key <k>` 手动查，`--session` 查历史） |
| `scripts/test.mjs` | `node scripts/test.mjs` —— 41 个测试，零依赖 |
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

统计从 Qoder 自己的事件日志里量出来，**量到本轮结束为止**：`Stop` 钩子等回答写完才取数，
所以这一行描述的是整段回答，减去事后被贴出来的那句引用。

这个边界很要紧。上一版设计是让模型在回答当中跑一条 `--current` 命令，而其中更早的变体要求
**先**运行命令再写总结，于是把总结本身悄悄排除掉了：在作者的日志上那是**平均 32% 的一轮**，
30 轮实测里 30 轮都和归档数字对不上。手动运行的 `--current` 照旧停在被调用的那一刻，调用早
了也会告警；而聊天行与归档行由同一个函数、同一份记录算出来，两者完全一致。

如果手动跑的 `--current` 确实在回答写完之前就被调用过，这一轮会被**标记**而不是当成完整轮汇报。
**标记不可能来自那次调用本身**——它跳过的工作当时还没发生，没有可比的量；标记是事后算的，
出现在归档的 `warnings`、`latest.md`、悬浮条（追加 `⚠ 数字偏小（统计早于回答结束）` 并把整行显示成
琥珀色），以及 `--session` 查询的 stderr 上。引用到聊天里的那一行与归档行**逐字节相同**，
所以只看聊天的人**看不出这个数偏小**。

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

Qoder 插件没有 UI 扩展点。客户端的钩子渲染器只认 `hook_started` / `hook_progress` /
`hook_response` 三种事件，画出来的 part 只有 `{id, event, status, exitCode, startedAt,
completedAt}`——**没有文字字段**——所以钩子往 stdout 写什么都进不了聊天面板（已在 Qoder
CN 0.3.4 的 `app.asar` 里核实）。钩子的 stdout 同样不会转给模型：运行时为此维护的白名单
只有两个事件，`new Set(["SessionStart","UserPromptSubmit"])`。`Stop` 钩子还剩一条能回到
本轮的通道——以 `{"decision":"deny","reason":…}` 应答，Qoder 会把这条 reason 当作续写消息
重新注入——这一行就搭这条通道进来：

```
UserPromptSubmit ──为本轮生成 key，写入 state.json──┐
                                                    └─additionalContext：
                          「统计行会在本轮结束时作为一条 Stop 钩子反馈交给你，
                            把它原样放进引用块；若本轮没有统计行就不要显示，
                            绝不凭记忆或估算编造数字」
模型作答 → Stop → 量数、归档，并把这一行作为 reason 以 deny 返回
模型贴出这一行 → Stop（stop_hook_active）→ 结算这次唤醒，不再出声
```

在 `Stop` 上量数也比旧设计更准：数字覆盖的是完整回答，而不是模型恰好挤出一次命令时已经
写完的那部分。

那条命令是上一版设计——钩子让模型把 `token-stats --current --key <key>` 作为最后一个动作
跑掉，思路取自 [zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor)，它面对的
是同一个「钩子画不了 UI」的问题，用的是同一个解法。它撑不过 **Auto 模式**：每轮那次被强制
安排的工具调用都要过分类器，先被判为与用户的请求无关而拒绝，再被判为工作区之外的脚本而
拒绝。计数按会话累计，阈值写着 `{maxConsecutive: 3, maxTotal: 20}`；`recordAllow()` 只为
真正走到分类器的那次调用清掉连续计数，所以中间被放行的无关调用并不会把它归零，而一旦触发，
两个计数又同时被重置——于是每轮一次的强制命令不是失败一次，而是循环失败，agent 看起来一直
卡在原地。**用户**主动开口要的数字照样能出，因为相关性那道闸读的是用户请求，范围那道闸不读。

`--current` 因此留给这类手动查询。每轮一个 12 位十六进制 key，模型读回的是自己那条记录，
不会和别的会话抢同一个槽位；不带 key 的 `--current` 仍然可用，它回落到最近一次拥有
transcript 的会话所记录的那一轮。两种情况下，只要本轮的 model 请求全部早于本轮自己的
时间戳，就一律不输出，绝不会把上一轮的数字当本轮显示。

`Stop` 钩子同时是可靠的归档来源：它按轮幂等地写 `history.jsonl` 和 `latest.json`，后台
子会话（没有 transcript）会记进历史，但绝不覆盖 `latest.json`。一次唤醒连着三轮被模型
忽略，该会话就换来八轮安静（`errors.jsonl` 里的 `stop:wake-suppressed`），因为每轮多一次
模型迭代是实打实的成本；`~/.qoder-cn/token-stats.config.json` 里写
`{"tokenRateLine": false}` 会把注入和唤醒一起关掉。

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

只想关掉聊天里那一行、保留归档：在 `~/.qoder-cn/token-stats.config.json` 写入
`{ "tokenRateLine": false }`，注入和唤醒会一起停掉。

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

归档行带警告时（那一轮里有过一次过早的 `--current` 调用），悬浮条会追加琥珀色的
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

- **聊天里那行统计依赖模型配合。** 那是一串注入指令加一次唤醒，不是渲染出来的控件——模型
  不理这次唤醒，这一行就不出现（连续三轮不理，该会话静默八轮）。旧设计时代的实测：指令覆盖到
  的轮次里 80% 真的跑了 CLI，57% 的回答里出现了那段引用块。绕开办法就是
  `dashboard/overlay.ps1`：一条桌面悬浮条，直接读归档好的那一行。
- **这一行不含事后被贴出来的那句引用。** 统计在本轮结束时量完，模型只是把算好的行原样贴出，
  被排除的只剩那句引用——在作者日志上约占一轮的 7%。手动运行的 `--current` 仍然停在被调用的
  那一刻，调用过早会被标记，但数字仍然偏小。
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
  整轮**以错误结束**时 `Stop` 压根不触发：日志里正常收尾是 `QueryEnd:end_turn`，出错收尾是
  `QueryEnd:error`。所以"少一行"至少两种成因，日志能分开它们。两种都不会在 `errors.jsonl` 留痕
  （没跑起来的进程写不出日志），证据只在 Qoder 自己的钩子事件里，要按字段筛（`hook_name` 存在且
  `success === false`），别按错误文本 grep——本仓库那份提示词的正文会被回写进同样的日志，一搜就命中自己。

## 许可证

MIT，见 [LICENSE](LICENSE)。
