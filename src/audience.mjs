/* ==========================================================================
   pumpbubble.fun — the bot's audience and the mass DM

   Everyone who has pressed Start on the bot — from the menu, the shop, or by
   verifying to join a group in private — is on this list, told so at that
   Start ("you'll get pumpbubble updates and promotions — /stop any time").
   The operator can DM all of them from the console, and projects can buy a
   sponsored DM that the operator approves before it goes.

   Why it was built this way, since the first answer was no. The operator
   asked for a DM list grown from the groups the bot is in, as Major and
   similar bots have. Telegram lets a bot message only people who pressed
   Start on it, so the list grows through the private-chat verification in
   🛡 Guard; what was kept from the refusal is the part that protects the
   bot: the disclosure at Start, a /stop that always works, and an
   Unsubscribe button on every message sent to the list. A bot whose
   messages get reported is restricted by Telegram, and a restricted bot stops
   posting buys in every group at once — the block rate is the thing to keep
   low, and people who can leave in one tap report less.

   Storage is a Durable Object (one, `AudienceDO` in worker/index.js), not KV:
   the list can reach hundreds of thousands, KV's free writes are spent, and a
   send has to be paced (Telegram allows ~30 messages a second) by something
   with a clock. This class is the logic, against a storage with
   get/put/delete/list — the DO's own, or a Map in the tests.
   ========================================================================== */

export const BATCH = 25;           // messages per tick, under Telegram's ~30/s
export const MAX_FOLLOWS = 10;     // wallets one person can track
export const TICK_MS = 1100;

export const UNSUB = { text: '🔕 Unsubscribe', callback_data: 'unsub' };
export const RECENT = 300;         // the newest subscribers, kept in order for the console
export const GROUPS_MAX = 2000;

/* Telegram names are typed by their owners: no control characters, no
   direction overrides, nothing long. The console escapes them as well. */
const tidy = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, n);
const handle = s => /^[A-Za-z0-9_]{4,32}$/.test(String(s || '')) ? String(s) : '';

export class Audience {
  constructor(storage) { this.s = storage; }

  async count() { return (await this.s.get('n')) || 0; }

  /* Everyone who pressed Start, with the name and @username they show on
   Telegram — what the operator's console lists, and nothing else about
   them. A repeat costs no write unless the name changed (or was never kept:
   people who started before names were). The newest are also kept in order,
   so the console can show who joined lately without reading the whole list. */
  async add(id, src = '', meta = {}) {
    id = Math.floor(+id);
    if (!(id > 0)) return { ok: false };
    const k = 'u:' + String(id).padStart(15, '0');
    const name = tidy(meta.name, 48), user = handle(meta.user);
    const have = await this.s.get(k);
    if (have) {
      if ((name && have.name !== name) || (user && have.user !== user)) {
        await this.s.put(k, { ...have, ...(name ? { name } : {}), ...(user ? { user } : {}) });
      }
      return { ok: true, added: false };
    }
    await this.s.put(k, { at: Date.now(), src: String(src).slice(0, 24), ...(name ? { name } : {}), ...(user ? { user } : {}) });
    await this.s.put('n', (await this.count()) + 1);
    const recent = (await this.s.get('recent')) || [];
    recent.unshift(id);
    await this.s.put('recent', recent.slice(0, RECENT));
    return { ok: true, added: true };
  }

  /* The list for the console: the newest first, or every record in id order
     a page at a time (`after` is the last id of the page before). */
  async list({ after = '', limit = 100, newest = false } = {}) {
    limit = Math.max(1, Math.min(200, Math.floor(+limit) || 100));
    if (newest) {
      const rows = [];
      for (const id of ((await this.s.get('recent')) || []).slice(0, limit)) {
        const r = await this.s.get('u:' + String(id).padStart(15, '0'));
        if (r) rows.push({ id, ...r });
      }
      return { ok: true, rows, next: '' };
    }
    const opt = { prefix: 'u:', limit };
    if (after) opt.startAfter = 'u:' + String(Math.floor(+after) || 0).padStart(15, '0');
    const rows = [...(await this.s.list(opt)).entries()].map(([k, v]) => ({ id: +k.slice(2), ...(v || {}) }));
    return { ok: true, rows, next: rows.length === limit ? String(rows[rows.length - 1].id) : '' };
  }

  /* --------------------------------------------------- groups the bot met */
  /* Every group the bot was added to, set up or not, written when it joins or
     leaves — so the console can show the groups that added it and never ran
     /setup, the ones worth a follow-up. */
  async seenGroup(g = {}) {
    const id = Math.trunc(+g.id);
    if (!id || id > 0) return { ok: false };          // group and channel ids are negative
    const k = 'g:' + id, prev = (await this.s.get(k)) || {};
    const gone = g.status === 'left' || g.status === 'kicked';
    const wasIn = prev.status && prev.status !== 'left' && prev.status !== 'kicked';
    await this.s.put(k, {
      id,
      title: tidy(g.title, 80) || prev.title || '',
      username: handle(g.username) || prev.username || '',
      type: tidy(g.type, 16) || prev.type || '',
      status: tidy(g.status, 16) || prev.status || '',
      addedAt: gone ? (prev.addedAt || 0) : (wasIn && prev.addedAt ? prev.addedAt : Date.now()),
      leftAt: gone ? Date.now() : 0,
      by: gone ? (prev.by || 0) : (Math.floor(+g.by) || prev.by || 0),
      byName: gone ? (prev.byName || '') : (tidy(g.byName, 48) || prev.byName || ''),
      byUser: gone ? (prev.byUser || '') : (handle(g.byUser) || prev.byUser || ''),
    });
    return { ok: true };
  }
  async groups() {
    const list = [...(await this.s.list({ prefix: 'g:', limit: GROUPS_MAX })).values()];
    return list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  async remove(id) {
    id = Math.floor(+id);
    const k = 'u:' + String(id).padStart(15, '0');
    if (!(await this.s.get(k))) return { ok: true, removed: false };
    await this.s.delete(k);
    await this.s.put('n', Math.max(0, (await this.count()) - 1));
    return { ok: true, removed: true };
  }

  /* ------------------------------------------------------ wallet tracker */
  /* Who follows which wallet, both ways round: `w:<user>` is a user's list
     (for /wallets), `f:<wallet>` the users to tell (for a delivery). A
     follow is something the user asked for, so unsubscribing from the mass
     DM does not touch it; blocking the bot or /stop does (`purge`). */
  async following(uid) { return (await this.s.get('w:' + Math.floor(+uid))) || []; }

  async follow(uid, wallet, label = '') {
    uid = Math.floor(+uid);
    wallet = String(wallet || '');
    if (!(uid > 0) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return { ok: false, error: 'that is not a Solana wallet address' };
    const mine = await this.following(uid);
    const have = mine.find(x => x.wallet === wallet);
    if (have) { have.label = String(label || have.label || '').slice(0, 24); await this.s.put('w:' + uid, mine); return { ok: true, added: false, list: mine }; }
    if (mine.length >= MAX_FOLLOWS) return { ok: false, error: `you can track ${MAX_FOLLOWS} wallets — remove one first` };
    mine.push({ wallet, label: String(label || '').slice(0, 24), at: Date.now() });
    await this.s.put('w:' + uid, mine);
    const fans = (await this.s.get('f:' + wallet)) || [];
    if (!fans.includes(uid)) { fans.push(uid); await this.s.put('f:' + wallet, fans); }
    return { ok: true, added: true, list: mine };
  }

  async unfollow(uid, wallet) {
    uid = Math.floor(+uid);
    const mine = (await this.following(uid)).filter(x => x.wallet !== wallet);
    await this.s.put('w:' + uid, mine);
    const fans = ((await this.s.get('f:' + wallet)) || []).filter(x => x !== uid);
    if (fans.length) await this.s.put('f:' + wallet, fans); else await this.s.delete('f:' + wallet);
    return { ok: true, list: mine };
  }

  /* following pump.fun's top traders as one switch, not three hundred rows */
  async smart(uid, on) {
    uid = Math.floor(+uid);
    if (on) await this.s.put('sm:' + String(uid).padStart(15, '0'), 1); else await this.s.delete('sm:' + String(uid).padStart(15, '0'));
    return { ok: true, smart: !!on };
  }
  async isSmart(uid) { return !!(await this.s.get('sm:' + String(Math.floor(+uid)).padStart(15, '0'))); }
  async smartFans() { return [...(await this.s.list({ prefix: 'sm:' })).keys()].map(k => +k.slice(3)); }

  /* the same switch for the week's top callers (src/callers.mjs): each new
     call of theirs arrives here with Buy and Chart */
  async callFan(uid, on) {
    uid = Math.floor(+uid);
    if (on) await this.s.put('cf:' + String(uid).padStart(15, '0'), 1); else await this.s.delete('cf:' + String(uid).padStart(15, '0'));
    return { ok: true, calls: !!on };
  }
  async isCallFan(uid) { return !!(await this.s.get('cf:' + String(Math.floor(+uid)).padStart(15, '0'))); }
  async callFans() { return [...(await this.s.list({ prefix: 'cf:' })).keys()].map(k => +k.slice(3)); }

  /* every wallet somebody follows — what the Helius webhook has to watch */
  async wallets() { return [...(await this.s.list({ prefix: 'f:' })).keys()].map(k => k.slice(2)); }

  /* for one delivery: who to tell about which wallet */
  async route(wallets) {
    const by = {};
    for (const w of [...new Set(wallets || [])]) {
      const fans = (await this.s.get('f:' + w)) || [];
      if (!fans.length) continue;
      by[w] = [];
      for (const uid of fans) {
        const hit = (await this.following(uid)).find(x => x.wallet === w);
        by[w].push({ uid, label: hit ? hit.label : '' });
      }
    }
    return { ok: true, by };
  }

  /* blocked the bot, or /stop: nothing more of any kind */
  async purge(uid) {
    uid = Math.floor(+uid);
    for (const x of await this.following(uid)) await this.unfollow(uid, x.wallet);
    await this.s.delete('w:' + uid);
    await this.smart(uid, false);
    await this.callFan(uid, false);
    return this.remove(uid);
  }

  async job() { return (await this.s.get('job')) || null; }

  /* One send at a time; the DO's alarm drives it. */
  async start({ html, buttons = [], label = '' }) {
    const cur = await this.job();
    if (cur && cur.status === 'sending') return { ok: false, error: 'a send is already running — wait for it or cancel it' };
    const total = await this.count();
    if (!total) return { ok: false, error: 'nobody on the list yet' };
    const job = {
      id: 'dm_' + Date.now().toString(36), html: String(html || '').slice(0, 3500), buttons, label,
      status: 'sending', cursor: '', total, sent: 0, gone: 0, failed: 0, startedAt: Date.now(), doneAt: 0,
    };
    if (!job.html.trim()) return { ok: false, error: 'empty message' };
    await this.s.put('job', job);
    return { ok: true, job };
  }

  async cancel() {
    const j = await this.job();
    if (j && j.status === 'sending') { j.status = 'cancelled'; j.doneAt = Date.now(); await this.s.put('job', j); }
    return { ok: true, job: j };
  }

  /* One tick: the next batch. `send(id, html, buttons)` resolves 'ok',
     'gone' (blocked the bot, deleted their account — forgotten, which is what
     they asked for) or 'fail'. Returns whether there is more to do. */
  async step(send) {
    const j = await this.job();
    if (!j || j.status !== 'sending') return { more: false };
    const opt = { prefix: 'u:', limit: BATCH };
    if (j.cursor) opt.startAfter = j.cursor;
    const page = await this.s.list(opt);
    const keys = [...page.keys()];
    const res = await Promise.all(keys.map(k => send(+k.slice(2), j.html, j.buttons).catch(() => 'fail')));
    for (let i = 0; i < keys.length; i++) {
      if (res[i] === 'ok') j.sent++;
      else if (res[i] === 'gone') { j.gone++; await this.purge(+keys[i].slice(2)); }
      else j.failed++;
    }
    if (keys.length) j.cursor = keys[keys.length - 1];
    if (keys.length < BATCH) { j.status = 'done'; j.doneAt = Date.now(); }
    await this.s.put('job', j);
    return { more: j.status === 'sending', job: j };
  }

  /* ------------------------------------------------------- the fan-out queue */
  /* One message to a list of people — a top trader's entry to everyone who
     follows the top traders. Sending that inline from the Helius webhook
     looped over every follower inside one request, past the per-request
     subrequest limit once a few dozen people followed; here it is paced by
     the same alarm as the mass DM, a batch per tick, in arrival order. */
  async enqueue({ uids, html, buttons = [] }) {
    const list = [...new Set((uids || []).map(x => Math.floor(+x)).filter(x => x > 0))];
    if (!list.length || !String(html || '').trim()) return { ok: false, queued: 0 };
    const k = 'q:' + String(Date.now()).padStart(15, '0') + ':' + Math.random().toString(36).slice(2, 8);
    await this.s.put(k, { uids: list, html: String(html).slice(0, 3500), buttons, i: 0 });
    return { ok: true, queued: list.length };
  }

  async hasQueue() { return (await this.s.list({ prefix: 'q:', limit: 1 })).size > 0; }

  async drain(send) {
    const [entry] = [...(await this.s.list({ prefix: 'q:', limit: 1 })).entries()];
    if (!entry) return { more: false };
    const [k, q] = entry;
    const batch = q.uids.slice(q.i, q.i + BATCH);
    const res = await Promise.all(batch.map(id => send(id, q.html, q.buttons).catch(() => 'fail')));
    for (let n = 0; n < batch.length; n++) if (res[n] === 'gone') await this.purge(batch[n]);
    q.i += batch.length;
    if (q.i >= q.uids.length) await this.s.delete(k); else await this.s.put(k, q);
    return { more: await this.hasQueue() };
  }
}

/* The sponsored DM a project bought: its token and nothing it typed, marked
   as sponsored, with the ways out. */
export function sponsoredDm(ad, links) {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = '📣 <b>Sponsored</b>\n\n'
    + `<b>${esc(String(ad.title || '').slice(0, 22))}</b>${ad.name ? ' — ' + esc(String(ad.name).slice(0, 48)) : ''}\n\n`
    + 'Found on pumpbubble.fun, the live bubble map for pump.fun, Base and Robinhood Chain.';
  const buttons = [[{ text: '📊 Chart', url: links.chart }, { text: '🫧 Bubble', url: links.bubble }]];
  return { html, buttons };
}

/* A Map with the DO storage API's shape, for the tests and the dev server. */
export function memoryStorage() {
  const m = new Map();
  return {
    get: async k => m.get(k),
    put: async (k, v) => { m.set(k, v); },
    delete: async k => m.delete(k),
    list: async ({ prefix = '', startAfter = '', limit = 1000 } = {}) => {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort().slice(0, limit);
      return new Map(keys.map(k => [k, m.get(k)]));
    },
  };
}
