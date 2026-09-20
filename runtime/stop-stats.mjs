// Stop hook: the turn has just finished, so its events are all on disk.
//
// Two jobs. It archives the per-turn throughput line for the dashboard/overlay,
// and it hands that line back to the model so the user actually sees it. The
// second is why this hook answers `decision: "deny"`: a Stop hook's stdout is not
// rendered, and Qoder only forwards stdout to the model for SessionStart and
// UserPromptSubmit — but a *blocking* Stop feeds its reason back as a continuation
// message, which is the one channel that lands in the same turn. It also means
// the number is measured at the end of the answer rather than where the model
// happened to squeeze a command in.
//
// Every outcome is recorded. "This turn had nothing to measure" and "the log
// could not be read" are different things and no longer share a silent exit 0.

import fs from 'node:fs';
import process from 'node:process';
import { appendError, archiveTurn, countSessionTurns, readGuard, readState, saveGuard } from './archive.mjs';
import { computeStats, formatTurnLine, measurable } from './stats.mjs';
import { qoderHome, rateLineDisabled, rememberRuntime } from './schema.mjs';
import { FAIL_LIMIT, SILENT_TURNS, carriesLine, isQuoted, markWoken, settleWake, shouldWake, wakeReason } from './wake.mjs';

// See prompt-submit.mjs: the wrapper that chose this interpreter reads the answer
// back out of the data directory on the next turn.
rememberRuntime();

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

// Re-entrancy guard: this is the Stop that follows our own wake. Never wake twice
// for one turn — settle the previous wake instead, which is how a model that
// ignored the instruction stops costing an iteration every turn.
if (payload.stop_hook_active) {
  const settled = payload.session_id && readGuard(payload.session_id);
  if (settled && settled.pending) {
    const quoted = isQuoted(payload.last_assistant_message, settled.pending.line);
    const { guard, enteredSilence } = settleWake(settled, quoted);
    saveGuard(payload.session_id, guard);
    if (enteredSilence) {
      appendError(
        'stop:wake-suppressed',
        `${FAIL_LIMIT} 次唤醒都没有换来统计行，静默 ${SILENT_TURNS} 轮（桌面条仍显示数字）`,
        { sessionId: payload.session_id },
      );
    }
  }
  process.exit(0);
}
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

// A turn with nothing measured is bookkeeping, not a measurement — the CLI
// prints nothing for one, so archiving one would leave a row in history that no
// chat line can ever correspond to.
if (!measurable(turn)) {
  appendError('stop:nothing-measured', `turn ${turn.turnId} produced no output tokens and no ratable segment`, {
    sessionId: payload.session_id,
  });
  process.exit(0);
}

// A background sub-session (recap, memory extraction) fires Stop in the same cwd
// and owns no transcript. Its turn is still worth recording in history, but it
// must not replace the user's own last turn on the overlay. Presence of the
// field is not the test: Qoder hands these runs a transcript_path that does not
// exist, which is also exactly how a real session's first turn looks — so ask
// the filesystem, not the payload.
const realSession = Boolean(payload.transcript_path) && fs.existsSync(payload.transcript_path);

const line = formatTurnLine(stats);
try {
  archiveTurn(
    { stats, line, warnings: turn.warnings || [], source: turn.window?.source || 'end', writeLatest: realSession },
    qoderHome(),
  );
} catch (error) {
  appendError('stop:archive-failed', String(error && error.message), { sessionId: payload.session_id });
  process.stderr.write(`token-stats: could not archive: ${error && error.message}\n`);
  process.exit(1);
}

if (!realSession || rateLineDisabled()) process.exit(0);

// A turn that already quoted a number needs no wake, and waking it anyway would
// put a second line under the first — the mid-answer one measuring less of the turn.
if (carriesLine(payload.last_assistant_message)) process.exit(0);

// The line exists and nobody in this turn has said it out loud, so ask for it.
// `shouldWake` is what keeps this from becoming a per-turn tax on a session where
// the model never pastes: three misses and the hook goes quiet for a stretch.
const guard = readGuard(payload.session_id);
const turnIndex = countSessionTurns(readState(), payload.session_id);
if (!shouldWake(guard, turnIndex)) process.exit(0);

saveGuard(payload.session_id, markWoken(guard, turnIndex, line));
process.stdout.write(JSON.stringify({ decision: 'deny', reason: wakeReason(line) }));
process.exit(0);
