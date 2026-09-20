// The Stop hook's wake: this turn's line only exists after the turn ends, so the
// hook measures it and hands it back to the model, which then pastes it.
//
// Everything here is pure — the hook owns the payload and the exit path, so the
// wake decision can be tested without a Qoder log.

// A wake costs the session one extra model iteration, so one that keeps failing
// must stop being attempted: FAIL_LIMIT failures in a row go quiet, then a single
// probe per SILENT_TURNS turns checks whether the model cooperates again.
export const FAIL_LIMIT = 3;
export const SILENT_TURNS = 8;

// A pending wake older than this never settled — the turn ended in an error, so
// its second Stop never came. Without a expiry one bad turn would silence the
// rest of the session.
export const PENDING_STALE_MS = 120000;

// The model may wrap the line in a blockquote, reflow spaces, or drop the clock
// suffix; the rate/latency/token fields before it are what must survive.
export function fingerprint(line) {
  return String(line || '')
    .split(' · ⏱ ')[0]
    .replace(/\s+/g, '');
}

export function isQuoted(text, line) {
  const fp = fingerprint(line);
  return Boolean(text) && fp.length > 0 && String(text).replace(/\s+/g, '').includes(fp);
}

// Any turn that already says a number out loud needs no wake — even when the
// numbers differ, because a `--current` run mid-answer measures less of the turn
// and waking anyway would put a second line under it. Shape, not content: the
// content is what the turn itself asked for.
const LINE_SHAPE = /⚡[\s\S]{0,90}tok\/s\(本轮\)/;

export function carriesLine(text) {
  return Boolean(text) && LINE_SHAPE.test(String(text));
}

export function blankGuard() {
  // -1, not 0: turn 1 of a session must be wakeable, and `silentUntil` is read
  // as "the last turn index that stays quiet".
  return { turns: 0, fails: 0, silentUntil: -1, pending: null };
}

export function shouldWake(guard, turnIndex, now = Date.now()) {
  const g = guard || blankGuard();
  if (turnIndex <= g.silentUntil) return false;
  if (g.pending && now - (g.pending.at || 0) < PENDING_STALE_MS) return false;
  return true;
}

export function markWoken(guard, turnIndex, line, at = Date.now()) {
  return { ...blankGuard(), ...(guard || {}), turns: turnIndex, pending: { line, at } };
}

// Called from the Stop that follows a wake. `fails` is deliberately not cleared on
// entering silence: that is what turns every later failure into a fresh silent
// window instead of a wake every turn.
export function settleWake(guard, quoted) {
  const g = { ...blankGuard(), ...(guard || {}), pending: null };
  if (quoted) {
    g.fails = 0;
    return { guard: g, enteredSilence: false };
  }
  g.fails += 1;
  const entering = g.fails === FAIL_LIMIT;
  if (entering) g.silentUntil = g.turns + SILENT_TURNS;
  return { guard: g, enteredSilence: entering };
}

export function wakeReason(line) {
  return [
    'token-stats: 本轮统计已完成。把下面这一行原样放进 Markdown 引用块（新行行首加「> 」），作为这条回复的唯一内容，也是你本轮的最后输出。',
    '不要改写、省略或补全其中任何数字，不要调用任何工具，也不要附加别的说明。',
    '',
    line,
  ].join('\n');
}

// Probe: does Qoder render a Stop hook's `systemMessage`? The SDK turns one into a
// `hook_system_message` message part for *any* event (`output.systemMessage &&
// !suppressOutput`), unlike stdout, which only reaches the model for
// SessionStart/UserPromptSubmit. A part type is not yet a rendered row, though —
// upstream zcode-tps-monitor shows its line exactly this way, and if Qoder's
// renderer draws it too then the model wake below is pure cost: an extra iteration
// per turn, plus the risk of a number copied wrong.
//
// Tagged, because an untagged line rendered by the client and the same line pasted
// by the model are indistinguishable from the chat alone. If the tag shows up, keep
// `systemMessage`, delete the wake and the tag together.
export const SYSTEM_MESSAGE_PROBE = true;

export function wakePayload(line) {
  const out = { decision: 'deny', reason: wakeReason(line) };
  if (SYSTEM_MESSAGE_PROBE) out.systemMessage = `〔探针〕${line}`;
  return out;
}
