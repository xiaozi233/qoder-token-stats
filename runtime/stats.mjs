// Token/throughput statistics computed from Qoder's own session event logs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CJK ideographs, kana and hangul cost ~1 token per character; a latin run collapses to one.
const CJK_ALL =
  /[　-〿぀-ヿ㐀-䶿一-鿿가-힯🀀-🫿]/gu;
const WORD = /[A-Za-z0-9_]+/g;
const MIN_SEGMENT_SECONDS = 0.2;

export function qoderHome() {
  return process.env.QODER_HOME || path.join(os.homedir(), '.qoder-cn');
}

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

function sanitizeProject(dir) {
  // Qoder replaces each separator run with a single dash but keeps the path's
  // own dashes, so `D:\test\x` becomes `D--test-x`, not `D-test-x`.
  return String(dir)
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-');
}

function readJsonl(file) {
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a partially flushed line is not worth failing over */
    }
  }
  return out;
}

function findSessionDir(home, sessionId, cwd) {
  const roots = [path.join(home, 'logs', 'sessions')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    if (cwd) {
      const direct = path.join(root, sanitizeProject(cwd), sessionId);
      if (fs.existsSync(direct)) return direct;
    }
    for (const project of fs.readdirSync(root)) {
      const candidate = path.join(root, project, sessionId);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function loadEvents(sessionDir) {
  const dir = path.join(sessionDir, 'segments');
  if (!fs.existsSync(dir)) return [];
  let events = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    events = events.concat(readJsonl(path.join(dir, file)));
  }
  return events.filter((e) => e && e.type && e.ts);
}

function groupTurns(events, sessionId) {
  const turns = new Map();
  for (const e of events) {
    // Hook events are stamped with the session id, not a real turn id.
    if (typeof e.turn_id !== 'string' || e.turn_id === sessionId) continue;
    if (!/^[0-9a-f-]{16,}$/i.test(e.turn_id)) continue;
    let turn = turns.get(e.turn_id);
    if (!turn) {
      turn = [];
      turns.set(e.turn_id, turn);
    }
    turn.push(e);
  }
  return turns;
}

function assistantResponses(transcriptPath) {
  const responses = new Map();
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return responses;
  for (const entry of readJsonl(transcriptPath)) {
    if (entry.type !== 'assistant' || !entry.message || !Array.isArray(entry.message.content)) continue;
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

function buildTurnMetrics(turnId, events, responses, sinceMs) {
  const sorted = events.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const at = (type) => sorted.find((e) => e.type === type);
  const of = (type) => sorted.filter((e) => e.type === type);

  const startEvent = at('turn.started') || at('input.prompt.submitted') || sorted[0];
  let start = Date.parse(startEvent.ts);
  const end = sorted.reduce((acc, e) => Math.max(acc, Date.parse(e.ts)), start);

  const segments = [];
  let realOutput = 0;
  let realInput = 0;
  let hasReal = false;
  const byId = new Map();
  for (const e of of('model.request.started')) {
    const segment = { start: Date.parse(e.ts), end: null, realTokens: 0 };
    segments.push(segment);
    if (e.request_id) byId.set(e.request_id, segment);
  }
  for (const e of of('model.response.completed')) {
    const segment = (e.request_id && byId.get(e.request_id)) || { start: Date.parse(e.ts), end: null, realTokens: 0 };
    if (!segments.includes(segment)) segments.push(segment);
    segment.end = Date.parse(e.ts);
    const out = Number(e.data && e.data.output_tokens) || 0;
    segment.realTokens += out;
    realOutput += out;
    realInput += Number(e.data && e.data.input_tokens) || 0;
    if (out > 0) hasReal = true;
  }
  segments.sort((a, b) => a.start - b.start);
  // Qoder reuses one turn_id across several user messages, so "the turn that
  // began after this prompt" is not a thing. Restricting to segments started
  // since the prompt is what actually isolates the current question.
  let noSegmentsInWindow = false;
  if (Number.isFinite(sinceMs)) {
    const only = segments.filter((s) => s.start >= sinceMs - 2000);
    if (only.length) {
      segments.length = 0;
      segments.push(...only);
      // Move the window forward to the first post-prompt segment; keeping the
      // turn's original start here would re-admit the earlier messages' tokens.
      start = segments[0].start;
      realOutput = segments.reduce((acc, s) => acc + (s.realTokens || 0), 0);
    } else {
      // Nothing in this window means the turn being measured predates the prompt,
      // so the numbers below are somebody else's turn. `--current` drops them.
      noSegmentsInWindow = true;
    }
  }

  const turnResponses = [...responses.values()]
    .filter((r) => r.ts >= start - 2000 && r.ts <= end + 2000)
    .sort((a, b) => a.ts - b.ts);
  const estimatedTokens = turnResponses.reduce((acc, r) => acc + estimateTokens(r.text), 0);
  const responseReal = turnResponses.reduce((acc, r) => acc + r.realTokens, 0);
  if (responseReal > 0) hasReal = true;

  // A transcript response is written when the model finishes, so its timestamp
  // lines up with the matching model.response.completed event. Retries and
  // failed attempts mean the counts can differ, hence nearest-neighbour pairing
  // instead of a positional zip.
  const secondsOf = (segment) => (segment.end == null ? 0 : (segment.end - segment.start) / 1000);
  const taken = new Set();
  const tokensOf = segments.map((segment) => {
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
    if (best === -1 || bestGap > 5000) return -1;
    taken.add(best);
    return estimateTokens(turnResponses[best].text);
  });

  const matched = tokensOf.filter((t) => t >= 0);
  let fallbackPerSecond = 0;
  if (matched.length !== segments.length) {
    const unmatched = estimatedTokens - matched.reduce((acc, t) => acc + t, 0);
    const restSeconds = segments.reduce((acc, s, i) => (tokensOf[i] < 0 ? acc + secondsOf(s) : acc), 0);
    fallbackPerSecond =
      restSeconds > 0 && unmatched > 0
        ? unmatched / restSeconds
        : estimatedTokens / Math.max(segments.reduce((acc, s) => acc + secondsOf(s), 0), 1);
  }

  let peak = 0;
  let genSeconds = 0;
  let ratedSegments = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const seconds = secondsOf(segments[i]);
    // Sub-200 ms segments are bookkeeping artefacts, not generation; their rate
    // is meaningless and would dominate the peak.
    if (!(seconds >= MIN_SEGMENT_SECONDS)) continue;
    ratedSegments += 1;
    genSeconds += seconds;
    const tokens = hasReal ? segments[i].realTokens : tokensOf[i] >= 0 ? tokensOf[i] : seconds * fallbackPerSecond;
    if (tokens > 0 && tokens / seconds > peak) peak = tokens / seconds;
  }

  const inWindow = (list) => list.filter((e) => Date.parse(e.ts) >= start);
  const firstEvent = inWindow(of('tool.requested'))[0] || inWindow(of('model.response.completed'))[0];
  const firstTokenMs = firstEvent ? Date.parse(firstEvent.ts) - start : null;

  const wallSeconds = (end - start) / 1000;
  const tokens = hasReal ? Math.max(realOutput, responseReal) : estimatedTokens;

  return {
    turnId,
    startedAt: new Date(start).toISOString(),
    lastEventAt: new Date(end).toISOString(),
    tokens,
    tokenSource: hasReal ? 'reported' : 'estimated',
    reportedOutputTokens: realOutput,
    reportedInputTokens: realInput,
    estimatedTokens,
    wallSeconds,
    genSeconds: genSeconds > 0 ? genSeconds : wallSeconds,
    firstTokenMs,
    segments: ratedSegments,
    requests: segments.length,
    rate: tokens > 0 && genSeconds > 0 ? tokens / genSeconds : 0,
    peakRate: peak,
    noSegmentsInWindow,
  };
}

export function computeStats(options = {}) {
  const home = options.home || qoderHome();
  const sessionId = options.sessionId;
  if (!sessionId) return { error: 'missing session id' };
  const sessionDir = findSessionDir(home, sessionId, options.cwd);
  if (!sessionDir) return { error: `no session log for ${sessionId}` };

  const events = loadEvents(sessionDir);
  const turns = groupTurns(events, sessionId);
  const ordered = [...turns.entries()]
    .map(([id, evs]) => ({ id, events: evs, start: Math.min(...evs.map((e) => Date.parse(e.ts))) }))
    .filter((t) => Number.isFinite(t.start))
    .sort((a, b) => a.start - b.start);

  const transcriptPath = options.transcriptPath || findTranscript(home, sessionId, options.cwd);
  const responses = assistantResponses(transcriptPath);
  const all = ordered.map((t) => buildTurnMetrics(t.id, t.events, responses));
  // The Stop hook names the finished turn outright; trust it over "latest on disk",
  // which is often one of Qoder's background sub-session turns. Narrow the reported
  // turn only — session totals always cover the whole session.
  let turnStats = all;
  if (options.turnId) turnStats = all.filter((t) => t.turnId === options.turnId);
  if (Number.isFinite(options.afterMs)) {
    // Re-measure the selected turn counting only segments that began after the
    // prompt, since a Qoder turn_id spans several user messages.
    const current = turnStats[turnStats.length - 1];
    const source = ordered.find((t) => t.id === current?.turnId);
    if (source) {
      const sliced = buildTurnMetrics(source.id, source.events, responses, options.afterMs);
      if (sliced.segments > 0) turnStats = [sliced];
    }
  }
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
    totals.reportedTurns === 0
      ? 'estimated'
      : totals.estimatedTurns === 0
        ? 'reported'
        : 'mixed';

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

function findTranscript(home, sessionId, cwd) {
  const root = path.join(home, 'projects');
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

const NUM = new Intl.NumberFormat('en-US');

export function recentSessions(home, cwd, limit = 5) {
  const root = path.join(home, 'logs', 'sessions');
  if (!fs.existsSync(root)) return [];
  const scoped = cwd && fs.existsSync(path.join(root, sanitizeProject(cwd)))
    ? path.join(root, sanitizeProject(cwd))
    : root;
  if (!fs.existsSync(scoped)) return [];
  const out = [];
  for (const entry of fs.readdirSync(scoped, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(scoped, entry.name);
    if (!fs.existsSync(path.join(dir, 'segments'))) continue;
    const stat = fs.statSync(dir);
    const { turns } = computeStats({ home, sessionId: entry.name, cwd }) || {};
    out.push({
      sessionId: entry.name,
      mtime: stat.mtimeMs,
      turns: turns?.length || 0,
      segments: turns?.reduce((acc, t) => acc + t.segments, 0) || 0,
      transcript: Boolean(findTranscript(home, entry.name, cwd)),
    });
  }
  // Real user sessions own a transcript; Qoder's background sub-sessions do not,
  // and they are usually the most recently touched. Rank transcripts first.
  return out
    .sort((a, b) => Number(b.transcript) - Number(a.transcript) || b.mtime - a.mtime)
    .slice(0, limit);
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
