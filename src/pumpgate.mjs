/* ==========================================================================
   pumpbubble.fun — one gate in front of every pump.fun request

   Since 2026-11-13 pump.fun answers every server request with a Cloudflare
   managed challenge: 403, `cf-mitigated: challenge`, an HTML "Just a
   moment…" page. That is pump.fun's own access control and it is respected,
   not worked around: once it is seen, nothing here asks pump.fun again for
   ten minutes, then a single request checks whether it has lifted.

   Why a gate and not just the error: a pump.fun snapshot is six requests, the
   callers' tick up to twenty, Trending's board three — every one a subrequest
   out of the fifty a free-plan invocation may make, spent on a door that is
   known to be shut, and each one a log line saying only "403".

   No imports, so every module that talks to pump.fun can use it (core,
   activity, traders, callers, smart money, pumptrend) without a cycle.
   ========================================================================== */

export const PUMP_PAUSE_MS = 10 * 60_000;

export const pumpStatus = {
  blocked: false,     // the last answer was a challenge
  since: 0,           // first challenge of the current run
  lastBlockAt: 0,
  lastOkAt: 0,
  lastError: '',
  skipped: 0,         // requests not sent while paused
};

const isPump = url => /^https:\/\/([a-z0-9-]+\.)*pump\.fun\//i.test(String(url));

export function pumpPaused(now = Date.now()) {
  return pumpStatus.blocked && now - pumpStatus.lastBlockAt < PUMP_PAUSE_MS;
}

/* A challenge, as opposed to an ordinary 403 (a banned coin, a private
   profile): Cloudflare says so in a header, and the body is HTML. */
export function isChallenge(r) {
  if (!r || r.status !== 403) return false;
  const h = r.headers;
  const mit = h && typeof h.get === 'function' ? String(h.get('cf-mitigated') || '') : '';
  const type = h && typeof h.get === 'function' ? String(h.get('content-type') || '') : '';
  return /challenge/i.test(mit) || /text\/html/i.test(type);
}

function refused(url) {
  const e = new Error('pump.fun refuses servers (Cloudflare challenge) — paused');
  e.status = 403; e.challenge = true; e.url = String(url).slice(0, 90);
  return e;
}

/* fetch(), for a pump.fun URL. Anything else passes straight through. */
export async function pumpFetch(url, init = {}, http = fetch, now = Date.now()) {
  if (!isPump(url)) return http(url, init);
  if (pumpPaused(now)) { pumpStatus.skipped++; throw refused(url); }
  const r = await http(url, init);
  if (isChallenge(r)) {
    if (!pumpStatus.blocked) pumpStatus.since = now;
    pumpStatus.blocked = true;
    pumpStatus.lastBlockAt = now;
    pumpStatus.lastError = '403 challenge ' + String(url).replace(/\?.*/, '').slice(0, 80);
    throw refused(url);
  }
  if (r.ok) { pumpStatus.blocked = false; pumpStatus.since = 0; pumpStatus.lastOkAt = now; }
  return r;
}

/* For tests. */
export function _resetPumpGate() {
  Object.assign(pumpStatus, { blocked: false, since: 0, lastBlockAt: 0, lastOkAt: 0, lastError: '', skipped: 0 });
}
