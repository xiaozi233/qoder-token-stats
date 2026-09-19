// CLI for querying per-turn and per-session throughput from Qoder session logs.
//
//   token-stats.mjs --current             the in-flight turn, one bare line (or nothing)
//   token-stats.mjs --session <id>        a specific session's last turn
//   token-stats.mjs --session <id> -n 3   last three turns
//   token-stats.mjs --json                machine readable

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  computeStats,
  formatStatsLine,
  formatTurnLine,
  formatNumber,
  recentSessions,
  qoderHome,
} from './stats.mjs';

function parseArgs(argv) {
  const out = { turns: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--session' || arg === '-s') out.sessionId = argv[++i];
    else if (arg === '--turns' || arg === '-n') out.turns = Number(argv[++i]) || 1;
    else if (arg === '--current') out.current = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else out.cwd = arg;
  }
  return out;
}

function readState(home) {
  for (const dir of [
    process.env.QODER_PLUGIN_DATA,
    path.join(home, 'plugins', 'data', 'token-stats-local'),
  ]) {
    if (!dir) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      if (Number.isFinite(state.promptAt)) return state;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const home = qoderHome();

if (args.help) {
  process.stdout.write(
    [
      'usage: token-stats [--current] [--session <id>] [--turns N] [--json] [<cwd>]',
      '',
      '--current prints one bare statistics line for the turn the UserPromptSubmit hook',
      'last timestamped, and nothing at all if that turn has not produced model requests',
      'yet — so a previous turn is never presented as the current one.',
      '',
      'Data source: ~/.qoder-cn/logs/sessions/<project>/<session>/segments/*.jsonl',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const cwd = args.cwd || process.cwd();

if (args.current) {
  const state = readState(home);
  if (!state) process.exit(0);
  const stats = computeStats({ home, sessionId: state.sessionId, cwd: state.cwd || cwd });
  const turn = (stats.turns || []).find((t) => Date.parse(t.startedAt) >= state.promptAt - 5000);
  if (!turn || !turn.tokens) process.exit(0);
  process.stdout.write(`${formatTurnLine({ ...stats, turn })}\n`);
  process.exit(0);
}

if (!args.sessionId) {
  // Qoder runs background sub-sessions (recap, memory extraction) alongside the
  // real one in the same project directory, so "most recently modified" is not
  // the current session. Refuse to guess rather than report someone else's turn.
  const candidates = recentSessions(home, cwd);
  process.stderr.write(
    [
      'token-stats: --session is required; this project has several sessions and Qoder',
      'also runs background sub-sessions here, so the newest one is not necessarily yours.',
      'Most recent:',
      ...candidates.map(
        (c) => `  ${c.sessionId}  ${new Date(c.mtime).toISOString()}  ${c.turns} turns / ${c.segments} segments${c.transcript ? '' : '  (no transcript — background sub-session)'}`,
      ),
      '',
    ].join('\n'),
  );
  process.exit(2);
}

const stats = computeStats({ home, sessionId: args.sessionId, cwd });
if (stats.error) {
  process.stderr.write(`token-stats: ${stats.error}\n`);
  process.exit(1);
}

if (args.json) {
  process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  process.exit(0);
}

const selected = stats.turns.slice(-Math.max(1, args.turns));
if (selected.length === 0) {
  process.stdout.write(`session ${stats.sessionId}: 尚无已完成的对话轮次\n`);
  process.exit(0);
}
const lines = selected.map((t) => formatStatsLine({ turn: t }));
const totals = stats.session;
const mark = totals.tokenSource === 'reported' ? '' : '~';
const footer = `会话累计 ${formatNumber(totals.rate)} tok/s · ${mark}${Math.round(totals.tokens)} tok / ${formatNumber(totals.genSeconds)}s · ${totals.segments} 段 / 峰 ${formatNumber(totals.peakRate)} · ${totals.turnCount} 轮`;
const source = {
  reported: 'token 来源: 服务端上报（真实值）',
  estimated: 'token 来源: 估算（Qoder 未开 QODERCN_EXPOSE_TOKEN_USAGE，日志里 usage 被清零）；~ 前缀表示估算值',
  mixed: `token 来源: 混合 — ${totals.reportedTurns} 轮服务端上报 + ${totals.estimatedTurns} 轮估算，整条累计按 ~ 标注`,
}[totals.tokenSource];

process.stdout.write([`session ${stats.sessionId}`, ...lines, footer, source, ''].join('\n'));
