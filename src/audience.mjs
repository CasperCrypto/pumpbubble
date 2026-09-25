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

export class Audience {
  constructor(storage) { this.s = storage; }

  async count() { return (await this.s.get('n')) || 0; }

  /* Everyone who pressed Start. A repeat is free: no write. */
  async add(id, src = '') {
    id = Math.floor(+id);
    if (!(id > 0)) return { ok: false };
    const k = 'u:' + String(id).padStart(15, '0');
    if (await this.s.get(k)) return { ok: true, added: false };
    await this.s.put(k, { at: Date.now(), src: String(src).slice(0, 24) });
    await this.s.put('n', (await this.count()) + 1);
    return { ok: true, added: true };
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
