/* ==========================================================================
   pumpbubble.fun — how long each Durable Object is awake.

   The free plan gives every Durable Object on the account one shared
   allowance of 13,000 GB-s a day — wall-clock time while an object is
   handling a request or an alarm, at 128 MB — and past it every object stops
   with "Exceeded allowed duration in Durable Objects free tier" until 00:00
   UTC. On 2026-10-17 that happened before 18:00 UTC, the day after the Solana
   watcher started polling through Alchemy every 8 s, and nothing said which
   object had spent it: the Solana buy alerts, the Calls and KOL boards,
   Insiders and the bot's own settings store all stopped at once.

   So every object class is metered: the wall time of each alarm and each
   request, summed per UTC day (Cloudflare's day), kept in the object's own
   storage under `__busy` and saved at most every five minutes. A request to
   `/__busy` answers the day so far without being metered itself.
   /api/health/do lists them all.
   ========================================================================== */

export const DAY_GBS = 13_000;      // the free plan's daily allowance, all objects together
export const GB = 0.128;            // what one second of an object costs, in GB-s
const KEY = '__busy';

export const dayOf = now => new Date(now).toISOString().slice(0, 10);

export function addBusy(b, kind, ms, now) {
  const day = dayOf(now);
  const cur = b && b.day === day ? { ...b } : { day, alarmMs: 0, fetchMs: 0, alarms: 0, fetches: 0 };
  if (kind === 'alarm') { cur.alarmMs += ms; cur.alarms++; } else { cur.fetchMs += ms; cur.fetches++; }
  return cur;
}

export function busyReport(b, now = Date.now()) {
  const today = b && b.day === dayOf(now) ? b : null;
  const s = today ? (today.alarmMs + today.fetchMs) / 1000 : 0;
  return { day: dayOf(now), s: Math.round(s), gbs: Math.round(s * GB), alarms: today ? today.alarms : 0, fetches: today ? today.fetches : 0 };
}

/* Wraps a Durable Object class's alarm() and fetch() in place. Every class
   here keeps its state as `this.state`. */
export function meterClass(Cls, { now = () => Date.now(), saveEvery = 300_000 } = {}) {
  const P = Cls.prototype;
  if (P.__metered) return Cls;
  P.__metered = true;
  const load = async self => {
    if (self.__busy !== undefined) return;
    try { self.__busy = (await self.state.storage.get(KEY)) || null; } catch { self.__busy = null; }
  };
  const add = async (self, kind, ms) => {
    await load(self);
    self.__busy = addBusy(self.__busy, kind, ms, now());
    if (!self.__busyAt || now() - self.__busyAt >= saveEvery) {
      self.__busyAt = now();
      try { await self.state.storage.put(KEY, self.__busy); } catch { /* the allowance is out: nothing to save into */ }
    }
  };
  if (typeof P.alarm === 'function') {
    const alarm = P.alarm;
    P.alarm = async function (...a) {
      const t0 = now();
      try { return await alarm.apply(this, a); }
      finally { await add(this, 'alarm', now() - t0); }
    };
  }
  const fetch = P.fetch;
  P.fetch = async function (req, ...a) {
    let path = '';
    try { path = new URL(req.url).pathname; } catch { /* not a URL we made */ }
    if (path === '/__busy') { await load(this); return Response.json(busyReport(this.__busy, now())); }
    const t0 = now();
    try { return await fetch.call(this, req, ...a); }
    finally { await add(this, 'fetch', now() - t0); }
  };
  return Cls;
}
