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
| `hooks/hooks.json` | registers the `Stop` hook |
| `bin/token-stats.cmd` | Windows wrapper, resolves a JS runtime then runs `runtime/*.mjs` |
| `runtime/stats.mjs` | parses Qoder session logs, computes the metrics |
| `runtime/prompt-submit.mjs` | `UserPromptSubmit` hook: timestamps the turn and injects the display instruction |
| `runtime/stop-stats.mjs` | `Stop` hook: archives the finished turn's line |
| `runtime/token-stats.mjs` | CLI (`--current --key <k>` for the model, `--session` for history) |
| `skills/token-stats/SKILL.md` | teaches the agent to run and explain the numbers |
| `dashboard/overlay.ps1` | optional always-on-top desktop strip (no model involved) |
| `dashboard/overlay.cmd` | double-click wrapper for `overlay.ps1` |
| `scripts/install.mjs` | writes the user plugin registry (with `.bak` backups) |

## Iterating without reinstalling

`install.mjs` copies a snapshot into `plugins/cache/local/` and records the
checkout path in `SOURCE`. After editing, either re-run the installer, or point
the wrapper at the live checkout:

```bash
set TOKEN_STATS_SOURCE=<path to this checkout>
```

With that set, `bin/token-stats.cmd` runs `runtime/*.mjs` from the checkout
instead of the installed copy. Unset it before relying on the hook in real use.

## How the numbers are derived

Qoder appends structured events to
`~/.qoder-cn/logs/sessions/<project>/<session>/segments/*.jsonl`. A turn is the
events sharing one `turn_id`; each `model.request.started` →
`model.response.completed` pair is one segment. Generation seconds sum those
segments, so tool execution and permission waits are excluded.

Per-segment token counts come from the session transcript
(`~/.qoder-cn/projects/<project>/<session>.jsonl`), grouped by assistant
`message.id` and paired to segments by nearest timestamp — retries and failed
attempts make the two counts differ, so a positional zip would drift.

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

`首字` is turn start → the first `tool.requested` or `model.response.completed`
event. Qoder does not log a first-token event, so this is an upper bound on
time-to-first-token, not a measured one.

## How the line gets displayed

Qoder plugins have no UI extension point, and a `Stop` hook's stdout is forwarded
as an SDK `hook_response` that the client does not render. So the visible line is
produced by the model instead:

```
UserPromptSubmit ──mints a per-turn key, writes state.json──┐
                                                            └─additionalContext:
                          "run token-stats --current --key <that key> at the end of
                           your answer and quote the output"
Model finishes tools → runs token-stats --current --key … → pastes the line in a blockquote
Stop                 → archives the same line to history.jsonl / latest.md
```

Every turn gets its own 12-hex key, so a model reads back its own record instead of
racing for one shared slot. That race is what used to swallow a session's very first
turn: its transcript file does not exist yet, so it failed the old "is this a real
session?" probe and never received the instruction at all. A keyless `--current`
still works — it falls back to the newest turn recorded by a transcript-owning
session, which only a real session may move. Either way a turn whose model requests
all predate its own timestamp prints nothing, so a previous turn can never be
presented as the current one.
This design is taken from [zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor),
which solves the same "hooks cannot paint UI" problem the same way.

The `Stop` hook is still the durable record: it reads `session_id`,
`transcript_path` and `parent_business_info.begin_at` from its payload to pin down
the finished turn, and writes `history.jsonl`, `latest.md` and `latest.json`.

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
with `-ProcessName`, and `-DataDir` if the plugin data lives elsewhere.

The label reads `(上一轮)` rather than `(本轮)`: the archive is written when a turn
*ends*, so while an answer is streaming the strip shows the turn before it.

## Hook output

`stop-stats.mjs` writes plain text to stdout and archives unconditionally. Disable
the injected instruction with `~/.qoder-cn/token-stats.config.json`:

```json
{ "tokenRateLine": false }
```

## Verified

Run against real sessions on the author's machine, including two historical
Bedrock-modding sessions:

| session | tok/s | 首字 | 输出 | 生成 | 段 | 峰 |
| --- | --- | --- | --- | --- | --- | --- |
| `9762dfc7` (this repo) | 33.3 | 4.5s | ~18,820 | 565.2s | 81 | 60.9 |
| `c1f7d924` | 22.1 | 6.8s | ~2,857 | 129.3s | 11 | 38.3 |
| `093d9f7a` | 21.9 avg over 2 turns | — | ~9,737 | 445.5s | 21 | 28.0 |

## Known limits

- **The in-chat line depends on the model cooperating.** It is an injected
  instruction, not a rendered widget — a model that ignores it shows nothing. Qoder
  plugins expose hooks, MCP servers and skills only, with no UI extension point, so
  nothing inside the plugin can paint into the chat panel. `dashboard/overlay.ps1`
  is the workaround: a desktop strip fed straight from the archived line.
- **Token totals are estimates unless `QODERCN_EXPOSE_TOKEN_USAGE=1` reaches the
  process.** With the flag off the client zeroes every usage field before writing
  the log, and `~/.qoder-cn` keeps no usage database (unlike ZCode's `model_usage`
  table, which stores real `output_tokens`, `reasoning_tokens` and
  `time_to_first_token_ms` per request). Estimates drift for code-heavy turns,
  where tokenizers cost punctuation and indentation differently than the
  word-count heuristic used here.
- **`首字` is an upper bound.** Qoder logs no first-token event.

## License

MIT — see [LICENSE](LICENSE).

