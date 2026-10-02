/* ==========================================================================
   pumpbubble.fun — Cloudflare Worker (production)

   Three jobs:
     1. read pump.fun server-side (the browser cannot: 403 on Origin)
     2. cache token art at the edge so IPFS never touches the render loop
     3. hold the paid layer — boost orders, Solana Pay verification, ad slots

   Static files are served by Workers Assets; anything under /api is ours.
   ========================================================================== */

import { Guard, runGuard } from '../src/guard.mjs';
import { guardExpire, onEvmBuys, sendDm, formatCallAlert, onTrade as solTrade, tracked as solTracked } from '../src/tgbot.mjs';
import { Endpoints, rpcList as solRpcs, watchList as solWatchList, poll as solPoll, solPolling, EVERY as SOL_EVERY, IDLE_EVERY as SOL_IDLE, QUIET_MS as SOL_QUIET } from '../src/solwatch.mjs';
import { CallerBook, pollOnce, WINDOWS as CALL_WINDOWS } from '../src/callers.mjs';
import { Audience, TICK_MS } from '../src/audience.mjs';
import { CHAINS, isChain, poll as evmPoll, ethUsd as evmEthUsd } from '../src/evmbuy.mjs';
import { handle } from '../src/api.mjs';
import { SWAP_CSP } from '../src/refs.mjs';
import { histToJSON, histFromJSON, pruneHistory, altGateways, fetchSolPrice } from '../src/core.mjs';
import { flush as flushStats } from '../src/stats.mjs';
import { tick as xbotTick } from '../src/xbot.mjs';
import { Arena } from '../src/taps.mjs';

/* ------------------------------------------------------------- Tap wars */
/* One Durable Object holds the whole arena. Taps are counter increments and
   KV cannot count: writes are last-wins across isolates (two tappers at once
   lose taps) and the free tier's thousand writes a day are gone in a minute
   of a tap war. A DO is a single process with a single memory, so every tap
   lands exactly once, and it is persisted from an alarm rather than per tap —
   at most one storage write every five seconds while people are tapping,
   none while they are not. The class in src/taps.mjs is the whole logic;
   this is only the box it lives in. */
/* One per Telegram group: pending captchas and the last welcome message.
   The alarm removes whoever let their captcha run out. src/guard.mjs has the
   logic and the why; this is only the box and the clock. */
export class GroupGuard {
  constructor(state, env) { this.state = state; this.env = env; this.g = null; }
  async load() {
    if (!this.g) this.g = Guard.from(await this.state.storage.get('g'));
  }
  async schedule() {
    const due = this.g.nextDue();
    if (due) await this.state.storage.setAlarm(due + 1000);
  }
  async fetch(req) {
    await this.load();
    let b = {};
    try { b = await req.json(); } catch { b = {}; }
    const out = runGuard(this.g, b.op, b, Date.now());
    await this.state.storage.put('g', this.g.toJSON());
    await this.schedule();
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }
  async alarm() {
    await this.load();
    const list = this.g.expired(Date.now());
    await this.state.storage.put('g', this.g.toJSON());
    if (list.length && this.g.chatId && this.env.TG_BOT_TOKEN) await guardExpire(this.env, this.g.chatId, list);
    await this.schedule();
  }
}

/* One per EVM chain: the tokens groups follow there, and a poll every few
   seconds while there are any. src/evmbuy.mjs has the decoding and the why.
   The last block is kept in memory and saved at most once a minute — a
   restart loses a few seconds, never floods a group with history. */
export class EvmWatch {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.tokens = null; this.chain = ''; this.last = 0; this.savedAt = 0; this.back = 0;
    this.eth = { v: 0, at: 0 };
    this.stat = { okAt: 0, err: '', errAt: 0, polls: 0, buys: 0, sent: 0 };
  }
  async load() {
    if (this.tokens) return;
    const s = (await this.state.storage.get('s')) || {};
    this.tokens = s.tokens || {}; this.chain = s.chain || ''; this.last = s.last || 0;
  }
  async save(force) {
    if (!force && Date.now() - this.savedAt < 60_000) return;
    this.savedAt = Date.now();
    await this.state.storage.put('s', { tokens: this.tokens, chain: this.chain, last: this.last });
  }
  drop(token, chatId) {
    const t = this.tokens[token];
    if (!t) return;
    t.chats = (t.chats || []).filter(c => c !== chatId);
    if (!t.chats.length) delete this.tokens[token];
  }
  async fetch(req) {
    await this.load();
    let b = {};
    try { b = await req.json(); } catch { b = {}; }
    if (isChain(b.chain)) this.chain = b.chain;
    let out = { ok: true };
    if (b.op === 'track') {
      const t = this.tokens[b.token] || { chats: [] };
      if (b.meta) Object.assign(t, b.meta, { chats: t.chats });
      if (!t.pools || !t.pools.length) out = { ok: false, error: 'no pools for this token yet' };
      else {
        if (!t.chats.includes(b.chatId)) t.chats.push(b.chatId);
        this.tokens[b.token] = t;
        await this.save(true);
      }
    } else if (b.op === 'untrack') {
      this.drop(b.token, b.chatId);
      await this.save(true);
    } else if (b.op === 'status') {
      out = { ok: true, chain: this.chain, tokens: Object.keys(this.tokens).length, last: this.last, ethUsd: this.eth.v, backoffMs: this.back, ...this.stat };
    }
    if (Object.keys(this.tokens).length && !(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 1000);
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }
  async alarm() {
    await this.load();
    if (!Object.keys(this.tokens).length || !CHAINS[this.chain]) return;   // nothing to watch: no next alarm
    const c = CHAINS[this.chain];
    try {
      if (Date.now() - this.eth.at > 60_000) { const v = await evmEthUsd(); if (v > 0) this.eth = { v, at: Date.now() }; }
      const { buys, head } = await evmPoll(this.chain, this.tokens, { last: this.last }, this.env, this.eth.v);
      this.last = head; this.stat.okAt = Date.now(); this.stat.polls++;
      this.back = Math.floor(this.back / 2) < c.every ? 0 : Math.floor(this.back / 2);
      if (buys.length && this.env.TG_BOT_TOKEN) {
        this.stat.buys += buys.length;
        const chats = Object.fromEntries(Object.entries(this.tokens).map(([k, t]) => [k, t.chats || []]));
        const r = await onEvmBuys({ env: this.env, store: makeStore(this.env) }, this.chain, buys, chats, this.eth.v);
        this.stat.sent += r.sent;
        for (const s of r.stale || []) this.drop(s.token, s.chatId);
      }
      /* A poll that posted buys saves its block at once: a restart (every
         deploy restarts this object) resumed from a minute-old block and
         posted the same buys to the groups a second time. Quiet polls still
         save at most once a minute. */
      await this.save(buys.length > 0);
    } catch (e) {
      this.stat.err = String(e && e.message || e).slice(0, 200); this.stat.errAt = Date.now();
      /* a rate limit backs off; anything else retries at the normal pace */
      if ((e && e.limited) || /429|Too Many/i.test(this.stat.err)) this.back = Math.min(60_000, Math.max(c.every, this.back) * 2);
    }
    await this.state.storage.setAlarm(Date.now() + (this.back || c.every));
  }
}

/* Solana buys, polled from free public RPCs — src/solwatch.mjs has the why
   (Helius's free credits ran out and took every Solana alert with them).
   One object for every followed token. The list is tg:mints, re-read every
   half minute, so /setup and /stop need no message of their own; /setup
   pokes it only so a new group's first buy lands in seconds. Cursors (the
   newest signature seen per address) live in memory and are saved at most
   once a minute, at once after a poll that read anything — a restart then
   resumes where it was, and pickNew's age limit keeps a long sleep from
   posting history. Quiet tokens are read every 8 s, busy ones every 4. */
export class SolWatch {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.cur = null; this.savedAt = 0; this.back = 0; this.movedAt = 0; this.fresh = false;
    this.eps = new Endpoints(solRpcs(env));
    this.seen = new Set(); this.retry = [];
    this.sol = { v: 0, at: 0 };
    this.stat = { okAt: 0, err: '', errAt: 0, polls: 0, txs: 0, buys: 0, sent: 0, skipped: 0, rpc: '', tokens: 0 };
  }
  async load() {
    if (this.cur) return;
    const s = (await this.state.storage.get('s')) || {};
    this.cur = s.cur || {};
  }
  async save(force) {
    if (!force && Date.now() - this.savedAt < 60_000) return;
    this.savedAt = Date.now();
    await this.state.storage.put('s', { cur: this.cur });
  }
  async fetch(req) {
    await this.load();
    let b = {};
    try { b = await req.json(); } catch { b = {}; }
    let out = { ok: true };
    if (b.op === 'status') out = { ok: true, ...this.stat, backoffMs: this.back };
    if (b.op === 'track') this.fresh = true;
    if (solPolling(this.env) && !(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 500);
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }
  /* SOL in dollars for the alert: the site's own saved price while it is
     fresh, else pump.fun's, at most once a minute. */
  async solUsd(store) {
    if (this.sol.v > 0 && Date.now() - this.sol.at < 60_000) return this.sol.v;
    let v = 0;
    try { const s = await store.get('sol:price'); if (s && s.price > 0 && Date.now() - s.at < 600_000) v = s.price; } catch {}
    if (!(v > 0)) v = await fetchSolPrice().catch(() => 0);
    if (v > 0) this.sol = { v, at: Date.now() };
    return this.sol.v;
  }
  async alarm() {
    await this.load();
    if (!solPolling(this.env) || !this.env.TG_BOT_TOKEN) return;
    const env = { ...this.env, IMG_SECRET: await imgSecret(this.env) };
    const store = makeStore(env);
    const { list } = await solTracked(store, this.fresh);
    this.fresh = false;
    this.stat.tokens = list.length;
    if (!list.length) return;               // nobody follows a token: no next alarm until /setup or the cron
    const now = Date.now();
    try {
      const prefer = new Set(list.map(t => t && t.pool).filter(Boolean));
      const r = await solPoll(solWatchList(list), this.cur, this.eps, { now, seen: this.seen, retry: this.retry, prefer });
      this.cur = r.next; this.retry = r.again;
      this.stat.rpc = r.rpc; this.stat.okAt = Date.now(); this.stat.polls++; this.stat.skipped += r.skipped;
      this.stat.last = r.diag; this.stat.cursors = Object.keys(this.cur).length;
      if (r.diag && r.diag.warn) { this.stat.warn = r.diag.warn; this.stat.warnAt = Date.now(); }
      this.back = 0;
      for (const tx of r.txs) {
        const sig = tx && tx.transaction && tx.transaction.signatures && tx.transaction.signatures[0];
        if (sig) { this.seen.add(sig); if (this.seen.size > 3000) { const it = this.seen.values(); for (let i = 0; i < 1000; i++) this.seen.delete(it.next().value); } }
      }
      if (r.txs.length) {
        this.movedAt = now; this.stat.txs += r.txs.length;
        /* saved before posting: a restart mid-send must not post twice */
        await this.save(true);
        const res = await solTrade({ env, store, callers: callersClient(env) }, r.txs, await this.solUsd(store), { wallets: false });
        this.stat.buys += res.buys || 0; this.stat.sent += res.sent || 0;
      } else await this.save(false);
    } catch (e) {
      this.stat.err = String(e && e.message || e).slice(0, 200); this.stat.errAt = Date.now();
      console.log(JSON.stringify({ ev: 'sol-poll-error', err: this.stat.err }));
      /* every endpoint refused: back off, doubling to a minute */
      this.back = Math.min(30_000, Math.max(SOL_EVERY, this.back) * 2);
    }
    this.stat.eps = this.eps.report();
    const every = now - this.movedAt > SOL_QUIET ? SOL_IDLE : SOL_EVERY;
    await this.state.storage.setAlarm(Date.now() + (this.back || every));
  }
}

/* The bot's list and the mass DM (src/audience.mjs). One object; its alarm
   paces a send at Telegram's rate, whether or not the console is open. */
export class AudienceDO {
  constructor(state, env) { this.state = state; this.env = env; this.a = new Audience(state.storage); }
  async fetch(req) {
    let b = {};
    try { b = await req.json(); } catch { b = {}; }
    let out;
    switch (b.op) {
      case 'add': out = await this.a.add(b.id, b.src, { name: b.name, user: b.user }); break;
      case 'list': out = await this.a.list({ after: b.after, limit: b.limit, newest: !!b.newest }); break;
      case 'seenGroup': out = await this.a.seenGroup(b.group || {}); break;
      case 'groups': out = { ok: true, list: await this.a.groups() }; break;
      case 'remove': out = await this.a.remove(b.id); break;
      case 'count': out = { ok: true, count: await this.a.count() }; break;
      case 'start':
        out = await this.a.start({ html: b.html, buttons: b.buttons, label: b.label });
        if (out.ok) await this.state.storage.setAlarm(Date.now() + 300);
        break;
      case 'cancel': out = await this.a.cancel(); break;
      case 'purge': out = await this.a.purge(b.id); break;
      case 'follow': out = await this.a.follow(b.id, b.wallet, b.label); break;
      case 'unfollow': out = await this.a.unfollow(b.id, b.wallet); break;
      case 'following': out = { ok: true, list: await this.a.following(b.id) }; break;
      case 'smart': out = await this.a.smart(b.id, !!b.on); break;
      case 'isSmart': out = { ok: true, smart: await this.a.isSmart(b.id) }; break;
      case 'smartFans': out = { ok: true, list: await this.a.smartFans() }; break;
      case 'callFan': out = await this.a.callFan(b.id, !!b.on); break;
      case 'isCallFan': out = { ok: true, calls: await this.a.isCallFan(b.id) }; break;
      case 'callFans': out = { ok: true, list: await this.a.callFans() }; break;
      case 'wallets': out = { ok: true, list: await this.a.wallets() }; break;
      case 'route': out = await this.a.route(b.wallets); break;
      case 'fanout':
        out = await this.a.enqueue({ uids: b.uids, html: b.html, buttons: b.buttons });
        if (out.ok && !(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 200);
        break;
      default: out = { ok: true, count: await this.a.count(), job: await this.a.job() };
    }
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }
  async alarm() {
    if (!this.env.TG_BOT_TOKEN) return;
    /* a mass DM first; the fan-out queue (tracker alerts) between sends */
    const j = await this.a.job();
    const more = j && j.status === 'sending'
      ? (await this.a.step((id, html, buttons) => sendDm(this.env, id, html, buttons))).more || await this.a.hasQueue()
      : (await this.a.drain((id, html, buttons) => sendDm(this.env, id, html, buttons, { unsub: false }))).more;
    if (more) await this.state.storage.setAlarm(Date.now() + TICK_MS);
  }
}

function audienceClient(env) {
  if (!env.AUDIENCE) return null;
  const stub = () => env.AUDIENCE.get(env.AUDIENCE.idFromName('audience'));
  return async (op, body = {}) => {
    const r = await stub().fetch('https://audience/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, ...body }),
    });
    return r.json();
  };
}

function evmClient(env) {
  if (!env.EVM) return null;
  return async (chain, op, body = {}) => {
    const stub = env.EVM.get(env.EVM.idFromName(chain));
    const r = await stub.fetch('https://evm/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, chain, ...body }),
    });
    return r.json();
  };
}

function solClient(env) {
  if (!env.SOL) return null;
  const stub = () => env.SOL.get(env.SOL.idFromName('solana'));
  return async (op, body = {}) => {
    const r = await stub().fetch('https://sol/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, ...body }),
    });
    return r.json();
  };
}

function guardClient(env) {
  if (!env.GUARD) return null;
  return async (chatId, op, body = {}) => {
    const stub = env.GUARD.get(env.GUARD.idFromName(String(chatId)));
    const r = await stub.fetch('https://guard/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, chatId, ...body }),
    });
    return r.json();
  };
}

export class TapArena {
  constructor(state) { this.state = state; this.arena = null; this.dirty = false; }
  async load() {
    if (this.arena) return;
    const saved = await this.state.storage.get('arena');
    this.arena = Arena.from(saved || null);
  }
  async fetch(req) {
    await this.load();
    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const now = Date.now();
    let out;
    switch (body.op) {
      case 'add': out = this.arena.add(body.tok, body.ip, now); break;
      case 'tap': out = this.arena.tap(body.key, body.n, body.ip, now); break;
      case 'sweep': this.arena.sweep(now); out = { ok: true }; break;
      case 'remove': out = this.arena.remove(body.key); break;
      case 'reset': out = this.arena.reset(body.key, now); break;
      case 'grant': out = this.arena.grant(body.tok, body.n, now); break;
      case 'config': out = this.arena.config(body.cfg); break;
      case 'cfg': out = { ok: true, cfg: this.arena.cfg }; break;
      default: out = this.arena.state(now);
    }
    /* state() records slot flips, so every op can dirty the arena */
    this.dirty = true;
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(now + 5000);
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }
  async alarm() {
    if (this.dirty && this.arena) {
      this.dirty = false;
      await this.state.storage.put('arena', this.arena.toJSON());
    }
  }
}

/* Callers (src/callers.mjs): one watcher for pump.fun's callout feeds. Its
   alarm is the heartbeat — one pollOnce every 20 seconds — so the map and
   the bot read a book that is already warm, and pump.fun is asked each
   thing once however many people are looking. Any request (the cron's
   `tick` every five minutes) restarts the alarm if a deploy lost it. The
   book is saved every two minutes: one storage write, not one per call. */
const CALLERS_TICK_MS = 20_000;
export class CallersDO {
  constructor(state, env) { this.state = state; this.env = env; this.book = null; this.savedAt = Date.now(); }
  async load() {
    if (this.book) return;
    this.book = CallerBook.from(await this.state.storage.get('book'));
  }
  async fetch(req) {
    await this.load();
    let b = {};
    try { b = await req.json(); } catch { b = {}; }
    const now = Date.now();
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(now + 1000);
    const win = CALL_WINDOWS[b.window] ? b.window : 'weekly';
    let out;
    switch (b.op) {
      case 'board': out = { ok: true, window: win, rows: this.book.board(win, now), status: this.book.status(now) }; break;
      case 'live': out = { ok: true, rows: this.book.live(now, Math.min(200, Math.max(1, +b.limit || 150))), status: this.book.status(now) }; break;
      case 'status': out = { ok: true, ...this.book.status(now) }; break;
      default: out = { ok: true };
    }
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }
  async alarm() {
    await this.load();
    const now = Date.now();
    try { await pollOnce(this.book, now); }
    catch (e) { this.book.polls.lastError = String(e && e.message || e).slice(0, 120); }
    try { await this.sendAlerts(now); } catch { /* the next tick tries the next calls */ }
    if (now - this.savedAt > 120_000) {
      this.savedAt = now;
      try { await this.state.storage.put('book', this.book.toJSON(now)); } catch { /* next save */ }
    }
    await this.state.storage.setAlarm(Date.now() + CALLERS_TICK_MS);
  }
  /* New calls from the week's top callers, to whoever asked for them, through
     the audience's paced queue — the same one the wallet tracker uses. */
  async sendAlerts(now) {
    const list = this.book.alerts(now);
    if (!list.length || !this.env.TG_BOT_TOKEN) return;
    const aud = audienceClient(this.env);
    if (!aud) return;
    const fans = ((await aud('callFans')) || {}).list || [];
    if (!fans.length) return;
    for (const a of list) {
      const { html, buttons } = formatCallAlert(this.env, a.call, a.caller);
      await aud('fanout', { uids: fans, html, buttons });
    }
  }
}

function callersClient(env) {
  if (!env.CALLERS) return null;
  const stub = () => env.CALLERS.get(env.CALLERS.idFromName('callers'));
  return async (op, body = {}) => {
    const r = await stub().fetch('https://callers/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, ...body }),
    });
    return r.json();
  };
}

/* The API talks to the arena through one async call, the same one the Node
   dev server answers from memory. Without the binding (a deploy that has not
   run the migration) the routes say so instead of throwing. */
function arenaClient(env) {
  if (!env.ARENA) return null;
  const stub = env.ARENA.get(env.ARENA.idFromName('arena'));
  return async (op, body = {}) => {
    const r = await stub.fetch('https://arena/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, ...body }),
    });
    return r.json();
  };
}

/* Per-isolate memory. Cloudflare recycles isolates freely, so this is a cache,
   never the source of truth — KV holds anything that must survive. */
let HIST = null;
let histDirtyAt = 0;
/* Fifteen minutes, not five: history was saved by the cron every tick and by
   every isolate every five minutes, ~600+ of the free plan's 1,000 KV writes
   a day on its own — the same budget a paid boost is recorded from. A lost
   quarter of an hour only dulls the colours. */
const HIST_SAVE_EVERY = 15 * 60 * 1000;

function makeStore(env) {
  const kv = env.BUBBLE_KV;
  return {
    /* No binding means boosts cannot be persisted, so the API refuses to sell
       one rather than taking money it cannot honour. */
    available: !!kv,
    async get(key) {
      if (!kv) return null;
      return await kv.get(key, 'json');
    },
    async put(key, value, opts = {}) {
      if (!kv) return;
      const o = {};
      if (opts.ttlSec) o.expirationTtl = Math.max(60, opts.ttlSec);
      await kv.put(key, JSON.stringify(value), o);
    },
  };
}

async function loadHist(env) {
  if (HIST) return HIST;
  HIST = new Map();
  try {
    const kv = env.BUBBLE_KV;
    if (kv) {
      const saved = await kv.get('hist', 'json');
      if (saved) { HIST = histFromJSON(saved); pruneHistory(HIST); }
    }
  } catch { /* history is an optimisation; losing it only dulls the colours */ }
  return HIST;
}

async function saveHist(env) {
  try {
    const kv = env.BUBBLE_KV;
    if (!kv || !HIST) return;
    pruneHistory(HIST);
    await kv.put('hist', JSON.stringify(histToJSON(HIST)));
    histDirtyAt = Date.now();
  } catch { /* non-fatal */ }
}

/* Edge-cached image proxy. Token art is immutable, so one fetch per image per
   colo serves everybody after that. */
function imageFetcher(execCtx) {
  return async (target, ttl) => {
    const cacheKey = new Request(target, { method: 'GET' });
    const cache = caches.default;

    /* **A cached failure is worse than no cache.** `cacheEverything` caches by
       status as well as by body, so one 429 from a rate-limited IPFS gateway
       was stored under the image's URL and served back for the whole week-long
       TTL — before any fallback could run, because the hit returns first. That
       is why $JEANPHIL wore a letter avatar on the map for days while its art
       sat one gateway away and answered in 300ms. Only an actual image is a
       cache hit. */
    const hit = await cache.match(cacheKey);
    if (hit && hit.ok && /^image\//i.test(hit.headers.get('content-type') || '')) return hit;

    /* A rate-limited IPFS gateway is not a missing image — the same CID is on
       every other gateway. Without this the proxy passed the 429 straight
       through and the token wore a letter avatar on the map, which is what
       $JEANPHIL and $Replicate were doing while their art sat one host away.
       Tried in order, fastest known first, and only on failure. */
    let upstream = null;
    for (const href of [target, ...altGateways(target)]) {
      try {
        const r = await fetch(href, {
          headers: { 'user-agent': 'pumpbubble.fun/1.0' },
          signal: AbortSignal.timeout(8000),
          /* by status, so a 429 or a 502 is never what the edge remembers */
          cf: { cacheTtlByStatus: { '200-299': ttl, '300-399': 0, '400-599': 0 } },
        });
        if (r.ok && /^image\//i.test(r.headers.get('content-type') || '')) { upstream = r; break; }
      } catch { /* try the next one */ }
    }
    if (!upstream) return new Response('upstream unreachable', { status: 502 });

    const type = upstream.headers.get('content-type') || 'image/png';

    const res = new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': type,
        'cache-control': `public, max-age=${ttl}, immutable`,
        'access-control-allow-origin': '*',
        'x-pb-cache': 'miss',
      },
    });
    execCtx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  };
}

/* The image proxy needs a signing secret that every isolate agrees on. If none
   was configured, images vanish entirely and nothing says why — which is a poor
   trade for a value nobody has to choose. Generate one, keep it in KV, and let
   every isolate load the same one. A configured IMG_SECRET always wins. */
let SECRET = null;

async function imgSecret(env) {
  if (env.IMG_SECRET) return env.IMG_SECRET;
  if (SECRET) return SECRET;
  const kv = env.BUBBLE_KV;
  if (!kv) return 'unconfigured-image-secret';
  try {
    SECRET = await kv.get('img_secret');
    if (!SECRET) {
      SECRET = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
      await kv.put('img_secret', SECRET);
    }
  } catch {
    SECRET = SECRET || 'unconfigured-image-secret';
  }
  return SECRET;
}

async function makeCtx(env, execCtx) {
  /* env is a frozen binding object, so hand the API a copy carrying the
     resolved secret rather than trying to write back onto it */
  env = { ...env, IMG_SECRET: await imgSecret(env) };
  return {
    env,
    store: makeStore(env),
    hist: await loadHist(env),
    arena: arenaClient(env),
    guard: guardClient(env),
    evm: evmClient(env),
    sol: solClient(env),
    audience: audienceClient(env),
    callers: callersClient(env),
    fetchImage: imageFetcher(execCtx),
    /* lets counting flush after the response is sent, off the critical path */
    waitUntil: p => execCtx.waitUntil(p),
    onSnapshot() {
      /* Persist history occasionally — at most every fifteen minutes per isolate. */
      if (Date.now() - histDirtyAt > HIST_SAVE_EVERY) {
        histDirtyAt = Date.now();
        execCtx.waitUntil(saveHist(env));
      }
    },
  };
}

export default {
  async fetch(request, env, execCtx) {
    const ctx = await makeCtx(env, execCtx);

    const res = await handle(request, ctx);
    if (res) return res;

    /* Not an API route → static assets. */
    if (!env.ASSETS) return new Response('not found', { status: 404 });

    /* /embed serves the same page, with headers that permit framing.
       The site-wide policy is frame-ancestors 'none' and X-Frame-Options DENY,
       which is right for a page showing a payment address and wrong for the one
       route whose entire purpose is to be put in somebody else's iframe. The
       exception is scoped to this path only, and set here rather than in
       _headers because the worker runs first and this must not depend on which
       rule the asset layer decides wins. */
    const p = new URL(request.url).pathname.replace(/\/+$/, '');

    /* /market is rendered on the server: the coin table, the summary line and
       the structured data are injected into the static shell before it is sent.
       A crawler that runs no JavaScript still gets the whole market as text,
       which is the entire point of the page. */
    if (p === '/market' || p === '/board') {
      /* Ask the asset layer for '/market', not '/market.html'. An explicit
         .html request is normalised into a 307 back to the extensionless path —
         which now re-enters the worker, because run_worker_first names /market,
         and loops. Same trap as /embed, where fetching '/index.html' redirected
         to '/'. env.ASSETS.fetch bypasses the worker, so this resolves to the
         file without recursing. */
      const shell = new URL(request.url);
      shell.pathname = p;
      shell.search = '';
      const res = await env.ASSETS.fetch(new Request(shell, { headers: request.headers }));
      if (!res.ok) return res;
      try {
        const html = await res.text();
        const api = p === '/board' ? '/api/board' : '/api/market';
        const data = await handle(new Request('https://pumpbubble.fun' + api), ctx);
        const j = data ? await data.json() : null;
        const body = j?.ok
          ? html
              .replace('<!--MARKET_SUMMARY-->', j.summary)
              .replace('<!--MARKET_TABLE-->', j.table)
              .replace('<!--MARKET_JSONLD-->', j.jsonld || '')
              .replace('<!--BOARD_SUMMARY-->', j.summary)
              .replace('<!--BOARD_TABLE-->', j.table)
              .replace('<!--BOARD_JSONLD-->', j.jsonld || '')
              .replace(/<!--UPDATED-->/g, new Date(j.ts).toISOString())
          : html;
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            /* the numbers age, the page does not need to be re-rendered per hit */
            'cache-control': 'public, max-age=60, s-maxage=60',
          },
        });
      } catch {
        return res;   // fall back to the shell rather than an error page
      }
    }

    if (p === '/embed') {
      /* Ask for '/', not '/index.html'. Workers Assets normalises an explicit
         index.html into a 307 back to the directory root — which lands on the
         main page, and that page is served frame-ancestors 'none'. The embed
         then refuses to frame with headers that look correct in isolation. */
      const page = new URL(request.url);
      page.pathname = '/';
      const res = await env.ASSETS.fetch(new Request(page, request));
      const h = new Headers(res.headers);
      h.delete('x-frame-options');
      h.set('content-security-policy',
        "default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; " +
        "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors *");
      /* an embed is a widget, not a document to be indexed on its own */
      h.set('x-robots-tag', 'noindex');
      h.set('cache-control', 'public, max-age=0, must-revalidate');
      return new Response(res.body, { status: res.status, headers: h });
    }

    /* /swap is Jupiter's widget (public/swap.html), and it is the one page
       that loads code from somebody else: the plugin and its CSS from
       plugin.jup.ag, Inter from Google Fonts, quotes and wallets over any
       https/wss host, token art from anywhere. So it gets its own policy, set
       here like /embed's so nothing depends on how _headers rules merge — and
       the map's strict one is untouched. It renders no token string except
       through esc(), and nothing of ours on it moves money. Popups stay
       allowed for wallets that sign in a window of their own. */
    if (p === '/swap') {
      const page = new URL(request.url);
      page.pathname = '/swap';
      const res = await env.ASSETS.fetch(new Request(page, { headers: request.headers }));
      const h = new Headers(res.headers);
      h.set('content-security-policy', SWAP_CSP);
      h.set('cross-origin-opener-policy', 'same-origin-allow-popups');
      h.set('cache-control', 'public, max-age=0, must-revalidate');
      return new Response(res.body, { status: res.status, headers: h });
    }

    return env.ASSETS.fetch(request);
  },

  /* Cron keeps a warm snapshot and a persisted history even with no traffic,
     so the first visitor of the day does not wait on a cold fetch. */
  async scheduled(event, env, execCtx) {
    const ctx = await makeCtx(env, execCtx);
    execCtx.waitUntil((async () => {
      try {
        await handle(new Request('https://pumpbubble.fun/api/tokens'), ctx);
        /* Keep the whole-market feed warm too. /market renders from it, and a
           cold CoinGecko fetch is several seconds — which a crawler counts
           against the page and a visitor simply waits through. */
        await handle(new Request('https://pumpbubble.fun/api/tokens?source=majors'), ctx);
        /* Reconcile payments whose buyer never came back to the tab. Without
           this a correct payment can sit unclaimed indefinitely — which is
           exactly what happened in production before the sweep existed. */
        await handle(new Request('https://pumpbubble.fun/api/boost/sweep'), ctx);
        /* One slice of stock long-windows per tick. The whole universe warms up
           over roughly half an hour and then only refreshes daily. */
        await handle(new Request('https://pumpbubble.fun/api/stocks/windows'), ctx);
        await handle(new Request('https://pumpbubble.fun/api/majors/windows'), ctx);
        /* One tick's worth of Robinhood Chain discovery. The chain has no
           endpoint that ranks it, so the list is widened a little at a time. */
        await handle(new Request('https://pumpbubble.fun/api/robinhood/discover'), ctx);
        /* One slice of Base pricing, and the token list once a day. */
        await handle(new Request('https://pumpbubble.fun/api/base/sweep'), ctx);
        /* Chain and launchpad flows, rebuilt every twenty minutes. */
        await handle(new Request('https://pumpbubble.fun/api/flows/refresh'), ctx);
        /* One slice of casino hot wallets per tick. */
        await handle(new Request('https://pumpbubble.fun/api/casinos/sweep'), ctx);
        /* Telegram buybot: registers its webhook once TG_BOT_TOKEN exists. A
           no-op without the token and a one-call check with it. */
        await handle(new Request('https://pumpbubble.fun/api/tg/ensure'), ctx);
        /* The callers' watcher runs on its own alarm; this only restarts it if
           a deploy or an error ever lost it. */
        if (ctx.callers) await ctx.callers('tick').catch(() => null);
        /* the Solana buy watcher, likewise: a deploy restarts it, this only
           makes sure it is running while groups follow a token */
        if (ctx.sol) await ctx.sol('tick').catch(() => null);
        /* Marketing. Silent unless four X secrets are set, and rate-limited
           inside itself rather than by how often this fires. */
        await xbotTick(env, makeStore(env), async () => {
          /* Only reached once the poster has decided it is actually going to
             post, so this is three cached snapshot reads a day, not per tick. */
          const feed = async (src) => {
            try {
              const r = await handle(new Request(
                'https://pumpbubble.fun/api/tokens?source=' + src), ctx);
              const j = await r.json();
              return (j && j.tokens) || [];
            } catch { return []; }
          };
          const [pumpfun, majors, stocks] = await Promise.all(
            [feed('pumpfun'), feed('majors'), feed('stocks')]);
          return { pumpfun, majors, stocks };
        });
        /* history on the quarter hours only (see HIST_SAVE_EVERY) */
        if (new Date(event.scheduledTime || Date.now()).getUTCMinutes() % 15 < 5) await saveHist(env);
        await flushStats(makeStore(env));
      } catch { /* next tick will retry */ }
    })());
  },
};
