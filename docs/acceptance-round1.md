# 第 1 轮验收报告

- 日期：2026-09-20
- 环境：Qoder CN（`~/.qoder-cn`），插件 `token-stats@local` 0.6.0
- 会话：`7e473992-2488-4920-85c3-73f905938266`，`cwd = D:\test\qoder-plugin`
- 本轮 key：`05e4a1589603`
- 执行者：**被测试的模型本人**（在 Qoder 内跑，非外部复现）

结论速览：**环境闸门通过；第 1 轮通过**（引用行与归档行逐字节相同）。另有 5 处与文档/注释
不符的地方，见第 3 节。

---

## 1. 环境闸门

| 检查 | 结论 | 证据 |
|---|---|---|
| 注册表指向 0.6.0 | 通过 | `version: "0.6.0"`，`installPath` 以 `plugins\cache\local\token-stats\0.6.0` 结尾 |
| `node scripts/test.mjs` | 通过 | `27 passed, 0 failed` |
| 缓存里没有旧版本目录 | 通过 | `plugins/cache/local/token-stats/` 下只有 `0.6.0` |
| 无旧版本钩子失败 | 通过（0 次） | 原始 grep 命中的 6 次全是**本提示词自身的文本**回流进日志，见 D5 |
| 注入指令送达 | 通过 | 上下文里 `【本轮统计指令】` 与 `runtime/prompt-submit.mjs:58-65` 逐字一致，含 key `05e4a1589603` |
| `QODERCN_EXPOSE_TOKEN_USAGE` | = 1 | 进程内 `EXPOSE=1`；`HKCU\Environment` = `1` |

## 2. 第 1 轮判定：通过

我按指令把统计命令作为最后一个动作运行，输出：

```
⚡ 177.6 tok/s(本轮) · 首字 2.3s · 输出 19,630 tok / 生成 110.5s · 17 段 / 峰 224 · ⏱ 15:10:15
```

与 Stop 钩子写入的归档行逐字节比对（不是肉眼，是 UTF-8 字节 + sha256）：

| | 长度 | sha256 前 16 位 |
|---|---|---|
| 我引用的行 | 83 | `2405d22c054ab30c` |
| `latest.json` 的 `line` | 83 | `2405d22c054ab30c` |

**BYTE-IDENTICAL = true。** 复现命令：

```bash
printf '%s' '⚡ 177.6 tok/s(本轮) · 首字 2.3s · 输出 19,630 tok / 生成 110.5s · 17 段 / 峰 224 · ⏱ 15:10:15' > /tmp/q.txt
node -e "const fs=require('fs'),crypto=require('crypto');const q=fs.readFileSync('C:/Users/xiaozi/AppData/Local/Temp/q.txt','utf8');const a=JSON.parse(fs.readFileSync(process.env.USERPROFILE+'/.qoder-cn/plugins/data/token-stats-local/latest.json','utf8')).line;console.log(q===a)"
```

归档内容（`~/.qoder-cn/plugins/data/token-stats-local/latest.json`，`at = 2026-09-20T07:10:22.826Z`）：

- `turnId`：`a3a14ee0-85f2-47e3-b4d2-8275069cb5bf`
- `tokens` 19630 / `reportedOutputTokens` 19630 / `reportedInputTokens` 949594
- `tokenSource`：`reported`（无 `~`，与"开关打开时看不到 `~`"一致）
- `genSeconds` 110.518 / `wallSeconds` 432.25 / `firstTokenMs` 2332 / `segments` 17 / `requests` 17
- `window`：`{promptMs: 1789887783333, boundaryMs: 1789888215722, source: "quote", segmentsTotal: 18}`
- `warnings`：`[]`

`errors.jsonl` **不存在**（`no errors file (good)`）。

关键旁证：`window.source === "quote"` 且 `boundaryMs` 非空，说明 CLI 在运行时**确实从日志里
读到了自己这次的调用**并据此截断——这条链路之前只在外部环境被断言过，现在是在 Qoder 内实测成立。

## 3. 排查中查清的机制细节（正文没写，但决定数字对不对）

命令替 `⏱` 后面那个时间（15:10:15）来自边界，而边界**不是** `tool.requested`。对同一轮日志逐事件统计，
提到 CLI 且带 `--current` 的事件有两条：

| 事件类型 | ts | 与最终边界的差 |
|---|---|---|
| `tool.requested` | 07:10:12.493Z | −3229 ms |
| `tool.shell.started` | 07:10:15.722Z | 0（就是它） |

`quoteBoundary()`（`runtime/stats.mjs:141-150`）取的是**最大值**，所以边界落在 `tool.shell.started` 上。
这不是无关紧要的细节：窗口条件是 `s.end != null && s.end <= boundaryMs`（`runtime/stats.mjs:202`），
而承载本轮正文的那一段（`07:09:53.332 → 07:10:12.530`，4106 tok）结束时间比 `tool.requested` **晚 37 ms**。

- 若边界取 `tool.requested`，这一段会被整体剔除，少 4106 tok；
- 取 `tool.shell.started`（晚 3.2 s），它留在窗口内。

按轮复算与归档完全一致：18 段中 17 段 IN，IN 合计 **19630 tok**，正是 `latest.json` 的 `tokens`。
被排除的是紧随其后的那一小段——即"只写引用块"的回复，**59 tok，占 0.3%**，低于 20% 阈值，
所以 `warnings` 为空。这与"只排除那一小段引用"的说法一致，**说法成立**。

两条路径都取同一个 max，所以仍然逐字节相同——没有正确性 bug，但这个余量很薄：
它依赖一个 shell 派生事件的时间戳，而不是模型那次调用本身。

## 4. 与文档/注释不符之处

**D1 — `realSession` 对新会话第一轮是假阴性，会让不带 `--key` 的 `--current` 指向上一个会话。**
`runtime/prompt-submit.mjs:91` 要求 `transcript_path` 指向一个**已存在**的文件；新会话第一轮提交时
transcript 尚未创建（本轮：prompt 于 15:03:02，transcript 文件 mtime 15:05），所以我的 key 被记成
`realSession: false`。而 `runtime/archive.mjs:172-176` 只在 `realSession` 为真时更新顶层
`sessionId/promptAt`，于是**每个新会话的第一轮都不会更新该指针**。
带 `--key` 的正常链路不受影响（`selectTurn` 在 `archive.mjs:182-190` 不校验 `realSession`）。

**D2 — `stop-stats.mjs` 关于"后台子会话不得覆盖 latest.json"的注释与代码相反。**
`runtime/stop-stats.mjs:70-74` 声明后台子会话 *must not overwrite latest.json*；但 `archiveTurn` 在
`:78` **无条件**调用，`background` 判断在 `:85` 之后、只跳过 stdout；`archive.mjs:229-233` 无条件写
`latest.json`。**这个保护不存在。**
现场证据：当前归档的 `sessionId` 是 `4c79b15a-c51e-425f-beb7-92b649aaf545`（14:56 那一行，29.3 tok/s），
而 `~/.qoder-cn/projects/D--test-qoder-plugin/` 下只有 `7e473992…jsonl` 与 `9762dfc7…jsonl`
两个 transcript——`4c79b15a` 没有 transcript。

**实测复现（2026-09-20 15:17，非推断）：** `history.jsonl` 出现一条不属于我会话的行：

```
2026-09-20T07:17:45.859Z | 0648fa82 | ⚡ 127.2 tok/s(本轮) · 首字 6.3s · 输出 797 tok / 生成 6.3s · ⏱ 15:17:45 | warn= []
```

`0648fa82-d2aa-45e1-ba4f-f34db5727876` 有 segment 日志，但**没有 transcript**（该目录下只有
`7e473992…` 与 `9762dfc7…` 两个 `.jsonl`），即后台子会话。它进了 history 就证明
`archiveTurn` 执行到了写入阶段；而 `archive.mjs:219`（history）→ `:229`（latestMd）→ `:230-233`
（latestJson）是**同一个函数里顺序执行的**，若后两次写失败会抛错并被 `stop-stats.mjs:79-83` 记进
`errors.jsonl`——该文件不存在。因此 `latest.json` 确实被这条 797 tok 的行覆盖，
持续约 27 秒（15:17:45 → 15:18:12 我这一轮 Stop 才覆盖回来）。
悬浮条若在运行，这段时间显示的就是后台 recap 子会话的数字。

**D3 — 0 token 的轮：归档有行、聊天无行。**
`runtime/token-stats.mjs:85` 在 `!turn.tokens` 时静默 `exit 0`；`runtime/stop-stats.mjs:62-68` 只挡
`!turn`，随后照样归档。所以 0-token 轮会进 `history.jsonl`，却永远不会出现在聊天里。
证据：`history.jsonl` 有 2 行 `输出 ~0 tok … 1 段`（`2026-09-19T16:22:46Z`、`16:32:58Z`）。
"归档行和引用行永远逐字节相同"只在两条路径都产出时成立。

**D4 — `last-payload.json` 是无主残留。** 全仓库无任何写入者（grep 为空），mtime `2026-09-20 00:47`，
内容却是 `9762dfc7` 的 Stop payload。它是上一任临时插桩（其 `last_assistant_message` 自述"我加了一行
临时的 payload 抓取（标了 TODO）"）删除后留下的垃圾。

**D5 — 文档给的"搜陈旧钩子失败"命令会误报。** 直接 grep `Plugin directory does not exist` 会命中
**提示词自身的文本**（它被写进了会话日志）；本轮在我会话里命中 6 次，**全部是误报，真实失败 0 次**。
必须按文档后半句加上 `hook.finished` + `plugin_id` 联合条件才可用。

## 5. 尚未闭环 / 无法验证

| 项 | 状态 | 原因 |
|---|---|---|
| 第 2 轮（纯文字轮也有行） | 待用户发起 | 需要一次"除统计命令外零工具调用"的轮次 |
| 第 3 轮（聊天 == 悬浮条 == 归档） | 待用户发起 | 悬浮条当前**未运行**（`Get-CimInstance` 查 `*overlay.ps1*` 只匹配到我自己的查询进程） |
| 第 3 轮 告警真的会出现 | 未验证 | `history.jsonl` 共 44 行，`warnings` 非空者 **0 行**；该路径在真实数据上从未被触发过 |
| 第 4 轮（`--session` 累计行） | 部分 | 已在历史会话上验证 `~` 纪律，见第 6 节 |
| 第 5 轮 另一侧（关掉开关能看到 `~`） | 无法验证 | 需重启 Qoder 进程，会终止本会话；按指示未动环境 |
| D2 的"后台子会话覆盖 `latest.json`" | **已证**（另一等价现场，见 4.D2） | `0648fa82` 无 transcript 却有 history 行，且 `errors.jsonl` 不存在 |
| D2 的"`4c79b15a`（14:56 那行）是后台子会话" | **推断，非已证** | 决定性验证需要抓一次 Stop payload 的 `session_id`/`transcript_path` |

## 6. 顺带完成的其他轮次证据

**第 5 轮 `~` 纪律——通过（逐轮断言，不只看末行）。**
`token-stats --session 9762dfc7-bd0d-4825-ae7b-887b44807dd0 --json`（跨开关会话）：

- `session.tokenSource = "mixed"`，`reportedTurns = 9`，`estimatedTurns = 19`，共 28 轮
- 逐轮断言：`estimated → reportedOutputTokens === 0`，`reported → tokens > 0`
- **violations = 0**

**第 6 轮 沙箱安装/卸载——通过。**
`QODER_HOME=%TEMP%\ts-verify`，`install --expose-token-usage` 后 `uninstall`：

- `installed_plugins_v2.json` → `{"version":2,"plugins":{}}`（key 已移除）
- `settings.json` → `{"enabledPlugins":{}}`
- `plugins/cache/local` **已删除**
- 残留仅 `.bak`（文档承诺保留）与两个空目录
- 沙箱内打印 `skipped QODERCN_EXPOSE_TOKEN_USAGE: this run targets …\ts-verify`
- 真实 `HKCU\Environment` 仍为 `1`；真实注册表里 `token-stats@local` 仍在

## 7. 第 2 轮判定：通过（无工具轮）

用户问了一个纯文字问题（"用一句话解释 tok/s 是什么"），该轮除末尾的统计命令外**没有调用任何工具**。
按 `tool.requested` 事件逐个统计该轮（`turnId = fd06eb7f-bc8b-4915-ba84-9ac67b1219d6`）：

```
events in turn = 28 | tool.requested = 1
  tool call #1  ts=2026-09-20T15:17:55.557+08:00  node "…token-stats.mjs" …
tool names = ["Bash"]
assistant segments = 2 | response.completed = 2
```

- 工具调用清单**恰好 1 条**，就是统计命令本身——"除统计命令外为空"成立。
- 引用行 `⚡ 135 tok/s(本轮) · 首字 4.0s · 输出 546 tok / 生成 4s · ⏱ 15:18:10`
  与归档行**逐字节相同**：均 59 字符，sha256 前 16 位 `4308a24ded75ef18`。
- `window = {promptMs: 1789888671413, boundaryMs: 1789888690301, source: "quote", segmentsTotal: 2}`
  —— 2 段中只计 1 段，被排除的是"只写引用块"的那一段。

## 8. 第 4 轮核对

`--session 7e473992…` 文本行（无 `~`，与开关打开一致）：

```
会话累计 172.9 tok/s · 48401 tok / 280s · 31 段 / 峰 236.7 · 4 轮
token 来源: 服务端上报（真实值）
```

`--json` 逐轮：4 轮全部 `reported`，`estimatedTurns = 0`，每轮 `warnings = []`，
`tokenSource === "reported"` 时 `tokens > 0` 全部成立。`errors.jsonl` 不存在。

补充观察：`--session` 的"本轮"行在使用期间是**正在进行的这一轮**（`source: "end"`），
所以它的数字会随着工具调用增长——上表 4439 tok / 3 段即本轮中途的快照，不是终值。
