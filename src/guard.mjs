/* ==========================================================================
   pumpbubble.fun — the group guard: join captcha and the welcome message

   Asked for next to the buybot, because Safeguard is the other bot every token
   group runs: *"guard captcha for group like safeguard has, and a welcome
   message that is auto-deleted when another person comes"*. So a group that
   already has @pumpbubblebot for buys does not need a second bot to stop the
   spam that arrives the minute a token trends.

   The captcha is Safeguard's *join captcha*, not its portal: a new member is
   muted on arrival and unmuted by tapping the emoji the message names, out of
   eight. Safeguard's own docs call that mode "not as secure as a portal,
   however it can stop spam", and that is the honest claim here too. The spam
   that floods a trending group is userbots that post on arrival and never
   press anything; a script that does press buttons guesses right one time in
   four with two tries, and every miss costs it a one-minute ban.

   This file is the state of one group, plain and portable like the tap arena:
   the `GroupGuard` Durable Object in worker/index.js is the box it lives in —
   one per group, with an alarm that removes whoever let their captcha expire
   — and server/dev.mjs holds them in memory. **No join touches KV**: the free
   tier's thousand writes a day are already spent elsewhere, and a raid is a
   hundred joins a minute.

   **Nobody is stored who did not stay.** A pending captcha holds the user id
   only until it is answered or expires, and then it is gone. There is no list
   of members, verified or otherwise — the rule the buybot was built on
   (CLAUDE.md, "Nobody is messaged who did not ask") applies here unchanged.
   ========================================================================== */

export const CAPTCHA = ['🐸', '🚀', '💎', '🔥', '🐶', '🌕', '👑', '⚡', '🍕', '🎯', '🦊', '🐳', '🍀', '🎲', '🧊', '🌵'];
export const OPTIONS = 8;          // buttons on the captcha, two rows of four
export const TRIES = 2;            // then a one-minute ban; rejoining is allowed
export const TTLS = [2, 5, 10];    // minutes to answer, picked in ⚙️ Settings → Guard
export const DUP_MS = 90_000;      // one join announced twice (service message + chat_member)
export const KICK_S = 60;          // "kick": a ban this short lifts itself

export class Guard {
  constructor(s = {}) {
    this.chatId = s.chatId || 0;
    this.pending = s.pending && typeof s.pending === 'object' ? s.pending : {};
    this.lastWelcome = s.lastWelcome || 0;
    this.recent = {};              // memory only: dedupe, never persisted
  }
  static from(s) { return new Guard(s || {}); }
  toJSON() { return { chatId: this.chatId, pending: this.pending, lastWelcome: this.lastWelcome }; }

  /* A join. With the captcha on, returns the challenge to post; the correct
     index stays here and never travels in a button. */
  join(uid, now, { captcha = false, ttlMin = 5, rnd = Math.random } = {}) {
    uid = String(uid);
    for (const k of Object.keys(this.recent)) if (now - this.recent[k] > DUP_MS) delete this.recent[k];
    if (this.recent[uid] || this.pending[uid]) return { dup: true };
    this.recent[uid] = now;
    if (!captcha) return { ok: true, captcha: false };
    const pool = CAPTCHA.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const options = pool.slice(0, OPTIONS);
    const answer = Math.min(OPTIONS - 1, Math.floor(rnd() * OPTIONS));
    const ttl = TTLS.includes(+ttlMin) ? +ttlMin : 5;
    const until = now + ttl * 60_000;
    /* the options stay here too, so a captcha answered in private chat can
       show the same eight the group was told about */
    this.pending[uid] = { at: now, until, answer, options, tries: 0, msg: 0 };
    return { ok: true, captcha: true, options, target: options[answer], until, ttl };
  }

  /* The captcha message's id, so an expiry or a pass can delete it. */
  setMsg(uid, msg) {
    const p = this.pending[String(uid)];
    if (p) p.msg = +msg || 0;
    return { ok: !!p };
  }

  /* The bot could not mute this member (not an admin, or lost the right):
     forget the challenge rather than leave a captcha nobody enforces. */
  drop(uid) {
    const p = this.pending[String(uid)];
    delete this.pending[String(uid)];
    return { ok: !!p, msg: p ? p.msg : 0 };
  }

  /* What the private-chat verification shows: never the answer's index. */
  peek(uid, now) {
    const p = this.pending[String(uid)];
    if (!p || now > p.until || !p.options) return { ok: false };
    return { ok: true, options: p.options, target: p.options[p.answer], until: p.until, left: TRIES - p.tries };
  }

  answer(uid, i, now) {
    uid = String(uid);
    const p = this.pending[uid];
    if (!p) return { result: 'none' };
    if (now > p.until) { delete this.pending[uid]; return { result: 'expired', msg: p.msg }; }
    if (+i === p.answer) { delete this.pending[uid]; return { result: 'ok', msg: p.msg }; }
    p.tries++;
    if (p.tries >= TRIES) { delete this.pending[uid]; return { result: 'fail', msg: p.msg }; }
    return { result: 'wrong', left: TRIES - p.tries };
  }

  /* Everyone whose time ran out, removed from pending as they are returned. */
  expired(now) {
    const out = [];
    for (const [uid, p] of Object.entries(this.pending)) {
      if (now > p.until) { out.push({ uid: +uid, msg: p.msg }); delete this.pending[uid]; }
    }
    return out;
  }

  nextDue() {
    let due = 0;
    for (const p of Object.values(this.pending)) if (!due || p.until < due) due = p.until;
    return due;
  }

  /* The newest welcome replaces the last one: returns the id to delete. */
  welcome(msg) {
    const prev = this.lastWelcome;
    this.lastWelcome = +msg || 0;
    return { prev: prev && prev !== this.lastWelcome ? prev : 0 };
  }
}

/* One entry point for both boxes (the Durable Object and dev's memory). */
export function runGuard(g, op, b = {}, now = Date.now()) {
  if (b.chatId) g.chatId = b.chatId;
  switch (op) {
    case 'join': return g.join(b.uid, now, { captcha: !!b.captcha, ttlMin: b.ttlMin });
    case 'msg': return g.setMsg(b.uid, b.msg);
    case 'drop': return g.drop(b.uid);
    case 'answer': return g.answer(b.uid, b.i, now);
    case 'peek': return g.peek(b.uid, now);
    case 'welcome': return g.welcome(b.msg);
    case 'expired': return { list: g.expired(now) };
    default: return { ok: false, error: 'unknown op' };
  }
}

/* Dev and tests: groups in memory. Nothing expires on its own here — there is
   no alarm — which is fine for a laptop. */
export function memoryGuard() {
  const groups = new Map();
  return async (chatId, op, body = {}) => {
    let g = groups.get(chatId);
    if (!g) { g = new Guard({ chatId }); groups.set(chatId, g); }
    return runGuard(g, op, { ...body, chatId }, Date.now());
  };
}
