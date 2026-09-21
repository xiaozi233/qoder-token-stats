// Zero-dependency test suite: `node scripts/test.mjs`.
//
// Runs the real modules against sanitized real-log fixtures. No third-party
// packages, no test framework — `node:test` would work but this keeps the
// "zero install" promise obvious and lets each case print what it asserted.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { computeStats, formatTurnLine, estimateTokens, measurable } from '../runtime/stats.mjs';
import { probe, rememberRuntime, sanitizeProject } from '../runtime/schema.mjs';
import {
  archiveTurn,
  readLatest,
  readState,
  recordTurn,
  readGuard,
  saveGuard,
  selectCurrentTurn,
  selectTurn,
  withLock,
  readJsonl,
} from '../runtime/archive.mjs';
import {
  FAIL_LIMIT,
  SILENT_TURNS,
  blankGuard,
  carriesLine,
  isQuoted,
  settleWake,
  shouldWake,
  SYSTEM_MESSAGE_PROBE,
} from '../runtime/wake.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FIXTURES = path.join(root, 'tests', 'fixtures');
const CLI = path.join(root, 'runtime', 'token-stats.mjs');

let passed = 0;
const failures = [];
const queue = [];

// Tests may be sync or async; the queue is drained in declaration order at the
// bottom so output stays readable and failures never interleave.
function test(name, fn) {
  queue.push({ name, fn });
}

function section(title) {
  queue.push({ section: true, title });
}

async function runQueue() {
  for (const item of queue) {
    if (item.section) {
      console.log(`\n# ${item.title}`);
      continue;
    }
    try {
      await item.fn();
      passed += 1;
      console.log(`  ok   ${item.name}`);
    } catch (error) {
      failures.push({ name: item.name, error });
      console.log(`  FAIL ${item.name}\n       ${String(error.message).split('\n').join('\n       ')}`);
    }
  }
}

// Build a throwaway QODER_HOME from a fixture directory.
function homeFor(caseName, { transcript = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-test-${caseName}-`));
  const src = path.join(FIXTURES, caseName);
  fs.cpSync(src, dir, { recursive: true });
  if (transcript) {
    const shared = path.join(FIXTURES, 'shared', 'transcript.jsonl');
    // The fixture's session id is the case name, so the transcript is named after it.
    const dest = path.join(dir, 'projects', 'F--fixture-project', `${caseName}.jsonl`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(shared, dest);
  }
  return dir;
}

function sessionIdOf(caseName) {
  const base = path.join(FIXTURES, caseName, 'logs', 'sessions', 'F--fixture-project');
  return fs.readdirSync(base)[0];
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

// Feed a hook script the JSON payload Qoder would pipe into it.
function runHook(script, payload, home) {
  return spawnSync(process.execPath, [path.join(root, 'runtime', script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, QODER_HOME: home },
  });
}

function archived(home) {
  const dir = path.join(home, 'plugins', 'data', 'token-stats-local');
  return { dir, history: path.join(dir, 'history.jsonl'), latest: path.join(dir, 'latest.json') };
}

// One QODER_HOME holding both halves of the real hazard: the user's session,
// which owns a transcript, and a background sub-session, which never will.
function homeWithTwoSessions(realCase, backgroundCase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-bgsessions-'));
  for (const name of [realCase, backgroundCase]) {
    fs.cpSync(
      path.join(FIXTURES, name, 'logs', 'sessions', 'F--fixture-project', name),
      path.join(dir, 'logs', 'sessions', 'F--fixture-project', name),
      { recursive: true },
    );
  }
  const dest = path.join(dir, 'projects', 'F--fixture-project', `${realCase}.jsonl`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'shared', 'transcript.jsonl'), dest);
  return dir;
}

section('format probing');

test('a real log is accepted', () => {
  const home = homeFor('no-tool-turn');
  const stats = computeStats({ home, sessionId: sessionIdOf('no-tool-turn') });
  assert.equal(stats.error, undefined);
  assert.ok(stats.turns.length >= 1);
});

test('a renamed event type is reported, not silently zeroed', () => {
  const home = homeFor('unknown-format');
  const stats = computeStats({ home, sessionId: sessionIdOf('unknown-format') });
  assert.equal(stats.error, 'unknown-log-format');
  assert.match(stats.detail, /llm\./);
});

test('a log that stops before model traffic is not an error', () => {
  const probeResult = probe([
    { type: 'session.config.loaded', ts: '2026-09-20T00:00:00Z' },
    { type: 'session.phase.started', ts: '2026-09-20T00:00:01Z' },
    { type: 'hook.started', ts: '2026-09-20T00:00:02Z' },
  ]);
  assert.equal(probeResult.ok, true);
  assert.equal(probeResult.hasModel, false);
});

test('an empty log is reported', () => {
  assert.equal(probe([]).ok, false);
  assert.equal(probe([]).reason, 'empty-log');
});

section('the six required scenarios');

test('session first turn: a line is produced even when counts are estimated', () => {
  const home = homeFor('session-first-turn', { transcript: true });
  const id = sessionIdOf('session-first-turn');
  const stats = computeStats({ home, sessionId: id });
  assert.equal(stats.error, undefined);
  const turn = stats.turn;
  assert.ok(turn, 'expected a turn');
  // This is the session's first turn and predates the usage flag, so it is an
  // estimate — the point is that it still measures and still renders.
  assert.ok(turn.tokens > 0, `expected tokens > 0, got ${turn.tokens}`);
  assert.ok(turn.segments >= 1, `expected >=1 segment, got ${turn.segments}`);
  assert.equal(turn.tokenSource, 'estimated');
  const line = formatTurnLine(stats);
  assert.match(line, /tok\/s\(本轮\) · 首字 .* · 输出 ~[\d,]+ tok \/ 生成 /);
});

test('a turn with no tool calls still produces a line', () => {
  const home = homeFor('no-tool-turn', { transcript: true });
  const id = sessionIdOf('no-tool-turn');
  const stats = computeStats({ home, sessionId: id });
  assert.equal(stats.error, undefined);
  const line = formatTurnLine(stats);
  assert.ok(line, 'expected a line for a tool-free turn');
  assert.match(line, /tok\/s\(本轮\)/);
  // Single segment: the "段 / 峰" suffix must be omitted.
  assert.ok(!/段 \/ 峰/.test(line), 'single-segment turns must not show 段/峰');
});

test('a turn containing retries is measured from reported usage', () => {
  const home = homeFor('retry-turn');
  const id = sessionIdOf('retry-turn');
  const stats = computeStats({ home, sessionId: id });
  assert.equal(stats.error, undefined);
  const turn = stats.turn;
  assert.ok(turn, 'expected a turn');
  assert.equal(turn.tokenSource, 'reported');
  assert.ok(turn.tokens > 0, `expected tokens > 0, got ${turn.tokens}`);
  // Failed attempts must not be counted as segments of their own.
  assert.ok(turn.requests <= turn.window.segmentsTotal, 'attempt_failed must not add segments');
});

test('an early measurement is flagged, not reported as the whole turn', () => {
  const home = homeFor('retry-turn');
  const id = sessionIdOf('retry-turn');
  const stats = computeStats({ home, sessionId: id });
  const turn = stats.turn;
  // In this turn the model called the CLI before writing its summary, so the
  // number is short and that must be visible rather than silently wrong.
  assert.ok(turn.warnings.length > 0, 'expected an early-boundary warning');
  assert.match(turn.warnings[0], /漏掉/);
  assert.equal(turn.window.source, 'quote');
});

test('a mixed-source session is labelled mixed, never reported as measured', () => {
  const home = homeFor('mixed-source');
  const id = sessionIdOf('mixed-source');
  const stats = computeStats({ home, sessionId: id });
  assert.equal(stats.error, undefined);
  assert.equal(stats.session.tokenSource, 'mixed');
  assert.ok(stats.session.reportedTurns >= 1, 'expected at least one reported turn');
  assert.ok(stats.session.estimatedTurns >= 1, 'expected at least one estimated turn');
  // The CLI marks the whole cumulative with ~ when the session is mixed.
  const out = runCli(['--session', id, 'F:\\fixture-project'], { QODER_HOME: home });
  assert.match(out.stdout, /会话累计 .* · ~\d/);
  assert.match(out.stdout, /token 来源: 混合/);
});

test('a turn_id spanning several user messages is windowed to the last one', () => {
  const home = homeFor('turn-id-multi-message');
  const id = sessionIdOf('turn-id-multi-message');
  const stats = computeStats({ home, sessionId: id });
  assert.equal(stats.error, undefined);
  // The fixture's single turn_id carries three separate user prompts. Treating
  // the turn_id as one message would report all three together.
  const own = readJsonl(
    path.join(home, 'logs', 'sessions', 'F--fixture-project', id, 'segments', '00-segment.jsonl'),
  );
  const prompts = own.filter((e) => e.type === 'input.prompt.submitted');
  assert.equal(prompts.length, 3, 'fixture must carry three prompts under one turn_id');
  const turn = stats.turn;
  assert.ok(turn, 'expected a turn');
  // The window must start at the LAST prompt, not the first.
  const firstPrompt = Math.min(...prompts.map((p) => Date.parse(p.ts)));
  const lastPrompt = Math.max(...prompts.map((p) => Date.parse(p.ts)));
  assert.ok(turn.window.promptMs >= lastPrompt - 2000, 'window must be derived from the last prompt');
  assert.ok(Date.parse(turn.startedAt) > firstPrompt, 'measurement must not start at the turn_id\'s first message');
});

test('a corrupt / half-written log still parses the good lines', () => {
  const home = homeFor('corrupt-log');
  const id = sessionIdOf('corrupt-log');
  const stats = computeStats({ home, sessionId: id });
  assert.equal(stats.error, undefined, 'a broken final line must not fail the read');
  const turn = stats.turn;
  assert.ok(turn && turn.tokens > 0, `expected tokens > 0 despite the garbage, got ${turn?.tokens}`);
});

section('a completion that arrives under a different request id');

// Qoder does not always complete a request under the id it started with. The
// started segment then stays open forever and the completion would become a
// segment of its own with start === end; both drop out of the >=200 ms filter,
// so the answer's tokens stayed in the numerator while the time they took
// vanished from the denominator. The turn then reported a rate above its own
// peak — see the fixture, whose middle segment is 30 s of a 45 s turn.
test('a completion with an unknown id is charged to the open segment', () => {
  const home = homeFor('orphan-completion');
  const turn = computeStats({ home, sessionId: sessionIdOf('orphan-completion') }).turn;
  assert.ok(turn, 'expected a turn');
  assert.equal(turn.tokens, 350, `every segment's tokens, including the orphan's, count once (got ${turn.tokens})`);
  assert.equal(
    turn.genSeconds,
    45,
    `generation time must include the 30 s the orphan completion took (got ${turn.genSeconds})`,
  );
  assert.equal(turn.segments, 3, `all three segments are long enough to rate (got ${turn.segments})`);
  assert.equal(turn.requests, 3, `the orphan does not invent a fourth request (got ${turn.requests})`);
});

test('rate never exceeds the peak it is drawn from', () => {
  const home = homeFor('orphan-completion');
  const turn = computeStats({ home, sessionId: sessionIdOf('orphan-completion') }).turn;
  // 350 tokens over 45 s is an average of the per-segment rates, so it cannot be
  // above the largest of them.
  assert.ok(
    turn.rate <= turn.peakRate + 1e-9,
    `rate ${turn.rate.toFixed(2)} must not exceed peak ${turn.peakRate.toFixed(2)}`,
  );
  assert.ok(
    Math.abs(turn.tokens / turn.genSeconds - turn.rate) < 0.05,
    'the printed 输出 / 生成 must reproduce the printed rate when every segment is rated',
  );
});

section('the measurement boundary is shared by CLI and Stop');

test('the archived line and the quoted line are the same number', () => {
  const home = homeFor('retry-turn');
  const id = sessionIdOf('retry-turn');
  const stats = computeStats({ home, sessionId: id });
  const line = formatTurnLine(stats);
  // The Stop hook and the CLI both call the same function, so archiving and
  // re-deriving must agree byte for byte.
  const entry = archiveTurn({ stats, line, warnings: stats.turn.warnings, source: 'stop' }, home);
  const latest = readLatest(home);
  assert.equal(latest.line, line);
  assert.equal(latest.turnId, entry.turnId);
  const again = computeStats({ home, sessionId: id });
  assert.equal(formatTurnLine(again), line);
});

test('archiving the same turn twice does not duplicate the row', () => {
  const home = homeFor('no-tool-turn');
  const id = sessionIdOf('no-tool-turn');
  const stats = computeStats({ home, sessionId: id });
  const line = formatTurnLine(stats);
  archiveTurn({ stats, line, source: 'stop' }, home);
  archiveTurn({ stats, line, source: 'stop' }, home);
  const rows = readJsonl(path.join(home, 'plugins', 'data', 'token-stats-local', 'history.jsonl'));
  assert.equal(rows.length, 1, `expected 1 row, got ${rows.length}`);
});

section('what may reach the archive');

test('a turn with nothing measured is refused, not archived as zero', () => {
  // This turn predates the usage flag and its transcript is withheld, so there
  // is nothing reported and nothing to estimate from: tokens is 0.
  const home = homeFor('session-first-turn');
  const id = sessionIdOf('session-first-turn');
  const turn = computeStats({ home, sessionId: id }).turn;
  assert.equal(turn.tokens, 0, 'fixture must measure nothing without its transcript');
  assert.equal(measurable(turn), false);
});

test('the CLI and the Stop hook agree that a nothing-measured turn has no line', () => {
  const id = sessionIdOf('session-first-turn');

  const cliHome = homeFor('session-first-turn');
  recordTurn({ key: 'k', sessionId: id, promptAt: 1000, cwd: 'F:\\fixture-project', realSession: false }, cliHome);
  const cli = runCli(['--current', '--key', 'k'], { QODER_HOME: cliHome });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, '', 'the CLI must not print a number when there is none');
  // ...but it has to say why: an empty stdout is also what a caller sees when the
  // measurement simply has not taken shape yet, and those are different things.
  assert.match(cli.stderr, /nothing to print: the turn produced no output tokens/);

  // The Stop hook used to archive a row anyway, leaving history entries that no
  // chat line could ever correspond to.
  const hookHome = homeFor('session-first-turn');
  const hook = runHook('stop-stats.mjs', { session_id: id, cwd: 'F:\\fixture-project' }, hookHome);
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, '');
  assert.equal(fs.existsSync(archived(hookHome).history), false, 'no history row either');
  assert.equal(fs.existsSync(archived(hookHome).latest), false, 'and nothing for the overlay');
  // Pinned to this reason, so a different guard firing cannot hide a regression.
  const errors = readJsonl(path.join(archived(hookHome).dir, 'errors.jsonl'));
  assert.equal(errors.at(-1).kind, 'stop:nothing-measured');
});

test('a key with no record is explained on stderr, not silently dropped', () => {
  const home = homeFor('no-tool-turn', { transcript: true });
  const out = runCli(['--current', '--key', 'evicted-key'], { QODER_HOME: home });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
  assert.match(out.stderr, /no turn recorded for key evicted-key/);
  // Without a key there is nothing to say: absent state is unremarkable.
  const bare = runCli(['--current'], { QODER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ts-nokey-')) });
  assert.equal(bare.stdout, '');
  assert.equal(bare.stderr, '');
});

test('a turn can be recorded without taking over latest.json', () => {
  const home = homeFor('no-tool-turn');
  const id = sessionIdOf('no-tool-turn');
  const stats = computeStats({ home, sessionId: id });
  archiveTurn({ stats, line: formatTurnLine(stats), source: 'stop', writeLatest: false }, home);
  assert.equal(readLatest(home), null, 'latest.json must be untouched');
  assert.equal(readJsonl(archived(home).history).length, 1, 'its row still belongs in history');
});

test('a background sub-session does not take the overlay from the user', () => {
  const home = homeWithTwoSessions('no-tool-turn', 'mixed-source');
  const payloadFor = (sessionId) => ({
    session_id: sessionId,
    cwd: 'F:\\fixture-project',
    transcript_path: path.join(home, 'projects', 'F--fixture-project', `${sessionId}.jsonl`),
  });

  const real = runHook('stop-stats.mjs', payloadFor('no-tool-turn'), home);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /tok\/s\(本轮\)/, 'a real session still reports its line');
  const owned = readLatest(home);
  assert.equal(owned.sessionId, 'no-tool-turn', "the user's own turn owns the overlay");

  // The recap run: same cwd, handed a transcript_path that does not exist — the
  // same shape as a real session whose first turn has not been written yet,
  // which is why "is the field set" is the wrong test.
  const background = runHook('stop-stats.mjs', payloadFor('mixed-source'), home);
  assert.equal(background.status, 0, background.stderr);
  assert.equal(background.stdout, '', 'a background turn must not report a line');
  assert.deepEqual(readLatest(home), owned, 'latest.json must survive a background turn');
  assert.equal(readJsonl(archived(home).history).length, 2, 'both turns still belong in history');
});

test('a keyless --current ignores a newer background entry', () => {
  const home = homeWithTwoSessions('no-tool-turn', 'mixed-source');
  // Neither entry carries realSession: the real session's transcript did not
  // exist yet when its prompt arrived, which is true of every session's first
  // turn. Believing that flag is what pinned this query to a recap run.
  recordTurn({ key: 'real', sessionId: 'no-tool-turn', promptAt: 1000, cwd: 'F:\\fixture-project', realSession: false }, home);
  recordTurn({ key: 'bg', sessionId: 'mixed-source', promptAt: 2000, cwd: 'F:\\fixture-project', realSession: false }, home);
  assert.equal(selectCurrentTurn(readState(home), home).sessionId, 'no-tool-turn');

  const out = runCli(['--current'], { QODER_HOME: home });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, `${formatTurnLine(computeStats({ home, sessionId: 'no-tool-turn' }))}\n`);

  // An entry the hook did flag is trusted as it stands, even if its transcript
  // has since been deleted.
  recordTurn({ key: 'flagged', sessionId: 'gone-session', promptAt: 3000, cwd: 'F:\\fixture-project', realSession: true }, home);
  assert.equal(selectCurrentTurn(readState(home), home).sessionId, 'gone-session');
});

test('an early measurement reaches the archive with its warning attached', () => {
  // The strip paints `warnings` (dashboard/overlay.ps1:287), so a warning that
  // never lands in latest.json is a warning nobody sees. Run the real hook: the
  // retry-turn fixture's model called the CLI before writing its summary, which
  // is the case the warning exists for.
  const home = homeFor('retry-turn', { transcript: true });
  const id = sessionIdOf('retry-turn');
  const hook = runHook(
    'stop-stats.mjs',
    {
      session_id: id,
      cwd: 'F:\\fixture-project',
      transcript_path: path.join(home, 'projects', 'F--fixture-project', `${id}.jsonl`),
    },
    home,
  );
  assert.equal(hook.status, 0, hook.stderr);
  const latest = readLatest(home);
  assert.ok(latest.warnings.length > 0, 'the early-call warning must reach latest.json');
  assert.match(latest.warnings[0], /漏掉/);
  assert.match(fs.readFileSync(path.join(archived(home).dir, 'latest.md'), 'utf8'), /- ⚠ /);
});

section('the Stop hook hands the finished line back to the model');

// A Stop hook's stdout only reaches the model for SessionStart and
// UserPromptSubmit — Qoder keeps a two-event whitelist for it. `decision: "deny"`
// is the one remaining channel into the same turn, so that is what the visible
// line now travels on, and these tests pin the shape of it.
function stopPayload(home, id) {
  return {
    session_id: id,
    cwd: 'F:\\fixture-project',
    transcript_path: path.join(home, 'projects', 'F--fixture-project', `${id}.jsonl`),
  };
}

test('a finished real turn is handed back as a blocking Stop', () => {
  const home = homeFor('no-tool-turn', { transcript: true });
  const id = sessionIdOf('no-tool-turn');
  const out = runHook('stop-stats.mjs', stopPayload(home, id), home);
  assert.equal(out.status, 0, out.stderr);
  const json = JSON.parse(out.stdout);
  assert.equal(json.decision, 'deny', 'deny is what makes Qoder feed the reason back');
  const line = formatTurnLine(computeStats({ home, sessionId: id }));
  assert.ok(json.reason.includes(line), 'the reason carries the archived line verbatim');
  // The probe: does Qoder render a hook's own `systemMessage`? Both channels are
  // answered at once while that is unknown, and the tag is what tells the two
  // renderings apart in the chat.
  assert.ok(SYSTEM_MESSAGE_PROBE);
  assert.equal(json.systemMessage, `〔探针〕${line}`);
  assert.equal(json.suppressOutput, undefined, 'suppressOutput would drop the systemMessage');
  assert.deepEqual(readGuard(id, home).pending.line, line, 'the wake is on record');
});

test('the Stop that follows a wake settles it instead of waking again', () => {
  const home = homeFor('no-tool-turn', { transcript: true });
  const id = sessionIdOf('no-tool-turn');
  const line = formatTurnLine(computeStats({ home, sessionId: id }));
  runHook('stop-stats.mjs', stopPayload(home, id), home);

  const quoted = { ...stopPayload(home, id), stop_hook_active: true, last_assistant_message: `> ${line}` };
  const again = runHook('stop-stats.mjs', quoted, home);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, '', 'a wake must never chain into a second wake');
  assert.equal(readGuard(id, home).fails, 0, 'a pasted line clears the failure tally');
  assert.equal(readGuard(id, home).pending, null);
});

test('a line is recognised even reflowed or missing its clock', () => {
  const line = '⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 ~3,389 tok / 生成 60.6s · 45 段 / 峰 84.6 · ⏱ 18:04:13';
  assert.ok(isQuoted(`> ${line}`, line));
  assert.ok(isQuoted(line.replace(/ · ⏱ .*$/, ''), line), 'the clock suffix is not part of the promise');
  assert.ok(isQuoted('>  ⚡ 55.9  tok/s(本轮)', line) === false, 'a truncated line is not a quote');
  assert.ok(!isQuoted('', line) && !isQuoted('some text', ''), 'nothing to match is not a match');
});

test(`${FAIL_LIMIT} ignored wakes buy the session ${SILENT_TURNS} silent turns`, () => {
  let guard = { ...blankGuard(), turns: FAIL_LIMIT };
  for (let i = 0; i < FAIL_LIMIT; i += 1) guard = settleWake(guard, false).guard;
  assert.equal(guard.fails, FAIL_LIMIT);
  assert.ok(!shouldWake(guard, guard.silentUntil), 'still silent on the last silent turn');
  assert.ok(shouldWake(guard, guard.silentUntil + 1), 'one probe is allowed after the window');
  assert.ok(!shouldWake({ ...blankGuard(), pending: { line: 'x', at: Date.now() } }, 5), 'an unsettled wake blocks');
  assert.ok(shouldWake({ ...blankGuard(), pending: { line: 'x', at: 0 } }, 5), 'a stale pending wake does not');
  assert.equal(settleWake(guard, true).guard.fails, 0, 'a pasted line ends the streak');
});

test('a silent guard gives the iteration back', () => {
  const home = homeFor('no-tool-turn', { transcript: true });
  const id = sessionIdOf('no-tool-turn');
  saveGuard(id, { ...blankGuard(), turns: 9, fails: FAIL_LIMIT, silentUntil: 9 }, home);
  assert.equal(runHook('stop-stats.mjs', stopPayload(home, id), home).stdout, '');
  saveGuard(id, { ...blankGuard(), turns: 9, fails: FAIL_LIMIT, silentUntil: -1 }, home);
  assert.equal(JSON.parse(runHook('stop-stats.mjs', stopPayload(home, id), home).stdout).decision, 'deny');
});

test('a turn that already quoted a number is not woken', () => {
  const home = homeFor('no-tool-turn', { transcript: true });
  const id = sessionIdOf('no-tool-turn');
  const early = '⚡ 12.1 tok/s(本轮) · 首字 3.0s · 输出 ~120 tok / 生成 9.9s · ⏱ 10:00:00';
  const out = runHook('stop-stats.mjs', { ...stopPayload(home, id), last_assistant_message: `> ${early}` }, home);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, '', 'waking anyway would put a second line under the first');
  assert.equal(readGuard(id, home), null, 'and no wake is recorded');
  assert.ok(carriesLine(early) && !carriesLine('本轮 45 tok/s 是估算的'), 'the shape test needs no exact match');
});

test('tokenRateLine:false silences both the prompt and the wake', () => {
  const home = homeFor('no-tool-turn', { transcript: true });
  const id = sessionIdOf('no-tool-turn');
  fs.writeFileSync(path.join(home, 'token-stats.config.json'), JSON.stringify({ tokenRateLine: false }), 'utf8');
  const prompt = runHook('prompt-submit.mjs', { session_id: id, cwd: 'F:\\fixture-project' }, home);
  assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, '');
  assert.equal(runHook('stop-stats.mjs', stopPayload(home, id), home).stdout, '', 'no wake either');
  assert.ok(readLatest(home), 'the archive the overlay reads is untouched');
});

section('state: per-turn keys and concurrency');

test('each turn gets its own key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-state-'));
  recordTurn({ key: 'aaa', sessionId: 's', promptAt: 1, cwd: 'F:\\x', realSession: true }, home);
  recordTurn({ key: 'bbb', sessionId: 's', promptAt: 2, cwd: 'F:\\x', realSession: true }, home);
  const state = readState(home);
  assert.equal(state.turns.length, 2);
  assert.equal(selectTurn(state, 'aaa').promptAt, 1);
  assert.equal(selectTurn(state, 'bbb').promptAt, 2);
  assert.equal(selectTurn(state, 'ccc'), null);
});

test('the state lock gives mutual exclusion across processes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-mutex-'));
  const { spawn } = await import('node:child_process');
  const archiveUrl = new URL('../runtime/archive.mjs', import.meta.url).href;
  const dir = path.join(home, 'plugins', 'data', 'token-stats-local');
  fs.mkdirSync(dir, { recursive: true });

  // Deterministically test the invariant the lock exists for: only one process
  // inside the critical section at a time. Each child, on entering, fails if
  // another child's flag is present; it then holds for 150 ms. Naively spawning
  // writers and comparing counts does NOT catch a missing lock, because process
  // startup is staggered enough that the read-modify-write never collides — that
  // version passed even with the lock removed.
  const OVERLAP_FILE = path.join(home, 'overlap');
  const children = Array.from({ length: 8 }, (_, i) =>
    new Promise((resolve) => {
      const file = path.join(home, `crit-${i}.mjs`);
      fs.writeFileSync(
        file,
        `import fs from 'node:fs';\n` +
          `import { withLock } from ${JSON.stringify(archiveUrl)};\n` +
          `const dir = ${JSON.stringify(dir)};\n` +
          `const flag = ${JSON.stringify(OVERLAP_FILE)} + '-' + process.pid;\n` +
          `withLock(dir, 'state', () => {\n` +
          `  const others = fs.readdirSync(${JSON.stringify(home)}).filter((f) => f.startsWith('overlap-'));\n` +
          `  if (others.length) { process.exit(3); }\n` +
          `  fs.writeFileSync(flag, 'x');\n` +
          `  const end = Date.now() + 150;\n` +
          `  while (Date.now() < end) {}\n` +
          `  fs.unlinkSync(flag);\n` +
          `});\n`,
      );
      const child = spawn(process.execPath, [file], { env: { ...process.env, QODER_HOME: home } });
      child.on('exit', (code) => resolve(code));
    }),
  );
  const codes = await Promise.all(children);
  const overlaps = codes.filter((c) => c === 3).length;
  assert.equal(overlaps, 0, `${overlaps} of ${codes.length} processes entered the critical section together`);
  assert.ok(codes.every((c) => c === 0), `unexpected exit codes: ${codes.join(',')}`);
});

test('concurrent turn records are all kept', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-concurrent-'));
  const { spawn } = await import('node:child_process');
  const archiveUrl = new URL('../runtime/archive.mjs', import.meta.url).href;
  // A barrier so the writers genuinely collide: every child loads the module and
  // spins until the go-file appears, then records at the same instant.
  const go = path.join(home, 'go');
  const ready = path.join(home, 'ready');
  fs.mkdirSync(ready, { recursive: true });
  const children = Array.from({ length: 24 }, (_, i) =>
    new Promise((resolve) => {
      const file = path.join(home, `writer-${i}.mjs`);
      fs.writeFileSync(
        file,
        `import fs from 'node:fs';\n` +
          `import { recordTurn } from ${JSON.stringify(archiveUrl)};\n` +
          `fs.writeFileSync(${JSON.stringify(ready)} + '/r' + ${i}, 'x');\n` +
          `while (!fs.existsSync(${JSON.stringify(go)})) {}\n` +
          `recordTurn({ key: 'k${i}', sessionId: 's${i}', promptAt: ${i + 1}, cwd: 'F:\\\\x', realSession: false });\n`,
      );
      const child = spawn(process.execPath, [file], { env: { ...process.env, QODER_HOME: home } });
      child.on('exit', resolve);
    }),
  );
  // Wait for every writer to be loaded and spinning, then release them together.
  const deadline = Date.now() + 15000;
  while (fs.readdirSync(ready).length < 24 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  fs.writeFileSync(go, 'x');
  await Promise.all(children);

  const state = readState(home);
  const keys = new Set(state.turns.map((t) => t.key));
  assert.equal(keys.size, 24, `expected all 24 keys, got ${keys.size} (lost updates)`);
});

test('the lock is released and does not leak', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-lock-'));
  const dir = path.join(home, 'plugins', 'data', 'token-stats-local');
  fs.mkdirSync(dir, { recursive: true });
  let ran = 0;
  withLock(dir, 'test', () => { ran += 1; });
  withLock(dir, 'test', () => { ran += 1; });
  assert.equal(ran, 2);
  assert.equal(fs.existsSync(path.join(dir, 'test.lock')), false);
});

test('a stale lock is reclaimed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-stale-'));
  const dir = path.join(home, 'plugins', 'data', 'token-stats-local');
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, 'state.lock');
  fs.mkdirSync(lockPath);
  const old = Date.now() - 60000;
  fs.utimesSync(lockPath, old / 1000, old / 1000);
  let ran = false;
  withLock(dir, 'state', () => { ran = true; }, { timeoutMs: 500 });
  assert.equal(ran, true, 'a stale lock must be reclaimed, not block forever');
});

section('CLI contract');

test('--current prints nothing (and exits 0) when there is no recorded turn', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cli-'));
  const out = runCli(['--current'], { QODER_HOME: home });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
});

test('an unreadable session log exits 2 with an explanation on stderr', () => {
  const home = homeFor('unknown-format');
  const id = sessionIdOf('unknown-format');
  const out = runCli(['--session', id, 'F:\\fixture-project'], { QODER_HOME: home });
  assert.equal(out.status, 2);
  assert.equal(out.stdout, '', 'stdout must stay clean');
  assert.match(out.stderr, /format has changed/);
});

test('a missing session reports no-session-log, not zeros', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-missing-'));
  const out = runCli(['--session', 'does-not-exist', 'F:\\fixture-project'], { QODER_HOME: home });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /no segment log/);
});

test('failures are recorded in errors.jsonl', () => {
  const home = homeFor('unknown-format');
  const id = sessionIdOf('unknown-format');
  runCli(['--session', id, 'F:\\fixture-project'], { QODER_HOME: home });
  const errors = readJsonl(path.join(home, 'plugins', 'data', 'token-stats-local', 'errors.jsonl'));
  assert.ok(errors.length >= 1, 'expected an error row');
  assert.match(errors[errors.length - 1].kind, /unknown-log-format/);
});

section('pure helpers');

test('sanitizeProject matches Qoder for dotted and spaced paths', () => {
  const cases = [
    ['D:\\test\\qoder-plugin', 'D--test-qoder-plugin'],
    ['D:\\Qoder CN\\.qoder-versions\\0.3.4', 'D--Qoder-CN--qoder-versions-0-3-4'],
    ['D:\\GAME\\Minecraft\\ModPC\\ModPC-3.4.0.47155', 'D--GAME-Minecraft-ModPC-ModPC-3-4-0-47155'],
    ['C:\\Users\\xiaozi\\AppData\\Roaming\\levilauncher.exe\\versions\\1.26.45.01', 'C--Users-xiaozi-AppData-Roaming-levilauncher-exe-versions-1-26-45-01'],
  ];
  for (const [input, want] of cases) assert.equal(sanitizeProject(input), want, input);
});

test('estimateTokens counts CJK per character and latin per word', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('hello world'), 2);
  assert.equal(estimateTokens('你好 world'), 3);
  assert.equal(estimateTokens('snake_case_name'), 1);
});

section('the installer');

test('install then uninstall leaves no registry, settings or cache residue', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-install-'));
  const install = path.join(root, 'scripts', 'install.mjs');
  const runInstaller = (args) =>
    spawnSync(process.execPath, [install, ...args], { encoding: 'utf8', env: { ...process.env, QODER_HOME: home } });

  const installed = runInstaller([]);
  assert.equal(installed.status, 0, installed.stderr);
  const regFile = path.join(home, 'plugins', 'installed_plugins_v2.json');
  const setFile = path.join(home, 'settings.json');
  assert.ok(JSON.parse(fs.readFileSync(regFile, 'utf8')).plugins['token-stats@local'], 'expected a registry entry');
  assert.ok(
    JSON.parse(fs.readFileSync(setFile, 'utf8')).enabledPlugins['token-stats@local'],
    'expected an enabledPlugins entry',
  );

  const removed = runInstaller(['--uninstall']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(regFile, 'utf8')).plugins['token-stats@local'], undefined);
  assert.equal(JSON.parse(fs.readFileSync(setFile, 'utf8')).enabledPlugins['token-stats@local'], undefined);
  // The versioned install directory AND its now-empty parents must be gone.
  assert.equal(fs.existsSync(path.join(home, 'plugins', 'cache', 'local')), false, 'empty cache dirs left behind');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a QODER_HOME-sandboxed install never touches the real environment', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-sandbox-'));
  const install = path.join(root, 'scripts', 'install.mjs');
  const r = spawnSync(process.execPath, [install, '--expose-token-usage'], {
    encoding: 'utf8',
    env: { ...process.env, QODER_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  // The env var lives in the real HKCU\Environment regardless of QODER_HOME, so a
  // sandboxed run must refuse it rather than silently edit the host. This is not
  // hypothetical: an early version of this suite wiped the author's flag.
  assert.match(r.stdout, /skipped QODERCN_EXPOSE_TOKEN_USAGE/, 'a sandboxed run must not set the host variable');
  fs.rmSync(home, { recursive: true, force: true });
});

test('an upgrade keeps the version a live session still points at', () => {
  // Qoder pins `${QODER_PLUGIN_ROOT}` per session, so removing the directory an
  // upgrade replaced does not merely cost that session a turn: Stop and every
  // following UserPromptSubmit fail with `Plugin directory does not exist` until
  // the client restarts. Observed on the author's install at 18:38 on 2026-09-20.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-prune-'));
  const install = path.join(root, 'scripts', 'install.mjs');
  const runInstaller = () =>
    spawnSync(process.execPath, [install], { encoding: 'utf8', env: { ...process.env, QODER_HOME: home } });

  assert.equal(runInstaller().status, 0);
  const versionsRoot = path.join(home, 'plugins', 'cache', 'local', 'token-stats');
  const live = fs.readdirSync(versionsRoot)[0];

  const day = 86400000;
  for (const [name, age] of [['0.0.1', 3], ['0.0.2', 2], ['0.0.3', 1]]) {
    const dir = path.join(versionsRoot, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'marker'), name);
    const when = new Date(Date.now() - age * day);
    fs.utimesSync(dir, when, when);
  }

  assert.equal(runInstaller().status, 0);
  const after = fs.readdirSync(versionsRoot).sort();
  assert.ok(after.includes(live), 'the version just installed must survive');
  assert.ok(after.includes('0.0.3'), 'the previous version must survive: a session may still point at it');
  assert.equal(after.includes('0.0.1'), false, 'older versions must be pruned');
  assert.equal(after.includes('0.0.2'), false, 'older versions must be pruned');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a hook records the interpreter that ran it', () => {
  // bin/token-stats.cmd has to choose a JavaScript runtime before any of this can
  // run, and until now its only reliable candidates were another plugin's file or a
  // global node.exe. The hook that is already running knows the answer.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-runtime-'));
  const file = path.join(home, 'plugins', 'data', 'token-stats-local', 'run', 'runtime-path.v1');
  assert.equal(fs.existsSync(file), false, 'nothing recorded before the first hook');
  assert.equal(rememberRuntime(home), file);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), process.execPath);
  assert.equal(rememberRuntime(home), null, 'a matching record is not rewritten');
  const when = fs.statSync(file).mtimeMs;
  rememberRuntime(home);
  assert.equal(fs.statSync(file).mtimeMs, when, 'and the disk is not touched again');
  fs.rmSync(home, { recursive: true, force: true });
});

test('the wrapper tries the recorded runtime before guessing', () => {
  const cmd = fs.readFileSync(path.join(root, 'bin', 'token-stats.cmd'), 'utf8');
  const order = [
    '!data!\\run\\runtime-path.v1',
    'token-stats-local\\run\\runtime-path.v1',
    'qoder-context-qoderapp-bundler',
  ].map((needle) => cmd.indexOf(needle));
  assert.equal(order.every((i) => i >= 0), true, `missing a candidate: ${JSON.stringify(order)}`);
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'our own record must be tried before another plugin',
  );
  // %~1 arrives quoted and may hold a path with spaces; unquoted, `if not exist`
  // reads only its first word and reports the candidate file as missing.
  assert.match(cmd, /if not exist "%~1"/);
  assert.match(cmd, /set \/p candidate=<"%~1"/);
  assert.ok(/\r\n/.test(cmd), 'cmd.exe needs CRLF line endings');
});

section('the overlay that reads the archive');

test('overlay.ps1 keeps its UTF-8 BOM', () => {
  const bytes = fs.readFileSync(path.join(root, 'dashboard', 'overlay.ps1'));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'PowerShell 5.1 reads a BOM-less script as ANSI');
});

await runQueue();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f.name}`);
  process.exit(1);
}
