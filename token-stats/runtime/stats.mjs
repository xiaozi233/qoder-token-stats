// Token/throughput statistics computed from Qoder's own session event logs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CJK ideographs, kana and hangul cost ~1 token per character; a latin run collapses to one.
const CJK_ALL =
  /[　-〿぀-ヿ㐀-䶿一-鿿가-힯🀀-🫿]/gu;
const WORD = /[A-Za-z0-9_]+/g;

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
  return dir.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

function groupTurns(events) {
  const turns = new Map();
  for (const e of events) {
    if (!e.turn_id || typeof e.turn_id !== 'string') continue;
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

function buildTurnMetrics(turnId, events, responses) {
  const sorted = events.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const at = (type) => sorted.find((e) => e.type === type);
  const of = (type) => sorted.filter((e) => e.type === type);

  const startEvent = at('turn.started') || at('input.prompt.submitted') || sorted[0];
  const start = Date.parse(startEvent.ts);
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

  const turnResponses = [...responses.values()]
    .filter((r) => r.ts >= start - 2000 && r.ts <= end + 2000)
    .sort((a, b) => a.ts - b.ts);
  const estimatedTokens = turnResponses.reduce((acc, r) => acc + estimateTokens(r.text), 0);
  const responseReal = turnResponses.reduce((acc, r) => acc + r.realTokens, 0);
  if (responseReal > 0) hasReal = true;

  let segmentTokens;
  if (hasReal) {
    segmentTokens = () => 0;
  } else if (turnResponses.length === segments.length && segments.length > 0) {
    segmentTokens = (i) => estimateTokens(turnResponses[i].text);
  } else {
    const seconds = segments.reduce((acc, s) => acc + (s.end - s.start), 0);
    const perSecond = seconds > 0 ? estimatedTokens / seconds : 0;
    segmentTokens = (i) => (segments[i].end - segments[i].start) * perSecond;
  }

  let peak = 0;
  let genSeconds = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const seconds = segments[i].end == null ? 0 : (segments[i].end - segments[i].start) / 1000;
    if (!(seconds > 0)) continue;
    genSeconds += seconds;
    const tokens = hasReal ? segments[i].realTokens : segmentTokens(i);
    if (tokens > 0 && tokens / seconds > peak) peak = tokens / seconds;
  }

  const firstEvent = of('tool.requested')[0] || of('model.response.completed')[0];
  const firstTokenMs = firstEvent ? Date.parse(firstEvent.ts) - start : null;

  const wallSeconds = (end - start) / 1000;
  const tokens = hasReal ? Math.max(realOutput, responseReal) : estimatedTokens;

  return {
    turnId,
    startedAt: new Date(start).toISOString(),
    tokens,
    tokenSource: hasReal ? 'reported' : 'estimated',
    reportedOutputTokens: realOutput,
    reportedInputTokens: realInput,
    estimatedTokens,
    wallSeconds,
    genSeconds: genSeconds > 0 ? genSeconds : wallSeconds,
    firstTokenMs,
    segments: segments.length,
    rate: tokens > 0 && genSeconds > 0 ? tokens / genSeconds : 0,
    peakRate: peak,
  };
}

export function computeStats(options = {}) {
  const home = options.home || qoderHome();
  const sessionId = options.sessionId;
  if (!sessionId) return { error: 'missing session id' };
  const sessionDir = findSessionDir(home, sessionId, options.cwd);
  if (!sessionDir) return { error: `no session log for ${sessionId}` };

  const events = loadEvents(sessionDir);
  const turns = groupTurns(events);
  const ordered = [...turns.entries()]
    .map(([id, evs]) => ({ id, events: evs, start: Math.min(...evs.map((e) => Date.parse(e.ts))) }))
    .filter((t) => Number.isFinite(t.start))
    .sort((a, b) => a.start - b.start);

  const transcriptPath = findTranscript(home, sessionId, options.cwd);
  const responses = assistantResponses(transcriptPath);
  const turnStats = ordered.map((t) => buildTurnMetrics(t.id, t.events, responses));
  const last = turnStats[turnStats.length - 1] || null;

  const totals = turnStats.reduce(
    (acc, t) => {
      acc.tokens += t.tokens;
      acc.genSeconds += t.genSeconds;
      acc.segments += t.segments;
      acc.wallSeconds += t.wallSeconds;
      acc.peakRate = Math.max(acc.peakRate, t.peakRate);
      return acc;
    },
    { tokens: 0, genSeconds: 0, segments: 0, wallSeconds: 0, peakRate: 0 },
  );

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
      turnCount: turnStats.length,
      tokenSource: last ? last.tokenSource : 'none',
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

export function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return 'n/a';
  return NUM.format(Number(value.toFixed(digits)));
}

export function formatStatsLine(stats) {
  const t = stats.turn;
  if (!t) return null;
  const mark = t.tokenSource === 'estimated' ? '~' : '';
  const first = t.firstTokenMs != null ? `${(t.firstTokenMs / 1000).toFixed(1)}s` : 'n/a';
  return `⚡ ${formatNumber(t.rate)} tok/s(本轮) · 首字 ${first} · 输出 ${mark}${NUM.format(Math.round(t.tokens))} tok / 生成 ${formatNumber(t.genSeconds)}s · ${t.segments} 段 / 峰 ${formatNumber(t.peakRate)}`;
}
