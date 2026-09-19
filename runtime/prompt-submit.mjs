// UserPromptSubmit hook: record when this turn started, then tell the model to
// measure it and quote the result.
//
// Qoder never renders a Stop hook's stdout, so the visible statistics line is
// produced by the model itself: it runs the CLI at the end of its answer and
// pastes the output. Each turn gets its own key — the hook mints one, records the
// turn's start time under it, and puts the key in the command it hands over — so
// the model reads back its own turn and can never be shown a previous one's
// numbers.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(runtimeDir, 'token-stats.mjs');

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
    setTimeout(finish, 1500);
  });
}

function configPath() {
  const home = process.env.QODER_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.qoder-cn');
  return path.join(home, 'token-stats.config.json');
}

function dataDir() {
  const fromEnv = process.env.QODER_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  const home = process.env.QODER_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.qoder-cn');
  const dir = fromEnv || path.join(home, 'plugins', 'data', 'token-stats-local');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const stateFile = () => path.join(dataDir(), 'state.json');

// Qoder fires UserPromptSubmit for its background sub-sessions too (recap
// generation, memory extraction) in the same cwd, so one shared slot ends up
// holding whichever prompt landed last. That is why a session's first turn showed
// no line at all: its transcript file is only written once the reply starts, so
// the old "is this a real session?" probe failed on exactly the turn it had to
// succeed on. Per-turn keys need no such probe — every caller reads its own entry.
const turnKey = crypto.randomBytes(6).toString('hex');
const MAX_TURNS = 32;

function recordTurn(entry) {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {};
  } catch {
    state = {};
  }
  const turns = Array.isArray(state.turns) ? state.turns : [];
  turns.push(entry);
  state.turns = turns.slice(-MAX_TURNS);
  // The unkeyed fields are what a bare `--current` falls back to, so only a
  // session that already owns a transcript may move them.
  if (entry.realSession) {
    state.sessionId = entry.sessionId;
    state.promptAt = entry.promptAt;
    state.cwd = entry.cwd;
  }
  fs.writeFileSync(stateFile(), JSON.stringify(state));
}

const INSTRUCTION = [
  '',
  '【本轮统计指令】本次回答收尾时（其他工作全部完成、输出最终总结文字之前）运行下面这条命令一次：',
  `node "${cli}" --current --key ${turnKey}`,
  '它会输出一行本轮的 token 速率统计。把该行原样放进 Markdown 引用块（新行行首加「> 」）贴在回复最末尾；不要改写数字，不要追加别的说明。',
  '注意：①本轮即使没有调用任何工具也要运行并显示——纯文字回答同样有真实的输出 token；②若命令没有任何输出，就不要显示统计行；③绝不要凭记忆或估算自行编造这行数字。',
].join('\n');

let payload = {};
try {
  payload = JSON.parse((await readStdin()) || '{}') || {};
} catch {
  payload = {};
}

let disabled = false;
try {
  disabled = JSON.parse(fs.readFileSync(configPath(), 'utf8')).tokenRateLine === false;
} catch {
  disabled = false;
}

if (!disabled) {
  try {
    recordTurn({
      key: turnKey,
      sessionId: payload.session_id || null,
      promptAt: Date.now(),
      cwd: payload.cwd || process.cwd(),
      realSession: Boolean(payload.transcript_path) && fs.existsSync(payload.transcript_path),
    });
  } catch {
    /* an unwritable state file costs the line, not the turn */
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: INSTRUCTION },
    }),
  );
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '' } }),
);
process.exit(0);
