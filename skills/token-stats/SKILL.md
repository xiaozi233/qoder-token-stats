---
name: token-stats
description: Report Qoder token throughput (tok/s, first-token latency, output tokens, generation seconds, segment count, peak rate) for the current or a past session. Use when the user asks 本轮 token 用量/速度、tok/s、首字耗时、生成了多少 token、对话统计、查看上一轮性能 or to compare throughput across sessions. 用户提到 token 统计、生成速度、首字延迟时使用。
---

# Token throughput report

Qoder writes a fine-grained event log for every session, flushed live as each
model segment completes. This turns those events into the line the app shows in
its status bar:

```
⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 3,389 tok / 生成 60.6s · 45 段 / 峰 84.6
```

## Showing the line at the end of an answer

The `UserPromptSubmit` hook injects an instruction telling you to do this. Follow
it: after all other work, just before your final summary, run

```bash
node "${QODER_PLUGIN_ROOT}/runtime/token-stats.mjs" --current
```

and paste whatever it prints, verbatim, inside a Markdown blockquote at the very
end of your reply. Run it **every turn, including a turn that called no tools** —
a plain text answer still has real output tokens. **If it prints nothing, show
nothing** — do not fall back to an older turn, and never invent the numbers.

`--current` reads the timestamp the hook wrote when this turn began and only
reports a turn that started at or after it, so a previous turn can never be
presented as the current one.

## Querying history

```bash
node "${QODER_PLUGIN_ROOT}/runtime/token-stats.mjs" --session <id> "$PWD"
```

- `--session <id>` — required unless `--current` is used
- `--turns N` — last N turns instead of only the newest
- `--json` — full machine-readable breakdown per turn

Run it without `--session` to list the project's recent sessions and turn counts
(exits 2). Do not infer the session from "most recently modified": Qoder runs
background sub-sessions (recap generation, memory extraction) in the same project
directory that are frequently newer than the real one and own no transcript.
`$QODER_SESSION_ID` is not exported to hook or tool shells either.

On Windows the same entry point is `bin/token-stats.cmd token-stats <flags>`.

## What each field measures

| Field | Source |
| --- | --- |
| `tok/s(本轮)` | tokens ÷ summed model-request time for the turn |
| `首字` | turn start → first `tool.requested` / `model.response.completed` |
| `输出 tok` | transcript assistant text + thinking + tool arguments |
| `生成` | sum of `model.request.started` → `model.response.completed` gaps |
| `段` / `峰` | completed model requests in the turn, and the fastest one; omitted for single-segment turns |

Wall-clock time is longer than `生成` because tool execution and permission
prompts are excluded. Segments under 200 ms are dropped as bookkeeping artefacts
rather than counted as generation.

## Token counts are real only with QODERCN_EXPOSE_TOKEN_USAGE

Qoder receives real usage from the gateway but zeroes it before writing the
session log, unless the provider is a BYOK `custom` one. Setting
`QODERCN_EXPOSE_TOKEN_USAGE=1` in the environment before Qoder launches makes the
true numbers appear in `model.response.completed`; this plugin then detects them,
drops the `~` prefix and reports the real value — nothing to configure here.
Verified 2026-09-20: with the flag on, `tokenSource` flipped to `reported` and one
turn showed 976 real output tokens against 565 from the character heuristic, so
estimates undercount by roughly 42% and a `~` number is a floor, not a
measurement.

Without the flag, numbers are counted from transcript text (CJK characters ≈ 1
token each, latin runs ≈ 1 word each) and carry a `~` prefix. Say which of the two
you are quoting when the difference matters.

`首字` is likewise an upper bound: Qoder logs no first-token event, so this is
turn start → first tool call or completed response, not a measured TTFT.

## Data locations

- events: `~/.qoder-cn/logs/sessions/<project>/<session>/segments/*.jsonl`
- transcript: `~/.qoder-cn/projects/<project>/<session>.jsonl`
- hook archive: `~/.qoder-cn/plugins/data/token-stats-*/{history.jsonl,latest.md,latest.json,state.json}`

The data directory is `$QODER_PLUGIN_DATA`, which Qoder names
`<plugin name>-<marketplace>` — here `token-stats-local`, not `token-stats`. Glob
it rather than hard-coding.
