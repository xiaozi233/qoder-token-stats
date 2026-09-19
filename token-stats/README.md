# token-stats

A Qoder plugin that reports per-turn token throughput after every reply, in the
same shape as the app's status line:

```
⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 3,389 tok / 生成 60.6s · 45 段 / 峰 84.6
会话累计 27.8 tok/s · ~14,868 tok / 533.1s · 78 段 / 峰 60.9 · 3 轮
```

## Layout

| Path | Purpose |
| --- | --- |
| `.qoder-plugin/plugin.json` | plugin manifest |
| `hooks/hooks.json` | registers the `Stop` hook |
| `bin/token-stats.cmd` | Windows wrapper, resolves a JS runtime then runs `runtime/*.mjs` |
| `runtime/stats.mjs` | parses Qoder session logs, computes the metrics |
| `runtime/stop-stats.mjs` | Stop hook entry point |
| `runtime/token-stats.mjs` | CLI for on-demand queries |
| `skills/token-stats/SKILL.md` | teaches the agent to run and explain the numbers |
| `scripts/install.mjs` | writes the user plugin registry (with `.bak` backups) |

## Install

```bash
node scripts/install.mjs            # register into ~/.qoder-cn
node scripts/install.mjs --uninstall
```

Restart Qoder afterwards: the plugin registry is reconciled once at startup.

## Iterating without reinstalling

`install.mjs` copies a snapshot into `plugins/cache/local/` and records the
checkout path in `SOURCE`. After editing, either re-run the installer, or point
the wrapper at the live checkout:

```bash
set TOKEN_STATS_SOURCE=D:\test\qoder-plugin\token-stats
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

**Token totals are estimated, not measured.** The gateway currently reports
`output_tokens = 0` on every `model.response.completed`, so the plugin counts
CJK characters (≈1 token each) and latin words (≈1 token each) in assistant text,
thinking, and tool arguments, and marks the result with a `~`. When the gateway
starts reporting non-zero usage, the reported value is used instead and the `~`
disappears — no configuration needed.

`首字` is turn start → the first `tool.requested` or `model.response.completed`
event. Qoder does not log a first-token event, so this is an upper bound on
time-to-first-token, not a measured one.

## Hook output

`stop-stats.mjs` writes `{"systemMessage": "..."}` on stdout, the format the
`qoder-context` plugin also uses. If this Qoder build ignores that field, run
`node runtime/stop-stats.mjs --text` to emit plain text instead, or read
`~/.qoder-cn/plugins/data/token-stats/latest.md`, which the hook rewrites every
turn regardless.

## Verified

Run against four real sessions on this machine, including two historical
Bedrock-modding sessions:

| session | tok/s | 首字 | 输出 | 生成 | 段 | 峰 |
| --- | --- | --- | --- | --- | --- | --- |
| `9762dfc7` (this repo) | 33.3 | 4.5s | ~18,820 | 565.2s | 81 | 60.9 |
| `c1f7d924` | 22.1 | 6.8s | ~2,857 | 129.3s | 11 | 38.3 |
| `093d9f7a` | 21.9 avg over 2 turns | — | ~9,737 | 445.5s | 21 | 28.0 |

## Known limits

- No persistent status bar. Qoder plugins expose hooks, MCP servers and skills
  only — there is no UI extension point, so this renders as a turn-end message
  plus a queryable log, not a live counter.
- Estimates drift for code-heavy turns, where tokenizers cost punctuation and
  indentation differently than the word-count heuristic used here.
