// CLI for querying per-turn and per-session throughput from Qoder session logs.
//
//   token-stats.mjs --current             the newest turn, one bare line (or nothing)
//   token-stats.mjs --current --key <k>   the turn the hook minted key <k> for
//   token-stats.mjs --session <id>        a specific session's last turn
//   token-stats.mjs --session <id> -n 3   last three turns
//   token-stats.mjs --json                machine readable
//
// Stdout is only ever the answer — never an error and never a placeholder
// number. A failure explains itself on stderr, exits non-zero, and lands in the
// data directory's errors.jsonl, so "no data this turn" stays distinguishable
// from "the log could not be read".

import process from 'node:process';
import { appendError, readState, selectCurrentTurn, selectTurn } from './archive.mjs';
import {
  computeStats,
  formatNumber,
  formatStatsLine,
  formatTurnLine,
  measurable,
  qoderHome,
  recentSessions,
} from './stats.mjs';

function parseArgs(argv) {
  const out = { turns: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--session' || arg === '-s') out.sessionId = argv[++i];
    else if (arg === '--turns' || arg === '-n') out.turns = Number(argv[++i]) || 1;
    else if (arg === '--current') out.current = true;
    else if (arg === '--key' || arg === '-k') out.key = argv[++i];
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else out.cwd = arg;
  }
  return out;
}

const HELP = [
  'usage: token-stats [--current [-k <key>]] [--session <id>] [--turns N] [--json] [<cwd>]',
  '',
  '--current prints one bare statistics line for the turn the UserPromptSubmit hook',
  'timestamped, and nothing at all if that turn has not produced model requests yet',
  '— so a previous turn is never presented as the current one. Pass the --key the',
  'hook injected to pin the lookup to this turn; without it the newest turn a',
  'transcript-owning session recorded is what you get.',
  '',
  'A readable session log whose format this build does not recognise exits 2 with an',
  'explanation on stderr — it never prints zeros as if they were measurements.',
  '',
  'Data source: ~/.qoder-cn/logs/sessions/<project>/<session>/segments/*.jsonl',
  '',
].join('\n');

function fail(kind, detail, code = 1) {
  appendError(kind, detail);
  process.stderr.write(`token-stats: ${detail}\n`);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const home = qoderHome();
const cwd = args.cwd || process.cwd();

if (args.current) {
  const state = readState(home);
  // With a --key, read back exactly the turn the hook minted it for. Without
  // one, the newest recorded turn has to prove it belongs to a real session —
  // a background sub-session's turn is not the user's "current" anything.
  const turnRecord = args.key ? selectTurn(state, args.key) : selectCurrentTurn(state, home);
  // Nothing to report is a normal outcome, not an error: the turn may simply
  // not have produced a model request yet.
  if (!turnRecord || !turnRecord.sessionId) process.exit(0);

  const stats = computeStats({
    home,
    sessionId: turnRecord.sessionId,
    cwd: turnRecord.cwd || cwd,
  });
  if (stats.error) fail(`current:${stats.error}`, stats.detail || stats.error, 2);
  const turn = stats.turn;
  if (!measurable(turn)) process.exit(0);
  process.stdout.write(`${formatTurnLine(stats)}\n`);
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
        (c) =>
          `  ${c.sessionId}  ${new Date(c.mtime).toISOString()}  ${c.turns} turns / ${c.segments} segments${c.background ? '  (no transcript, no turns — background sub-session)' : ''}${c.error ? `  [! ${c.error}]` : ''}`,
      ),
      '',
    ].join('\n'),
  );
  process.exit(2);
}

const stats = computeStats({ home, sessionId: args.sessionId, cwd });
if (stats.error) fail(stats.error, stats.detail || stats.error, 2);

if (args.json) {
  process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  process.exit(0);
}

const selected = stats.turns.slice(-Math.max(1, args.turns));
const warnings = selected.flatMap((t) => t.warnings || []);
if (selected.length === 0) {
  process.stdout.write(`session ${stats.sessionId}: 尚无已完成的对话轮次\n`);
  if (warnings.length) process.stderr.write(`${warnings.map((w) => `warning: ${w}`).join('\n')}\n`);
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
if (warnings.length) process.stderr.write(`${[...new Set(warnings)].map((w) => `warning: ${w}`).join('\n')}\n`);
