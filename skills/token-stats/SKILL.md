---
name: token-stats
description: Report Qoder token throughput (tok/s, first-token latency, output tokens, generation seconds, segment count, peak rate) for the current or a past session. Use when the user asks 本轮 token 用量/速度、tok/s、首字耗时、生成了多少 token、对话统计、查看上一轮性能 or to compare throughput across sessions. 用户提到 token 统计、生成速度、首字延迟时使用。
---

# Token throughput report

Qoder writes a fine-grained event log for every session. This skill turns those
events into the same line the app shows in its status bar:

```
⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 3,389 tok / 生成 60.6s · 45 段 / 峰 84.6
```

## Workflow

1. Run the bundled CLI. `${QODER_PLUGIN_ROOT}` is this plugin's install directory;
   if it is unset, locate the plugin under `~/.qoder-cn/plugins/cache/`.

   ```bash
   node "${QODER_PLUGIN_ROOT}/runtime/token-stats.mjs" --session <id> "$PWD"
   ```

   Flags:
   - `--session <id>` — required
   - `--turns N` — last N turns instead of only the newest one
   - `--json` — full machine-readable breakdown per turn

   To find the current session id, read the newest `history.jsonl` entry the Stop
   hook wrote, or run the CLI with a wrong id and it will list the project's most
   recent sessions with turn counts:

   ```bash
   node "${QODER_PLUGIN_ROOT}/runtime/token-stats.mjs" "$PWD"     # exits 2, prints candidates
   ```

   Never derive the session from "most recently modified" alone, and never use
   `$QODER_SESSION_ID` — it is not exported to hook or tool shells. Qoder runs
   background sub-sessions (recap generation, memory extraction) in the same
   project directory, and they are frequently newer than the real one.

   On Windows the same entry point is `bin/token-stats.cmd token-stats <flags>`.

2. Report the printed line verbatim, then the 会话累计 line.

3. State the token source. The gateway currently returns `output_tokens = 0`, so
   numbers carry a `~` prefix and are estimated from transcript text (CJK
   characters ≈ 1 token each, latin runs ≈ 1 token per word). Once real usage is
   reported the `~` disappears automatically and the reported value wins.

## What each field measures

| Field | Source |
| --- | --- |
| `tok/s(本轮)` | tokens ÷ summed model-request time for the newest turn |
| `首字` | turn start → first `tool.requested` / `model.response.completed` |
| `输出 tok` | transcript assistant text + thinking + tool arguments |
| `生成` | sum of `model.request.started` → `model.response.completed` gaps |
| `段` | number of completed model requests in the turn |
| `峰` | highest per-segment rate among those requests |

Wall-clock time of the turn is longer than `生成` because tool execution and
permission prompts are excluded from generation seconds.

## Data locations

- events: `~/.qoder-cn/logs/sessions/<project>/<session>/segments/*.jsonl`
- transcript: `~/.qoder-cn/projects/<project>/<session>.jsonl`
- archived hook output: `~/.qoder-cn/plugins/data/token-stats-*/{history.jsonl,latest.md}`

The data directory is `$QODER_PLUGIN_DATA`, which Qoder names
`<plugin name>-<marketplace>` — for this plugin that is `token-stats-local`, not
`token-stats`. Glob it rather than hard-coding.
