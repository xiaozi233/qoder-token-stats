# 第 1 轮验收报告

- 日期：2026-09-20
- 环境：Qoder CN（`~/.qoder-cn`），插件 `token-stats@local` 0.6.0
- 会话：`7e473992-2488-4920-85c3-73f905938266`，`cwd = D:\test\qoder-plugin`
- 本轮 key：`05e4a1589603`
- 执行者：**被测试的模型本人**（在 Qoder 内跑，非外部复现）

结论速览：**环境闸门通过；第 1 轮、第 2 轮通过**（引用行与归档行逐字节相同）。第 3 轮的三方
一致性**失败**，根因是 D2（`latest.json` 被后台子会话抢占，不是窗口分歧）；6 处与文档/注释不符
的地方见第 4 节，其中 D1/D2/D3/D4/D5/D6 已修，见第 10 节。

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

**D6 — 文档第 0 步举的版本号是错的。** 它说失败发生在 `...\token-stats\0.5.0`。按
`hook.finished` 事件的字段筛（`success === false` 且 `error` 含该文本），全量日志里真实失败
**5 次**，cache 版本分别是 **0.1.0 / 0.2.0 / 0.2.0 / 0.2.1 / 0.4.0**——没有一次是 0.5.0。
时间跨度 `2026-09-20T00:26:52` → `13:49:13`，均为 `Stop` 钩子、`exit_code: 1`、`duration_ms: 0`。
最后一次在 13:49，注册表 `lastUpdated` 为 14:48（本地），此后消失；我会话内 0 次。
所以文档第 0 步的"先重启"要求是**有真实依据的**（同一失效模式反复发生过 5 次），只是例子版本号写错了。

## 5. 尚未闭环 / 无法验证

| 项 | 状态 | 原因 |
|---|---|---|
| 第 2 轮（纯文字轮也有行） | 待用户发起 | 需要一次"除统计命令外零工具调用"的轮次 |
| 第 3 轮（聊天 == 悬浮条 == 归档） | **失败**——根因 D2，不是窗口分歧（已修，见第 10 节；已确认，见第 12 节） | 见第 9 节 |
| 第 3 轮 告警真的会出现 | **已验**（见第 12 节） | 本表填写时 `history.jsonl` 50 行里 `warnings` 非空者为 **0**——那时确实从未触发过 |
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

## 9. 第 3 轮判定：聊天行 == 归档行通过，聊天行 == 悬浮条失败

悬浮条已启动（`overlay.ps1 -Status` → `running (pid 34524)`）。它的渲染规则（`dashboard/overlay.ps1:274-292`）：
读 `latest.json`；把 `(本轮)` 替换成 `(上一轮)`；整行含 `⏱` 都显示；`warnings` 非空时追加
`  ⚠ 数字偏小（统计早于回答结束）` 并改用琥珀色 `#FFE8A33D`；归档超过 600 秒转暗色。
`(上一轮)` 是设计如此（`overlay.ps1:281-282`），**不是 bug**。

**通过的部分：** 我上一轮的引用行与 `history.jsonl` 里属于我这一轮的那一行**逐字节相同**
（均 sha256 前 16 位 `d2e71cd22504c245`）。也就是说两条独立计算路径没有分歧——
窗口机制本身是好的。

**失败的部分：** 核对时 `latest.json` 已被**另一个会话覆盖**：

```
at = 2026-09-20T07:23:17.743Z   sessionId = 834cc38f-f77f-4e9c-b53f-edd649399c72
line = ⚡ 200.5 tok/s(本轮) · 首字 4.8s · 输出 972 tok / 生成 4.8s · ⏱ 15:23:17
```

`834cc38f` 有会话目录、**没有 transcript**，是后台子会话；它在 07:23:17.743Z 覆盖了
`latest.json`，距我上一轮归档（`07:22:24.657Z`）只差 **53 秒**。因此悬浮条此刻显示的是这条
972 tok 的行，而不是我的 11,253 tok。

**量化（`history.jsonl` 全部 50 行）：**

- 20 个不同会话，其中 **14 个没有 transcript**（后台子会话），各贡献 1 行
- 后台子会话贡献的归档行 = **14 / 50 = 28%**
- `latest.json` 与 `history.jsonl` 的**最新一行**逐字段相同（同 `at`、同 `line`），
  即 `latest.json` 只是"最新一行"的镜像

**结论：** 文档断言的"聊天行 == 悬浮条 == 归档"只在**期间没有后台子会话结束**时成立；
实际不变量是"聊天行 == `history.jsonl` 中我这一轮的行"。两者分离的根因是 D2——
`stop-stats.mjs` 想挡却没挡。所以第 3 轮的失败**不是**窗口分歧，而是 `latest.json` 被抢占。

**给用户的目视核对项：** 悬浮条此刻应显示
`⚡ 200.5 tok/s(上一轮) · 首字 4.8s · 输出 972 tok / 生成 4.8s · ⏱ 15:23:17`（无告警后缀）。
若确实如此，说明**渲染链路是忠实的**，错的是它读的那个文件。

## 10. 修复（2026-09-20）

改了 4 个运行时文件 + 2 份文档；测试 **27 → 32 passed, 0 failed**（第 12 节后又补了一条
"告警必须落进归档"的端到端测试，**最终 33 passed**）。
每一处都做了**变异验证**：先把修复临时改回旧行为，确认对应测试确实失败，再改回。
（不这么做就不知道新测试有没有牙齿。）

| 问题 | 改法 | 变异验证 |
|---|---|---|
| D2 | `stop-stats.mjs` 改用「transcript 文件**是否真实存在**」代替「字段是否存在」；`archiveTurn` 新增 `writeLatest`，后台轮只追加 history，不写 `latest.json`/`latest.md` | `writeLatest: realSession` 改回 `true` → `a background sub-session does not take the overlay from the user` 失败 |
| D3 | `stats.mjs` 新增 `measurable(turn)`，CLI 与 Stop **共用同一个判定**；无 tokens / 无段 / 无窗口内段时不打印也不归档，并记 `stop:nothing-measured` | `measurable` 改成 `Boolean(turn)` → 两条 nothing-measured 测试失败 |
| D1 | `archive.mjs` 新增 `selectCurrentTurn`：无 `--key` 时在**读取时**重查 transcript 归属，不再相信提示时刻写的 `realSession` | 改回旧的 `state.promptAt` 逻辑 → `a keyless --current ignores a newer background entry` 失败 |
| D4 | 删除 `~/.qoder-cn/plugins/data/token-stats-local/last-payload.json`（2758 B，全仓库无写入者） | — |
| D5 | `docs/agent-prompt.md` 两处：给出按 `hook.finished` 字段筛的**已实测**命令，并写明不要搜那句错误文本本身 | 该命令实测输出 5 条真实失败 |
| D6 | `docs/agent-prompt.md` 第 0 步：版本号例子改成真实的 0.1.0 / 0.2.0 / 0.2.1 / 0.4.0，并注明实测 5 次 | 同上 |
| 注释 | `stats.mjs` 的 `quoteBoundary` 注释补上：边界实际取 `tool.shell.started`，这份"迟到 3.2 秒"正是承载答案的那一段得以留在窗口内的原因 | — |

顺带：`findTranscript` 从 `stats.mjs` 上移到 `schema.mjs`（路径知识集中一处），删掉了重复的查找实现。

**部署**：`node scripts/install.mjs`（不带 flag，未触碰环境变量），**同版本 0.6.0 原地覆盖**——
故意不升版本号，因为升版本会删掉旧版本目录，正是 D6 那个失效模式的成因。
已用**插件缓存里的副本**（不是仓库副本）复跑两态：真实会话打印并占据 `latest.json`；后台轮
（`transcript_path` 给了但文件不存在）不打印、且 `latest.json` 逐字段不变；history 两行都在。

**后续（同一天，按维护者要求）**：升到 `0.6.1`——改 `plugin.json` 与 `docs/agent-prompt.md`
里的期望版本，跑 `install.mjs` 完成替换。所以上面那句"故意不升版本号"只描述当时那一次部署，
不代表最终决定；它的理由（升版本会删旧目录，需要完全重开 Qoder）在升级时依然成立。

## 11. 升级到 0.6.1 之后的回验

重启后钩子注入的路径已是 `...\token-stats\0.6.1\runtime\token-stats.mjs`，注册表与缓存目录也只剩 0.6.1。

**D6 被我自己触发了一次——升级前说明过的代价，如期发生且只发生一次。**
`2026-09-20T15:48:12.070` 的 Stop 钩子失败：

```
{"hook_name":"Stop","source":"plugins","success":false,"duration_ms":1,"exit_code":1,
 "error":"Plugin directory does not exist: …\\token-stats\\0.6.0 (token-stats@local — run /plugin to reinstall)",
 "plugin_id":"token-stats@local","plugin_root":"…\\token-stats\\0.6.0"}
```

真实失败总数 5 → **6**：跨 6 次版本替换，每次恰好约 1 次，之后自愈（本次之后无新增）。
所以"升版本会打断钩子"是**有界**的，不是持续性的。

**代价是一次静默丢轮。** 那一轮（我引用的是 `⏱ 15:48:09`）在归档里**不存在**：
`grep -c "15:48:09" history.jsonl` = **0**，`latest.json` 也仍停在 15:44:54。
于是"**聊天有行、归档没有**"这种反向不对称是真实存在的，成因是钩子压根没执行——
与 D3 的方向正好相反，两者都不是"数字不对"，而是"行该不该存在"。

**D7（新发现）— 这类失败在 `errors.jsonl` 里查不到。** 插件没被执行，自然写不了自己的日志；
Qoder 只把它记在会话日志的 `hook.finished` 里。所以"没有 `errors.jsonl`"**不能**推出"没有失败"。
要查必须用第 4 节 D5 那条按字段筛的命令。

**D2 修复的现场确认。** `61b8b093`（无 transcript 的后台会话）在 `15:45:44` 照旧进了 history，
但 `latest.json` 仍是我这一轮的 `15:44:54` 行。修复前，这条 709 tok 的后台行会把它顶掉——
8 分钟内至少两次后台轮（`15:42:41` 的 `052047c0`、`15:45:44` 的 `61b8b093`）都没有再抢走悬浮条。

**D1 修复的现场确认。** `state.json` 里本轮 key `634901cf43fd` 的 `realSession` 是 **true**
（该会话已有 transcript），顶层 `sessionId` 也随之更新为 `7e473992`；而 `49a19ac1bffd`
（`session=61b8b093`，后台）是 `false`。会话首轮的假阴性不再是常态。

**窗口规则本身没改——而且后来想清楚了：不能改。** 我一度提议把判决条件从"段在边界前**结束**"
改成"在边界前**开始**"，理由是那样对边界事件的选择不敏感。**那个提议是错的**：CLI 运行时，
正在飞行中的那一段还没有 token，而 Stop 钩子稍后看到同一段已经完成、带上了真实 token；按开始
时间算会让两条路径得出不同的数，**逐字节一致**就此失效。当前条件（只算边界前已结束的段）是让
两条独立路径得出同一个数的唯一选择，所以钉住不动，并在 `runtime/stats.mjs:205-211` 写明原因，
避免后来者（包括我自己）再提一遍这个错提案。

## 12. 提前调用实验：告警在真实环境里成立（2026-09-20 16:03）

做法：本轮**先把统计命令跑掉**（16:03:48），再写总结，故意违反"命令放最后"。

| 项 | 值 |
|---|---|
| 早调用那行 | `⚡ 184.3 tok/s(本轮) · 首字 19.4s · 输出 3,588 tok / 生成 19.5s · ⏱ 16:03:48` |
| 归档行 | 同上，**逐字节相同**（sha256 前 16 位 `8dc06af26c47a7db`） |
| `warnings` | `["统计命令在本轮结束前 16s 就被调用，漏掉 2908 tok（约 45%）——应把该命令作为最后一个动作"]` |
| `window` | `source: "quote"`，`segmentsTotal: 2`（1 段计入、1 段判为漏掉） |
| 被排除份额 | 2908 / 6496 = **约 45%**，> 20% 阈值 → 告警成立 |
| `latest.md` | 多出 `- ⚠ …` |
| 带告警的 history 行 | **1 / 63**（此前 59 行里 0 行）——历史上第一条 |
| `errors.jsonl` | 不存在 |

所以告警在真实环境里**确实会出现**，且"提前调用"的代价被量化：本轮真实总量 6,496 tok，
早调用只报出 3,588（残值 45%）。两行仍逐字节相同——差异只在告警。

**本轮暴露的两条结论比"告警能画出来"更重要：**

**D8 — 告警在聊天里不可见。** `formatTurnLine` 只输出数字行；`warnings` 只进归档、`latest.md`、
悬浮条和 `--session` 的 stderr。引用到聊天的那一行与归档行逐字节相同，所以**只看聊天的人
无法察觉自己拿到的是残值**。两份 README 已写明。

**D9 — 那次提前调用自己不可能报出告警。** 调用那一刻，被它跳过的工作还没发生，
`excludedTokens` 为 0，判定条件 `excludedTokens / totalTokens > 0.2` 无从成立。告警本质是
**事后**判定，只能由 Stop 钩子（或更晚的 `--session` 查询）给出。两份 README 原文说
"CLI 往 stderr 写 warning"，对 `--current` 这条路径并不成立，已改。

**目视确认（维护者本人）：琥珀色成立。** 观察窗口是 `16:04:04`（告警行写入 `latest.json`）
到 `16:11:18`——而且这个窗口意外地长，原因见下面的 D10。看到的确实是真实数据，
没有为了看颜色而伪造过任何行。

**D10 — "少一行"有两种成因，日志能分开。** 上一轮（边界 `⏱ 16:08:20`）没有留下归档行，
也没有覆盖 `latest.json`。查日志：`16:04:04.387 Stop token-stats@local success=true exit=0 dur=498ms`
是最后一次 Stop；之后就**再没有 Stop 事件**，下一批是 `16:11:18 QueryEnd:error`。即那一轮
**以错误结束**，Qoder 走 `QueryEnd:error` 而不触发 Stop。所以：

- 钩子**执行了但失败** → `hook.finished` 里 `success: false`（D6/D7 那一类）；
- 整轮**出错收尾** → `QueryEnd:error`，Stop 压根不触发，`errors.jsonl` 同样为空；
- 正常收尾 → `QueryEnd:end_turn` + `Stop`。

这两类都不会在 `errors.jsonl` 留痕，而"没有 `errors.jsonl`"曾被当成健康的证据——**它不能**。

## 13. 升级到 0.6.2 之后：一次如期发生的丢行，和 D11 的机制

**升级的代价如期发生，这是第二次。** `0.6.1` → `0.6.2` 的目录替换让 `16:40:36.878` 的 Stop 钩子
失败（`Plugin directory does not exist: …\token-stats\0.6.…`，`plugin_root` 指向已删目录），
插件目录失败总数 **6 → 7**。于是 `⏱ 16:40:27` 那一轮没有归档行
（`grep -c "16:40:27" history.jsonl` = **0**），`latest.json` 仍停在 `16:38:57`。

**⚠ 上一条结论已被推翻（本节初稿说"每次替换恰好约 1 次、之后自愈——代价有界且可预期"，那是错的）。**
`0.6.2` → `0.6.3` 之后实测到失败与成功**交错**出现：

| 时刻 | 钩子 | 结果 |
|---|---|---|
| 17:07:13 | Stop | **失败**（0.6.2） |
| 17:08:01 | UserPromptSubmit | 成功（431ms） |
| 17:08:06 | Stop | 成功（272ms） |
| 17:09:13 | UserPromptSubmit | **失败**（0.6.2） |

插件目录失败总数 **7 → 9**。所以它不是"下一轮重新解析就自愈"，而是**间歇性**的：有东西按注册表
重新解析，另一样东西仍持着旧路径。按轮计数不成立。
（这同时给 `0.2.0` 连**连续两轮**都失败提供了合理解释——之前我把那条记为"未被模型解释的异常"。）

**后果比"少一行归档"更重**：`17:09:13` 失败的正是**那一轮的 UserPromptSubmit**，于是
① 该轮没有任何注入指令；② `state.json` 里没有该轮的 key（最新一条是另一会话的）。
**这一轮连统计行都不会有**，而且会间歇命中直到重启进程。

因此**推迟删除的修法（第 13 节末）价值上调**：它省下的不是一轮归档，而是"重启之前一直间歇丢"。

**D11 — `--current` 会静默空输出，而调用者无法区分两种含义。**
实测：同一 key 连调三次，第一次**空输出**，后两次正常（16:40:10、16:40:27）。
从日志事后复算第一次调用（边界 `16:39:57.487`）那一刻的窗口：

| 段 | 起始 | 时长 | tok | end ≤ 边界 | rated(≥0.2s) |
|---|---|---|---|---|---|
| #2 | 08:39:43.874 | **0.00s** | 970 | **是** | 否 |
| #3 | 08:39:51.243 | 6.26s | 876 | 否（晚 **16 ms**） | 是 |
| #4 | 08:39:58.054 | 12.60s | 2279 | 否 | 是 |

那一刻 inWindow 只有 #2，而 `segments` 只数 ≥0.2 秒的段 → **segments = 0** →
`measurable()` 为假 → 静默 `exit 0`。所以空输出**不是**故障代码，是守卫按设计工作。

但它暴露了一个真问题：**"这轮确实没有可测内容"和"这轮的内容还没成形"对外是同一件事——空输出。**
这正是本插件最想消灭的那类含糊（"读不懂"与"没有"必须分开），现在多出第三种。
注意 #3 只比边界晚 **16 毫秒**结束——与第 3 节"晚 3.2 秒的边界救了答案段"是同一个刀刃的两面。

**为什么不能靠加宽边界来修。** 直觉方案是把 `end ≤ boundaryMs` 放宽为 `end ≤ boundaryMs + 宽限`。
**不行**：落在 `(boundary, boundary+宽限]` 之间的段在 CLI 运行时**还没有 `response.completed`**，
于是 CLI 侧排除、Stop 侧收入——两条路径算出不同的数，逐字节一致就此失效。
理由与第 12 节记录的是同一个。

**可选修法（已实施，见下）。** 窗口与数字完全不动，只在"轮次存在但无 rated 段"时往
**stderr** 写一行说明（stdout 与归档都不变）。调用者便能区分两种空，且不碰任何对外数字。
频度：正常用法（命令放在最后）不会触发——那时前面已有多个 rated 段；它只在命令紧跟一个
不足 200 毫秒的段时出现，本轮我就是这样撞上的。

**D11 修法（已提交，未部署）**：`--current` 现在分四种原因往 stderr 说明——轮次不存在、
无 output token、窗口内段尚未收尾、窗口内段全部短于 200 毫秒。另外，**带 `--key` 却查不到该 key**
也会说明（无 key 时不说明，因为"没有 state"不值得报）。stdout 与归档一字未动。
测试 33 → **34 passed**；变异验证：把两句说明的文字抹掉，**恰好**这两条测试变红。

**钩子为什么会失效——根因在安装顺序。** `scripts/install.mjs` 在 `:146-148` **先删旧版本目录**，
`copyDir` 在 `:150`，写注册表在 `:166`。于是从删除那一刻起，注册表指向的路径**已经不存在**：
宿主机在这一轮里解析到的钩子路径必然失效。这解释了失败的两个特征：

- **为什么恰好一次**：失败落在"做替换的那一轮"，下一轮重新解析就拿到新目录；
- **为什么总数等于替换次数**：跨 3 次替换 7 次失败，几乎一一对应。

一个未被该模型解释的异常：`0.2.0` 曾在**连续两轮**各失败一次（00:30:23、00:32:07）。
按"每轮重新解析"解释不通，可能是当时连着做了两次替换、或注册表晚于目录更新——**我没有证据，
不下结论**。

**要根治**得让旧目录活到不再被引用为止，也就是**把删除推迟**（例如下一次安装时才清理过期版本目录）。
代价是缓存里暂时多留一个旧版本目录。这一步会改变安装/卸载的语义，**未实施，等你定夺**。

