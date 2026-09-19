# Qoder Token Stats

English | [简体中文](README.zh-CN.md)

A Qoder plugin that reports per-turn token throughput after every reply, in the
same shape as the app's status line:

```
⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 3,389 tok / 生成 60.6s · 45 段 / 峰 84.6
会话累计 27.8 tok/s · ~14,868 tok / 533.1s · 78 段 / 峰 60.9 · 3 轮
```

## Quick start

```bash
git clone <this repo> && cd qoder-token-stats
node scripts/install.mjs        # registers into ~/.qoder-cn, backs up both files
```

Restart Qoder — the plugin registry is reconciled once at startup. The `Stop`
hook then prints the line above after every reply, and the `token-stats` skill
lets the agent answer "本轮多少 tok/s".

## Layout

| Path | Purpose |
| --- | --- |
| `.qoder-plugin/plugin.json` | plugin manifest |
| `hooks/hooks.json` | registers the `Stop` hook |
| `bin/token-stats.cmd` | Windows wrapper, resolves a JS runtime then runs `runtime/*.mjs` |
| `runtime/stats.mjs` | parses Qoder session logs, computes the metrics |
| `runtime/prompt-submit.mjs` | `UserPromptSubmit` hook: timestamps the turn and injects the display instruction |
| `runtime/stop-stats.mjs` | `Stop` hook: archives the finished turn's line |
| `runtime/token-stats.mjs` | CLI (`--current` for the model, `--session` for history) |
| `skills/token-stats/SKILL.md` | teaches the agent to run and explain the numbers |
| `scripts/install.mjs` | writes the user plugin registry (with `.bak` backups) |

## Install

```bash
node scripts/install.mjs            # register into ~/.qoder-cn
node scripts/install.mjs --uninstall
```

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
UserPromptSubmit ──writes state.json──┐
                                      └─additionalContext: "run --current at the
                                         end of your answer and quote the output"
Model finishes tools → runs token-stats --current → pastes the line in a blockquote
Stop                 → archives the same line to history.jsonl / latest.md
```

`--current` only reports a turn that started at or after the timestamp
`UserPromptSubmit` wrote, so a previous turn can never be presented as the
current one — if nothing qualifies, it prints nothing and no line is shown.
This design is taken from [zcode-tps-monitor](https://github.com/shy3130/zcode-tps-monitor),
which solves the same "hooks cannot paint UI" problem the same way.

The `Stop` hook is still the durable record: it reads `session_id`,
`transcript_path` and `parent_business_info.begin_at` from its payload to pin down
the finished turn, and writes `history.jsonl`, `latest.md` and `latest.json`.

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

- **The line depends on the model cooperating.** It is an injected instruction,
  not a rendered widget — a model that ignores it shows nothing. Qoder plugins
  expose hooks, MCP servers and skills only, with no UI extension point, so there
  is no way to paint a persistent bar from inside the plugin.
- **Token totals are estimates.** The gateway reports `output_tokens = 0` and
  `~/.qoder-cn` keeps no usage database (unlike ZCode's `model_usage` table, which
  stores real `output_tokens`, `reasoning_tokens` and `time_to_first_token_ms` per
  request). Estimates drift for code-heavy turns, where tokenizers cost punctuation
  and indentation differently than the word-count heuristic used here.
- **`首字` is an upper bound.** Qoder logs no first-token event.

## License

MIT — see [LICENSE](LICENSE).

