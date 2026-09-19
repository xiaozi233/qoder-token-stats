// UserPromptSubmit hook: record when this turn started, then tell the model to
// measure it and quote the result.
//
// Qoder never renders a Stop hook's stdout, so the visible statistics line is
// produced by the model itself: it runs the CLI at the end of its answer and
// pastes the output. `--current` makes that safe — the CLI prints nothing unless
// the turn actually began after the timestamp recorded here, so a previous
// turn's numbers can never be presented as this one's.

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

const INSTRUCTION = [
  '',
  '【本轮统计指令】本次回答收尾时（其他工作全部完成、输出最终总结文字之前）运行下面这条命令一次：',
  `node "${cli}" --current`,
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
  // Qoder fires UserPromptSubmit for its background sub-sessions too (recap
  // generation, memory extraction), and those prompts arrive *after* the real
  // user turn — so an unguarded hook lets a sub-session overwrite the state and
  // --current then finds no turn at all. A sub-session has no transcript file.
  const isRealSession = Boolean(payload.transcript_path) && fs.existsSync(payload.transcript_path);
  if (isRealSession) {
    try {
      fs.writeFileSync(
        stateFile(),
        JSON.stringify({
          sessionId: payload.session_id || null,
          promptAt: Date.now(),
          cwd: payload.cwd || process.cwd(),
        }),
      );
    } catch {
      /* a missing state file only costs the --current guard, not the turn */
    }
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: INSTRUCTION },
      }),
    );
    process.exit(0);
  }
}

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '' } }),
);
process.exit(0);
