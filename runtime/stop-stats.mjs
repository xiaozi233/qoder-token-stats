// Stop hook: the turn has just finished, so its events are all on disk.
// Archives the per-turn throughput line for the dashboard/overlay and reports it
// on stdout. Qoder forwards Stop stdout as an SDK `hook_response` rather than
// rendering it, so the visible copy is produced by the model's own quote — this
// hook is the durable record, and it computes the *same* window the CLI does
// (both stop at the model's end-of-answer `--current` call), so the archived
// line and the quoted line are always the same number.
//
// Every outcome is recorded. "This turn had nothing to measure" and "the log
// could not be read" are different things and no longer share a silent exit 0.

import process from 'node:process';
import { appendError, archiveTurn } from './archive.mjs';
import { computeStats, formatTurnLine } from './stats.mjs';
import { qoderHome } from './schema.mjs';

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

let payload = {};
try {
  payload = JSON.parse((await readStdin()) || '{}') || {};
} catch (error) {
  appendError('stop:bad-payload', String(error && error.message));
  payload = {};
}

// Re-entrancy guard: while a Stop hook is being handled the client may stop again.
if (payload.stop_hook_active) process.exit(0);
if (!payload.session_id) {
  appendError('stop:no-session-id', 'Stop payload carried no session_id');
  process.exit(0);
}

const stats = computeStats({
  home: qoderHome(),
  sessionId: payload.session_id,
  transcriptPath: payload.transcript_path,
  cwd: payload.cwd,
});

if (stats.error) {
  appendError(`stop:${stats.error}`, stats.detail || stats.error, { sessionId: payload.session_id });
  process.stderr.write(`token-stats: ${stats.detail || stats.error}\n`);
  process.exit(1);
}

const turn = stats.turn;
if (!turn) {
  // The format was readable but the session has no completed turn yet. Rare and
  // not an error, but worth a line in the record rather than nothing.
  appendError('stop:no-turn', 'session log parsed but produced no turn', { sessionId: payload.session_id });
  process.exit(0);
}

// A background sub-session (recap, memory extraction) fires Stop in the same
// cwd and owns no transcript. Its turn is still worth recording in history, but
// it must not overwrite latest.json — that would put a sub-session's numbers on
// the overlay in place of the user's own last turn.
const background = !payload.transcript_path;

const line = formatTurnLine(stats);
try {
  archiveTurn({ stats, line, warnings: turn.warnings || [], source: turn.window?.source || 'end' }, qoderHome());
} catch (error) {
  appendError('stop:archive-failed', String(error && error.message), { sessionId: payload.session_id });
  process.stderr.write(`token-stats: could not archive: ${error && error.message}\n`);
  process.exit(1);
}

if (background) process.exit(0);

process.stdout.write(`${line}\n`);
process.exit(0);
