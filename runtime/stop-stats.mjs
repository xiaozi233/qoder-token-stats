// Stop hook: the turn has just finished, so its events are all on disk.
// Archives the per-turn throughput line for the dashboard/overlay and reports it
// on stdout. Qoder forwards Stop stdout as an SDK `hook_response` rather than
// rendering it, so the visible copy is produced by the UserPromptSubmit
// instruction — this hook is the durable record.

import fs from 'node:fs';
import path from 'node:path';
import { computeStats, formatTurnLine } from './stats.mjs';

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(raw);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', finish);
    // A client that never closes stdin must not stall the turn.
    setTimeout(finish, 1500);
  });
}

function dataDir() {
  const fromEnv = process.env.QODER_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  const dir = fromEnv || path.join(qoderHomeFallback(), 'plugins', 'data', 'token-stats-local');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function qoderHomeFallback() {
  return process.env.QODER_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.qoder-cn');
}

function record(stats, line, dir) {
  const entry = { at: new Date().toISOString(), sessionId: stats.sessionId, line, ...stats.turn };
  fs.appendFileSync(path.join(dir, 'history.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  const s = stats.session;
  fs.writeFileSync(
    path.join(dir, 'latest.md'),
    `# ${line}\n\n- session: \`${stats.sessionId}\`\n- turn: \`${stats.turn.turnId}\`\n- token 来源: ${
      stats.turn.tokenSource === 'estimated' ? '估算（服务端 usage 为 0）' : '服务端上报'
    }\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'latest.json'),
    JSON.stringify({ at: entry.at, sessionId: stats.sessionId, turnId: stats.turn.turnId, line, turn: stats.turn, session: s }),
    'utf8',
  );
}

function readJsonLines(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partially flushed final line */
    }
  }
  return out;
}

// The Stop payload has no turn_id. It does carry `parent_request_set_id`, which is
// the transcript's own id for the user prompt that opened this turn, plus
// `parent_business_info.begin_at` — together they pin down which turn just ended.
function turnStartMs(payload) {
  const beginAt = Number(payload.parent_business_info?.begin_at);
  const entries = readJsonLines(payload.transcript_path);
  const prompt = entries.find((e) => e.requestSetId === payload.parent_request_set_id);
  const stamped = Date.parse(prompt?.timestamp || prompt?.ts || '');
  const candidates = [beginAt, Number.isFinite(stamped) ? stamped : NaN].filter(Number.isFinite);
  return candidates.length ? Math.min(...candidates) : NaN;
}

let payload = {};
try {
  payload = JSON.parse((await readStdin()) || '{}') || {};
} catch {
  payload = {};
}

// Re-entrancy guard: while a Stop hook is being handled the client may stop again.
if (payload.stop_hook_active) process.exit(0);

const dir = dataDir();
const stats = computeStats({
  home: qoderHomeFallback(),
  sessionId: payload.session_id,
  transcriptPath: payload.transcript_path,
  cwd: payload.cwd,
  afterMs: turnStartMs(payload),
});

if (stats.error || !stats.turn || !stats.turn.tokens) process.exit(0);

const line = formatTurnLine(stats);
record(stats, line, dir);
process.stdout.write(`${line}\n`);
process.exit(0);
