/* ==========================================================================
   pumpbubble.fun — Tap wars

   A tab where any community can put its token and tap it. Taps are the
   only measure on the tab: a bubble's size is how many taps it holds, and
   the rewards are decided by rank, not by money —

     - the top GOLD_SLOTS tokens holding at least GOLD_MIN taps wear a small
       gold shell on every tab of the map (the "mini golden bubble"), and
     - the next AD_SLOTS tokens holding at least AD_MIN taps take the open
       slots in the ad rail, free.

   Thresholds are floors, ranks decide: a token that passes one is
   eligible, and whoever holds more taps holds the slot. Being out-tapped
   takes it away, and a flip is recorded so the tab (and later the buybot)
   can say who took what from whom.

   Taps decay — a score halves every HALF_LIFE — for the same reason boosts
   do: staying on top has to cost effort now, not effort once. A community
   that tapped to gold on Monday and went quiet is below the floor by
   Wednesday, and the slot is open again.

   Everything here is a plain class over a plain object so it runs the same
   in the Node dev server (one instance in memory) and in production, where
   a Durable Object owns the single instance. That is the one architectural
   fact worth knowing: a tap is a counter increment, and KV is the wrong
   tool for a counter twice over — writes are last-wins across isolates, so
   two people tapping at once lose taps, and the free tier allows a thousand
   writes a day, which a tap war spends in a minute. A Durable Object is one
   process, one memory, atomic by construction. No tap ever touches KV.

   What keeps a bot from winning: not much, and this is the honest shape of
   any tap game. What it has is per-IP caps — a rate cap so a script cannot
   tap faster than a thumb, and a *daily* cap so one address cannot outweigh
   a community no matter how long it runs. Winning by bot therefore costs
   proxies, which costs money, which is roughly the price of the ad.
   ========================================================================== */

export const HALF_LIFE_MS = 24 * 36e5;   // a score halves in a day
export const AD_MIN = 1000;              // taps held to be eligible for a rail slot
export const GOLD_MIN = 5000;            // taps held to be eligible for gold
export const AD_SLOTS = 2;               // rail slots taps can win (sold ads always come first)
export const GOLD_SLOTS = 3;             // mini golden bubbles at once
/* A tap-won gold is a small one: the "paid size" it counts for is twelve
   dollars' worth, a Spark and a half — clearly gold, clearly not a Whale.
   It goes through the same bonus curve and the same 25% gold-share guard as
   money does, so the tab cannot oversell the map either. */
export const GOLD_USD = 12;
/* A slot, once won, is kept down to nine tenths of its floor. Without this a
   community that reached exactly 1,000 lost the slot two minutes later to
   decay, got it back on the next tap, and the event feed read as a stutter.
   Being out-tapped still takes it at any count. */
export const KEEP = 0.9;

export const TAP_MAX_PER_REQ = 50;       // one batch from the page
export const IP_PER_10S = 100;           // ten a second, a fast thumb
export const IP_PER_DAY = 1500;          // one address's whole day
export const ADD_PER_IP_DAY = 5;
export const MAX_TOKENS = 150;
export const PRUNE_IDLE_MS = 48 * 36e5;  // untapped this long and near zero → gone when full
export const PRUNE_SCORE = 25;
export const MAX_EVENTS = 40;

const DAY = 864e5;

/* What a score written at `since` is worth at `now`. */
export function decayed(score, since, now) {
  if (!(score > 0)) return 0;
  const dt = Math.max(0, now - since);
  return score * Math.pow(0.5, dt / HALF_LIFE_MS);
}

const KEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$|^0x[0-9a-f]{40}$/;

export class Arena {
  constructor(state) {
    const s = state || {};
    /* key → row. key is addr (EVM, lowercase) or mint (Solana). */
    this.tokens = s.tokens && typeof s.tokens === 'object' ? s.tokens : {};
    this.events = Array.isArray(s.events) ? s.events.slice(-MAX_EVENTS) : [];
    /* ip → { day, dayN, adds, win, winN } — rolling counters, pruned daily */
    this.ips = s.ips && typeof s.ips === 'object' ? s.ips : {};
    /* who held what at the last look, so a change can be named */
    this.held = s.held && typeof s.held === 'object' ? s.held : { gold: [], ad: [] };
    this.updatedAt = +s.updatedAt || 0;
  }

  static from(json) { return new Arena(json); }

  toJSON() {
    return { tokens: this.tokens, events: this.events, ips: this.ips, held: this.held, updatedAt: this.updatedAt };
  }

  /* -------------------------------------------------------------- limits */
  _ip(ip, now) {
    const day = Math.floor(now / DAY);
    let r = this.ips[ip];
    if (!r || r.day !== day) { r = this.ips[ip] = { day, dayN: 0, adds: 0, win: 0, winN: 0 }; }
    return r;
  }

  _pruneIps(now) {
    const day = Math.floor(now / DAY);
    for (const [ip, r] of Object.entries(this.ips)) if (r.day < day) delete this.ips[ip];
  }

  /* ----------------------------------------------------------------- add */
  /* `tok` is a resolved token from resolveAnyToken(): the identity comes from
     the chain, never from the form. */
  add(tok, ip, now = Date.now()) {
    if (!tok || typeof tok !== 'object') return { ok: false, error: 'no token' };
    const key = String(tok.addr || tok.mint || '');
    if (!KEY_RE.test(key)) return { ok: false, error: 'not a token address' };

    const have = this.tokens[key];
    if (have) return { ok: true, key, row: this._row(have, now), existed: true };

    const r = this._ip(String(ip || 'local'), now);
    if (r.adds >= ADD_PER_IP_DAY) return { ok: false, error: 'that is enough new tokens from one address for today' };

    if (Object.keys(this.tokens).length >= MAX_TOKENS) {
      this._prune(now);
      if (Object.keys(this.tokens).length >= MAX_TOKENS) return { ok: false, error: 'the arena is full — out-tap someone' };
    }

    r.adds++;
    this.tokens[key] = {
      key,
      mint: String(tok.mint || ''),
      addr: String(tok.addr || ''),
      chain: String(tok.chain || (tok.mint ? 'solana' : '')),
      sym: String(tok.sym || '?').slice(0, 12),
      name: String(tok.name || tok.sym || '').slice(0, 48),
      img: typeof tok.img === 'string' ? tok.img.slice(0, 400) : '',
      mcap: +tok.mcap || 0,
      added: now,
      score: 0, since: now, total: 0, lastTap: 0,
      goldSince: 0, adSince: 0,
    };
    this.updatedAt = now;
    return { ok: true, key, row: this._row(this.tokens[key], now), existed: false };
  }

  /* When the arena is full, drop what nobody is tapping. Never a token that
     holds a slot, never one tapped in the last two days. */
  _prune(now) {
    const held = new Set([...this.held.gold, ...this.held.ad]);
    for (const [key, t] of Object.entries(this.tokens)) {
      if (held.has(key)) continue;
      const idle = now - Math.max(t.lastTap, t.added);
      if (idle > PRUNE_IDLE_MS && decayed(t.score, t.since, now) < PRUNE_SCORE) delete this.tokens[key];
    }
  }

  /* ----------------------------------------------------------------- tap */
  tap(key, n, ip, now = Date.now()) {
    const t = this.tokens[String(key || '')];
    if (!t) return { ok: false, error: 'not in the arena' };
    const asked = Math.floor(+n || 0);
    if (asked <= 0) return { ok: false, error: 'no taps' };
    const want = Math.min(asked, TAP_MAX_PER_REQ);

    const r = this._ip(String(ip || 'local'), now);
    if (now - r.win > 10_000) { r.win = now; r.winN = 0; }
    const room = Math.max(0, Math.min(IP_PER_10S - r.winN, IP_PER_DAY - r.dayN));
    const counted = Math.min(want, room);
    if (counted > 0) {
      r.winN += counted; r.dayN += counted;
      /* decay what is there, then add — one score, one timestamp */
      t.score = decayed(t.score, t.since, now) + counted;
      t.since = now;
      t.total += counted;
      t.lastTap = now;
      this.updatedAt = now;
    }
    const st = this.state(now);
    const me = st.tokens.find(x => x.key === t.key);
    return {
      ok: true, counted, asked,
      score: me ? me.taps : Math.round(decayed(t.score, t.since, now)),
      rank: me ? me.rank : 0,
      award: me ? me.award : '',
      /* what this address has left today — the page can say "slow down" */
      left: Math.max(0, IP_PER_DAY - r.dayN),
      limited: counted < asked,
    };
  }

  /* --------------------------------------------------------------- state */
  _row(t, now) {
    return {
      key: t.key, mint: t.mint, addr: t.addr, chain: t.chain, sym: t.sym, name: t.name, img: t.img,
      mcap: t.mcap, added: t.added, lastTap: t.lastTap,
      taps: Math.round(decayed(t.score, t.since, now)),
      tapsTotal: t.total,
      goldSince: t.goldSince, adSince: t.adSince,
    };
  }

  /* Ranked, with awards. Computing awards is also where flips are noticed:
     the previous holders are kept, compared, and a change becomes an event.
     Calling state() is therefore not free of side effects, on purpose — the
     arena is the one place that knows a slot changed hands. */
  state(now = Date.now()) {
    const rows = Object.values(this.tokens).map(t => this._row(t, now));
    rows.sort((a, b) => b.taps - a.taps || a.added - b.added);

    const prevGoldSet = new Set(this.held.gold || []), prevAdSet = new Set(this.held.ad || []);
    const gold = [], ad = [];
    for (const r of rows) {
      const goldOk = r.taps >= GOLD_MIN || (prevGoldSet.has(r.key) && r.taps >= GOLD_MIN * KEEP);
      const adOk = r.taps >= AD_MIN || ((prevAdSet.has(r.key) || prevGoldSet.has(r.key)) && r.taps >= AD_MIN * KEEP);
      if (gold.length < GOLD_SLOTS && goldOk) { gold.push(r.key); continue; }
      if (ad.length < AD_SLOTS && adOk) ad.push(r.key);
    }

    /* flips */
    const prevGold = this.held.gold || [], prevAd = this.held.ad || [];
    for (const k of gold) if (!prevGold.includes(k)) this._event(now, 'gold', k, prevGold.find(p => !gold.includes(p)));
    for (const k of ad) if (!prevAd.includes(k) && !prevGold.includes(k)) this._event(now, 'ad', k, prevAd.find(p => !ad.includes(p) && !gold.includes(p)));
    for (const k of prevGold) if (!gold.includes(k) && !ad.includes(k)) this._event(now, 'lost', k);
    for (const k of prevAd) if (!ad.includes(k) && !gold.includes(k)) this._event(now, 'lost', k);

    /* held-since timestamps live on the rows */
    for (const k of Object.keys(this.tokens)) {
      const t = this.tokens[k];
      t.goldSince = gold.includes(k) ? (t.goldSince || now) : 0;
      t.adSince = ad.includes(k) ? (t.adSince || now) : 0;
    }
    this.held = { gold, ad };

    let rank = 0;
    for (const r of rows) {
      r.rank = ++rank;
      r.award = gold.includes(r.key) ? 'gold' : ad.includes(r.key) ? 'ad' : '';
      r.goldSince = this.tokens[r.key].goldSince;
      r.adSince = this.tokens[r.key].adSince;
    }
    return {
      tokens: rows,
      gold: gold.map(k => rows.find(r => r.key === k)),
      ad: ad.map(k => rows.find(r => r.key === k)),
      events: this.events.slice(-12).reverse(),
      updatedAt: this.updatedAt,
      n: rows.length,
    };
  }

  _event(at, kind, key, fromKey) {
    const t = this.tokens[key], f = fromKey ? this.tokens[fromKey] : null;
    if (!t) return;
    this.events.push({
      at, kind, key, sym: t.sym,
      taps: Math.round(decayed(t.score, t.since, at)),
      ...(f ? { from: f.sym, fromKey: f.key } : {}),
    });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  /* housekeeping the owner calls now and then */
  sweep(now = Date.now()) {
    this._pruneIps(now);
    if (Object.keys(this.tokens).length >= MAX_TOKENS) this._prune(now);
  }
}

/* One instance in memory, behind the same async signature the Worker gives
   the Durable Object. This is what the Node dev server uses. */
export function memoryArena() {
  const arena = new Arena();
  return async (op, body = {}) => {
    const now = Date.now();
    if (op === 'add') return arena.add(body.tok, body.ip, now);
    if (op === 'tap') return arena.tap(body.key, body.n, body.ip, now);
    if (op === 'sweep') { arena.sweep(now); return { ok: true }; }
    return arena.state(now);
  };
}
