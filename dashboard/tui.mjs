#!/usr/bin/env node
// Qoder tok/s —— 终端常驻监控条。
//
// 为什么有这个：桌面聊天界面不渲染钩子写的统计行，而桌面悬浮条是另一个窗口。
// Qoder 自带集成终端（xterm + node-pty），所以把这条数据画在终端面板里，
// 就成了"在 Qoder 窗口内、跟着它最小化、不经过模型"的显示位。
//
//   node dashboard/tui.mjs             常驻刷新（Ctrl+C 退出）
//   node dashboard/tui.mjs --once      画一帧就退出
//   node dashboard/tui.mjs --plain     不带 ANSI 颜色/光标控制（便于记录与测试）
//   node dashboard/tui.mjs --dir <p>   指定插件数据目录
//   node dashboard/tui.mjs --spark 40  趋势图保留多少轮（默认 24）
//
// 它只读插件自己归档的两个文件，不解析 Qoder 会话日志，也不 import runtime/：
//   latest.json     Stop 钩子每轮重写
//   history.jsonl   每轮一行
// 依赖越少，越不容易跟着 Qoder 版本一起坏。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- 参数 -------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, d) => {
  const i = argv.indexOf(f);
  return i > -1 && argv[i + 1] ? argv[i + 1] : d;
};

const ONCE = has('--once');
const PLAIN = has('--plain');
const SPARK_TURNS = Math.max(1, Number(valueOf('--spark', 24)) || 24);
const INTERVAL_MS = Math.max(200, Number(valueOf('--interval', 1000)) || 1000);

// --- 数据目录：与 overlay.ps1 同一套规则，外加 glob 兜底 ---------------------
//
// 目录名是 `<插件名>-<marketplace>`，所以硬写 `token-stats-local` 在别的
// marketplace 下就找不到。先试字面量，再 glob `token-stats*` 取最新的那个。
function resolveDataDir() {
  const explicit = valueOf('--dir', null);
  if (explicit) return explicit;

  const home = process.env.QODER_HOME || path.join(os.homedir(), '.qoder-cn');
  const candidates = [
    process.env.QODER_PLUGIN_DATA,
    process.env.CLAUDE_PLUGIN_DATA,
    path.join(home, 'plugins', 'data', 'token-stats-local'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'latest.json'))) return dir;
  }

  const root = path.join(home, 'plugins', 'data');
  let best = null;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!/^token-stats/.test(name)) continue;
      const dir = path.join(root, name);
      const latest = path.join(dir, 'latest.json');
      if (!fs.existsSync(latest)) continue;
      const at = fs.statSync(latest).mtimeMs;
      if (!best || at > best.at) best = { dir, at };
    }
  } catch {
    /* 没有数据目录不是错误，只是还没跑过一轮 */
  }
  return best ? best.dir : candidates[candidates.length - 1] || path.join(home, 'plugins', 'data', 'token-stats-local');
}

const DATA_DIR = resolveDataDir();
const LATEST = path.join(DATA_DIR, 'latest.json');
const HISTORY = path.join(DATA_DIR, 'history.jsonl');

// --- 读数 -------------------------------------------------------------------

function readLatest() {
  try {
    return JSON.parse(fs.readFileSync(LATEST, 'utf8'));
  } catch {
    return null;
  }
}

// 只读文件尾部：history.jsonl 会一直长，趋势图只要最后几十行。
function readHistory(tailBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(HISTORY);
    const start = Math.max(0, stat.size - tailBytes);
    const fd = fs.openSync(HISTORY, 'r');
    let raw;
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 半行是写入中的正常现象 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// --- 格式化 -----------------------------------------------------------------

const NUM = new Intl.NumberFormat('en-US');
const fmt = (v, d = 1) => (Number.isFinite(v) ? NUM.format(Number(v.toFixed(d))) : '-');

// 终端里的"紧凑"数字：1 万以上换算成 k/M，避免长行被挤断。
function compact(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1e4) return `${fmt(v / 1000, 1)}k`;
  if (v < 1e6) return `${Math.round(v / 1000)}k`;
  return `${fmt(v / 1e6, 1)}M`;
}

const SPARK = '▁▂▃▄▅▆▇█';
function sparkline(values, width) {
  const vs = values.filter((v) => Number.isFinite(v)).slice(-width);
  if (vs.length === 0) return '';
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  return vs
    .map((v) => SPARK[Math.max(0, Math.min(7, Math.floor(((v - min) / span) * 7.999)))])
    .join('');
}

// --- 颜色（PLAIN 模式下全部退化成空串） --------------------------------------

const C = PLAIN
  ? new Proxy({}, { get: () => '' })
  : {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      green: '\x1b[92m',
      amber: '\x1b[93m',
      cyan: '\x1b[96m',
      grey: '\x1b[90m',
    };

// --- 显示宽度：终端里 CJK 占两列，按码点数算会让右对齐与截断全部失准 --------

const ANSI_RE = /\x1b\[[0-9;]*m/g;
// 东亚宽字符（够用的近似集合）。emoji 与 em dash 属于 ambiguous，多数等宽终端按 1 列，
// 这里也按 1 列算，并在截断时留出安全边际。
const WIDE_RE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function dispWidth(s) {
  let n = 0;
  for (const ch of String(s).replace(ANSI_RE, '')) n += WIDE_RE.test(ch) ? 2 : 1;
  return n;
}

// 按显示宽度裁剪，保留 ANSI 序列，末尾补省略号与 reset（否则颜色会漏到下一行）。
function clip(s, width) {
  const str = String(s);
  if (dispWidth(str) <= width) return str;
  let out = '';
  let n = 0;
  const budget = Math.max(0, width - 2); // 省略号 + 安全边际
  let i = 0;
  while (i < str.length) {
    const esc = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    const ch = str[i];
    const w = WIDE_RE.test(ch) ? 2 : 1;
    if (n + w > budget) break;
    out += ch;
    n += w;
    i += 1;
  }
  return out + '…' + C.reset;
}

// 按预算逐项拼接：放得下才加，加不下就停。保证每一项都是完整的。
function fitFields(fields, budget) {
  const out = [];
  let used = 0;
  for (const f of fields) {
    const w = dispWidth(f);
    const add = out.length ? w + 3 : w;
    if (used + add > budget) break;
    out.push(f);
    used += add;
  }
  return out.join('   ');
}

// 左右两端对齐。放不下时丢掉右半，而不是让那一行溢出换行 —— 溢出会把常驻画面的行数搞乱。
function joinLR(left, right, width) {
  const room = width - dispWidth(left) - dispWidth(right);
  return room >= 1 ? left + ' '.repeat(room) + right : left;
}

// --- 主体 -------------------------------------------------------------------

function collect() {
  const latest = readLatest();
  const rows = readHistory();
  const rates = rows.map((r) => Number(r.rate)).filter((v) => Number.isFinite(v) && v > 0);
  return { latest, rows, rates, now: Date.now() };
}

// 纯函数：给定数据与宽度，产出要打印的行。--plain 与常驻模式共用它，
// 所以测试看到的就是屏幕上看到的。
function render(state, width) {
  const lines = [];
  const { latest } = state;

  if (!latest || !latest.turn) {
    return [
      `${C.dim}Qoder tok/s${C.reset}  ${C.grey}等待第一轮…（回答结束后会出现）${C.reset}`,
      `  ${C.grey}数据目录 ${DATA_DIR}${C.reset}`,
    ].map((l) => clip(l, width));
  }

  const t = latest.turn;
  const age = Math.max(0, (state.now - Date.parse(latest.at)) / 1000);
  const stale = age > 600;
  const warned = Array.isArray(latest.warnings) && latest.warnings.length > 0;

  // 第 1 行：谁 + 什么时候 ＋ 新鲜度
  const stamp = new Date(latest.at).toLocaleTimeString('zh-CN', { hour12: false });
  const fresh = age < 90 ? `${C.green}${Math.round(age)}s 前${C.reset}` : `${C.grey}${Math.round(age / 60)} 分钟前${C.reset}`;
  const right = `${C.grey}⏱ ${stamp}${C.reset}  ${fresh}`;
  const title = `${C.bold}Qoder tok/s${C.reset} ${C.grey}· 上一轮${C.reset}`;
  lines.push(joinLR(title, right, width));

  // 第 2 行：本轮的硬指标。窄终端逐项丢，而不是把某一项截一半 ——
  // 「输出 ~3…」这种半截数字比少显示一项更糟。
  const mark = t.tokenSource === 'estimated' ? '~' : '';
  const fields = [
    `${stale ? C.grey : C.green}${C.bold}⚡ ${fmt(t.rate)} tok/s${C.reset}`,
    `首字 ${t.firstTokenMs != null ? `${(t.firstTokenMs / 1000).toFixed(1)}s` : '-'}`,
    `输出 ${mark}${NUM.format(Math.round(t.tokens))} tok`,
  ];
  if (width >= 76) {
    fields.push(`生成 ${fmt(t.genSeconds)}s`);
    if (t.segments > 1) fields.push(`${t.segments} 段 · 峰 ${fmt(t.peakRate)}`);
  }
  lines.push('  ' + fitFields(fields, width - 2));

  // 第 3 行：趋势 + 会话累计。趋势图是终端独有的——悬浮条只有一行放不下。
  if (width >= 76) {
    const spark = sparkline(state.rates, Math.min(SPARK_TURNS, Math.max(8, width - 56)));
    const s = latest.session || {};
    const parts = [];
    if (spark) {
      const win = state.rates.slice(-SPARK_TURNS);
      parts.push(`${C.grey}近 ${win.length} 轮${C.reset} ${C.cyan}${spark}${C.reset}`);
      if (win.length > 1) parts.push(`${C.grey}均 ${fmt(win.reduce((a, b) => a + b, 0) / win.length)}${C.reset}`);
    }
    if (Number.isFinite(s.rate)) {
      parts.push(`${C.grey}会话${C.reset} ${fmt(s.rate)} tok/s · ${compact(s.tokens)} tok · ${s.turnCount || 0} 轮`);
    }
    if (parts.length) lines.push('  ' + fitFields(parts, width - 2));
  }

  // 告警单独占一行：它常常很长，和别的挤在一起会被截掉关键信息。
  if (warned) lines.push(`  ${C.amber}⚠ ${latest.warnings[0]}${C.reset}`);

  const notes = [];
  if (t.tokenSource === 'estimated') {
    notes.push(`${C.amber}~ 估算值（服务端 usage 被清零）${C.reset}`);
  } else if (t.tokenSource === 'reported') {
    notes.push(`${C.grey}来源 服务端上报（真实值）${C.reset}`);
  }
  if (stale) notes.push(`${C.grey}数据超 10 分钟未更新${C.reset}`);
  if (notes.length) lines.push('  ' + notes.join('   '));

  // 最后一道防线：无论上面哪一行算错，都不允许水平溢出 —— 溢出会折行，
  // 常驻画面的行数就乱了（擦除逻辑按行工作）。
  return lines.map((l) => clip(l, width));
}

// --- 输出 -------------------------------------------------------------------

function frameLines() {
  const cols = Number(valueOf('--width', 0)) || Number(process.stdout.columns) || 100;
  return render(collect(), Math.min(cols, 120));
}

if (ONCE) {
  process.stdout.write(frameLines().join('\n') + '\n');
  process.exit(0);
}

// 常驻：用备用屏幕，退出后原样恢复，不污染用户的滚动历史。
// 非 TTY（被重定向到文件、或跑在管道里）时不发这些序列，否则日志里会混进控制码。
// --alt / --no-alt 可以强制覆盖：有些终端里 isTTY 判断不准。
const TTY = Boolean(process.stdout.isTTY);
const USE_ALT = has('--no-alt') ? false : has('--alt') ? true : !PLAIN && TTY;
const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';

if (USE_ALT) process.stdout.write(ALT_ON + HIDE);
let drawn = 0;
let timer = null;

function draw() {
  const lines = frameLines();
  const out = [];
  if (USE_ALT) {
    out.push('\x1b[H');
    for (let i = 0; i < Math.max(drawn, lines.length); i += 1) {
      out.push('\x1b[2K');
      if (i < lines.length) out.push(lines[i]);
      if (i < Math.max(drawn, lines.length) - 1) out.push('\n');
    }
  } else {
    out.push(lines.join('\n') + '\n');
  }
  process.stdout.write(out.join(''));
  drawn = lines.length;
}

function cleanup() {
  if (timer) clearInterval(timer);
  timer = null;
  if (USE_ALT) process.stdout.write(SHOW + ALT_OFF);
}

function quit() {
  cleanup();
  process.stdout.write('\n');
  process.exit(0);
}

// Windows 上 Ctrl+C 是 SIGINT、Ctrl+Break 是 SIGBREAK；SIGHUP 覆盖终端被关掉的情况。
// 少接一个，用户就可能把终端留在备用屏里。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, quit);
  } catch {
    /* 该平台没有这个信号 */
  }
}
process.on('exit', cleanup);
process.on('uncaughtException', (e) => {
  cleanup();
  process.stderr.write(`tui: ${e && e.message}\n`);
  process.exit(1);
});

draw();
timer = setInterval(draw, INTERVAL_MS);
