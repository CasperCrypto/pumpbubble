/* ==========================================================================
   pumpbubble.fun — the keys that must save, kept in a Durable Object.

   The free plan allows 1,000 KV writes a day for the whole account, and the
   background jobs (feed copies, history, sweeps) spend them by the evening.
   After that every KV write fails until 00:00 UTC — and among them were the
   ones that matter: on 2026-10-16 a group's /setup answered "KV put() limit
   exceeded for the day", and the same wall stands in front of the write that
   activates a paid boost. A Durable Object's storage has its own allowance,
   100,000 rows written a day, so these keys live there instead:

     - everything the Telegram bot keeps (`tg:` — groups, tracked mints,
       subscribers, its profile), and
     - everything money buys or the operator sets by hand (boosts, pending
       orders, ads, bids, the hide list, the welcome gift).

   Everything else stays in KV; losing a feed copy for a few hours only makes
   a cold isolate slower.

   The object is the truth for these keys once it holds one. Until a key's
   first write lands there, KV's copy is read — so nothing has to be moved by
   hand, and data written before this existed is still found. Reads are kept
   per isolate for 30 seconds (KV's own edge cache holds a read for 60, so
   this is no staler than before) and cloned, because callers push into the
   lists they read. A write that cannot reach the object throws: a save that
   silently went to KV instead would be overwritten by the object's older copy
   on the next read, which is worse than an error the caller can show.
   ========================================================================== */

export const OBJECT_KEYS = new Set(['boosts', 'pending', 'ads', 'alertads', 'dmads', 'bids', 'welcomed', 'hidden', 'ourtoken', 'affiliates']);
export const inObject = key => typeof key === 'string' && (key.startsWith('tg:') || OBJECT_KEYS.has(key));

const clone = v => v == null ? null : structuredClone(v);

/* `base` is the KV store ({available, get, put}); `call(body)` reaches the
   object and resolves to its JSON answer. */
export function objectStore(base, call, { ttl = 30_000, mem = new Map(), now = () => Date.now() } = {}) {
  return {
    available: base.available,
    async get(key) {
      if (!inObject(key)) return base.get(key);
      const hit = mem.get(key);
      if (hit && now() - hit.at < ttl) return clone(hit.v);
      let r = null;
      try { r = await call({ op: 'get', key }); } catch { /* out of reach: KV's copy below */ }
      const v = r && r.has ? (r.v ?? null) : await base.get(key);
      mem.set(key, { at: now(), v: clone(v) });
      return clone(v);
    },
    async put(key, value, opts = {}) {
      if (!inObject(key)) return base.put(key, value, opts);
      const exp = opts.ttlSec ? now() + Math.max(60, opts.ttlSec) * 1000 : 0;
      await call({ op: 'put', key, v: value ?? null, exp });
      mem.set(key, { at: now(), v: clone(value) });
    },
  };
}

/* The object itself: one instance (`idFromName('store')`), SQLite-backed.
   A key is {v, exp}; an expired one reads as null rather than falling back to
   KV, whose copy is older still. */
export class StoreDO {
  constructor(state) { this.state = state; }
  async fetch(req) {
    let b = null;
    try { b = await req.json(); } catch { /* below */ }
    const s = this.state.storage;
    if (b && b.op === 'get' && typeof b.key === 'string') {
      const e = await s.get(b.key);
      if (e === undefined) return Response.json({ has: false });
      return Response.json({ has: true, v: e.exp && e.exp < Date.now() ? null : e.v });
    }
    if (b && b.op === 'put' && typeof b.key === 'string') {
      await s.put(b.key, { v: b.v ?? null, exp: +b.exp || 0 });
      return Response.json({ ok: true });
    }
    if (b && b.op === 'keys') {
      const m = await s.list({ limit: 1000 });
      return Response.json({ keys: [...m.keys()] });
    }
    return new Response('bad request', { status: 400 });
  }
}
