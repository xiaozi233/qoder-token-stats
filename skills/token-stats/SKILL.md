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
it exactly: **write your whole summary first, then run this as your last action** —

```bash
node "${QODER_PLUGIN_ROOT}/runtime/token-stats.mjs" --current --key <key>
```

Order matters, and not cosmetically. The metrics stop at the moment this command
runs, so anything you write afterwards is not counted. Run it before your summary
and the summary is excluded — measured at **32% of the turn on average** across
30 real turns. Run it last and only the short quote itself is excluded (~7%).

Use the command exactly as the hook injected it — the `--key` is minted per turn
and identifies *your* turn. Paste whatever it prints, verbatim, inside a Markdown
blockquote at the very end of your reply, with nothing after it. Run it **every
turn, including a turn that called no tools** — a plain text answer still has real
output tokens. **If it prints nothing, show nothing** — do not fall back to an
older turn, and never invent the numbers.

The early call cannot warn you about itself — the work it would be missing has not
happened yet — so your own `--current` prints nothing extra. The flag is applied
afterwards and lands in the archive's `warnings`, on the desktop strip, and on the
stderr of a later `--session` query. Never in the chat line: that stays
byte-identical to the archived one, so a reader of the chat alone cannot tell the
number is short. If you suspect you measured early, check with `--session`.

`--current` looks up the record the hook wrote for that key, so nothing has to
guess which turn is live; without `--key` it falls back to the newest turn
recorded by a transcript-owning session. A turn whose model requests all predate
its own timestamp prints nothing, so a previous turn can never be presented as the
current one.

### If the command fails

A non-zero exit with a message on stderr is not "no data". A message containing
`Qoder's log format has changed` means this build cannot read the log — report that
to the user instead of showing a number or staying silent. A full example:

```
token-stats: unrecognised model event type(s): llm.request.begin, llm.response.done — Qoder's log format has changed
```

Every failure is also appended to `errors.jsonl` in the plugin data directory.
## The desktop strip (no model involved)

`dashboard/overlay.ps1` renders the archived line on an always-on-top strip, so the
numbers stay visible even in a turn where the model skipped the quote. It polls
`latest.json`, which the `Stop` hook rewrites at the end of every turn.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${QODER_PLUGIN_ROOT}/dashboard/overlay.ps1"
powershell -NoProfile -File "${QODER_PLUGIN_ROOT}/dashboard/overlay.ps1" -Status
powershell -NoProfile -File "${QODER_PLUGIN_ROOT}/dashboard/overlay.ps1" -Stop
```

Run `-Status` before starting one, or it will just report `already running` and
exit. The strip shows the *finished* turn, labelled `(上一轮)`. When the user asks
why the chat line is missing, offer this as the reliable alternative rather than
retrying the quote.

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

Exit codes: `0` with a line (or with nothing, when the turn simply has no model
requests yet), `2` when the log cannot be read or parsed. Never treat a `2` as an
empty turn — that distinction is the whole point of the code.

On Windows the same entry point is `bin/token-stats.cmd token-stats <flags>`.

## What each field measures

| Field | Source |
| --- | --- |
| `tok/s(本轮)` | tokens ÷ summed model-request time, measured up to the model's own `--current` call |
| `首字` | turn start → first `tool.requested` / `model.response.completed` |
| `输出 tok` | transcript assistant text + thinking + tool arguments |
| `生成` | sum of `model.request.started` → `model.response.completed` gaps |
| `段` / `峰` | completed model requests in the turn, and the fastest one; omitted for single-segment turns |

Wall-clock time is longer than `生成` because tool execution and permission
prompts are excluded. Segments under 200 ms are dropped as bookkeeping artefacts
rather than counted as generation.

A `turn_id` is **not** one user message: `turn.started` and
`input.prompt.submitted` can repeat under it (the author's logs contain a turn
with three of each). The window therefore starts at the last prompt at or before
the measurement boundary.

## Token counts are real only with QODERCN_EXPOSE_TOKEN_USAGE

Qoder receives real usage from the gateway but zeroes it before writing the
session log, unless the provider is a BYOK `custom` one. Setting
`QODERCN_EXPOSE_TOKEN_USAGE=1` in the environment before Qoder launches makes the
true numbers appear in `model.response.completed`; this plugin then detects them,
drops the `~` prefix and reports the real value — nothing to configure here.
Verified 2026-09-20: with the flag on, `tokenSource` flipped to `reported` and one
turn showed 976 real output tokens against 565 from the character heuristic, so
estimates undercount by roughly 42% and a `~` number is a floor, not a
measurement. Across 13 turns the measured undercount was 37.5%.

Without the flag, numbers are counted from transcript text (CJK characters ≈ 1
token each, latin runs ≈ 1 word each) and carry a `~` prefix. Say which of the two
you are quoting when the difference matters. A session spanning a flag flip is
reported as `mixed` and its whole cumulative carries `~` — never present a mixed
total as measured.

`首字` is likewise an upper bound: Qoder logs no first-token event, so this is
turn start → first tool call or completed response, not a measured TTFT. For a
single-segment turn it equals the whole generation time, so it says nothing about
latency there.

## Known failure modes

- **The line is missing.** Start with `errors.jsonl` in the plugin data directory:
  `no-session-log` and `unknown-log-format` are recorded there, and the latter means
  Qoder renamed its events so `runtime/schema.mjs` needs the new names. **But an
  absent `errors.jsonl` proves nothing** — a hook that never ran cannot write it.
  Two silent causes look identical from the chat: the hook failed to start (Qoder
  logs `hook.finished` with `success: false`, e.g. `Plugin directory does not exist`
  after a version swap), or the turn never reached `Stop` because it ended in an
  error (Qoder logs `QueryEnd:error` where a clean turn logs `QueryEnd:end_turn`).
  Filter on those events' fields; do not grep the message text, which self-matches
  on this plugin's own prompt.
- **The number looks too small.** The turn was flagged; see the note above on why
  the flag is not in the chat line.
- **A turn is missing from `history.jsonl`.** Archiving is per-turn and idempotent,
  and a turn with no tokens and no segments is deliberately not archived. The two
  silent causes under "the line is missing" drop a row the same way.

## Data locations

- events: `~/.qoder-cn/logs/sessions/<project>/<session>/segments/*.jsonl`
- transcript: `~/.qoder-cn/projects/<project>/<session>.jsonl`
- hook archive: `$QODER_PLUGIN_DATA` (or `~/.qoder-cn/plugins/data/token-stats-*/`) containing `history.jsonl`, `latest.json`, `latest.md`, `state.json`, `errors.jsonl`

The data directory is `<plugin name>-<marketplace>` — here `token-stats-local`, not
`token-stats`. Glob it rather than hard-coding.
