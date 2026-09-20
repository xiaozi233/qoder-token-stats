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

import { computeStats, formatTurnLine, estimateTokens } from '../runtime/stats.mjs';
import { probe, sanitizeProject } from '../runtime/schema.mjs';
import { archiveTurn, readLatest, readState, recordTurn, selectTurn, withLock, readJsonl } from '../runtime/archive.mjs';

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
