// Every name, path and field this plugin borrows from Qoder lives here and only
// here. Qoder's session log is an internal format: event names, payload fields
// and directory naming can change between releases without notice. Keeping them
// in one table means a rename is a one-line change, and `probe()` can tell the
// difference between "this turn produced nothing" and "Qoder changed the log",
// which used to be indistinguishable (both printed an empty line).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return null;
}

export function qoderHome() {
  return env('QODER_HOME') || path.join(os.homedir(), '.qoder-cn');
}

// Qoder names a project directory after its absolute path with every character
// that is not [A-Za-z0-9-] replaced by a dash — separators, dots and spaces
// alike, and dashes already in the path survive as themselves. Verified against
// all 8 project directories on the reference install, e.g.
//   D:\Qoder CN\.qoder-versions\0.3.4 -> D--Qoder-CN--qoder-versions-0-3-4
//   D:\GAME\...\ModPC-3.4.0.47155     -> D--GAME-...-ModPC-3-4-0-47155
export function sanitizeProject(dir) {
  return String(dir).replace(/[^A-Za-z0-9-]/g, '-');
}

// The transcript a session owns, if one exists. Qoder's background sub-sessions
// (recap generation, memory extraction) never write one, and that is the only
// signal that separates them from the user's own session. It is a signal that
// only becomes readable over time: a real session has no transcript yet at the
// moment its first prompt is submitted, so anything decided at prompt time is a
// false negative for every session's first turn.
export function findTranscript(home, sessionId, cwd) {
  if (!sessionId) return null;
  const root = projectsRoot(home);
  if (!fs.existsSync(root)) return null;
  if (cwd) {
    const direct = path.join(root, sanitizeProject(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) return direct;
  }
  for (const project of fs.readdirSync(root)) {
    const candidate = path.join(root, project, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function sessionsRoot(home = qoderHome()) {
  return path.join(home, 'logs', 'sessions');
}

export function projectsRoot(home = qoderHome()) {
  return path.join(home, 'projects');
}

// `QODER_PLUGIN_DATA` is `<plugin name>-<marketplace>`, so hard-coding
// `token-stats-local` breaks as soon as the marketplace differs. Qoder exports
// it to hook subprocesses; the literal is only a fallback for manual runs.
export function dataDir(home = qoderHome()) {
  const fromEnv = env('QODER_PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA');
  const dir = fromEnv || path.join(home, 'plugins', 'data', 'token-stats-local');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// --- the format description -------------------------------------------------

// Each logical event maps to the literal `type` values we accept, newest first.
// Add an alias here when Qoder renames; nothing else needs to know.
export const EVENTS = {
  turnStarted: ['turn.started'],
  turnFinished: ['turn.finished'],
  promptSubmitted: ['input.prompt.submitted', 'input.prompt.received'],
  requestStarted: ['model.request.started'],
  responseCompleted: ['model.response.completed'],
  requestFailed: ['model.request.attempt_failed'],
  toolRequested: ['tool.requested'],
  shellStarted: ['tool.shell.started'],
};

// Payload fields, as dot paths from the event root, newest first.
export const FIELDS = {
  turnId: ['turn_id'],
  requestId: ['request_id'],
  outputTokens: ['data.output_tokens', 'data.completion_tokens', 'data.outputTokens'],
  inputTokens: ['data.input_tokens', 'data.prompt_tokens'],
  subagent: ['data.is_subagent'],
  // Command text of a tool invocation, wherever the event carries it.
  command: ['data.command', 'data.args.command', 'data.tool_input.command'],
  toolName: ['data.tool_name', 'data.name'],
};

// Transcript (projects/<slug>/<session>.jsonl) field names.
export const TRANSCRIPT = {
  assistant: 'assistant',
  usage: 'message.usage',
  messageId: 'message.id',
  content: 'message.content',
  contentText: 'text',
  contentThinking: 'thinking',
  contentInput: 'input',
  timestamp: 'timestamp',
  requestSetId: 'requestSetId',
};

function get(obj, dotPath) {
  let cur = obj;
  for (const part of dotPath.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

export function field(event, keys) {
  for (const key of keys) {
    const value = get(event, key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function isType(event, logical) {
  const names = EVENTS[logical];
  return Boolean(event) && typeof event.type === 'string' && names.includes(event.type);
}

function allKnownTypes() {
  return new Set(Object.values(EVENTS).flat());
}

// Qoder emits plenty of event types this plugin does not consume (session
// phases, hook bookkeeping, attachments, permissions, loop chatter). Their
// presence is normal and must not be mistaken for a format change. Only an
// event whose *namespace* is the model's means the metrics below would be
// wrong — so match `model.` / `llm.` as a segment, or a completion-shaped name.
const MODEL_LIKE = /(^|[._-])(model|llm|response)($|[._-])|completion|output_tokens/i;

// The CLI's own invocation, found in a tool event's command text. Only
// `--current` counts: that is the end-of-answer quote. A `--session` call is a
// human/agent query and must not be mistaken for the measurement boundary.
const CLI_MARKER = /token-stats(?:\.mjs|\.cmd|\.exe)?/i;

export function cliInvocation(event) {
  const command = field(event, FIELDS.command);
  if (typeof command !== 'string') return null;
  if (!CLI_MARKER.test(command)) return null;
  if (!/--current\b/.test(command)) return null;
  return command;
}

// --- format probing ---------------------------------------------------------

// Decide whether we can read this session at all. `ok:false` means Qoder's log
// no longer looks like what this plugin was written against; callers must
// report that instead of emitting zeros.
//
// A log that stops before any model traffic (a headless run, a session that
// only loaded configuration) is `ok:true` with `hasModel:false` — empty for a
// legitimate reason, not an unrecognised format.
export function probe(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: 'empty-log', detail: 'no events in the session log' };
  }
  const known = allKnownTypes();
  const seen = new Set();
  const unknownModelLike = [];
  for (const e of events) {
    if (!e || typeof e.type !== 'string') continue;
    seen.add(e.type);
    if (!known.has(e.type) && MODEL_LIKE.test(e.type)) unknownModelLike.push(e.type);
  }
  if (unknownModelLike.length) {
    const unique = [...new Set(unknownModelLike)];
    return {
      ok: false,
      reason: 'unknown-log-format',
      detail: `unrecognised model event type(s): ${unique.slice(0, 4).join(', ')} — Qoder's log format has changed`,
    };
  }
  const hasTurn = [...seen].some((t) => EVENTS.turnStarted.includes(t) || EVENTS.promptSubmitted.includes(t));
  const hasModel = [...seen].some(
    (t) => EVENTS.requestStarted.includes(t) || EVENTS.responseCompleted.includes(t),
  );
  return { ok: true, eventTypes: seen.size, hasModel, hasTurn };
}
