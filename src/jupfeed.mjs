/* ==========================================================================
   pumpbubble.fun — Jupiter's token API: the pump.fun feed's second source

   **pump.fun closed its API to servers on 2026-11-13.** Every host —
   frontend-api-v3, swap-api, advanced-indexer, profile-api — answers a
   Cloudflare managed challenge ("Just a moment…", `cf-mitigated: challenge`)
   to the Worker, to its Durable Objects and to a plain request from a cloud
   machine alike. A challenge is pump.fun's own access control, so it is not
   something to get round: the map reads the same coins from a source that
   publishes them openly.

   Jupiter's Tokens API v2 is that source. Keyless on lite-api.jup.ag (and on
   api.jup.ag with a free key), CORS-open, and it labels every token with the
   launchpad that minted it (`launchpad: "pump.fun"`). Measured 2026-11-18:

   - the trending, traded and organic-score lists (5m/1h/6h/24h, 100 each)
     and `recent` held 199 pump.fun mints, 170 of them graduated;
   - `/tokens/v2/search?query=<up to 100 mints>` answers a batch in one call,
     which is how the established names (Fartcoin, Pnut, MOODENG…) that are
     not trending today are kept on the map — `src/pumpseed.mjs`;
   - every row carries market cap, liquidity, price change and buy/sell
     volume per window, holders, and an audit: top holders' share, the
     deployer's share and how many tokens the deployer has minted.

   The keyless tier answered with `x-ratelimit-remaining: 4` and a one-second
   reset, i.e. about five requests a second per caller, so calls go out in
   paced bursts of four. With `JUP_API_KEY` set the keyed host is used and the
   quota is ours rather than shared with whoever else is on the same egress IP.

   This module is HTTP only. The rows are shaped into map tokens by
   `normalizeJup()` in core.mjs, beside `normalizeCoin()`, so nothing here
   imports core and there is no cycle.
   ========================================================================== */

export const JUP_LITE = 'https://lite-api.jup.ag';
export const JUP_KEYED = 'https://api.jup.ag';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const UA = 'pumpbubble.fun/1.0 (+https://pumpbubble.fun)';

let KEY = '';
export function setJupKey(k) { KEY = /^[A-Za-z0-9_-]{8,128}$/.test(String(k || '')) ? String(k) : ''; }
const host = () => (KEY ? JUP_KEYED : JUP_LITE);

/* What the last call said, for /api/health. */
export const jupStatus = { lastOkAt: 0, lastError: '', lastErrorAt: 0, calls: 0, keyed: false };

export const BURST = 4;
export const GAP_MS = 1100;
export const SEARCH_MAX = 100;

/* The lists that carry pump.fun's coins, most useful first (measured greedy
   coverage of the 199: 5m trending 58, 6h +42, recent +26, organic 1h +26,
   24h trending +15, 1h trending +12 — the other seven lists added 20). */
export const PUMP_LISTS = [
  'toptrending/5m', 'toptrending/6h', 'toporganicscore/1h', 'toptrending/24h', 'toptrending/1h', 'recent',
];

async function jj(path, { ms = 8000, http = fetch } = {}) {
  const headers = { accept: 'application/json', 'user-agent': UA };
  if (KEY) headers['x-api-key'] = KEY;
  jupStatus.calls++;
  jupStatus.keyed = !!KEY;
  try {
    const r = await http(host() + path, { headers, signal: AbortSignal.timeout(ms) });
    if (!r.ok) { const e = new Error('jupiter ' + r.status + ' ' + path.split('?')[0]); e.status = r.status; throw e; }
    const j = await r.json();
    jupStatus.lastOkAt = Date.now();
    return j;
  } catch (e) {
    jupStatus.lastError = String((e && e.message) || e).slice(0, 120);
    jupStatus.lastErrorAt = Date.now();
    throw e;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Runs thunks in bursts that stay under the keyless tier's per-second limit. */
export async function paced(tasks, { burst = BURST, gap = GAP_MS } = {}) {
  const out = [];
  for (let i = 0; i < tasks.length; i += burst) {
    if (i) await sleep(gap);
    out.push(...await Promise.allSettled(tasks.slice(i, i + burst).map(f => f())));
  }
  return out;
}

const listPath = l => '/tokens/v2/' + l + (l.includes('?') ? '' : '?limit=100');
const searchPath = mints => '/tokens/v2/search?query=' + mints.map(encodeURIComponent).join(',');

/* Every row from the lists plus a batch lookup of `mints`, one row per mint.
   A list that fails is skipped; only all of them failing is an error. */
export async function jupRows({ lists = PUMP_LISTS, mints = [], http, gap } = {}) {
  const tasks = lists.map(l => () => jj(listPath(l), { http }));
  const want = [...new Set(mints.filter(Boolean))];
  for (let i = 0; i < want.length; i += SEARCH_MAX) {
    const chunk = want.slice(i, i + SEARCH_MAX);
    tasks.push(() => jj(searchPath(chunk), { http }));
  }
  const res = await paced(tasks, { gap });
  const by = new Map();
  let ok = 0;
  for (const r of res) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    ok++;
    for (const t of r.value) if (t && typeof t.id === 'string' && !by.has(t.id)) by.set(t.id, t);
  }
  if (!ok) throw new Error(jupStatus.lastError || 'jupiter: no list answered');
  return [...by.values()];
}

/* Rows for exactly these mints (the map's single-token lookups, and the
   colour for Solana tokens DexScreener would not price). */
export async function jupByMint(mints, { http, gap } = {}) {
  const want = [...new Set((mints || []).filter(Boolean))];
  const out = new Map();
  if (!want.length) return out;
  const tasks = [];
  for (let i = 0; i < want.length; i += SEARCH_MAX) {
    const chunk = want.slice(i, i + SEARCH_MAX);
    tasks.push(() => jj(searchPath(chunk), { http }));
  }
  for (const r of await paced(tasks, { gap })) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const t of r.value) if (t && want.includes(t.id)) out.set(t.id, t);
  }
  return out;
}

/* SOL in dollars, for pricing a bonding curve's reserves. */
export async function jupSolPrice({ http } = {}) {
  try {
    const j = await jj('/price/v3?ids=' + SOL_MINT, { ms: 5000, http });
    const p = j && j[SOL_MINT] && +j[SOL_MINT].usdPrice;
    return Number.isFinite(p) && p > 0 ? p : 0;
  } catch { return 0; }
}
