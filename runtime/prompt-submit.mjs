// UserPromptSubmit hook: record when this turn started, then tell the model to
// measure it and quote the result.
//
// Qoder never renders a hook's stdout, so the visible statistics line is
// produced by the model itself: it runs the CLI at the end of its answer and
// pastes the output. Each turn gets its own key — the hook mints one, records
// the turn's start time under it, and puts the key in the command it hands
// over — so the model reads back its own turn and can never be shown a
// previous one's numbers.
//
// The instruction asks for the command as the *last* action, after the summary.
// That is not cosmetic: the metrics stop at the CLI call (so the CLI and the
// Stop hook agree exactly), which means everything written after it is not
// counted. Called before the summary, that excluded tail was 32% of the turn
// on average; called after it, only the short quote itself is excluded.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { appendError, archivePaths, recordTurn } from './archive.mjs';
import { qoderHome } from './schema.mjs';

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
    // A client that never closes stdin must not stall the prompt.
    setTimeout(finish, 1500);
  });
}

function configDisabled() {
  try {
    const { dir } = archivePaths();
    const config = JSON.parse(fs.readFileSync(path.join(qoderHome(), 'token-stats.config.json'), 'utf8'));
    void dir;
    return config.tokenRateLine === false;
  } catch {
    return false;
  }
}

const turnKey = crypto.randomBytes(6).toString('hex');

const INSTRUCTION = [
  '',
  '【本轮统计指令】本次回答的**最后一个动作**：先把所有总结文字写完，然后运行下面这条命令一次——',
  `node "${cli}" --current --key ${turnKey}`,
  '它会输出一行本轮的 token 速率统计。把该行原样放进 Markdown 引用块（新行行首加「> 」）贴在回复最末尾，这就是你本轮的最后输出；不要改写数字，不要追加别的说明。',
  '为什么必须是最后一个动作：统计在命令被调用的那一刻截断，之后再写的内容不计入。先写总结再运行，数字才完整。',
  '注意：①本轮即使没有调用任何工具也要运行并显示——纯文字回答同样有真实的输出 token；②若命令没有任何输出，就不要显示统计行；③绝不要凭记忆或估算自行编造这行数字。',
].join('\n');

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }),
  );
  process.exit(0);
}

let payload = {};
try {
  payload = JSON.parse((await readStdin()) || '{}') || {};
} catch (error) {
  appendError('prompt-submit:bad-payload', String(error && error.message));
  payload = {};
}

if (!configDisabled()) {
  try {
    recordTurn({
      key: turnKey,
      sessionId: payload.session_id || null,
      promptAt: Date.now(),
      cwd: payload.cwd || process.cwd(),
      // Qoder fires UserPromptSubmit for its background sub-sessions too (recap
      // generation, memory extraction); those own no transcript.
      realSession: Boolean(payload.transcript_path) && fs.existsSync(payload.transcript_path),
    });
  } catch (error) {
    // An unwritable state file costs the line, not the prompt — but it must be
    // findable, not swallowed.
    appendError('prompt-submit:state-write-failed', String(error && error.message), { key: turnKey });
  }
  emit(INSTRUCTION);
}

emit('');
