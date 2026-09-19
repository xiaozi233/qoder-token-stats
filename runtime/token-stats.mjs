// CLI for querying per-turn and per-session throughput from Qoder session logs.
//
//   token-stats.mjs                       newest session, last turn
//   token-stats.mjs --session <id>        specific session
//   token-stats.mjs --turns 3             last three turns
//   token-stats.mjs --json                machine readable

import process from 'node:process';
import { computeStats, formatStatsLine, formatNumber, recentSessions, qoderHome } from './stats.mjs';

function parseArgs(argv) {
  const out = { turns: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--session' || arg === '-s') out.sessionId = argv[++i];
    else if (arg === '--turns' || arg === '-n') out.turns = Number(argv[++i]) || 1;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else out.cwd = arg;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(
    [
      'usage: token-stats [--session <id>] [--turns N] [--json] [<cwd>]',
      '',
      'Without --session the most recently active session is used.',
      'Data source: ~/.qoder-cn/logs/sessions/<project>/<session>/segments/*.jsonl',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const cwd = args.cwd || process.cwd();
if (!args.sessionId) {
  // Qoder runs background sub-sessions (recap, memory extraction) alongside the
  // real one in the same project directory, so "most recently modified" is not
  // the current session. Refuse to guess rather than report someone else's turn.
  const candidates = recentSessions(qoderHome(), cwd);
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
const stats = computeStats({ sessionId: args.sessionId, cwd });
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
const header = `session ${stats.sessionId}`;
const totals = stats.session;
const footer = `会话累计 ${formatNumber(totals.rate)} tok/s · ~${Math.round(totals.tokens)} tok / ${formatNumber(totals.genSeconds)}s · ${totals.segments} 段 / 峰 ${formatNumber(totals.peakRate)} · ${totals.turnCount} 轮`;
const source =
  totals.tokenSource === 'estimated'
    ? 'token 来源: 估算（服务端 usage 返回 0）；~ 前缀表示估算值'
    : 'token 来源: 服务端上报';

process.stdout.write([header, ...lines, footer, source, ''].join('\n'));
