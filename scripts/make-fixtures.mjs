// Extracts sanitized fixtures from real Qoder logs, so the tests run against the
// shapes Qoder actually produces rather than against what we assume.
//
// Text is replaced but *lengths are preserved* (free text becomes same-length
// filler), because the estimated-token path depends on character counts.
// Structural fields — types, timestamps, ids, request ids, token counts — are
// kept: they are what the metrics key on.
//
// The transcript is shared by every case and cut to only the assistant rows the
// cases need, because a full copy per case made the repository 7 MB.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const QH = path.join(os.homedir(), '.qoder-cn');
const OUT = path.join(process.cwd(), 'tests', 'fixtures');
const PROJECT_SLUG = 'F--fixture-project';

// Identifiers must keep their shape (length, dash positions, hex-ness) *and*
// stay distinct from one another. Mapping every hex digit to `a` preserved the
// shape but collapsed all turn_ids into a single value, which made a two-turn
// fixture look like a one-turn session.
const idMap = new Map();
function scrubId(text) {
  if (idMap.has(text)) return idMap.get(text);
  const hexCount = (text.match(/[0-9a-f]/gi) || []).length;
  // Same count of hex characters, drawn from a counter so each input differs.
  const pool = (idMap.size + 1).toString(16).padStart(hexCount, '0').slice(-hexCount);
  let i = 0;
  const out = text.replace(/[0-9a-f]/gi, () => pool[i++]);
  idMap.set(text, out);
  return out;
}

function scrubText(text) {
  const n = text.length;
  // Cap the filler: a 400 KB tool input adds nothing to a fixture whose point is
  // the event shape, and the token counts under test come from `usage`, not from
  // re-counting this text. The recorded expectations were computed from these
  // fixtures, so any cap would do — 600 keeps a realistic spread.
  const capped = Math.min(n, 600);
  if (/[\u3000-\u9fff\uff00-\uffef]/.test(text)) return '测'.repeat(capped);
  return 'x'.repeat(capped);
}

function scrubValue(value, key) {
  if (typeof value === 'string') {
    // Structural keys stay verbatim: they are what the metrics key on. Scrubbing
    // `type` (or a timestamp) silently turned every fixture into an unreadable
    // log, which is how this was caught.
    if (/^(type|ts|timestamp|hook_name|hook_event_name|hook_event|phase|level|stop_reason|model|provider|reason|outcome|subtype|status|source|event)$/.test(key)) {
      return value;
    }
    if (/(_id|^id$|uuid|request_id|tool_call_id|hook_id)/i.test(key)) return scrubId(value);
    if (/command/i.test(key)) {
      // The command text is what identifies the model's end-of-answer call, so
      // scrubbing it to filler would erase the measurement boundary the fixtures
      // exist to exercise. Keep only the semantic shape.
      if (/token-stats/i.test(value)) {
        return /--current\b/.test(value)
          ? 'node "<plugin>/runtime/token-stats.mjs" --current --key aaaaaaaaaaaa'
          : 'node "<plugin>/runtime/token-stats.mjs" --session aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      }
      return `command:${scrubText(value).length}`;
    }
    return scrubText(value);
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = typeof v === 'number' || typeof v === 'boolean' || v === null ? v : scrubValue(v, k);
    }
    return out;
  }
  return value;
}

function load(proj, sess) {
  const dir = path.join(QH, 'logs', 'sessions', proj, sess, 'segments');
  const events = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  return events;
}

function pick(events, turnIds) {
  return events.filter((e) => turnIds.includes(e.turn_id)).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function turnSpan(events, turnId) {
  const own = events.filter((e) => e.turn_id === turnId);
  if (!own.length) return null;
  const times = own.map((e) => Date.parse(e.ts));
  return { from: Math.min(...times), to: Math.max(...times) };
}

const written = [];
function writeCase(name, sessionId, events, { corrupt = false, rename = false } = {}) {
  const dir = path.join(OUT, name, 'logs', 'sessions', PROJECT_SLUG, sessionId, 'segments');
  fs.mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => {
    const out = scrubValue(e, 'type');
    if (rename) {
      if (e.type === 'model.request.started') out.type = 'llm.request.begin';
      if (e.type === 'model.response.completed') out.type = 'llm.response.done';
    }
    return JSON.stringify(out);
  });
  if (corrupt) {
    // A truncated final line and a line that is not JSON at all.
    lines.push('{"ts":"2026-09-20T00:00:00.000+08:00","type":"model.respo');
    lines.push('this is not json');
  }
  fs.writeFileSync(path.join(dir, '00-segment.jsonl'), `${lines.join('\n')}\n`);
  written.push({ name, sessionId, events, from: events.length ? Date.parse(events[0].ts) : 0, to: events.length ? Date.parse(events[events.length - 1].ts) : 0 });
  console.log(`${name}: ${lines.length} lines`);
}

fs.rmSync(OUT, { recursive: true, force: true });

const big = load('D--test-qoder-plugin', '9762dfc7-bd0d-4825-ae7b-887b44807dd0');
const allTurnIds = [...new Set(big.map((e) => e.turn_id))];

// Which turns are estimated (zero usage) vs reported, for the mixed case.
function turnHasReal(turnId) {
  return big.some((e) => e.turn_id === turnId && e.type === 'model.response.completed' && Number(e.data?.output_tokens) > 0);
}
const reportedTurn = allTurnIds.find((t) => t && turnHasReal(t));
const estimatedTurn = allTurnIds.find((t) => t && !turnHasReal(t) && big.some((e) => e.turn_id === t && e.type === 'model.response.completed'));
console.log('reported turn:', String(reportedTurn).slice(0, 8), ' estimated turn:', String(estimatedTurn).slice(0, 8));

// --- case 1: a session's first turn ------------------------------------------
// 03bde3c0 is the first turn of 9762dfc7. It predates the usage flag, so it is an
// estimated turn — which is itself worth covering, since a first turn must still
// produce a line when the real counts are unavailable.
writeCase('session-first-turn', 'session-first-turn', pick(big, ['03bde3c0-bc1a-4a26-9571-c303fe9cf6b7']));

// --- case 2: a turn that called no tools -------------------------------------
{
  const events = pick(big, ['7b8d7268-5bb6-42a1-9ed5-d866559ade3a']);
  const tools = events.filter((e) => e.type === 'tool.requested').length;
  if (tools !== 0) throw new Error(`no-tool fixture has ${tools} tool.requested events`);
  writeCase('no-tool-turn', 'no-tool-turn', events);
}

// --- case 3: a turn containing retries ---------------------------------------
{
  // 76534783 lost five attempts to the network and still reported real usage,
  // and its end-of-answer CLI call ran early enough to be flagged.
  const retried = '76534783-0745-488b-a5de-97535eb8bde0';
  const events = pick(big, [retried]);
  const retries = events.filter((e) => e.type === 'model.request.attempt_failed').length;
  if (retries < 2) throw new Error(`retry fixture lost its retries (${retries})`);
  console.log(`retry-turn: turn ${retried.slice(0, 8)}, ${retries} failed attempts, ${events.length} events`);
  writeCase('retry-turn', 'retry-turn', events);
}

// --- case 4: one session with both reported and estimated turns --------------
{
  const events = [...pick(big, [reportedTurn]), ...pick(big, [estimatedTurn])].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const hasReal = events.some((e) => e.type === 'model.response.completed' && Number(e.data?.output_tokens) > 0);
  const hasZero = events.some((e) => e.type === 'model.response.completed' && !Number(e.data?.output_tokens));
  if (!hasReal || !hasZero) throw new Error('mixed-source fixture is not mixed');
  console.log(`mixed-source: reported ${String(reportedTurn).slice(0, 8)} + estimated ${String(estimatedTurn).slice(0, 8)}`);
  writeCase('mixed-source', 'mixed-source', events);
}

// --- case 5: one turn_id spanning several user messages ----------------------
{
  // A real one, and the only one in this whole log history: d2e81fa9's turn
  // d2e81fa9-6d62-4ee2-9296-1d107b5f46e0 carries three input.prompt.submitted
  // and three turn.started events under a single exact turn_id, the last one
  // twenty minutes after the first. A turn_id therefore cannot be treated as one
  // user message, which is why the measurement window is derived from the last
  // prompt at or before the measurement rather than from the turn's own start.
  const source = load('D--GAME-Minecraft-ModPC-ModPC-3-4-0-47155', 'd2e81fa9-6d62-4ee2-9296-1d107b5f46e0');
  const turnId = source.find(
    (e) => e.type === 'turn.started' && String(e.turn_id).startsWith('d2e81fa9-6d62'),
  )?.turn_id;
  const own = pick(source, [turnId]);
  const prompts = own.filter((e) => e.type === 'input.prompt.submitted').length;
  const starts = own.filter((e) => e.type === 'turn.started').length;
  if (prompts < 3 || starts < 3) throw new Error(`expected a 3-prompt turn, saw ${prompts} prompts / ${starts} starts`);
  console.log(`turn-id-multi-message: turn ${String(turnId).slice(0, 8)}, ${prompts} prompts, ${starts} turn.started, ${own.length} events`);
  writeCase('turn-id-multi-message', 'turn-id-multi-message', own);
}

// --- case 6: corrupt / half-written log --------------------------------------
writeCase('corrupt-log', 'corrupt-log', pick(big, ['7b8d7268-5bb6-42a1-9ed5-d866559ade3a']), { corrupt: true });

// --- case 7: renamed events --------------------------------------------------
writeCase('unknown-format', 'unknown-format', pick(big, ['7b8d7268-5bb6-42a1-9ed5-d866559ade3a']), { rename: true });

// Only the fields the code reads. Keeping whole rows made the transcript 740 KB
// and implied the plugin depends on fields it never looks at.
function scrubTranscriptRow(entry) {
  const content = Array.isArray(entry.message?.content)
    ? entry.message.content.map((block) => {
        if (block.type === 'text') return { type: 'text', text: scrubText(block.text || '') };
        if (block.type === 'thinking') return { type: 'thinking', thinking: scrubText(block.thinking || '') };
        if (block.type === 'tool_use') return { type: 'tool_use', id: 'aaaa', name: 'Tool', input: { a: scrubText(JSON.stringify(block.input ?? {})) } };
        return { type: block.type };
      })
    : [];
  return {
    type: 'assistant',
    timestamp: entry.timestamp || entry.ts,
    message: {
      // Must go through scrubId, not a blanket replace: collapsing every id to
      // one value merged all 403 rows into a single response whose timestamp
      // then fell outside every measurement window.
      id: entry.message?.id ? scrubId(entry.message.id) : undefined,
      stop_reason: entry.message?.stop_reason,
      usage: { output_tokens: Number(entry.message?.usage?.output_tokens) || 0 },
      content,
    },
  };
}

// --- the shared transcript ---------------------------------------------------
{
  // Only the assistant rows in the fixture turns' time windows are needed; the
  // whole session's 543 rows made a 1.4 MB file for tests that touch three turns.
  const windows = written.map((w) => ({ from: w.from - 60000, to: w.to + 60000 }));
  const rows = fs
    .readFileSync(path.join(QH, 'projects', 'D--test-qoder-plugin', '9762dfc7-bd0d-4825-ae7b-887b44807dd0.jsonl'), 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.type === 'assistant' && e.message?.usage)
    .filter((e) => {
      const t = Date.parse(e.timestamp || e.ts || '');
      return windows.some((w) => t >= w.from && t <= w.to);
    });
  const dir = path.join(OUT, 'shared');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), `${rows.map(scrubTranscriptRow).map((e) => JSON.stringify(e)).join('\n')}\n`);
  console.log(`shared transcript: ${rows.length} assistant rows (was 543)`);
}

console.log('\nfixtures written to', OUT);
