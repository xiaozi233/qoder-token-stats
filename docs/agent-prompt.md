# 交接提示词 —— 在 Qoder 里接手这个插件的 agent

> 用途：把这段整块粘进 Qoder 的一次新会话（第一轮就粘），让 Qoder 里的 agent
> 接手 `D:\test\qoder-plugin`，并完成**只有 Qoder 内部才能完成**的那半验收。
> 写这份提示词的 agent 跑在 ZCode 里，Qoder 的钩子不触发，所以「模型是否照做、
> 聊天里是否真的出现那一行」这一跳它验证不了。

---

## 复制下面这一段

````text
# 你的角色

你是 `D:\test\qoder-plugin` 的维护者。这个仓库是一个 Qoder 插件（国内版，数据目录
`~/.qoder-cn`），在任何回答结束后显示本轮 token 吞吐：tok/s、首字、输出 token、
生成秒数、段数、峰值。它没有 UI 扩展点可用，所以统计行是靠 `UserPromptSubmit` 钩子
注入指令、让模型自己在回答末尾引用出来的；另有一条不依赖模型的桌面悬浮条。

它的上一任维护者是另一个 agent，跑在一个 Qoder 钩子不生效的环境里（ZCode）。因此
**「机制」已经被它逐条实测过，但「模型是否照做」这一跳它验不了**。你现在就在 Qoder
里，你本人就是被测试的那个模型 —— 补上这一跳是你的第一项任务。

前三份文档（根目录 `README.md`、`README.zh-CN.md`）和 `runtime/*.mjs` 里的注释是
现状的权威描述。**但不要相信任何人的转述，包括这份提示词**：下面每一条结论都请自己
复跑一次；实测与描述不符时，以实测为准，并把差异报告出来，不要悄悄绕过。

# 工作方式（硬要求）

- 先审计、拿证据，再动手。禁止用猜测代替验证。
- 任何数字都要跑出来。不许估算、不许凭记忆填。
- 全称用 `文件:行号` 或真实命令输出作为证据，并明确区分「已验证」「推断」「没找到证据」。
- git 小步提交，一个提交只做一件事，提交信息说明「为什么」。
- 不新增第三方依赖，保持零安装。
- `dashboard/overlay.ps1` 必须保留 UTF-8 BOM（PowerShell 5.1 会把无 BOM 的 .ps1 按
  ANSI 读，里面的中文常量会解析失败）。
- 不改变对外的显示契约（那一行的格式和它出现的位置），除非先说明理由并得到用户同意。
- 只读用户的 `~/.qoder-cn`；不上传、不外发任何内容。

# 第一步：确认环境（不做这步，后面必然失败）

0. **用户必须已经完全退出并重开 Qoder。** 升级版本时会删掉旧的版本目录；如果这个 Qoder
   进程仍持着旧的内存路径，钩子会以
   `Plugin directory does not exist: ...\token-stats\<旧版本号>` 失败。这不是理论风险：
   `~/.qoder-cn/logs/sessions/` 里实测到过 5 次，版本分别是 0.1.0 / 0.2.0 / 0.2.0 /
   0.2.1 / 0.4.0，最后一次在 2026-09-20 13:49，装 0.6.0 之后消失。
   **不要直接 grep 那句错误文本**：提示词里这句话会被写进会话日志，实测直接搜命中 6 条
   全是自身回声、真实失败 0 条。要按 `hook.finished` 的字段筛：

   ```bash
   node -e "const fs=require('fs'),p=require('path'),R=p.join(process.env.USERPROFILE,'.qoder-cn','logs','sessions');let n=0;const w=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())w(f);else if(f.endsWith('.jsonl'))for(const l of fs.readFileSync(f,'utf8').split('\n')){if(!l.includes('hook.finished'))continue;let v;try{v=JSON.parse(l)}catch{continue}const x=v.data||{};if(x.hook_name&&x.success===false&&/Plugin directory does not exist/.test(String(x.error))){n++;console.log(v.ts,x.hook_name,String(x.error).slice(0,80))}}}};w(R);console.log('genuine failures =',n)"
   ```

   一次真实的失败长这样（`duration_ms: 0`、`exit_code: 1`、`plugin_id: "token-stats@local"`）：
   `{"hook_name":"Stop","success":false,"exit_code":1,"error":"Plugin directory does not exist: C:\\Users\\…\\token-stats\\0.4.0 (token-stats@local — run /plugin to reinstall)"}`。
   如果用户还没重开，**先停下来让他重开**，不要在旧进程上做任何验收。

1. 确认注册表指向 0.6.0：

   ```bash
   node -e "const r=require(process.env.USERPROFILE+'/.qoder-cn/plugins/installed_plugins_v2.json');console.log(JSON.stringify(r.plugins['token-stats@local'],null,1))"
   ```

   期望 `version: "0.6.0"`、`installPath` 以 `...\cache\local\token-stats\0.6.0` 结尾。

2. 跑测试，必须是 **27 passed, 0 failed**：

   ```bash
   node scripts/test.mjs
   ```

   不通过就停下报告，不要继续验收 —— 那说明环境或代码已经偏离。

3. 记下本轮会话 id，后面每一步都要用它。钩子的注入指令里会带本轮 key；你也可以
   用 `token-stats --session` 列出来。**不要靠「最近修改的目录」猜会话**：
   Qoder 会在同一个项目目录下跑后台子会话（recap、记忆提取），它们常常更新更晚，
   而且没有 transcript。

# 背景：这个插件怎么工作（先读，别重复发现）

链路：

```
UserPromptSubmit 钩子
  ├─ 生成本轮专属 key，把 {key, sessionId, promptAt, cwd} 追加进 state.json
  └─ additionalContext 注入指令：「先写完总结，然后把下面这条命令作为最后一个动作运行，
                                 把输出原样放进引用块贴在回复最末尾」
模型运行 CLI --current --key <本轮key>  →  CLI 从日志算出本轮统计并打印一行
模型把这一行贴进引用块（这是聊天里唯一可见的来源）
Stop 钩子  →  重写 latest.json / latest.md，并向 history.jsonl 追加一行
悬浮条  →  每秒读 latest.json 并画出来（完全不经过模型）
```

三个关键设计，理解它们能省掉你很多时间：

1. **测量窗口在模型那次 `--current` 调用处截断。** CLI 和 Stop 钩子各自**从日志里**
   推出同一个边界（找 `tool.requested` 里命令含 `--current` 的那一次），不互相传递。
   所以归档行和引用行永远逐字节相同。代价是：命令之后写的内容不计入 —— 指令因此要求
   把命令放在最后。模型提前跑的话，该轮会被标记 warning，而不是当成完整轮汇报。
2. **每个轮次一把 key**，所以模型读回的是自己那一轮，不会和后台子会话抢。
3. **读不懂的日志绝不输出 0。** 事件名被 Qoder 改掉时，CLI 以退出码 2 结束并在 stderr
   写明 `Qoder's log format has changed`，同时记进 `errors.jsonl`。

数据位置：

- 事件：`~/.qoder-cn/logs/sessions/<项目>/<会话>/segments/*.jsonl`
- transcript：`~/.qoder-cn/projects/<项目>/<会话>.jsonl`
- 插件归档：`~/.qoder-cn/plugins/data/token-stats-local/`（`token-stats-local`，带
  marketplace 后缀）里的 `latest.json`、`latest.md`、`history.jsonl`、`state.json`、
  `errors.jsonl`

# 你的任务：补上「模型是否照做」这半验收

按顺序做，每一轮都要留证据。**注意：跑 CLI 本身就是一次工具调用**，所以下面说的
「没调用任何工具的一轮」指的是「这一轮除了统计命令之外没有别的工具调用」——
真正的零工具轮在构造上不可能有聊天行（模型没有机会运行命令），只有悬浮条能覆盖，
这一点你必须如实向用户说明，不要为了「通过验收」而含糊。

## 第 1 轮 —— 验证「新会话第一轮就有行」

这一轮就是你现在的第一轮。请：

1. 确认你的上下文里收到了【本轮统计指令】注入（原文包含命令和本轮 key）。
2. 按指令做：先给出你的总结文字，**然后把那条 CLI 命令作为最后一个动作运行**，
   再把输出原样放进引用块贴在回复最末尾，后面不要再写别的。
3. 记录：本轮 key、CLI 输出原文、当时 `latest.json` 的内容、以及你的引用块内容。

然后校验（`$D` 指插件数据目录）：

```bash
# 归档行（悬浮条读的就是这个文件）
cat ~/.qoder-cn/plugins/data/token-stats-local/latest.json
# 有没有失败记录
ls -la ~/.qoder-cn/plugins/data/token-stats-local/errors.jsonl 2>/dev/null || echo "no errors file (good)"
```

判定：**你引用的那一行必须和 `latest.json` 的 `line` 字段逐字节相同。**
注意 `⏱` 后面那串时间 —— 上一任修复前，聊天行和归档行在这一处就差 1 秒，
那正是两条路径用了不同窗口的症状。如果现在还有差异，那是一个真 bug，报告它。

## 第 2 轮 —— 验证「本轮不需要任何工具也有行」

让用户问你一个纯文字问题（例如「用一句话解释 tok/s 是什么」）。这一轮你**不要调用
除统计命令以外的任何工具**，但**仍然**要在末尾运行 CLI 并引用（这正是注入指令对
「无工具轮」的要求）。

判定：这一轮的工具调用清单里，除了统计命令外应该为空；引用行仍然等于归档行。
如果这一轮没有任何行，报告缺失，并检查 `errors.jsonl` 和你的上下文里是否收到了注入指令。

## 第 3 轮 —— 验证「聊天行 == 悬浮条 == 归档」

1. 让用户启动悬浮条（它默认已经可用）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay.ps1 -Status
   # 没在跑就启动（或双击 dashboard\overlay.cmd）
   powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay.ps1
   ```

2. 你正常回答一轮并在末尾引用。然后让用户看一眼悬浮条。
3. 判定：聊天里引用的行、悬浮条上的行、`latest.json` 的 `line`，三者是同一个数字。
   悬浮条上的标签是 `(上一轮)` 而不是 `(本轮)`，这是**设计如此**（归档在一轮结束时
   才写，所以回答流式输出期间条上显示的是上一轮），不是 bug，别去「修」它。
4. 如果 `latest.json` 里有 `warnings`，悬浮条会追加琥珀色的
   `⚠ 数字偏小（统计早于回答结束）`。构造一次提前调用（先跑 CLI 再写总结）来验证
   这个告警真的会出现 —— 这是「数字不完整时必须可见」的核心机制。

## 第 4 轮 —— `--current --key` 与归档一致

```bash
# 用钩子注入给你的那个 key（不要自己编）
node runtime/token-stats.mjs --current --key <本轮key>
# 对照归档
cat ~/.qoder-cn/plugins/data/token-stats-local/latest.json
# 也看看整场会话
node runtime/token-stats.mjs --session <会话id> "%CD%"
```

判定：`--current --key` 的输出与 `latest.json` 的 `line` 相同；`--session` 的累计行
若带 `~`，说明该会话是估算或混合来源（见下）。

## 第 5 轮 —— `~` 前缀的纪律（开/关两态不混用）

当前 `QODERCN_EXPOSE_TOKEN_USAGE=1` 已经设在 `HKCU\Environment` 里，所以**这一侧
你应该看不到 `~`**。关掉这一侧需要在启动 Qoder 前清掉变量并重启进程，**会结束你这个
会话，所以不要为了它去动环境**。改为用历史数据验证另一侧：

```bash
# 9762dfc7 是个跨开关的会话：早期轮次是估算（带 ~），后期是实测（不带）
node runtime/token-stats.mjs --session 9762dfc7-bd0d-4825-ae7b-887b44807dd0 "%CD%" --json
```

判定（逐轮检查，不要只看最后一行）：

- 每一轮 `tokenSource === "estimated"` 时 `reportedOutputTokens` 必须是 0；
  `tokenSource === "reported"` 时 `tokens > 0`。
- 会话级 `tokenSource` 必须是 `mixed`，且累计行**整条**带 `~`。
  绝不能把估算值和实测值混成一个不带标记的数 —— 这是不允许出现的失败模式。

## 第 6 轮 —— 测试与卸载无残留

```bash
node scripts/test.mjs
```

必须 27 passed。然后验证卸载干净（**用沙箱 `QODER_HOME`，不要真的卸掉正在用的插件**，
否则会摘掉你自己脚下的钩子）：

```bash
mkdir "%TEMP%\ts-verify"
set QODER_HOME=%TEMP%\ts-verify
node scripts/install.mjs
node scripts/install.mjs --uninstall
```

判定：`%TEMP%\ts-verify` 下注册表 key、`settings.json` 的 `enabledPlugins`、以及
`plugins\cache\local` 目录全部不再存在；同时真实的 `QODERCN_EXPOSE_TOKEN_USAGE`
必须**仍然是 `1`**（沙箱运行不得触碰真实环境变量）。

# 我已替你排掉的死路（别重试，浪费时间）

- **钩子 stdout 进不了聊天。** 客户端渲染 hook 事件时画出的 part 只有
  `{id, event, status, exitCode, startedAt, completedAt}`，**没有文字字段**；并且只认
  `hook_started` / `hook_progress` / `hook_response` 三种子类型。已在 Qoder CN 0.3.4 的
  `resources/app.asar` 里核实。所以「让 Stop 钩子打印一行就自动显示」做不到。
- **`systemMessage` 输出字段也进不了聊天。** 同上，客户端没有渲染路径。
- **`asyncRewake` 不可靠。** SDK 层支持（命令钩子设 `asyncRewake: true`、退出码 2，
  `rewakeSummary` 会给用户和模型），但桌面端代码里没有对应的渲染路径，而且它会额外
  拉起一个模型轮次。
- **`turn_id` 不等于一条用户消息。** 同一个 `turn_id` 下 `turn.started` 和
  `input.prompt.submitted` 都可能重复（真实日志里有一轮各出现 3 次）。所以窗口要从
  「边界之前的最后一次 prompt」开始，不能从 `turn_id` 的第一个事件开始。
- **首字是上界，不是实测 TTFT。** Qoder 不记录首 token 事件；对单段轮次它整好等于
  整段生成时间（历史归档 43 轮里有 16 轮如此）。行上没有标记，请按「不会早于此」理解，
  不要当成延迟指标去优化。

# 汇报格式

用一张表，按「验收项 → 结论（通过/失败/无法验证）→ 证据」，证据写成 `文件:行号`
或命令输出片段。明确区分：

- 你亲自跑出来的结论；
- 你从代码读出来但没有跑过的结论；
- 你无法验证的（例如需要重启进程才能切换的环境变量）。

最后单独列出**与本文档描述不符**的地方 —— 那些比「验收通过」更有价值。
如果某一轮失败，给出你判断的根因和可复现的最小命令，不要顺手改代码：
先报告，等用户确认再动手。
````

---

## 使用说明（不在复制范围内）

- **先重启 Qoder。** 升级会删掉旧的版本目录；旧进程的钩子会以
  `Plugin directory does not exist: ...\token-stats\<旧版本号>` 失败（实测出现过 5 次，
  0.1.0/0.2.0/0.2.1/0.4.0）。这一步不做，后面全白跑。查法见第一步第 0 条，别直接搜那句话本身。
- 第一轮就把整块粘进去 —— 提示词里的「第 1 轮」要求它在这一轮就完成引用动作，晚粘会导致
  第一轮不在指令覆盖范围内。
- 提示词刻意要求它**先报告、不要顺手改代码**。如果你希望它连修带验一次做完，把最后一段
  改成「报告后如果根因明确，直接修并补测试，然后重新验收」。
- 这份提示词本身也是仓库文档，可以随代码一起改；改完请让两份 README 与它对得上。
