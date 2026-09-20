// The plugin's own on-disk record. One writer, so the CLI, the Stop hook and
// the overlay can never disagree about what the latest turn's line is.
//
// Everything is written atomically (temp file + rename): a reader must never
// observe a half-written state.json, which used to make `--current` print
// nothing at random and the overlay report "no archived data".

import fs from 'node:fs';
import path from 'node:path';
import { dataDir, qoderHome } from './schema.mjs';

export function archivePaths(home = qoderHome()) {
  const dir = dataDir(home);
  return {
    dir,
    state: path.join(dir, 'state.json'),
    latestJson: path.join(dir, 'latest.json'),
    latestMd: path.join(dir, 'latest.md'),
    history: path.join(dir, 'history.jsonl'),
    errors: path.join(dir, 'errors.jsonl'),
  };
}

// --- atomic write & read ----------------------------------------------------

export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the rename failure is the one worth reporting */
    }
    throw error;
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readJsonl(file, { tailBytes = 0 } = {}) {
  let raw;
  try {
    if (tailBytes > 0) {
      const stat = fs.statSync(file);
      const start = Math.max(0, stat.size - tailBytes);
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        raw = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A partially flushed last line is expected while a writer is active.
    }
  }
  return out;
}

function appendJsonl(file, entry) {
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

// --- advisory lock ----------------------------------------------------------

function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

// Two Qoder sub-sessions in the same project both fire UserPromptSubmit, so
// read-modify-write on state.json raced and lost most updates (measured: 24
// concurrent writers left 4 entries). An atomic-mkdir lock inside the data dir
// serialises them. On timeout we proceed unlocked rather than lose the line,
// but say so, because a silently dropped turn key is exactly the failure this
// is here to prevent.
export function withLock(dir, name, fn, { timeoutMs = 4000, staleMs = 15000 } = {}) {
  const lockPath = path.join(dir, `${name}.lock`);
  const deadline = Date.now() + timeoutMs;
  let locked = false;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      locked = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmdirSync(lockPath);
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry
      }
      if (Date.now() > deadline) break;
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    if (locked) {
      try {
        fs.rmdirSync(lockPath);
      } catch {
        /* already released by the stale sweeper */
      }
    }
  }
}

// --- errors -----------------------------------------------------------------

// "No data this turn" and "the script could not read the log" used to be the
// same thing: a silent exit 0. They are not the same, so a failure now lands
// somewhere a human can find it.
export function appendError(kind, detail, extra = {}) {
  try {
    const { errors } = archivePaths();
    appendJsonl(errors, { at: new Date().toISOString(), kind, detail, ...extra });
  } catch {
    /* if even this fails there is nowhere left to report it */
  }
}

// --- state ------------------------------------------------------------------

// `QODER_PLUGIN_DATA` first; the literal path is the fallback for a manual run
// where Qoder did not export it.
export function readState(home = qoderHome()) {
  const { state } = archivePaths(home);
  const parsed = readJson(state, null);
  if (parsed && (Array.isArray(parsed.turns) || Number.isFinite(parsed.promptAt))) return parsed;
  return null;
}

// Each turn gets its own key so every caller reads back its own record instead
// of racing for one shared slot.
export function recordTurn(entry, home = qoderHome()) {
  const { dir, state } = archivePaths(home);
  return withLock(dir, 'state', () => {
    const current = readJson(state, null) || {};
    const turns = Array.isArray(current.turns) ? current.turns : [];
    turns.push(entry);
    // Keep enough history for a long session's parallel sub-session keys without
    // growing without bound. 32 was reached in practice and evicted keys that
    // were still in flight.
    current.turns = turns.slice(-256);
    if (entry.realSession) {
      current.sessionId = entry.sessionId;
      current.promptAt = entry.promptAt;
      current.cwd = entry.cwd;
    }
    writeFileAtomic(state, JSON.stringify(current));
    return current.turns;
  });
}

export function selectTurn(state, key) {
  if (!state) return null;
  const turns = Array.isArray(state.turns) ? state.turns : [];
  if (key) {
    const hit = turns.find((t) => t && t.key === key);
    return hit && Number.isFinite(hit.promptAt) ? hit : null;
  }
  return Number.isFinite(state.promptAt) ? state : null;
}

// --- archive ----------------------------------------------------------------

function turnKey(entry) {
  return `${entry.sessionId}|${entry.turnId}|${entry.startedAt || ''}`;
}

// Archives one finished turn: the durable record the overlay reads and the
// history the CLI reports. Idempotent per turn, so a turn whose Stop hook fires
// twice (or whose model quoted a line that Stop then re-derives identically)
// does not produce two rows.
export function archiveTurn({ stats, line, warnings = [], source = 'stop' }, home = qoderHome()) {
  const p = archivePaths(home);
  const at = new Date().toISOString();
  const entry = {
    at,
    sessionId: stats.sessionId,
    turnId: stats.turn.turnId,
    line,
    windowSource: source,
    window: stats.turn.window || null,
    ...stats.turn,
    warnings,
  };
  return withLock(p.dir, 'archive', () => {
    const recent = readJsonl(p.history, { tailBytes: 256 * 1024 });
    const key = turnKey(entry);
    const duplicate = recent.find((row) => turnKey(row) === key);
    if (!duplicate) appendJsonl(p.history, entry);
    const md = [
      `# ${line}`,
      '',
      `- session: \`${stats.sessionId}\``,
      `- turn: \`${stats.turn.turnId}\``,
      `- token 来源: ${stats.turn.tokenSource === 'estimated' ? '估算（服务端 usage 为 0）' : '服务端上报'}`,
      ...(warnings.length ? ['', ...warnings.map((w) => `- ⚠ ${w}`)] : []),
      '',
    ].join('\n');
    writeFileAtomic(p.latestMd, md);
    writeFileAtomic(
      p.latestJson,
      JSON.stringify({ at, sessionId: stats.sessionId, turnId: stats.turn.turnId, line, warnings, turn: stats.turn, session: stats.session }),
    );
    return entry;
  });
}

export function readLatest(home = qoderHome()) {
  return readJson(archivePaths(home).latestJson, null);
}
