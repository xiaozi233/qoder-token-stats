# Qoder Token Stats

English | [简体中文](README.zh-CN.md)

A Qoder plugin that reports per-turn token throughput after every reply, in the
same shape as the app's status line:

```
⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 3,389 tok / 生成 60.6s · 45 段 / 峰 84.6 · ⏱ 19:24:51
```

No session cumulative figure on this line: across a flag flip it would add estimated
tokens to reported ones and present the mix as one number. `token-stats --session
<id>` still prints 会话累计 for an explicit query.

## Quick start

```bash
git clone https://github.com/xiaozi233/qoder-token-stats.git
cd qoder-token-stats
node scripts/install.mjs --expose-token-usage   # register + ask Qoder for real token counts
```

`--expose-token-usage` writes `QODERCN_EXPOSE_TOKEN_USAGE=1` into
`HKCU\Environment`. Without it Qoder zeroes every token count on its way to
the session log and the numbers stay estimated.

**Relaunching Qoder alone is not enough.** Shortcuts, the taskbar and double-clicking
an exe all inherit their environment from `explorer.exe`, which reads
`HKCU\Environment` once at logon and never again — so a variable added after
logon is invisible to everything Explorer launches. Pick one:

- restart Explorer (Task Manager → Windows Explorer → Restart, or
  `Stop-Process -Name explorer -Force`) — one-time, after which shortcuts work
  normally forever;
- sign out and back in;
- or skip the refresh and start Qoder via `scripts/launch-with-usage.ps1`, which sets
  the variable in its own process first.

Then fully quit and reopen Qoder — the variable is read at process start, and the
plugin registry is reconciled at the same time. The line appears after every reply:

```
⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 3,389 tok / 生成 60.6s · 45 段 / 峰 84.6
```

The `token-stats` skill is registered too, so you can just ask the agent
"本轮多少 tok/s".

The chat line is rendered by the model, so it can occasionally be skipped. For a
display that never depends on the model, start the desktop strip — it reads the
same archived line:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay.ps1   # or double-click dashboard\overlay.cmd
```

## Where the number comes from, and what it excludes

The line is measured from Qoder's own event log, and the measurement **ends at
the moment the model ran the `--current` command** — the instruction asks for
that command as the very last action, after the summary is written. So the line
describes all of the turn except the short sentence that quotes it.

That boundary matters. An earlier version asked for the command *before* the
summary, which silently excluded the summary itself: on the author's logs that
was **32% of the turn on average**, and 30 of 30 measured turns disagreed with
the archived figure. Now the chat line and the archived line are computed by the
same function from the same boundary, so they agree exactly.

If the model runs the command early anyway — before finishing its answer — the
turn is **flagged** rather than reported as if complete: the CLI writes
`warning: 统计命令在本轮结束前 Ns 就被调用，漏掉 M tok（约 P%）` to stderr, the
archive records it in `warnings`, and the desktop strip appends
`⚠ 数字偏小（统计早于回答结束）` and draws the line in amber.

## What the plugin will not do

- It will not print zeros for a log it cannot read. If Qoder renames its events,
  the CLI exits 2 with `Qoder's log format has changed` on stderr and the Stop
  hook records the failure in `errors.jsonl`. This replaced a silent `exit 0`
  that made an unreadable log look like an empty turn.
- It will not present a previous turn as the current one. A turn whose model
  requests all predate its own timestamp prints nothing.

## Install

```bash
node scripts/install.mjs                          # plugin only, token counts estimated
node scripts/install.mjs --expose-token-usage     # + set QODERCN_EXPOSE_TOKEN_USAGE=1
node scripts/install.mjs --uninstall              # remove plugin and the env var
node scripts/install.mjs --uninstall --keep-env   # keep the env var
```

Re-running with `--expose-token-usage` when the variable is already set leaves it
alone. Uninstall clears it (a `0` value rather than deleting the entry, so the
change is visible in `HKCU\Environment`).

### If the `~` prefix does not disappear

`setx` writes `HKCU\Environment` but only *notifies* running processes via
`WM_SETTINGCHANGE`; whatever launched Qoder often does not re-read it, so the
variable never reaches Qoder's own environment and token counts stay redacted.
Check and fix it with the bundled launcher:

```powershell
powershell -File scripts/launch-with-usage.ps1 -CheckOnly   # what Qoder sees now
# quit Qoder completely, then:
powershell -File scripts/launch-with-usage.ps1              # starts it with the var set
```

The script refuses to run while Qoder is alive, because a second instance just
hands off to the first and inherits nothing.

## Layout

| Path | Purpose |
| --- | --- |
| `.qoder-plugin/plugin.json` | plugin manifest |
| `hooks/hooks.json` | registers the `UserPromptSubmit` and `Stop` hooks |
| `bin/token-stats.cmd` | Windows wrapper, resolves a JS runtime then runs `runtime/*.mjs` |
| `runtime/schema.mjs` | **every borrowed Qoder name in one place**: event types, payload fields, directory rules, and the probe that detects a format change |
| `runtime/stats.mjs` | parses Qoder session logs, computes the metrics (the only implementation) |
| `runtime/archive.mjs` | the plugin's own record: atomic writes, an advisory lock, `state.json`/`latest.json`/`history.jsonl`/`errors.jsonl` |
| `runtime/prompt-submit.mjs` | `UserPromptSubmit` hook: timestamps the turn and injects the display instruction |
| `runtime/stop-stats.mjs` | `Stop` hook: archives the finished turn's line |
| `runtime/token-stats.mjs` | CLI (`--current --key <k>` for the model, `--session` for history) |
| `scripts/test.mjs` | `node scripts/test.mjs` — 25 tests, no dependencies |
| `scripts/make-fixtures.mjs` | regenerates `tests/fixtures/` from a real `~/.qoder-cn` |
| `skills/token-stats/SKILL.md` | teaches the agent to run and explain the numbers |
| `docs/agent-prompt.md` | handoff prompt for running an agent on this repo inside Qoder — includes the verification steps that cannot run outside Qoder |
| `dashboard/overlay.ps1` | optional always-on-top desktop strip (no model involved) |
| `dashboard/overlay.cmd` | double-click wrapper for `overlay.ps1` |
| `scripts/install.mjs` | writes the user plugin registry (with `.bak` backups) |

## Tests

```bash
node scripts/test.mjs
```

Runs against sanitized fixtures cut from real session logs, covering a session's
first turn, a tool-free turn, a turn with network retries, a session mixing
reported and estimated turns, one `turn_id` spanning three user messages, and a
corrupt half-written log — plus the failure paths: an unrecognised event type, a
missing session, concurrent state writers, and the archive/quote agreement. No
third-party packages, so `git clone` is still the whole install.

## How the numbers are derived

Qoder appends structured events to
`~/.qoder-cn/logs/sessions/<project>/<session>/segments/*.jsonl`. A turn is the
events sharing one `turn_id`; each `model.request.started` →
`model.response.completed` pair is one segment. Generation seconds sum those
segments, so tool execution and permission waits are excluded.

A turn_id is **not** one user message: `turn.started` and `input.prompt.submitted`
can both repeat under a single turn_id (the author's logs contain a turn with
three of each). The measurement window therefore starts at the last prompt at or
before the boundary, not at the turn_id's first event.

Per-segment token counts come from the session transcript
(`~/.qoder-cn/projects/<project>/<session>.jsonl`), grouped by assistant
`message.id` and paired to segments by nearest timestamp — retries and failed
attempts make the two counts differ, so a positional zip would drift.
`model.request.attempt_failed` events are not segments of their own.

`首字` is turn start → the first `tool.requested` or `model.response.completed`
event. Qoder logs no first-token event, so **this is an upper bound on
time-to-first-token, not a measured one** — and for a single-segment turn it is
simply the whole generation time (37% of the author's archived turns). The line
does not mark it, so read it as "no earlier than".

**Token totals are estimated, not measured — but only because Qoder hides them.**
The gateway *does* return usage. The client zeroes it on the way to the log:

```js
function ror(A) { return l7() ? A : 0 }                 // real value -> 0
l3s = new Set(["input_tokens", "output_tokens", "completion_tokens",
             "total_tokens", "cache_read_input_tokens", …])  // field-name blocklist
// on write: preserveSessionTokenUsage ? raw data : redacted data
//   where preserveSessionTokenUsage = (provider === "custom")
```

`preserveSessionTokenUsage` is only true for a BYOK `custom` provider, so on
Qoder’s own gateway every `model.response.completed` logs zeros. Set the SDK’s
`QODERCN_EXPOSE_TOKEN_USAGE=1` (values `1`/`true`/`yes`/`on`) in the environment
before launching Qoder and the real numbers reach the log untouched. This plugin
then switches to them automatically — `~` disappears, no configuration here.
**Verified on 2026-09-20:** with the flag on, the same turn reported 976 real
output tokens against 565 estimated, i.e. the character heuristic undercounted by
~42%. Treat any `~`-prefixed number as a rough floor, not a measurement.

Until then it counts CJK characters (≈1 token each) and latin words (≈1 token each)
in assistant text, thinking, and tool arguments, marking the result with a `~`.

A session that straddles the flag flip reports `token 来源: 混合` and marks the
**whole cumulative** with `~`, rather than blending the two sources behind one
unmarked number.

## How the line gets displayed

Qoder plugins have no UI extension point. The client's hook renderer only accepts
`hook_started` / `hook_progress` / `hook_response` and draws a part carrying
`{id, event, status, exitCode, startedAt, completedAt}` — **no text field** — so a
hook cannot paint anything into the chat, no matter what it writes to stdout
(confirmed in `app.asar` for Qoder CN 0.3.4). The visible line is therefore
produced by the model:

```
UserPromptSubmit ──mints a per-turn key, writes state.json──┐
                                                            └─additionalContext:
                          "write your summary first, then run
                           token-stats --current --key <that key>
                           as your last action and quote the output"
Model finishes tools → writes the summary → runs the CLI → pastes the line in a blockquote
Stop                 → archives the same line to history.jsonl / latest.md
```

Every turn gets its own 12-hex key, so a model reads back its own record instead of
racing for one shared slot. A keyless `--current` still works — it falls back to
the newest turn recorded by a transcript-owning session. Either way a turn whose
model requests all predate its own timestamp prints nothing, so a previous turn
can never be presented as the current one.
This design is taken from [zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor),
which solves the same "hooks cannot paint UI" problem the same way.

The `Stop` hook is the durable record. It computes the **same** window the CLI
does — both stop at the model's own `--current` call, found in the log rather than
handed over — so the archived line and the quoted line are always the same
number. Archiving is idempotent per turn, and a background sub-session (which
owns no transcript) is written to history but never overwrites `latest.json`.

## Desktop overlay strip (optional)

The quoted line above still depends on the model obeying the instruction — it
usually does, and sometimes does not. `dashboard/overlay.ps1` removes the model
from the loop: it reads `latest.json`, which the `Stop` hook rewrites after every
turn, and paints it on a transparent always-on-top strip. Nothing to configure,
nothing to prompt.

```powershell
# start (or double-click dashboard\overlay.cmd)
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay.ps1
powershell -NoProfile -File dashboard\overlay.ps1 -Status   # is it running?
powershell -NoProfile -File dashboard\overlay.ps1 -Stop     # close it
```

Drag the strip anywhere; the position is remembered. Right-click for a close menu.
It docks next to the bottom-right of the Qoder window on first launch and switches
between a dark and light palette by sampling that window's edge, so it stays
readable in both themes. `Qoder CN` is the process name it looks for — override
with `-ProcessName`. The data directory defaults to `$env:QODER_PLUGIN_DATA`, then
`$env:QODER_HOME\plugins\data\token-stats-local`, then `~/.qoder-cn/...`; override
with `-DataDir`.

If the archived line carries a warning (the model measured before its summary), the
strip appends `⚠ 数字偏小（统计早于回答结束）` in amber rather than showing the
short number as if it were complete.

The label reads `(上一轮)` rather than `(本轮)`: the archive is written when a turn
*ends*, so while an answer is streaming the strip shows the turn before it. The
strip follows its own monitor when dragged to a second display.

## Iterating without reinstalling

`install.mjs` copies a snapshot into `plugins/cache/local/` and records the
checkout path in `SOURCE`. After editing, either re-run the installer, or point
the wrapper at the live checkout:

```bash
set TOKEN_STATS_SOURCE=<path to this checkout>
```

With that set, `bin/token-stats.cmd` runs `runtime/*.mjs` from the checkout
instead of the installed copy. Unset it before relying on the hook in real use.

## When something is wrong

Failures are recorded rather than swallowed. Three places to look:

| File | What lands there |
| --- | --- |
| `errors.jsonl` | every failure, with a `kind`: `unknown-log-format`, `no-session-log`, `state-write-failed`, `archive-failed`, … |
| `history.jsonl` | one row per archived turn, including a `warnings` array |
| `latest.json` | the newest line, plus its `warnings` |

A readable log this build cannot parse is never reported as zeros. The CLI exits 2
with the reason on stderr:

```
$ token-stats --session <id>
token-stats: unrecognised model event type(s): llm.request.begin, llm.response.done — Qoder's log format has changed
```

Disable the injected instruction (keeping the archive) with
`~/.qoder-cn/token-stats.config.json`:

```json
{ "tokenRateLine": false }
```

## Verified

Run against real sessions on the author's machine — 224 session logs, 27 sessions
with completed turns, 55 `Stop` fires and 51 `UserPromptSubmit` fires. The numbers
below came from the CLI during the audit, and the counts that drove the refactor
(call-window undercount, archive loss, user-message reuse, retry turns) are the
measurements recorded in this repository's history.

| session | tok/s | 首字 | 输出 | 生成 | 段 | 峰 |
| --- | --- | --- | --- | --- | --- | --- |
| `9762dfc7` (this repo) | 33.3 | 4.5s | ~18,820 | 565.2s | 81 | 60.9 |
| `c1f7d924` | 22.1 | 6.8s | ~2,857 | 129.3s | 11 | 38.3 |
| `093d9f7a` | 21.9 avg over 2 turns | — | ~9,737 | 445.5s | 21 | 28.0 |

## Known limits

- **The in-chat line depends on the model cooperating.** It is an injected
  instruction, not a rendered widget — a model that ignores it shows nothing.
  Measured on the author's logs: the CLI ran in 80% of instructed turns, and the
  visible blockquote appeared in 57% of replies. `dashboard/overlay.ps1` is the
  workaround: a desktop strip fed straight from the archived line.
- **The line excludes whatever the model writes after the command.** The
  instruction asks for the command last, which leaves only the quoting sentence
  out — about 7% of the turn on the author's logs. A model that runs it early is
  flagged, but the number is still short.
- **Token totals are estimates unless `QODERCN_EXPOSE_TOKEN_USAGE=1` reaches the
  process.** With the flag off the client zeroes every usage field before writing
  the log, and `~/.qoder-cn` keeps no usage database (unlike ZCode's `model_usage`
  table, which stores real `output_tokens`, `reasoning_tokens` and
  `time_to_first_token_ms` per request). Measured undercount: 37.5% over 13 turns.
- **`首字` is an upper bound**, and for a single-segment turn it equals the whole
  generation time. Qoder logs no first-token event.
- **The first turn of a session is the most fragile.** Its transcript file does not
  exist until the reply starts, and a background sub-session can fire
  `UserPromptSubmit` in the same directory. Per-turn keys and the lock cover this,
  but it is the case to check first if a line goes missing.
- **A missing line is not a wrong number — check whether the hook ran at all.**
  Replacing the plugin's version directory while Qoder is running makes the hook
  fail with `Plugin directory does not exist`, and that turn is never archived: the
  chat line ends up with no row behind it. `errors.jsonl` cannot report this,
  because a process that never started writes nothing. The failure only exists in
  Qoder's own `hook.finished` events, so filter on their fields (a `hook_name` is
  present and `success` is `false`) rather than grepping the message text — the
  prompt that describes this failure is itself echoed into those same logs.

## License

MIT — see [LICENSE](LICENSE).

