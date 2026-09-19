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
end of your reply. **If it prints nothing, show nothing** — do not fall back to
an older turn, do not estimate the numbers yourself, and do not call extra tools
just to produce a line.

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

## Token totals are estimated (for now)

The gateway does return usage; Qoder zeroes it before writing the session log unless the
provider is a BYOK `custom` one. Set `QODERCN_EXPOSE_TOKEN_USAGE=1` in the
environment before launching Qoder and real numbers start appearing in
`model.response.completed`. This plugin detects them automatically, drops the `~`
prefix, and reports the true value — no configuration on its side.

Until then numbers are counted from transcript text (CJK characters ≈ 1 token each,
latin runs ≈ 1 token per word) and carry a `~` prefix.

`首字` is likewise an upper bound: Qoder logs no first-token event, so this is
turn start → first tool call or completed response, not a measured TTFT.

## Data locations

- events: `~/.qoder-cn/logs/sessions/<project>/<session>/segments/*.jsonl`
- transcript: `~/.qoder-cn/projects/<project>/<session>.jsonl`
- hook archive: `~/.qoder-cn/plugins/data/token-stats-*/{history.jsonl,latest.md,latest.json,state.json}`

The data directory is `$QODER_PLUGIN_DATA`, which Qoder names
`<plugin name>-<marketplace>` — here `token-stats-local`, not `token-stats`. Glob
it rather than hard-coding.
