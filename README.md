# Qoder Token Stats

English | [简体中文](README.zh-CN.md)

A Qoder plugin that reports how fast the model generated the last reply. The
`Stop` hook measures the finished turn and hands the line back to the model,
which pastes it at the end of the turn:

```
⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 3,389 tok / 生成 60.6s · 45 段 / 峰 84.6
```

Fields: throughput, time to first token, output tokens, generation seconds,
segment count, peak segment rate. Tool execution and permission waits are
excluded — only the model's own generation time counts.

The chat line is written by the model, so it can occasionally be skipped. The
desktop strip shows the same archived line and never involves the model.

## Install

```bash
git clone https://github.com/xiaozi233/qoder-token-stats.git
cd qoder-token-stats
node scripts/install.mjs --expose-token-usage
```

`--expose-token-usage` sets `QODERCN_EXPOSE_TOKEN_USAGE=1`. Without it Qoder
zeroes every token count on its way to the session log, so the numbers stay
estimates, marked with `~`.

Then **fully quit and reopen Qoder**: the variable and the plugin registry are
read at process start. One caveat — shortcuts and the taskbar are launched by
`explorer.exe`, which reads that variable once at logon, so either restart
Explorer / sign out once, or start Qoder through the bundled launcher, which sets
it in its own process first:

```powershell
powershell -File scripts/launch-with-usage.ps1 -CheckOnly   # what Qoder sees now
powershell -File scripts/launch-with-usage.ps1              # start Qoder this way
```

## Usage

- **The line** appears at the end of every reply.
- **Ask for it**: `node runtime/token-stats.mjs --session <id>` prints the current
  turn, or any past session. The `token-stats` skill is registered, so
  "本轮多少 tok/s" works too.
- **Opt out** of the chat line (the strip and `--session` keep working): write
  `{"tokenRateLine": false}` to `~/.qoder-cn/token-stats.config.json`.

## Desktop strip

A transparent always-on-top bar that reads the archived line once a second — no
model, no prompt, nothing to configure. Drag it anywhere; right-click to close.
It shows `(上一轮)` rather than `(本轮)`: the archive is written when a turn ends,
so mid-answer it describes the turn before.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay.ps1   # or dashboard\overlay.cmd
powershell -NoProfile -File dashboard\overlay.ps1 -Status
powershell -NoProfile -File dashboard\overlay.ps1 -Stop

# keep it up across logon (this also starts it now); -Remove deletes it and stops it
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\overlay-autostart.ps1 -Install
```

## How it works

Qoder plugins cannot paint UI: a hook's stdout is not forwarded to the model, and
the client's hook renderer draws no text. The one channel into the visible turn is
a `Stop` hook answering `{"decision":"deny","reason":…}`, which Qoder re-injects as
a continuation message — so the hook measures, archives, and hands the line over,
and the model pastes it. Measuring at `Stop` also means the number covers the whole
answer, not whatever had been written when the model happened to fit a command in.

```
UserPromptSubmit → per-turn key + "paste the line you receive at Stop"
Model answers → Stop → measure, archive, deny with the line
Model pastes the line → Stop (stop_hook_active) → stays quiet
```

Every turn mints its own key, so nothing races for a shared slot, and a turn whose
model requests all predate its own timestamp prints nothing rather than presenting
a previous turn as the current one. One wake per turn costs one extra model
iteration, so three ignored wakes in a row buy the session eight quiet turns.

## Uninstall

```bash
node scripts/install.mjs --uninstall              # plugin + the env variable
node scripts/install.mjs --uninstall --keep-env   # keep the variable
```

## When something is wrong

- `~/.qoder-cn/plugins/data/token-stats-local/errors.jsonl` — hook failures, wake
  suppressions, unreadable logs, each with a `kind`.
- `latest.md` next to it — the last archived turn in plain text.
- A log this build cannot parse is never reported as zeros: the CLI exits 2 with
  the reason on stderr.

## Development

```bash
node scripts/test.mjs    # 46 tests against sanitized real-log fixtures, no dependencies
```

`set TOKEN_STATS_SOURCE=<path to this checkout>` makes the hook wrapper run
`runtime/*.mjs` from the checkout instead of the installed copy, so you can edit
without reinstalling. Unset it for real use.

`dashboard/overlay.ps1` must keep its UTF-8 BOM — PowerShell 5.1 reads a BOM-less
`.ps1` as ANSI and the CJK literals in it fail to parse. A test enforces this.

## License

MIT — see [LICENSE](LICENSE).
