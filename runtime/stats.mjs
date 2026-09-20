// Token/throughput statistics computed from Qoder's own session logs.
//
// There is exactly one implementation of this: the CLI, the Stop hook and the
// overlay all consume what is computed here, so no two of them can report
// different numbers for the same turn.

import fs from 'node:fs';
import path from 'node:path';
import {
  EVENTS,
  FIELDS,
  TRANSCRIPT,
  field,
  isType,
  cliInvocation,
  findTranscript,
  probe,
  qoderHome,
  sanitizeProject,
  sessionsRoot,
} from './schema.mjs';

// CJK ideographs, kana and hangul cost ~1 token per character; a latin run
// collapses to one.
const CJK_ALL = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯🀀-🫿]/gu;
const WORD = /[A-Za-z0-9_]+/g;
const MIN_SEGMENT_SECONDS = 0.2;
const WINDOW_SLACK_MS = 2000;
const PAIRING_SLACK_MS = 5000;
// A quote measured this far before the turn ends means the model called the CLI
// early and the number is missing real work — worth saying out loud.
const EARLY_BOUNDARY_SHARE = 0.2;

export { qoderHome };

export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(CJK_ALL) || []).length;
  const latin = text.replace(CJK_ALL, ' ').match(WORD);
  return cjk + (latin ? latin.length : 0);
}

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.thinking === 'string') return block.thinking;
  if (block.input !== undefined) return JSON.stringify(block.input);
  return '';
}

function readJsonl(file) {
  let raw;
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
      // A partially flushed line is not worth failing the turn over.
    }
  }
  return out;
}

// Prefer the sanitized directory name; fall back to scanning, so a slug-rule
// change degrades to "slower" rather than "wrong".
function findIn(root, sessionId, cwd, suffix) {
  if (!fs.existsSync(root)) return null;
  if (cwd) {
    const direct = path.join(root, sanitizeProject(cwd), `${sessionId}${suffix}`);
    if (fs.existsSync(direct)) return direct;
  }
  for (const project of fs.readdirSync(root)) {
    const candidate = path.join(root, project, `${sessionId}${suffix}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findSessionDir(home, sessionId, cwd) {
  return findIn(sessionsRoot(home), sessionId, cwd, '');
}

function loadEvents(sessionDir) {
  const dir = path.join(sessionDir, 'segments');
  if (!fs.existsSync(dir)) return [];
  let events = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    events = events.concat(readJsonl(path.join(dir, file)));
  }
  return events.filter((e) => e && typeof e.type === 'string' && e.ts);
}

function groupTurns(events, sessionId) {
  const turns = new Map();
  for (const e of events) {
    const turnId = field(e, FIELDS.turnId);
    // Hook events carry the session id where a turn id would be.
    if (typeof turnId !== 'string' || turnId === sessionId) continue;
    if (!/^[0-9a-f-]{16,}$/i.test(turnId)) continue;
    if (!turns.has(turnId)) turns.set(turnId, []);
    turns.get(turnId).push(e);
  }
  return turns;
}

function assistantResponses(transcriptPath) {
  const responses = new Map();
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return responses;
  for (const entry of readJsonl(transcriptPath)) {
    if (entry.type !== TRANSCRIPT.assistant || !entry.message || !Array.isArray(entry.message.content)) continue;
    const stamp = Date.parse(entry.timestamp || entry.ts || '');
    const key = entry.message.id || (Number.isFinite(stamp) ? `@${stamp}` : '?');
    let response = responses.get(key);
    if (!response) {
      response = { ts: Number.isFinite(stamp) ? stamp : 0, text: '', realTokens: 0 };
      responses.set(key, response);
    }
    if (Number.isFinite(stamp)) response.ts = Math.max(response.ts, stamp);
    const usage = entry.message.usage;
    if (usage) response.realTokens += Number(usage.output_tokens ?? usage.completion_tokens) || 0;
    for (const block of entry.message.content) response.text += blockText(block);
  }
  return responses;
}

// The measurement window for a turn is delimited by the model's own end-of-
// answer CLI call: everything up to and including the segment that made that
// call. Deriving it from the log (not from a hand-off) is what makes the CLI
// and the Stop hook agree to the byte — both see the same call, so both stop at
// the same place. Only the short quote the model writes afterwards is excluded.
//
// The timestamp taken is the latest event carrying that command, which in
// practice is `tool.shell.started` (the shell actually starting, ~3s after
// `tool.requested`). That lateness is load-bearing: the answering segment's
// response.completed lands tens of milliseconds *after* the tool request, so a
// boundary taken at the request would classify the whole answer as "after the
// call" and drop it.
function quoteBoundary(events) {
  let at = null;
  for (const e of events) {
    if (cliInvocation(e)) {
      const ts = Date.parse(e.ts);
      if (Number.isFinite(ts) && (at == null || ts > at)) at = ts;
    }
  }
  return at;
}

function buildTurnMetrics(turnId, events, responses, options = {}) {
  const sorted = events.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const at = (logical) => sorted.find((e) => isType(e, logical));
  const of = (logical) => sorted.filter((e) => isType(e, logical));

  const startEvent = at('turnStarted') || at('promptSubmitted') || sorted[0];
  const turnStart = Date.parse(startEvent.ts);
  const turnEnd = sorted.reduce((acc, e) => Math.max(acc, Date.parse(e.ts)), turnStart);

  const segments = [];
  const byId = new Map();
  for (const e of of('requestStarted')) {
    const segment = {
      start: Date.parse(e.ts),
      end: null,
      realTokens: 0,
      inputTokens: 0,
      requestId: field(e, FIELDS.requestId),
    };
    segments.push(segment);
    if (segment.requestId) byId.set(segment.requestId, segment);
  }
  let realOutput = 0;
  for (const e of of('responseCompleted')) {
    const id = field(e, FIELDS.requestId);
    const segment = (id && byId.get(id)) || { start: Date.parse(e.ts), end: null, realTokens: 0, inputTokens: 0 };
    if (!segments.includes(segment)) segments.push(segment);
    segment.end = Date.parse(e.ts);
    segment.realTokens += Number(field(e, FIELDS.outputTokens)) || 0;
    segment.inputTokens += Number(field(e, FIELDS.inputTokens)) || 0;
  }
  segments.sort((a, b) => a.start - b.start);

  const warnings = [];
  const boundaryMs = options.boundaryMs ?? quoteBoundary(sorted);
  const windowSource = boundaryMs != null ? 'quote' : 'end';
  const end = Math.min(boundaryMs ?? turnEnd, turnEnd);

  // The user message that opened this measurement is the last prompt submitted
  // at or before the boundary. Deriving it from the log — rather than from the
  // hook's clock — is what lets the CLI and the Stop hook compute the identical
  // window without handing anything to each other.
  let promptMs = null;
  for (const e of of('promptSubmitted')) {
    const ts = Date.parse(e.ts);
    if (ts <= end + WINDOW_SLACK_MS && (promptMs == null || ts > promptMs)) promptMs = ts;
  }

  let inWindow = segments;
  if (boundaryMs != null) {
    // A segment counts only if it had already finished when the boundary was
    // recorded — not merely if it had started. That distinction is what keeps the
    // quoted line and the archived line identical: a segment still in flight when
    // the CLI runs carries no tokens yet, so counting it would make the CLI report
    // less than the Stop hook, which later sees the same segment completed. Do not
    // "improve" this to a start-based test.
    inWindow = segments.filter((s) => s.end != null && s.end <= boundaryMs);
    const excluded = segments.filter((s) => !inWindow.includes(s));
    const excludedTokens = excluded.reduce((acc, s) => acc + (s.realTokens || 0), 0);
    const totalTokens = segments.reduce((acc, s) => acc + (s.realTokens || 0), 0);
    // Only the model's own short quote legitimately trails the CLI call. A large
    // trailing share means the command ran early, so the number is missing real
    // work — say so instead of presenting it as the turn.
    if (totalTokens > 0 && excludedTokens / totalTokens > EARLY_BOUNDARY_SHARE) {
      warnings.push(
        `统计命令在本轮结束前 ${Math.round((turnEnd - boundaryMs) / 1000)}s 就被调用，漏掉 ${excludedTokens} tok（约 ${Math.round((100 * excludedTokens) / totalTokens)}%）——应把该命令作为最后一个动作`,
      );
    }
  }

  // Qoder reuses one turn_id across several user messages, so narrow to the
  // segments that start after the prompt that opened this measurement.
  const selected = (promptMs != null ? inWindow.filter((s) => s.start >= promptMs - WINDOW_SLACK_MS) : inWindow)
    .slice()
    .sort((a, b) => a.start - b.start);
  const noSegmentsInWindow = selected.length === 0;
  const start = selected.length ? selected[0].start : promptMs ?? turnStart;

  const turnResponses = [...responses.values()]
    .filter((r) => r.ts >= start - WINDOW_SLACK_MS && r.ts <= end + WINDOW_SLACK_MS)
    .sort((a, b) => a.ts - b.ts);
  const estimatedTokens = turnResponses.reduce((acc, r) => acc + estimateTokens(r.text), 0);
  const responseReal = turnResponses.reduce((acc, r) => acc + r.realTokens, 0);

  const windowRealOutput = selected.reduce((acc, s) => acc + (s.realTokens || 0), 0);
  const realInput = selected.reduce((acc, s) => acc + (s.inputTokens || 0), 0);
  const hasReal = windowRealOutput > 0 || responseReal > 0;

  // A transcript response is written when the model finishes, so its timestamp
  // lines up with the matching model.response.completed event. Retries and
  // failed attempts mean the counts can differ, hence nearest-neighbour pairing
  // instead of a positional zip.
  const secondsOf = (segment) => (segment.end == null ? 0 : (segment.end - segment.start) / 1000);
  const taken = new Set();
  const tokensOf = selected.map((segment) => {
    if (!segment.end) return 0;
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < turnResponses.length; i += 1) {
      if (taken.has(i)) continue;
      const gap = Math.abs(turnResponses[i].ts - segment.end);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    if (best === -1 || bestGap > PAIRING_SLACK_MS) return -1;
    taken.add(best);
    return estimateTokens(turnResponses[best].text);
  });

  const matched = tokensOf.filter((t) => t >= 0);
  let fallbackPerSecond = 0;
  if (matched.length !== selected.length) {
    const unmatched = estimatedTokens - matched.reduce((acc, t) => acc + t, 0);
    const restSeconds = selected.reduce((acc, s, i) => (tokensOf[i] < 0 ? acc + secondsOf(s) : acc), 0);
    const totalSeconds = selected.reduce((acc, s) => acc + secondsOf(s), 0);
    fallbackPerSecond =
      restSeconds > 0 && unmatched > 0 ? unmatched / restSeconds : estimatedTokens / Math.max(totalSeconds, 1);
  }

  let peak = 0;
  let genSeconds = 0;
  let ratedSegments = 0;
  for (let i = 0; i < selected.length; i += 1) {
    const seconds = secondsOf(selected[i]);
    // Sub-200 ms segments are bookkeeping artefacts, not generation; their rate
    // is meaningless and would dominate the peak.
    if (!(seconds >= MIN_SEGMENT_SECONDS)) continue;
    ratedSegments += 1;
    genSeconds += seconds;
    const tokens = hasReal
      ? selected[i].realTokens || 0
      : tokensOf[i] >= 0
        ? tokensOf[i]
        : seconds * fallbackPerSecond;
    if (tokens > 0 && tokens / seconds > peak) peak = tokens / seconds;
  }

  const inWindowEvents = (logical) =>
    sorted.filter((e) => isType(e, logical)).filter((e) => Date.parse(e.ts) >= start && Date.parse(e.ts) <= end);
  const firstEvent = inWindowEvents('toolRequested')[0] || inWindowEvents('responseCompleted')[0];
  const firstTokenMs = firstEvent ? Date.parse(firstEvent.ts) - start : null;

  const wallSeconds = (end - start) / 1000;
  const tokens = hasReal ? windowRealOutput : estimatedTokens;

  return {
    turnId,
    startedAt: new Date(start).toISOString(),
    lastEventAt: new Date(end).toISOString(),
    tokens,
    tokenSource: hasReal ? 'reported' : 'estimated',
    reportedOutputTokens: windowRealOutput,
    reportedInputTokens: realInput,
    estimatedTokens,
    wallSeconds,
    genSeconds: genSeconds > 0 ? genSeconds : wallSeconds,
    firstTokenMs,
    segments: ratedSegments,
    requests: selected.length,
    rate: tokens > 0 && genSeconds > 0 ? tokens / genSeconds : 0,
    peakRate: peak,
    noSegmentsInWindow,
    window: { promptMs, boundaryMs, source: windowSource, segmentsTotal: segments.length },
    warnings,
  };
}

export function computeStats(options = {}) {
  const home = options.home || qoderHome();
  const sessionId = options.sessionId;
  if (!sessionId) return { error: 'missing-session-id', detail: 'no session id was supplied' };
  const sessionDir = findSessionDir(home, sessionId, options.cwd);
  if (!sessionDir) {
    return {
      error: 'no-session-log',
      detail: `no segment log for session ${sessionId} under ${sessionsRoot(home)}`,
    };
  }

  const events = loadEvents(sessionDir);
  const format = probe(events);
  if (!format.ok) return { error: format.reason, detail: format.detail, sessionDir };

  const turns = groupTurns(events, sessionId);
  const ordered = [...turns.entries()]
    .map(([id, evs]) => ({ id, events: evs, start: Math.min(...evs.map((e) => Date.parse(e.ts))) }))
    .filter((t) => Number.isFinite(t.start))
    .sort((a, b) => a.start - b.start);

  const transcriptPath = options.transcriptPath || findTranscript(home, sessionId, options.cwd);
  const responses = assistantResponses(transcriptPath);
  const build = (t) => buildTurnMetrics(t.id, t.events, responses, { afterMs: options.afterMs });
  const all = ordered.map(build);

  // The Stop hook names the finished turn outright; trust it over "latest on
  // disk", which is often one of Qoder's background sub-session turns. Narrow
  // the reported turn only — session totals always cover the whole session.
  let turnStats = all;
  if (options.turnId) turnStats = all.filter((t) => t.turnId === options.turnId);
  const last = turnStats[turnStats.length - 1] || null;

  const totals = all.reduce(
    (acc, t) => {
      acc.tokens += t.tokens;
      acc.genSeconds += t.genSeconds;
      acc.segments += t.segments;
      acc.wallSeconds += t.wallSeconds;
      acc.peakRate = Math.max(acc.peakRate, t.peakRate);
      if (t.tokenSource === 'reported') acc.reportedTurns += 1;
      else acc.estimatedTurns += 1;
      return acc;
    },
    { tokens: 0, genSeconds: 0, segments: 0, wallSeconds: 0, peakRate: 0, reportedTurns: 0, estimatedTurns: 0 },
  );

  // A session can straddle the QODERCN_EXPOSE_TOKEN_USAGE flip, so derive the
  // label from every turn rather than the newest one — otherwise one estimated
  // tail stamps "~" onto a total that is mostly measured.
  const source =
    totals.reportedTurns === 0 ? 'estimated' : totals.estimatedTurns === 0 ? 'reported' : 'mixed';

  return {
    sessionId,
    sessionDir,
    transcriptPath,
    turn: last,
    turns: turnStats,
    session: {
      tokens: totals.tokens,
      genSeconds: totals.genSeconds,
      segments: totals.segments,
      wallSeconds: totals.wallSeconds,
      rate: totals.tokens > 0 && totals.genSeconds > 0 ? totals.tokens / totals.genSeconds : 0,
      peakRate: totals.peakRate,
      turnCount: all.length,
      reportedTurns: totals.reportedTurns,
      estimatedTurns: totals.estimatedTurns,
      tokenSource: source,
    },
  };
}

// A turn with no output tokens and no ratable segment is bookkeeping, not a
// measurement — a background sub-session's turn, or one that never reached the
// model. The CLI prints nothing for it, so the Stop hook must archive nothing
// for it either: the two used to disagree, leaving rows in history that no chat
// line could ever correspond to.
export function measurable(turn) {
  return Boolean(turn && turn.tokens > 0 && turn.segments > 0 && !turn.noSegmentsInWindow);
}

const NUM = new Intl.NumberFormat('en-US');

export function recentSessions(home, cwd, limit = 5) {
  const root = sessionsRoot(home);
  if (!fs.existsSync(root)) return [];
  const sanitized = cwd ? path.join(root, sanitizeProject(cwd)) : null;
  const scoped = sanitized && fs.existsSync(sanitized) ? sanitized : root;
  const out = [];
  for (const entry of fs.readdirSync(scoped, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(scoped, entry.name);
    if (!fs.existsSync(path.join(dir, 'segments'))) continue;
    const stat = fs.statSync(dir);
    const stats = computeStats({ home, sessionId: entry.name, cwd });
    const transcript = Boolean(findTranscript(home, entry.name, cwd));
    const turnCount = stats.turns?.length || 0;
    out.push({
      sessionId: entry.name,
      mtime: stat.mtimeMs,
      turns: turnCount,
      segments: stats.turns?.reduce((acc, t) => acc + t.segments, 0) || 0,
      transcript,
      // Only a session with no transcript *and* no completed turn looks like a
      // Qoder background sub-session. A headless run (--input-format stream-json)
      // and a session mid-first-turn also have no transcript, and labelling
      // those "background" was wrong.
      background: !transcript && turnCount === 0,
      error: stats.error || null,
    });
  }
  // Real user sessions own a transcript; Qoder's background sub-sessions do not,
  // and they are usually the most recently touched. Rank transcripts first.
  return out.sort((a, b) => Number(b.transcript) - Number(a.transcript) || b.mtime - a.mtime).slice(0, limit);
}

export function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return 'n/a';
  return NUM.format(Number(value.toFixed(digits)));
}

export function formatStatsLine(stats) {
  const t = stats.turn;
  if (!t) return null;
  const mark = t.tokenSource === 'estimated' ? '~' : '';
  const first = t.firstTokenMs != null ? `${(t.firstTokenMs / 1000).toFixed(1)}s` : '-';
  const parts = [
    `⚡ ${formatNumber(t.rate)} tok/s(本轮)`,
    `首字 ${first}`,
    `输出 ${mark}${NUM.format(Math.round(t.tokens))} tok / 生成 ${formatNumber(t.genSeconds)}s`,
  ];
  // A single-segment turn's "peak" is just its own rate; showing it is noise.
  if (t.segments > 1) parts.push(`${t.segments} 段 / 峰 ${formatNumber(t.peakRate)}`);
  return parts.join(' · ');
}

export function formatTurnLine(stats) {
  const line = formatStatsLine(stats);
  if (!line) return null;
  // No session cumulative here: it would blend pre-flag estimated turns with
  // post-flag reported ones behind a single number.
  const at = new Date(stats.turn.lastEventAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  return `${line} · ⏱ ${at}`;
}
