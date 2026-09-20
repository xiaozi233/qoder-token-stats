// UserPromptSubmit hook: record when this turn started, and tell the model that
// the statistics line will arrive at the end of the turn.
//
// Qoder never renders a hook's stdout, so the visible line has to come from the
// model. The model cannot compute it, though: the number only exists once the
// answer is finished, and a command run mid-answer both misses the tail of the
// turn and has to pass Auto mode's classifier — which rejects an unrequested
// script every turn until the session's denial circuit breaker trips. So the
// Stop hook measures the finished turn and wakes the model to paste it; this
// hook introduces that line and stops the model from improvising one.
//
// The turn key is still minted and recorded: it is how `--current` finds *this*
// turn when a reader asks for the numbers by hand.

import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { appendError, recordTurn } from './archive.mjs';
import { rateLineDisabled } from './schema.mjs';

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

const turnKey = crypto.randomBytes(6).toString('hex');

const INSTRUCTION = [
  '',
  '【本轮统计】本轮的 token 速率统计由系统在本轮结束后算好，再作为一条 Stop 钩子反馈交给你，形如：',
  '⚡ 55.9 tok/s(本轮) · 首字 4.8s · 输出 ~3,389 tok / 生成 60.6s · 45 段 / 峰 84.6',
  '收到后把那一行原样放进 Markdown 引用块（新行行首加「> 」）贴在回复最末尾；一个数字都不要改写，也不要附加别的说明。',
  '本轮之内不要自己运行任何统计命令：统计要覆盖你写的全部正文，而命令只能在你回答中途执行，那样算出来的数字必然偏小。正常作答即可。',
  '注意：①若系统本轮没有把统计行交给你，就不要显示统计行；②绝不要凭记忆或估算自行编造这行数字。',
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

if (!rateLineDisabled()) {
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
