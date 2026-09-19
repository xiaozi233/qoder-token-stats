// Stop hook: print the per-turn throughput line and archive it to the plugin data dir.

import fs from 'node:fs';
import path from 'node:path';
import { computeStats, formatStatsLine, formatNumber, newestSession, qoderHome } from './stats.mjs';

async function readStdin() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function dataDir() {
  const fromEnv = process.env.QODER_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  const dir = fromEnv || path.join(qoderHome(), 'plugins', 'data', 'token-stats');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function record(stats, line) {
  const dir = dataDir();
  const entry = { at: new Date().toISOString(), sessionId: stats.sessionId, line, ...stats.turn };
  fs.appendFileSync(path.join(dir, 'history.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  const s = stats.session;
  fs.writeFileSync(
    path.join(dir, 'latest.md'),
    [
      `# ${line}`,
      '',
      `- session: \`${stats.sessionId}\``,
      `- 会话累计: ${formatNumber(s.rate)} tok/s · ~${Math.round(s.tokens)} tok / ${formatNumber(s.genSeconds)}s · ${s.segments} 段 / 峰 ${formatNumber(s.peakRate)} · ${s.turnCount} 轮`,
      `- token 来源: ${stats.turn.tokenSource === 'estimated' ? '估算（服务端 usage 为 0）' : '服务端上报'}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

const raw = await readStdin();
let payload = {};
try {
  payload = JSON.parse(raw) || {};
} catch {
  // The hook payload is not documented as stable, so fall back to the newest
  // session on disk rather than reporting nothing.
}

// TODO(token-stats): temporary payload capture while the Stop contract is unknown.
fs.writeFileSync(path.join(dataDir(), 'last-payload.json'), raw || '<empty stdin>', 'utf8');

const sessionId = payload.session_id || payload.sessionId || process.env.QODER_SESSION_ID || newestSession(qoderHome());
const stats = computeStats({ sessionId, cwd: payload.cwd || process.cwd() });

if (stats.error) {
  process.stdout.write(`${JSON.stringify({ systemMessage: `token-stats: ${stats.error}` })}\n`);
  process.exit(0);
}

const line = formatStatsLine(stats);
if (line) record(stats, line);

const session = stats.session;
const tail = `会话累计 ${formatNumber(session.rate)} tok/s · ~${Math.round(session.tokens)} tok / ${formatNumber(session.genSeconds)}s · ${session.segments} 段 / 峰 ${formatNumber(session.peakRate)} · ${session.turnCount} 轮`;
const text = line ? `${line}\n${tail}` : 'token-stats: 本轮无可统计的模型请求';

if (process.argv.includes('--text')) {
  process.stdout.write(`${text}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ systemMessage: text })}\n`);
}
