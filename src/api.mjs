/* ==========================================================================
   pumpbubble.fun — HTTP API, shared by the Worker and the local dev server.
   Written against web-standard Request/Response, which Node 22 and Workers
   both provide, so there is exactly one implementation of every route.
   ========================================================================== */

import { sponsoredDm } from './audience.mjs';
import { buildSnapshot, verifyUrl, isMint, isCA, isEvmAddr, fetchCoin, fetchSolPrice, clean,
         signUrl, enrich, resolveAnyToken, dexStatus, _dexMemForTests, fastImage } from './core.mjs';
import { embedConfig, safeAccent } from './embed.mjs';
import { buyConfig, swapConfig } from './refs.mjs';
import { pctLabel, mcapLabel, TF_LABEL, TF_SHORT, CARD_W } from './card.mjs';
import { cardSvgFor, boardCardSvgFor, bubbleCardSvgFor, sharePage, page, logoDataUri } from './share.mjs';
import { seedFor } from './bubblecard.mjs';
import { buildTableSvg, UP as T_UP, DN as T_DN, DIM as T_DIM } from './tablecard.mjs';
import { svgToPng } from './png.mjs';
import { creds as xCreds, KEY as XBOT_KEY, topMovers, build as buildPost } from './xbot.mjs';
import {
  enabled as tgEnabled, webhookSecret as tgWebhookSecret, handleUpdate as tgUpdate,
  onTrade as tgTrade, ensureWebhook as tgEnsure, status as tgStatus, broadcast as tgBroadcast, notifyPaid as tgNotifyPaid, tokenLinks as tgTokenLinks, setChannel as tgSetChannel,
  syncHelius as tgSyncHelius, groupList as tgGroups, sendDm as tgSendDm,
} from './tgbot.mjs';
import { deliveryAuth as heliusAuth } from './helius.mjs';
import { solPolling } from './solwatch.mjs';
import { sweepCasinos, loadHot as loadCasinoHot, totals as casinoTotals } from './casinos.mjs';
import { discover } from './rhchain.mjs';
import { refreshUniverse, sweep as baseSweep, seed as baseSeed, loadCache as baseCache } from './basechain.mjs';
import { refreshFlows } from './flows.mjs';
import { buildTrending, mergeMovers, TREND_SOURCES } from './trending.mjs';
import { pumpTrending } from './pumptrend.mjs';
import { GOLD_USD as TAP_GOLD_USD, AD_SLOTS as TAP_AD_SLOTS } from './taps.mjs';
import { adminEnabled, adminPath, authed, adminPage,
         lockedOut, noteFailure, clearFailures } from './admin.mjs';
import { loadRegistry as rhRegistry, seed as rhSeed } from './rhchain.mjs';
import { loadWindows, applyWindows, refreshWindows } from './stockwin.mjs';
import {
  loadWindows as loadCryptoWin,
  applyWindows as applyCryptoWin,
  refreshWindows as refreshCryptoWin,
} from './cryptowin.mjs';
import { SOURCES, DEFAULT_SOURCE, sourceOf, publicSources, setCoingeckoKey } from './sources.mjs';
import { gpuBoard, COMPUTE_STOCKS, computeCgIds, gpuFeed, HIST_KEY as GPU_HIST_KEY } from './compute.mjs';
import { renderMarketPage, marketTable, marketSummary, marketJsonLd,
         boardTable, boardSummary, boardJsonLd } from './seo.mjs';
import { resolveReferral, statement, getAffiliate, isCode } from './affiliates.mjs';
import { shouldCount, record, dueForFlush, flush as flushStats, summary as statsSummary } from './stats.mjs';
import { board, priceFor, standing, countClick, bidsAsBoostSpend,
         FLOOR_SOL, INCREMENT_SOL } from './bids.mjs';
import {
  TIERS, tierOf, createOrder, signOrder, readOrder, findPayment,
  activeBoosts, activateBoost, applyBoosts, goldShare, bonusFromSpend, spendForBonus,
  addPending, listPending, sweepPayments, ORDER_TTL_MS, AD_TIERS, AD_QUEUE_DAYS, adSchedule,
} from './boosts.mjs';

const SNAPSHOT_TTL = 10_000;      // pump.fun poll interval
const STALE_OK     = 120_000;     // serve stale rather than fail
const IMG_TTL      = 604_800;     // a token's art never changes: cache a week
const GOLD_CAP     = 0.25;        // hard ceiling on paid share of bubble area
const VIEW_N       = 100;         // bubbles the default desktop view shows

/* Gold share has to be measured against what is actually on screen. Measuring
   it across all 300 fetched tokens would dilute it and quietly allow
   over-selling, so use the default view — the top VIEW_N by market cap — plus
   any boosted token, which is pinned into the view wherever its cap sits. */
function visibleSet(tokens, byMint) {
  const top = [...tokens].sort((a, b) => b.mcap - a.mcap).slice(0, VIEW_N);
  const have = new Set(top.map(t => t.mint));
  for (const t of tokens) if (byMint.has(t.mint) && !have.has(t.mint)) top.push(t);
  return top;
}

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...extra,
  },
});

/* ---------------------------------------------------------- rate limiting */
/* Per-isolate, in memory. Deliberately not KV: a limiter that writes to KV can
   be used to exhaust the very quota it protects. This stops the obvious abuse
   (one client hammering one colo) at zero cost. The real edge-wide limit
   belongs in a Cloudflare Rate Limiting rule — see docs/security.md. */
const hits = new Map();
function rateLimit(req, bucket, max, windowMs) {
  const ip = req.headers.get('cf-connecting-ip')
    || req.headers.get('x-forwarded-for')
    || 'local';
  const key = bucket + ':' + ip;
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.reset) {
    hits.set(key, { n: 1, reset: now + windowMs });
    if (hits.size > 10000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    return null;
  }
  if (++rec.n > max) {
    return json({ ok: false, error: 'slow down — too many requests' }, 429,
      { 'retry-after': String(Math.ceil((rec.reset - now) / 1000)) });
  }
  return null;
}

/* ------------------------------------------------------- snapshot cache */
/* One fetch per TTL per isolate, with in-flight de-duplication so a burst of
   visitors cannot fan out into a burst of pump.fun calls. */
/* One cache per mode: graduated and bonding are separate feeds with different
   lifetimes, and a shared cache would have them evicting each other every poll. */
const caches = new Map();

/* Market data for boosted tokens that are not in the feed being shown.

   A boost is bought for a small token, and small is exactly what does not make
   pump.fun's top-cap pages — so the paid bubble is re-added below, from the
   boost record. That record holds what was paid, not what the token is doing,
   and for a long time the re-added bubble therefore carried a hardcoded zero
   change and zero volume. It rendered as a confident "+0.00%" on the token the
   site most wants people to look at, and would now mint share cards saying the
   same. DexScreener has the real figures; they just were never asked for.

   Cached separately from the snapshot because the re-add happens per request,
   after it. One upstream call a minute for a handful of paid mints. */
/* Which feeds the ranked card is allowed to draw from, and what it calls them.
   A table rather than free text out of the query string: the value reaches the
   rasteriser and is printed onto an image that carries our domain. */
const BOARD_SRC = { pumpfun: 'pumpfun', majors: 'majors', stocks: 'stocks', robinhood: 'robinhood', base: 'base', trending: 'trending', compute: 'compute',
  smart: 'smart', 'smart-daily': 'smart-daily', 'smart-weekly': 'smart-weekly', 'smart-monthly': 'smart-monthly',
  traders: 'traders-daily', 'traders-daily': 'traders-daily', 'traders-weekly': 'traders-weekly', 'traders-monthly': 'traders-monthly',
  callers: 'callers-weekly', 'callers-daily': 'callers-daily', 'callers-weekly': 'callers-weekly', 'callers-monthly': 'callers-monthly' };
const BOARD_SUB = { pumpfun: 'PUMP.FUN · 24H', majors: 'CRYPTO · 24H', stocks: 'STOCKS · 24H', compute: 'COMPUTE · 24H' };
const TEN_TITLE = {
  smart: 'WHAT TOP TRADERS HOLD',
  'smart-daily': 'TODAY\u2019S TOP TRADERS HOLD', 'smart-weekly': 'THIS WEEK\u2019S TOP TRADERS HOLD',
  'smart-monthly': 'THIS MONTH\u2019S TOP TRADERS HOLD',
  'traders-daily': 'TOP 10 BANKED', 'traders-weekly': 'TOP 10 BANKED', 'traders-monthly': 'TOP 10 BANKED',
  trending: 'TOP 10 TRENDING',
  pumpfun: 'TOP 10 ON PUMP.FUN',
  majors: 'TOP 10 IN CRYPTO',
  stocks: 'TOP 10 STOCKS',
  robinhood: 'TOP 10 ON ROBINHOOD',
  base: 'TOP 10 ON BASE',
};
const TEN_SHARE = {
  smart: 'What pump.fun\u2019s best traders are holding right now',
  'smart-daily': 'What today\u2019s top pump.fun traders are holding',
  'smart-weekly': 'What this week\u2019s top pump.fun traders are holding',
  'smart-monthly': 'What this month\u2019s top pump.fun traders are holding',
  'callers-daily': 'The best callers on pump.fun today — by how often their calls reach 2×',
  'callers-weekly': 'The best callers on pump.fun this week — by how often their calls reach 2×',
  'callers-monthly': 'The best callers on pump.fun this month — by how often their calls reach 2×',
  'traders-daily': 'Who actually banked on pump.fun today — realized profit, not paper gains',
  'traders-weekly': 'Who actually banked on pump.fun this week — realized profit, not paper gains',
  'traders-monthly': 'Who actually banked on pump.fun this month — realized profit, not paper gains',
  trending: 'Trending right now — the top 10, across every chain',
  pumpfun: 'The top 10 on pump.fun right now',
  majors: 'The top 10 in crypto right now',
  stocks: 'The top 10 stocks right now',
  robinhood: 'The top 10 on Robinhood Chain right now',
  base: 'The top 10 on Base right now',
};

/* The ten the card draws: the tab's own order, not a re-ranking of it — that
   order is the product. Only rows whose window was actually measured, because
   a bubble with no percentage has nothing to say and the card would print a
   dash where the number is the point. */
function pickTen(tokens, tf) {
  if ((tokens || []).some(t => t && t.kind === 'caller')) return tokens.filter(t => t && t.caller && t.sym).slice(0, 10);
  return (tokens || [])
    /* `!= null` first — Number(null) is 0, which is finite, and would have put
       an unmeasured window on the card's share page as "+0%" */
    .filter(t => t && t.sym && t.solid !== false && t.pc && t.pc[tf] != null && Number.isFinite(Number(t.pc[tf])))
    .slice(0, 10);
}

const BOARD_TITLE = {
  pumpfun: 'Top movers on pump.fun today',
  majors: 'Top movers in crypto today',
  stocks: 'Biggest movers in stocks today',
  robinhood: 'Top movers on Robinhood Chain today',
  base: 'Top movers on Base today',
  trending: 'Trending right now across every chain',
};

/* How long a collapsed build waits before trying again. Short, because it
   means an upstream is unwell rather than a market genuinely emptying. */
const EMPTY_RETRY_MS = 20_000;

const boostMkt = new Map();
const BOOST_MKT_TTL = 60_000;

const KV_SNAP_EVERY = 15 * 60_000;   // a shared feed's KV copy, at most this often (see snapshot())
const cacheFor = mode => {
  if (!caches.has(mode)) caches.set(mode, { at: 0, data: null, inflight: null, err: null });
  return caches.get(mode);
};

/* Older links said mode=graduated|bonding. Keep them working rather than
   breaking every embed and bookmark that already exists. */
const LEGACY_MODES = { graduated: 'pumpfun', bonding: 'bonding', all: 'pumpfun' };

function resolveSource(url) {
  const q = url.searchParams.get('source') || '';
  if (SOURCES[q]) return SOURCES[q];
  /* a link to the tab, with no period in it, is the daily board */
  if (q === 'traders') return SOURCES['traders-daily'];
  if (q === 'callers') return SOURCES['callers-weekly'];
  const legacy = LEGACY_MODES[url.searchParams.get('mode') || ''];
  return SOURCES[legacy] || SOURCES[DEFAULT_SOURCE];
}

/* Locate one token for a share card. Goes through the same feed the map is
   built from rather than a source directly, so a card carries the merged
   figures - boosts, and the long windows filled in by cron - instead of the
   raw upstream row, which has neither. */
async function findToken(ctx, origin, { mint, sym, srcId }) {
  const order = srcId ? [srcId] : (mint ? ['pumpfun'] : ['majors', 'stocks', 'pumpfun']);
  for (const id of order) {
    if (!sourceOf(id)) continue;
    try {
      const r = await handle(new Request(origin + '/api/tokens?source=' + id), ctx);
      if (!r || !r.ok) continue;
      const j = await r.json();
      const list = (j && j.tokens) || [];
      const hit = mint
        ? list.find(t => t.mint === mint)
        : list.find(t => String(t.sym || '').toUpperCase() === sym);
      if (hit) return { t: hit, srcId: id };
    } catch { /* try the next source */ }
  }
  /* A mint the map does not currently rank is still a real token. */
  if (mint && isMint(mint)) {
    try {
      const t = await fetchCoin(mint, ctx.env.IMG_SECRET);
      if (t) return { t, srcId: 'pumpfun' };
    } catch { /* fall through */ }
  }
  return null;
}

/* ---------------------------------------------------------- hidden tokens */
/* The operator's hide list, read through a 30s per-isolate cache so a map
   poll does not cost a KV read. Busted on this isolate by the console. */
let hiddenCache = { at: 0, set: new Set() };
async function hiddenSet(ctx) {
  if (Date.now() - hiddenCache.at < 30_000) return hiddenCache.set;
  try {
    const list = (await ctx.store.get('hidden')) || [];
    hiddenCache = { at: Date.now(), set: new Set(list.map(h => h.key)) };
  } catch { hiddenCache.at = Date.now(); }
  return hiddenCache.set;
}
const isHidden = (set, t) => set.size > 0 && t && (set.has(t.addr || '') || set.has(t.mint || '') || set.has(String(t.addr || '').toLowerCase()));

/* ---------------------------------------------------------- the rail fill */
/* What fills the rail when nothing is sold: the top of the Trending tab.
   Not ads and never labelled as ads — each row carries its rank and its move
   and the page tags it "trending".

   **This never builds a snapshot.** The first version raced `snapshot()`
   against 1.5 seconds, and lost four times in five: every `/api/ads` lands on
   whatever isolate Cloudflare picks, a cold one has no trending in memory, and
   composing that tab is four feeds plus three pump.fun calls — far more than a
   second and a half. So the rail shipped empty placeholders to most visitors,
   which is exactly the thing it was built to stop. It reads what is already
   warm instead: this isolate's trending snapshot if it has one, else the
   shared KV copy the cron refreshes every five minutes, and it keeps the
   derived rows for a minute so a busy isolate reads KV once. Stale by a few
   minutes is the right trade for a strip of logos; empty is not. */
let fillCache = { at: 0, rows: [] };
async function railFill(ctx) {
  const now = Date.now();
  if (fillCache.rows.length && now - fillCache.at < 60_000) return fillCache.rows;
  let snap = cacheFor('trending').data;
  if (!snap || !snap.tokens || !snap.tokens.length) {
    try { snap = await ctx.store.get('snap:trending'); } catch { snap = null; }
  }
  const hid = await hiddenSet(ctx);
  const rows = ((snap && snap.tokens) || [])
    .filter(t => t && t.sym && t.solid !== false && !isHidden(hid, t))
    .slice(0, 14)
    .map(t => ({
      key: t.addr || t.mint || t.id, mint: t.mint || '', addr: t.addr || '', chain: t.chain || '',
      sym: t.sym, img: t.img || '',
      pc: t.pc && Number.isFinite(t.pc.h24) ? t.pc.h24
        : (t.pc && Number.isFinite(t.pc.h1) ? t.pc.h1 : null),
      rank: t.via === 'pump' ? (t.rank || 0) : 0,
    }));
  if (rows.length) fillCache = { at: now, rows };
  return rows;
}

/* ------------------------------------------------------ the swap's lists */
/* The swap page's "on the map" list for an EVM chain: that tab's tokens as the
   map already holds them — this isolate's snapshot, else the shared KV copy —
   never a build. The map has done the hard part on these chains already: one
   survivor per ticker, chosen by pool depth. A token search there cannot do
   that — Relay's search for PONS on Robinhood Chain lists five clones before
   the real one, and its index does not carry the real one at all. Most
   traded first; the chain's own money (wrapped ETH, dollars) is what a buyer
   pays with, so it is left out. */
const SWAP_LIST_SRC = { base: 'base', robinhood: 'robinhood' };
const SWAP_MONEY = /^(W?ETH|USDC|USDBC|USDT|USDG|DAI|USDE|PYUSD|RLUSD)$/i;
const swapLists = {};
async function swapList(ctx, chain) {
  const sid = SWAP_LIST_SRC[chain];
  const now = Date.now(), c = swapLists[chain];
  if (c && now - c.at < 60_000) return c.rows;
  let snap = cacheFor(sid).data;
  if (!snap || !snap.tokens || !snap.tokens.length) {
    try { snap = await ctx.store.get('snap:' + sid); } catch { snap = null; }
  }
  const hid = await hiddenSet(ctx);
  const rows = ((snap && snap.tokens) || [])
    .filter(t => t && t.addr && t.sym && t.solid !== false && !isHidden(hid, t) && (t.chain || chain) === chain && !SWAP_MONEY.test(t.sym))
    .sort((a, b) => (b.vol || 0) - (a.vol || 0))
    .slice(0, 30)
    .map(t => ({
      addr: String(t.addr).toLowerCase(), chain, sym: t.sym, name: t.name || '', img: t.img || '',
      mcap: t.mcap || 0, liq: t.liq || 0, vol: t.vol || 0, price: t.price || 0,
      pc: t.pc && Number.isFinite(t.pc.h24) ? t.pc.h24 : null,
    }));
  if (rows.length) swapLists[chain] = { at: now, rows };
  return rows;
}

/* ------------------------------------------------------------- Tap wars */
/* The arena is one Durable Object, and every visitor's map poll would be a
   request to it. Cached per isolate for five seconds instead, and busted by
   this isolate's own taps so a tapper sees their count land on the next
   poll. */
let arenaCache = { at: 0, data: null, inflight: null };
async function arenaState(ctx) {
  if (!ctx.arena) return null;
  const now = Date.now();
  if (arenaCache.data && now - arenaCache.at < 5000) return arenaCache.data;
  if (arenaCache.inflight) return arenaCache.inflight;
  arenaCache.inflight = (async () => {
    try {
      const st = await ctx.arena('state');
      arenaCache = { at: Date.now(), data: st, inflight: null };
      return st;
    } catch {
      arenaCache.inflight = null;
      return arenaCache.data;
    }
  })();
  return arenaCache.inflight;
}
function ipOf(req) {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'local';
}
const TAP_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$|^0x[0-9a-f]{40}$/;
function tapUrl(r) {
  return r.mint ? 'https://pump.fun/coin/' + r.mint
    : 'https://dexscreener.com/' + encodeURIComponent(r.chain || 'ethereum') + '/' + r.addr;
}
const fmtTaps = n => n >= 1000 ? (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + 'k' : String(n);

/* The tab's tokens: the arena's rows, with price change and volume from
   DexScreener so the colour stays honest — size is taps, colour is still the
   market. Enrichment is cached a minute per token; the tap counts are not. */
const tapMkt = new Map();
async function tapsSnapshot(ctx) {
  const st = await arenaState(ctx);
  const rows = (st && st.tokens) || [];
  const tokens = rows.map(r => ({
    id: (r.chain && r.chain !== 'solana' ? r.chain + ':' : '') + r.key,
    chain: r.chain || 'solana', mint: r.mint || '', addr: r.addr || '',
    sym: r.sym, name: r.name, img: r.img || '',
    mcap: r.mcap || 0, vol: 0, liq: 0, price: 0,
    pc: { m5: null, h1: null, h6: null, h24: null, d7: null, d30: null, y1: null },
    grad: true, solid: true, flags: [], copies: 1,
    taps: r.taps, tapsTotal: r.tapsTotal, tapRank: r.rank, award: r.award || '',
    goldSince: r.goldSince || 0, adSince: r.adSince || 0, added: r.added || 0,
    via: 'taps', boost: 0,
  }));
  const now = Date.now();
  const keyOf = t => t.addr || t.mint;
  const stale = tokens.filter(t => { const c = tapMkt.get(keyOf(t)); return !c || now - c.at > 60_000; });
  const byChain = new Map();
  for (const t of stale) { const c = t.chain || 'solana'; if (!byChain.has(c)) byChain.set(c, []); byChain.get(c).push(t); }
  await Promise.all([...byChain].map(async ([chain, list]) => {
    try {
      await enrich(list, chain);
      for (const t of list) tapMkt.set(keyOf(t), { at: now, pc: t.pc, vol: t.vol, liq: t.liq, price: t.price, mcap: t.dexMcap || 0 });
    } catch { /* grey is honest */ }
  }));
  for (const t of tokens) {
    const c = tapMkt.get(keyOf(t));
    delete t.rawImg; delete t.dexMcap;
    if (!c) continue;
    if (c.pc) t.pc = { m5: null, h1: null, h6: null, h24: null, d7: null, d30: null, y1: null, ...c.pc };
    t.vol = c.vol || 0; t.liq = c.liq || 0; t.price = c.price || 0;
    if (c.mcap > 0) t.mcap = c.mcap;
  }
  return {
    ts: Date.now(), sol: 0, count: tokens.length, enriched: tokens.length,
    withArt: tokens.filter(t => t.img).length, sampleArt: '', solid: tokens.length, signed: true,
    source: 'taps', sourceLabel: 'Tap wars', boostable: true,
    tokens,
    events: (st && st.events) || [],
    arena: { n: rows.length, gold: ((st && st.gold) || []).map(r => r.sym), ad: ((st && st.ad) || []).map(r => r.sym) },
  };
}

/* --------------------------------------------------------------- Callers */
/* The watcher is one Durable Object (src/callers.mjs, worker/index.js), and
   every visitor's poll would otherwise be a request to it. Cached per isolate
   for twenty seconds, its own tick, and signed here, because the image
   secret lives with the API rather than with the watcher. */
let bhMem = { at: 0, v: null };
const callCache = new Map();
async function callersRead(ctx, op, body = {}) {
  if (!ctx.callers) return null;
  const key = op + ':' + (body.window || '');
  const c = callCache.get(key) || {};
  if (c.data && Date.now() - c.at < 20_000) return c.data;
  if (c.inflight) return c.inflight;
  c.inflight = (async () => {
    try { const d = await ctx.callers(op, body); callCache.set(key, { at: Date.now(), data: d }); return d; }
    catch { callCache.set(key, { at: c.at || 0, data: c.data }); return c.data || null; }
  })();
  callCache.set(key, c);
  return c.inflight;
}
const signMem = new Map();
async function signedImg(ctx, raw) {
  if (!raw || !ctx.env.IMG_SECRET) return '';
  const u = fastImage(raw);
  const hit = signMem.get(u);
  if (hit) return hit;
  try {
    const out = '/api/img?u=' + encodeURIComponent(u) + '&s=' + await signUrl(u, ctx.env.IMG_SECRET);
    if (signMem.size > 4000) signMem.clear();
    signMem.set(u, out);
    return out;
  } catch { return ''; }
}
const NULL_PC = () => ({ m5: null, h1: null, h6: null, h24: null, d7: null, d30: null, y1: null });
const callersMeta = d => d && d.status
  ? { calls: d.status.calls, callers: d.status.callers, withStats: d.status.withStats, lastOk: d.status.lastOk,
      lastError: String(d.status.lastError || '').slice(0, 120), errors: d.status.errors || 0, ticks: d.status.ticks || 0, backoffS: Math.round((d.status.backoff || 0) / 1000) } : null;

/* Live calls as token rows: the called coin is the row, so the card's Chart,
   Buy and Boost work as they do for any token; the call rides along. One row
   per call — two callers on one coin are two rows. */
async function callsSnapshot(ctx) {
  const d = await callersRead(ctx, 'live', { limit: 150 });
  const tokens = [];
  for (const c of (d && d.rows) || []) {
    const by = c.caller || {};
    tokens.push({
      id: 'call:' + c.id, kind: 'call', chain: 'solana', mint: c.mint, addr: '',
      sym: c.sym, name: c.name, img: await signedImg(ctx, c.rawImg),
      mcap: c.mcapNow || 0, vol: 0, liq: 0, price: 0, pc: NULL_PC(),
      grad: true, solid: true, flags: [], copies: 1, boost: 0, via: 'call',
      call: {
        id: c.id, at: c.at, mcapAtCall: c.mcapAtCall, now: c.now, peak: c.peak, peakAt: c.peakAt,
        thesis: c.thesis, views: c.views, likes: c.likes, status: c.status, heldUsd: c.heldUsd, pnlUsd: c.pnlUsd, seenAt: c.seenAt,
        by: { wallet: by.wallet, name: by.name, xh: by.xh, img: await signedImg(ctx, by.avatar), verified: !!by.verified,
          rank: by.rank || 0, hit2: by.hit2, n: by.n, calls: by.calls },
      },
    });
  }
  return {
    ts: Date.now(), sol: 0, count: tokens.length, enriched: tokens.length, withArt: tokens.filter(t => t.img).length,
    sampleArt: '', solid: tokens.length, signed: true, source: 'calls', sourceLabel: 'Live calls', boostable: true,
    tokens, callers: callersMeta(d),
  };
}

/* Top callers as people rows, like Top traders: no mint and no address, so
   the card shows Profile rather than Buy and Boost. */
async function callersSnapshot(ctx, win) {
  const d = await callersRead(ctx, 'board', { window: win });
  const tokens = [];
  for (const r of (d && d.rows) || []) {
    tokens.push({
      id: 'caller:' + r.wallet, kind: 'caller', mint: '', addr: '', wallet: r.wallet,
      sym: r.name, name: r.xh ? '@' + r.xh : r.name, xh: r.xh, verified: !!r.verified,
      img: await signedImg(ctx, r.avatar),
      mcap: Math.max(1, Math.round((r.score || 0) * 1e6)), vol: 0, liq: 0, price: 0, pc: NULL_PC(),
      grad: true, solid: true, flags: [], copies: 1, boost: 0, via: 'caller', rank: r.rank, period: win,
      caller: { n: r.n, hit2: r.hit2, hit15: r.hit15, med: r.med, avg: r.avg, ttpMs: r.ttpMs, best: r.best, score: r.score,
        banked: r.banked, soldOf: r.soldOf, seenCalls: r.seenCalls, lastAt: r.lastAt, recent: r.recent || [] },
    });
  }
  return {
    ts: Date.now(), sol: 0, count: tokens.length, enriched: tokens.length, withArt: tokens.filter(t => t.img).length,
    sampleArt: '', solid: tokens.length, signed: true, source: 'callers-' + win, sourceLabel: 'Top callers', boostable: false,
    tokens, callers: callersMeta(d),
  };
}
/* Insiders as rows: one trade each, from Congress, the White House or a
   company's insiders (src/insiders.mjs). No mint and no address, so nothing
   here is boosted or bought; the row links to the filing itself. `name`
   carries the person and the asset so the search box finds "pelosi" and
   "nvidia" alike, and `mcap` is the trade's size so the table can rank by it. */
let insMem = { at: 0, data: null };
async function insidersSnapshot(ctx) {
  let d = insMem.data;
  if (!d || Date.now() - insMem.at > 60_000) {
    try { d = ctx.insiders ? await ctx.insiders('rows') : null; } catch { d = null; }
    if (d && d.ok) insMem = { at: Date.now(), data: d }; else d = insMem.data;
  }
  const tokens = ((d && d.rows) || []).map(r => ({
    id: 'ins:' + r.id, kind: 'insider', chain: 'mixed', mint: '', addr: '',
    sym: r.ticker || '', name: r.who + ' \u00b7 ' + (r.asset || r.ticker || ''), img: '',
    mcap: Math.max(1, r.usd || r.hi || r.lo || 1), vol: 0, liq: 0, price: 0, pc: NULL_PC(),
    grad: true, solid: true, flags: [], copies: 1, boost: 0, via: 'insider', ins: r,
  }));
  return {
    ts: Date.now(), sol: 0, count: tokens.length, enriched: tokens.length, withArt: 0,
    sampleArt: '', solid: tokens.length, signed: true, source: 'insiders', sourceLabel: 'Insiders', boostable: false,
    tokens, insiders: d ? { ...(d.status || {}), people: d.people || [] } : null,
  };
}
/* feeds whose empty answer is a state (nothing yet), not an outage */
const EMPTY_OK = new Set(['taps', 'calls', 'callers-daily', 'callers-weekly', 'callers-monthly', 'insiders']);
/* feeds drawn as tables of people or calls, where a re-added paid bubble
   would be a stray row rather than a gold bubble */
const TABLE_FEED = id => id === 'calls' || id === 'insiders' || id.startsWith('callers-') || id.startsWith('traders-');

async function snapshot(ctx, source, force = false) {
  const src = typeof source === 'string' ? sourceOf(source) : (source || sourceOf(DEFAULT_SOURCE));
  const cache = cacheFor(src.id);
  const now = Date.now();
  /* Each source sets its own lifetime. pump.fun tolerates a 10s poll; the free
     GeckoTerminal and CoinGecko tiers are ~30 requests a minute shared across
     all our traffic, so those feeds are cached far longer. Bitcoin's market cap
     does not move enough in ten seconds to be worth a request. */
  const ttl = src.ttl || SNAPSHOT_TTL;
  if (!force && cache.data && now - cache.at < ttl) return cache.data;
  /* A build that just failed is not retried by the very next request. */
  if (!force && cache.data && now < (cache.retryAt || 0)) return cache.data;
  if (cache.inflight) return raceStale(cache, cache.inflight);

  cache.inflight = (async () => {
    /* Sources marked `shared` are cached in KV as well as in memory. Isolates
       do not share memory, so a per-isolate cache multiplies our upstream
       request count by however many isolates Cloudflare is running — which is
       how a feed with a 2-minute TTL still managed to get itself 429'd. KV is
       the one cache every isolate can see. */
    const kvKey = 'snap:' + src.id;
    if (src.shared && !force) {
      try {
        const saved = await ctx.store.get(kvKey);
        /* how old the shared copy is, whoever wrote it — the write below waits on it */
        cache.kvAt = saved && saved.ts ? saved.ts : 0;
        /* Same rule on the way in. A namespace written by an older build may
           still hold an empty snapshot, and reading it back would reinstate
           exactly the outage the write guard exists to prevent. */
        if (saved && saved.tokens && saved.tokens.length && Date.now() - saved.ts < ttl) {
          cache.data = saved; cache.at = Date.now(); cache.err = null;
          return saved;
        }
      } catch { /* KV miss is not an error, just a slower path */ }
    }

    try {
      /* Trending is composed rather than fetched: it ranks the feeds against
         each other, so it has no upstream of its own. Built here rather than in
         a source's fetch() because it needs snapshot(), and each member feed
         keeps its own cache and its own lifetime. */
      const snap = src.id === 'trending'
        ? await (async () => {
            /* The order is the budget. A free-plan invocation may make 50
               outbound calls, KV reads included, and a cold build of all four
               feeds plus pump.fun's board made about 55: the board, read last,
               kept its list but lost its prices, so every row pump.fun ranks
               drew grey with a dash on every window (2026-10-06). So: copies
               of the feeds that already exist, then the board, then at most
               one of the two expensive feeds built (TREND_HEAVY), each against
               a deadline — a build that runs out costs its own rows, not the
               board's. One after another and with no deadline, a cold build
               also took 40 s and more, past the page's own 12. */
            const copies = await Promise.all(TREND_SOURCES.map(id => trendCopy(ctx, id)));
            /* pump.fun's own board leads; see src/pumptrend.mjs. Our feeds
               lend it liquidity and art for tokens they already carry. A
               board that fails to answer leaves the computed list alone,
               which is what the tab was before the board existed. */
            const known = new Map();
            TREND_SOURCES.forEach((id, i) => {
              if ((id === 'pumpfun' || id === 'robinhood') && copies[i]) for (const t of copies[i].tokens) known.set(t.addr || t.mint, t);
            });
            let movers = [], moversError = '';
            const t0 = Date.now();
            /* A deadline, and its last good answer — one that carried prices. */
            movers = await within(pumpTrending({ secret: ctx.env.IMG_SECRET, known })
              .then(m => { if (m && m.some(t => t.pc && t.pc.h24 != null)) lastMovers = m; return m; })
              .catch(e => { moversError = String(e && e.message || e); return lastMovers; }), TREND_MOVERS_MS, null);
            if (movers === null) { moversError = moversError || 'pump.fun board slow — last good list'; movers = lastMovers; }
            const moversMs = Date.now() - t0;
            let heavy = 1;
            const feeds = (await Promise.all(TREND_SOURCES.map(async (id, i) => {
              let m = copies[i];
              if (!m && (!TREND_HEAVY.includes(id) || heavy-- > 0)) {
                m = await within(snapshot(ctx, sourceOf(id)).catch(() => null), TREND_FEED_MS, cacheFor(id).data);
              }
              return m && Array.isArray(m.tokens) ? { id, tokens: m.tokens } : null;
            }))).filter(Boolean);
            const tokens = mergeMovers(movers, buildTrending(feeds));
            return {
              ts: Date.now(), sol: 0, count: tokens.length,
              enriched: tokens.length, withArt: tokens.filter(t => t.img).length,
              sampleArt: '', solid: tokens.length, signed: true,
              source: 'trending', sourceLabel: 'Trending', boostable: true,
              /* priced: board rows that came with prices — 0 of 39 was this bug */
              movers: { n: movers.length, ms: moversMs, error: moversError,
                priced: movers.filter(t => t.pc && t.pc.h24 != null).length,
                feeds: feeds.map(f => f.id).join(',') },
              tokens,
            };
          })()
        : src.id === 'taps'
        ? await tapsSnapshot(ctx)
        : src.id === 'calls'
        ? await callsSnapshot(ctx)
        : src.id === 'insiders'
        ? await insidersSnapshot(ctx)
        : src.id.startsWith('callers-')
        ? await callersSnapshot(ctx, src.id.slice(8))
        : await buildSnapshot({
            source: src,
            hist: ctx.hist,
            secret: ctx.env.IMG_SECRET,
            store: ctx.store,
          });
      /* An empty build is a failure wearing a success's clothes. Every upstream
         here fails by returning nothing rather than by throwing — a 429, a
         timeout, a shape that changed — and buildSnapshot cannot tell the
         difference between "the feed is down" and "the chain has no tokens".

         Caching that answer is what turns a blip into an outage: an empty
         snapshot went into KV during a deploy, every isolate then read it back
         as valid for the whole TTL, and the map served one bubble for minutes
         after the upstream had recovered. So an empty result never replaces
         data we already have, and never reaches KV; it just retries sooner. */
      const got = (snap.tokens && snap.tokens.length) || 0;
      const had = (cache.data && cache.data.tokens && cache.data.tokens.length) || 0;

      /* Not just empty — *collapsed*. A pump.fun snapshot is six paged requests
         and ten DexScreener ones; when half of them fail the build still
         succeeds, with a fraction of the feed in it. That is how a map that
         should show three hundred bubbles showed eight, and then kept showing
         eight because the result was cached like any other.

         A quarter of what we had is far outside normal churn for every source
         here, so it is treated as a bad build rather than a small market. */
      /* Token count is not enough on its own. A pump.fun build can return all
         three hundred tokens with the DexScreener pass having failed, and
         liquidity is what decides whether a market cap is backed — so every
         bubble becomes "unbacked", the map's own filter hides them, and three
         hundred tokens render as eight. That is what this looked like from the
         outside, and the snapshot behind it looked perfectly healthy by count.

         So a collapse in enrichment is treated exactly like a collapse in
         tokens, for the sources that depend on it. */
      const enrNow = snap.enriched || 0;
      const enrWas = (cache.data && cache.data.enriched) || 0;
      /* Relative to the last build in this isolate — and absolute, for a
         source that states its normal coverage. The relative check alone saw
         nothing on a fresh isolate, which after a deploy is every isolate, so
         a refused DexScreener pass went straight to the page. */
      const enrichBroke = src.enrich !== false && (
        (enrWas > 0 && enrNow < enrWas * 0.25) ||
        (src.minEnrich && got >= 20 && enrNow < got * src.minEnrich));
      /* carried to the page, which then shows everything instead of filtering
         on quality it could not measure */
      snap.degraded = !!(src.minEnrich && got >= 20 && enrNow < got * src.minEnrich);

      /* The arena is allowed to be empty, and allowed to shrink: nobody has
         added a token yet, or the idle ones were pruned. Neither is an outage. */
      const empty = !EMPTY_OK.has(src.id) && (got === 0 || (had > 0 && got < had * 0.25) || enrichBroke);

      if (empty && had) {
        /* Keep the good data, and come back well before the normal lifetime. */
        cache.at = Date.now() - Math.max(0, ttl - EMPTY_RETRY_MS);
        return cache.data;
      }
      /* A fresh isolate has nothing to keep — but a shared feed has a copy
         in KV, however old. The Robinhood tab served zero rows to a fresh
         isolate while a good snapshot sat in KV, because the KV read only
         accepts data inside its lifetime. Stale beats empty. */
      if (empty && !had && src.shared) {
        try {
          const saved = await ctx.store.get(kvKey);
          if (saved && saved.tokens && saved.tokens.length) {
            cache.data = saved;
            cache.at = Date.now() - Math.max(0, ttl - EMPTY_RETRY_MS);
            return saved;
          }
        } catch { /* fall through */ }
      }

      cache.data = snap;
      cache.at = empty ? Date.now() - Math.max(0, ttl - EMPTY_RETRY_MS) : Date.now();
      cache.err = null; cache.retryAt = 0;
      /* The shared copy is refreshed at most every fifteen minutes, not on
         every rebuild. Every rebuild used to write it — trending alone could
         spend 1,440 writes a day — and the free plan's 1,000 KV writes a day
         are also what records a paid boost: measured 933 writes on 2026-09-29
         and 1,661 on 2026-09-30, so on a busy day a payment found after the cap
         would have gone unrecorded, silently. The copy is a convenience for
         other isolates; the boost is money. */
      if (src.shared && !empty && Date.now() - (cache.kvAt || 0) >= KV_SNAP_EVERY) {
        try { await ctx.store.put(kvKey, snap); cache.kvAt = Date.now(); } catch { /* non-fatal */ }
      }
      ctx.onSnapshot?.(snap);
      return snap;
    } catch (e) {
      cache.err = String(e && e.message || e);
      /* Back off before asking again. Without this every request retried an
         upstream that had just refused us: after the 2026-10-06 deploy most
         isolates had CoinPaprika answer each of them on every visit while they
         served a copy from KV, which is how a rate limit keeps itself going. */
      cache.retryAt = Date.now() + EMPTY_RETRY_MS;
      /* Stale data beats an empty map — the front end shows the age. */
      if (cache.data && Date.now() - cache.at < STALE_OK) return cache.data;
      /* For a shared source, fall back to whatever KV holds however old it is.
         A five-minute-old market cap is worth far more than an error page, and
         being rate-limited upstream must not empty the map. */
      if (src.shared) {
        try {
          const saved = await ctx.store.get(kvKey);
          if (saved) { cache.data = saved; return saved; }
        } catch { /* fall through to the throw */ }
      }
      throw e;
    } finally {
      cache.inflight = null;
    }
  })();
  return raceStale(cache, cache.inflight);
}

/* A build that is taking too long must not become a page that never loads.

   Every upstream call has a 9s timeout, but a pump.fun snapshot makes six paged
   requests plus ten DexScreener ones in sequence, so a slow upstream can stall
   the build for a minute — and because everyone shares the in-flight promise,
   every visitor waits exactly that long. Measured in production: one request
   hung for 60 seconds while the next returned in 1.2.

   So the wait is bounded. Past the deadline, whatever is already cached is
   served however old it is, and the build carries on in the background to
   refresh it. Stale data with its age shown beats a spinner, and the front end
   already displays that age. With nothing cached there is nothing to serve, so
   the wait is the only option and the build is awaited in full. */
const BUILD_DEADLINE = 6000;

/* The Compute tab's GPU price board (src/compute.mjs), on its own clock: ten
   minutes in this isolate, a minute after a failed read, and it never holds
   the map — four seconds, then the last good board or none, with the read
   carried on by waitUntil. A board with no price at all never replaces one
   that had prices; its errors are reported on the old one. */
let gpuMem = { at: 0, data: null, good: false, inflight: null };
const GPU_TTL = 10 * 60_000, GPU_RETRY = 60_000, GPU_WAIT = 4000;
async function gpuBoardCached(ctx) {
  const age = Date.now() - gpuMem.at;
  if (gpuMem.data && age < (gpuMem.good ? GPU_TTL : GPU_RETRY)) return gpuMem.data;
  if (!gpuMem.inflight || Date.now() - gpuMem.since > 30_000) {
    const p = gpuBoard({ store: ctx.store }).then(b => {
      const good = b.gpus.some(r => r.price != null);
      gpuMem = good || !gpuMem.data
        ? { at: Date.now(), data: b, good, inflight: null }
        : { at: Date.now(), data: { ...gpuMem.data, errors: b.errors }, good: false, inflight: null };
      return gpuMem.data;
    }).catch(() => { gpuMem.inflight = null; return gpuMem.data; });
    gpuMem.inflight = p;
    gpuMem.since = Date.now();
    if (ctx.waitUntil) ctx.waitUntil(p);
  }
  return within(gpuMem.inflight, GPU_WAIT, gpuMem.data);
}

/* A promise, or `fallback` once `ms` have passed — whichever comes first. */
const within = (p, ms, fallback) => Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);
const TREND_FEED_MS = 3500, TREND_MOVERS_MS = 4500;
let lastMovers = [];

/* How old a feed's copy may be and still rank on Trending (which rebuilds
   every minute), and which feeds are expensive to build: pump.fun is ~17
   calls, Robinhood ~20 with its registry, Base and the wider market one or
   two. Shared copies sit in KV for up to fifteen minutes between writes. */
const TREND_REUSE_MS = { pumpfun: 3 * 60_000, base: 20 * 60_000, robinhood: 20 * 60_000, majors: 20 * 60_000 };
const TREND_HEAVY = ['pumpfun', 'robinhood'];

/* A feed's copy recent enough to rank — this isolate's, else the shared one
   in KV — without building anything. */
async function trendCopy(ctx, id) {
  const max = TREND_REUSE_MS[id] || 10 * 60_000;
  const ok = m => m && Array.isArray(m.tokens) && m.tokens.length > 0 && Date.now() - (m.ts || 0) < max;
  const mem = cacheFor(id).data;
  if (ok(mem)) return mem;
  if (!sourceOf(id).shared) return null;
  try { const saved = await ctx.store.get('snap:' + id); if (ok(saved)) return saved; } catch { /* a miss */ }
  return null;
}

function raceStale(cache, inflight) {
  if (!cache.data) return inflight;
  return Promise.race([
    inflight,
    new Promise(resolve => setTimeout(() => resolve(cache.data), BUILD_DEADLINE)),
  ]);
}

/* The SOL price, reliably.

   Both a boost and a bid need it to price an order, and both used to read it
   off whatever snapshot happened to be cached. On a cold isolate that is empty,
   so checkout answered "no SOL price available right now" — the one error that
   costs a sale outright. It now falls through three sources, and the KV copy
   means a cold isolate never has to wait on pump.fun to quote a price. */
let solMem = { at: 0, price: 0 };
const SOL_TTL = 120_000;

async function solPriceNow(ctx) {
  const now = Date.now();
  if (solMem.price > 0 && now - solMem.at < SOL_TTL) return solMem.price;

  const cached = cacheFor('pumpfun').data?.sol;
  if (cached > 0) { solMem = { at: now, price: cached }; return cached; }

  try {
    const saved = await ctx.store.get('sol:price');
    if (saved?.price > 0 && now - saved.at < 10 * 60_000) {
      solMem = { at: now, price: saved.price };
      return saved.price;
    }
  } catch { /* KV miss just means we fetch */ }

  const fresh = await fetchSolPrice().catch(() => 0);
  if (fresh > 0) {
    solMem = { at: now, price: fresh };
    try { await ctx.store.put('sol:price', { price: fresh, at: now }); } catch {}
    return fresh;
  }

  /* Last resort: a stale KV price beats refusing the sale. A rate that is ten
     minutes old misprices an order by a fraction of a percent; refusing to
     quote loses the whole thing. */
  try {
    const saved = await ctx.store.get('sol:price');
    if (saved?.price > 0) return saved.price;
  } catch {}
  return 0;
}

/* =============================================================== routes */
let tgStatusMem = { at: 0, v: null };
let doHealthMem = { at: 0, v: null };

/* after a tracker-wide change made from the console */
async function tgEnsureAudience(ctx) {
  return tgSyncHelius(ctx.env, ctx.store, ctx.audience);
}

/* where a token sits on the Trending tab right now, from what this isolate
   already holds — for the buy alert's "#4 trending on the bubble map" */
function mapRank(key) {
  const d = cacheFor('trending').data;
  if (!key || !d || !Array.isArray(d.tokens)) return null;
  const i = d.tokens.findIndex(t => t && (t.addr || t.mint) === key);
  return i >= 0 ? { rank: i + 1 } : null;
}

export async function handle(req, ctx) {
  setCoingeckoKey(ctx.env.COINGECKO_KEY);
  if (!ctx.mapRank) ctx.mapRank = mapRank;
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    });
  }

  /* Count page reads here, where every request passes, rather than from a
     script an ad blocker or our own CSP would stop. Never let counting fail a
     request — a missed pageview is not worth a 500. */
  if (ctx.store?.available && shouldCount(path, req.method)) {
    try {
      await record(req, path, ctx.env.IMG_SECRET || 'salt');
      if (dueForFlush()) {
        const p = flushStats(ctx.store);
        if (ctx.waitUntil) ctx.waitUntil(p); else await p;
      }
    } catch { /* best effort */ }
  }

  try {
    /* -------------------------------------------------- /api/compute/gpus */
    /* The Compute strip as an open feed: what one GPU rents for, an hour, on
       Akash's open market, with the day's and week's move and, on ?history=1,
       the hourly points behind them. Free with a link back — it is what the
       grant proposal to Akash offers, live before it is asked for. Read from
       the same ten-minute board the map uses, so a caller costs no upstream
       call; the edge and the caller may cache it five minutes. */
    if (path === '/api/compute/gpus') {
      const limited = rateLimit(req, 'gpuapi', 60, 60_000);
      if (limited) return limited;
      const board = await gpuBoardCached(ctx).catch(() => null);
      let hist = null;
      if (url.searchParams.get('history') === '1') {
        try { hist = await ctx.store.get(GPU_HIST_KEY); } catch { /* none yet */ }
      }
      return json(gpuFeed(board, hist), board ? 200 : 503,
        { 'cache-control': 'public, max-age=300' });
    }

    /* ------------------------------------------------------- /api/tokens */
    if (path === '/api/tokens') {
      const limited = rateLimit(req, 'tokens', 180, 60_000);
      if (limited) return limited;

      const src = resolveSource(url);
      const snap = await snapshot(ctx, src);
      const { byMint } = await activeBoosts(ctx.store);

      /* Bids join the same paid-size pool as boosts, converted through USD, so
         the renderer needs no idea that bids exist and there is one definition
         of "paid size" rather than two that drift apart. A token that has both
         gets the sum, which is the honest answer. */
      const bidRows = await board(ctx.store);
      if (bidRows.length) {
        const asSpend = bidsAsBoostSpend(bidRows, snap.sol || 0);
        for (const [mint, b] of asSpend) {
          const cur = byMint.get(mint);
          if (cur) {
            cur.liveUsd += b.liveUsd;
            cur.spentUsd += b.spentUsd;
            cur.until = Math.max(cur.until, b.until);
            cur.rank = b.rank;
            cur.bid = true;
          } else {
            byMint.set(mint, b);
          }
        }
        for (const v of byMint.values()) v.bonus = bonusFromSpend(v.liveUsd);
      }
      /* Gold won by taps joins the same pool, as twelve dollars' worth of
         paid size — so it draws through the same curve, counts toward the
         same 25% guard, and re-adds through the same path when the token is
         not in this feed. A token that is also paid for gets the sum. */
      const arena = await arenaState(ctx);
      if (arena && arena.gold && arena.gold.length) {
        for (const r of arena.gold) {
          const cur = byMint.get(r.key);
          if (cur) { cur.liveUsd += TAP_GOLD_USD; cur.tap = r.taps; }
          else {
            byMint.set(r.key, {
              mint: r.key, sym: r.sym, name: r.name, img: r.img || '', mcap: r.mcap || 0,
              ...(r.chain && r.chain !== 'solana' ? { chain: r.chain } : {}),
              liveUsd: TAP_GOLD_USD, spentUsd: 0, until: Date.now() + 60_000, tap: r.taps, bonus: 0,
            });
          }
        }
        for (const v of byMint.values()) v.bonus = bonusFromSpend(v.liveUsd);
      }
      let tokens = applyBoosts(snap.tokens.map(t => ({ ...t })), byMint);

      /* Monthly and yearly change for stocks is filled in by cron, one slice at
         a time, and merged here. A symbol not reached yet reports null and
         renders grey rather than holding up the map. */
      if (src.id === 'stocks') {
        try { tokens = applyWindows(tokens, await loadWindows(ctx.store)); } catch {}
      }
      /* Same arrangement for the whole-market view, from Binance rather than
         Yahoo. CoinPaprika's own 30d and 1y are zero on the free tier. */
      if (src.id === 'majors') {
        try { tokens = applyCryptoWin(tokens, await loadCryptoWin(ctx.store)); } catch {}
      }
      /* Compute mixes both, so each row takes the windows of its own kind:
         keyed by symbol, a coin and a company sharing a ticker would trade
         numbers otherwise. */
      let gpus = null;
      if (src.id === 'compute') {
        try {
          const [sw, cw] = await Promise.all([loadWindows(ctx.store), loadCryptoWin(ctx.store)]);
          applyWindows(tokens.filter(t => String(t.id).startsWith('stock:')), sw);
          applyCryptoWin(tokens.filter(t => String(t.id).startsWith('cg:')), cw);
        } catch {}
        gpus = await gpuBoardCached(ctx).catch(() => null);
      }

      /* A boosted token that dropped out of the pump.fun feed is re-added so a
         paid bubble never disappears before its time is up. */
      /* Keyed the same way applyBoosts is. Built from `mint` alone this set
         was {''} for an EVM chain, so a boosted Base token was judged absent
         and re-added next to the copy that was already there — two gold MAC
         bubbles, one of them with no data behind it. */
      const have = new Set(tokens.map(t => t.addr || t.mint));
      const readd = [];
      for (const [mint, b] of TABLE_FEED(src.id) ? [] : byMint) {
        if (have.has(mint)) continue;

        /* Art has to go through the signed proxy, exactly like every token in
           the feed. A raw ipfs.io URL is blocked by the page's own CSP
           (img-src 'self'), so a re-added bubble rendered with no picture at
           all — which is the whole point of a paid bubble, missing. The tokens
           built by buildSnapshot are signed there; these never passed through
           it, so they are signed here. */
        let img = '';
        if (b.img && ctx.env.IMG_SECRET) {
          try {
            /* Already a proxy URL if the boost was stored after this landed;
               a raw upstream URL if it was stored before. Sign only the raw
               ones, or the second signing would sign the proxy path itself. */
            img = b.img.startsWith('/api/img?')
              ? b.img
              : '/api/img?u=' + encodeURIComponent(b.img) +
                '&s=' + await signUrl(b.img, ctx.env.IMG_SECRET);
          } catch { img = ''; }
        }
        /* A paid bubble appears in whichever view the visitor is looking at,
           regardless of which feed the token came from. Scoping it to its own
           feed meant a boosted bonding token was invisible on the default map —
           the buyer paid and saw nothing, which is the one outcome that cannot
           happen here.
           The scale problem that scoping was meant to solve is handled where it
           belongs, in sizes(): a boosted bubble is sized by what was paid rather
           than by its market cap, so an out-of-place cap no longer distorts
           anything. */
        /* A boost on an EVM chain carries a contract address where a Solana
           boost carries a mint. Putting that address in `mint` would send the
           chart link to pump.fun, which has never heard of it. */
        const evm = /^0x[0-9a-fA-F]{40}$/.test(mint);
        readd.push({
          id: (b.chain ? b.chain + ':' : '') + mint,
          mint: evm ? '' : mint,
          ...(evm ? { addr: mint.toLowerCase() } : {}),
          sym: b.sym || mint.slice(0, 4), name: b.name || b.sym || 'boosted',
          img, mcap: b.mcap || 0, vol: 0,
          /* null, not zero. If nothing below fills these in, the map greys the
             bubble and the share card refuses to render — both of which say
             "we do not know" instead of "it did not move". */
          pc: { m5: null, h1: null, h6: null, h24: null },
          grad: true, solid: true, flags: [], copies: 1,
          boost: b.bonus, boostUsd: b.spentUsd, boostUntil: b.until,
        });
      }

      if (readd.length) {
        const now = Date.now();
        const keyOf = t => t.addr || t.mint;
        const stale = readd.filter(t => {
          const c = boostMkt.get(keyOf(t));
          return !c || (now - c.at) > BOOST_MKT_TTL;
        });

        /* Solana boosts go through the batched DexScreener pass; a boost on any
           other chain is resolved individually, because enrich() is told one
           chain per call and these can be on several at once. There are only
           ever a handful of paid bubbles, so one request each is cheap. */
        const evmStale = stale.filter(t => isEvmAddr(keyOf(t)));
        const solStale = stale.filter(t => !isEvmAddr(keyOf(t)));

        if (solStale.length) {
          try {
            await enrich(solStale);
            for (const t of solStale) {
              /* enrich fills rawImg when a token has no art; these already
                 carry a signed proxy URL, so the raw one would only travel
                 unused and blocked by the page's own CSP. */
              delete t.rawImg;
              boostMkt.set(keyOf(t), { at: now, pc: t.pc, vol: t.vol, price: t.price, mcap: t.mcap });
            }
          } catch { /* leave them null; grey is honest */ }
        }

        for (const t of evmStale) {
          try {
            const live = await resolveAnyToken(keyOf(t), ctx.env.IMG_SECRET);
            if (!live) continue;
            boostMkt.set(keyOf(t), {
              at: now, pc: live.pc, vol: live.vol, price: live.price, mcap: live.mcap,
            });
          } catch { /* grey is honest */ }
        }

        for (const t of readd) {
          const c = boostMkt.get(keyOf(t));
          if (!c) continue;
          if (c.pc) t.pc = c.pc;
          if (Number.isFinite(c.vol)) t.vol = c.vol;
          if (Number.isFinite(c.price)) t.price = c.price;
          /* A boost record stores the market cap at purchase. Months later that
             is a stale number wearing a live label. */
          if (Number.isFinite(c.mcap) && c.mcap > 0) t.mcap = c.mcap;
        }
        tokens.push(...readd);
      }

      /* the operator's hide list — off every tab, whatever put it there */
      const hid = await hiddenSet(ctx);
      if (hid.size) tokens = tokens.filter(t => !isHidden(hid, t));

      /* Say on the token that its gold was tapped for, not paid for. */
      for (const [k, b] of byMint) if (b.tap) {
        const t = tokens.find(x => (x.addr || x.mint) === k);
        if (t) t.tapGold = b.tap;
      }

      return json({
        ok: true,
        ts: snap.ts,
        age: Date.now() - snap.ts,
        sol: snap.sol,
        source: snap.source,
        sourceLabel: snap.sourceLabel,
        boostable: snap.boostable,
        sources: publicSources(),
        /* Sent once per response rather than per token: 300 near-identical
           URLs for a button most visitors never press is wasted payload. */
        buy: buyConfig(ctx.env),
        enriched: snap.enriched,
        withArt: snap.withArt,
        signed: snap.signed,
        mode: src.id,
        solid: snap.solid,
        /* Trending only: whether pump.fun's board answered, and how fast. */
        movers: snap.movers || undefined,
        callers: snap.callers || undefined,
        insiders: snap.insiders || undefined,
        /* Compute only: the GPU-hour price board */
        compute: gpus || undefined,
        events: snap.events || undefined,
        arena: snap.arena || undefined,
        goldShare: goldShare(visibleSet(tokens, byMint)),
        stale: Date.now() - snap.ts > SNAPSHOT_TTL * 3,
        /* why a feed is older than its lifetime: its last build's error, query strings cut */
        buildError: cacheFor(src.id).err && Date.now() - snap.ts > (src.ttl || SNAPSHOT_TTL)
          ? String(cacheFor(src.id).err).replace(/\?\S*/g, '').slice(0, 120) : undefined,
        degraded: !!snap.degraded,
        tokens,
      });
    }

    /* ----------------------------------------------------------- /api/tap */
    /* Put a token in the arena. Identity is resolved from the chain, the same
       way a boost order does it, so the arena cannot be told a mint is a
       token it is not. */
    if (path === '/api/tap/add' && req.method === 'POST') {
      if (!ctx.arena) return json({ ok: false, error: 'the arena is not running' }, 503);
      const limited = rateLimit(req, 'tapadd', 12, 60_000);
      if (limited) return limited;
      const body = await req.json().catch(() => ({}));
      const ca = String(body.ca || '').trim();
      if (!isCA(ca)) return json({ ok: false, error: 'that is not a contract address' }, 400);
      const t = await resolveAnyToken(ca, ctx.env.IMG_SECRET);
      if (!t) return json({ ok: false, error: 'no market found for that address' }, 404);
      const tok = {
        mint: t.mint || '', addr: t.addr || '', chain: t.chain || 'solana',
        sym: t.sym, name: t.name, img: t.img || '', mcap: t.mcap || 0,
      };
      const r = await ctx.arena('add', { tok, ip: ipOf(req) });
      /* the next poll from this isolate sees the new row, not a 5s-old list */
      arenaCache.at = 0; cacheFor('taps').at = 0;
      return json(r, r.ok ? 200 : 400);
    }

    /* A batch of taps. The page counts locally and sends every second or
       so; the arena applies its per-address caps and answers with the score
       as it stands. `sec-fetch-site` is stamped same-origin by a browser
       fetching from our own page and by nothing else — a cheap first door,
       not a lock; the caps are the control. */
    if (path === '/api/tap' && req.method === 'POST') {
      if (!ctx.arena) return json({ ok: false, error: 'the arena is not running' }, 503);
      /* A door, not a lock — the per-address caps are the control. Requiring
         the header to *equal* same-origin locked out every browser that does
         not send it, which includes Safari before 16.4: an iPhone is the most
         likely device at a tap game and it would have got 403 on every tap,
         silently. So a header that is present and says cross-site is refused,
         and one that is absent falls through to Origin, which a POST carries
         whether or not Sec-Fetch does. */
      const sfs = req.headers.get('sec-fetch-site');
      if (sfs && sfs !== 'same-origin') {
        return json({ ok: false, error: 'taps come from the page' }, 403);
      }
      const origin = req.headers.get('origin');
      if (origin) {
        let bad = true;
        try { bad = new URL(origin).host !== url.host; } catch { bad = true; }
        if (bad) return json({ ok: false, error: 'taps come from the page' }, 403);
      }
      const limited = rateLimit(req, 'tap', 150, 60_000);
      if (limited) return limited;
      const body = await req.json().catch(() => ({}));
      const key = String(body.key || '');
      const n = Math.floor(+body.n || 0);
      if (!TAP_KEY.test(key) || n <= 0) return json({ ok: false, error: 'bad tap' }, 400);
      const r = await ctx.arena('tap', { key, n, ip: ipOf(req) });
      arenaCache.at = 0; cacheFor('taps').at = 0;
      return json(r, r.ok ? 200 : 400);
    }

    /* --------------------------------------------------------- /api/stats */
    /* Public on purpose. Nobody bids for attention without evidence the
       attention exists, so the traffic number is part of the pitch — the same
       reason outbid.lol puts its visitor count on its own board. */
    if (path === '/api/stats') {
      const s = await statsSummary(ctx.store, 7);
      return json({ ok: true, ...s }, 200, { 'cache-control': 'public, max-age=60' });
    }

    /* --------------------------------------------------------- /api/board */
    /* The board rendered as HTML for the worker to inject. Same reason as
       /market: this is the page people link to when they take #1, and a link
       that unfurls into an empty canvas gets clicked once. */
    if (path === '/api/board') {
      const rows = await board(ctx.store);
      return json({
        ok: true,
        ts: Date.now(),
        summary: boardSummary(rows, { floor: FLOOR_SOL }),
        table: boardTable(rows, { increment: INCREMENT_SOL, floor: FLOOR_SOL }),
        jsonld: boardJsonLd(rows, 'https://pumpbubble.fun/board'),
      }, 200, { 'cache-control': 'public, max-age=15' });
    }

    /* ---------------------------------------------------------- /api/bids */
    /* The board, and what each rank costs to take. Public and unauthenticated:
       the whole mechanic depends on everyone being able to see the price of
       being #1 without committing to anything. */
    if (path === '/api/bids') {
      const rows = await board(ctx.store);
      const top = await priceFor(ctx.store, 1);
      return json({
        ok: true,
        floorSol: FLOOR_SOL,
        incrementSol: INCREMENT_SOL,
        treasury: ctx.env.TREASURY_WALLET || null,
        top,
        board: rows,
      });
    }

    /* Where a given token stands, and the cheapest way up. Quoting the gap
       rather than the full price is what makes defending a rank affordable
       enough that a bidding war actually happens. */
    if (path === '/api/bid/standing') {
      const mint = url.searchParams.get('mint') || '';
      if (!isMint(mint)) return json({ ok: false, error: 'that is not a valid token mint' }, 400);
      return json({ ok: true, ...(await standing(ctx.store, mint)) });
    }

    /* --------------------------------------------------- /api/bid/order */
    if (path === '/api/bid/order' && req.method === 'POST') {
      const limited = rateLimit(req, 'order', 30, 600_000);
      if (limited) return limited;

      /* Same three refusals as a boost: never quote a price we cannot honour. */
      if (!ctx.env.TREASURY_WALLET) return json({ ok: false, error: 'bidding is not open yet' }, 503);
      if (!ctx.store.available) return json({ ok: false, error: 'bidding is temporarily closed — storage is not configured' }, 503);
      if (!ctx.env.SOLANA_RPC) return json({ ok: false, error: 'bidding is temporarily closed — no Solana RPC configured' }, 503);

      const body = await req.json().catch(() => ({}));
      /* Bids stay Solana-only. The board ranks pump.fun tokens and nothing here
         has been taught to price anything else; widening it would be a money
         path nobody had asked for. */
      if (!isMint(body.mint)) return json({ ok: false, error: 'that is not a valid token mint' }, 400);

      const solAmount = Number(body.sol);
      if (!(solAmount >= FLOOR_SOL)) {
        return json({ ok: false, error: `the smallest bid is ${FLOOR_SOL} SOL` }, 400);
      }

      /* Identity comes from our own data, never the caller — same rule as a
         boost. A bid can name any pump.fun token, including one too small to be
         on the map, which is exactly who wants to buy visibility. */
      let tok = null;
      for (const sid of ['pumpfun', 'bonding']) {
        const s = cacheFor(sid).data;
        tok = s?.tokens.find(t => t.mint === body.mint);
        if (tok) break;
      }
      if (!tok) tok = await fetchCoin(body.mint, ctx.env.IMG_SECRET);
      if (!tok) return json({ ok: false, error: 'pump.fun has no token with that address' }, 404);

      const solPrice = await solPriceNow(ctx);
      if (!(solPrice > 0)) return json({ ok: false, error: 'no SOL price available right now' }, 503);

      const inFlight = (await listPending(ctx.store)).map(o => o.lamports);
      const refCode = isCode(body.ref) && await getAffiliate(ctx.store, body.ref) ? body.ref : '';

      let order;
      try {
        order = await createOrder({
          kind: 'bid', bidSol: solAmount, taken: inFlight,
          mint: body.mint, sym: tok.sym, name: tok.name, img: tok.img, mcap: tok.mcap,
          grad: !!tok.grad, solPrice, treasury: ctx.env.TREASURY_WALLET, ref: refCode,
        });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 400);
      }

      /* Say plainly where this lands them, before they pay. Being outbid later
         is the product working, but being surprised at checkout is not. */
      const st = await standing(ctx.store, body.mint);
      const rows = await board(ctx.store);
      const after = (st.current?.sol || 0) + order.amountSol;
      const wouldBeRank = rows.filter(r => r.mint !== body.mint && r.sol > after).length + 1;
      order.projection = {
        currentSol: st.current?.sol || 0,
        afterSol: Math.round(after * 1e6) / 1e6,
        rankNow: st.current?.rank || null,
        rankAfter: wouldBeRank,
      };

      await addPending(ctx.store, order);
      const token = await signOrder(order, ctx.env.IMG_SECRET);
      return json({ ok: true, order, token });
    }

    /* Click-throughs on a ranked token. Counted here rather than in the page so
       the number belongs to us — it is the evidence the next bidder weighs. */
    if (path === '/api/bid/click') {
      const mint = url.searchParams.get('mint') || '';
      if (!isMint(mint)) return json({ ok: false, error: 'bad mint' }, 400);
      const limited = rateLimit(req, 'click', 120, 60_000);
      if (limited) return limited;
      const clicks = await countClick(ctx.store, mint);
      return json({ ok: true, clicks });
    }

    /* ------------------------------------------------------------ /market */
    /* Dev serves the rendered page here; in production the worker does it so
       the injection happens ahead of the asset layer. Same renderer either way. */
    if ((path === '/market' || path === '/board') && ctx.readAsset) {
      const shell = await ctx.readAsset(path === '/board' ? '/board.html' : '/market.html');
      if (!shell) return null;
      let body = shell;
      if (path === '/board') {
        const rows = await board(ctx.store);
        body = shell
          .replace('<!--BOARD_SUMMARY-->', boardSummary(rows, { floor: FLOOR_SOL }))
          .replace('<!--BOARD_TABLE-->', boardTable(rows, { increment: INCREMENT_SOL, floor: FLOOR_SOL }))
          .replace('<!--BOARD_JSONLD-->', boardJsonLd(rows, 'https://pumpbubble.fun/board'));
      } else {
        const snap = await snapshot(ctx, 'majors').catch(() => null);
        if (snap) body = renderMarketPage(shell, snap, 'https://pumpbubble.fun/market');
      }
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    /* -------------------------------------------------------- /api/market */
    /* The market page rendered as HTML, on the server. A canvas is an empty box
       to a crawler — measured, 196 indexable words on the homepage and not one
       coin name — which is why a market-overview query finds coin360 and not
       us. The adapters serve it; the worker injects it into the page. */
    if (path === '/api/market') {
      const snap = await snapshot(ctx, 'majors').catch(() => null);
      if (!snap) return json({ ok: false, error: 'market data unavailable' }, 503);
      return json({
        ok: true,
        ts: snap.ts,
        summary: marketSummary(snap.tokens),
        table: marketTable(snap.tokens),
        jsonld: marketJsonLd(snap.tokens, { url: 'https://pumpbubble.fun/market' }),
      }, 200, { 'cache-control': 'public, max-age=60' });
    }

    /* --------------------------------------------------------- /api/embed */
    /* What this embed is allowed to do. Called by the embedded page itself, so
       partner permissions are decided here rather than trusted from a query
       string that anyone could copy off someone else's site. */
    if (path === '/api/embed') {
      const cfg = await embedConfig(url.searchParams.get('k') || '', ctx.env.IMG_SECRET);
      return json({
        ok: true,
        ...cfg,
        accent: safeAccent(cfg.accent),
        home: 'https://pumpbubble.fun',
      }, 200, { 'cache-control': 'public, max-age=60' });
    }

    /* --------------------------------------------------- /api/swap-config */
    /* The swap page's fee: our Jupiter referral account and its bps, or
       `fee: false`. Public by construction — the account is written into
       every swap it earns on. */
    if (path === '/api/swap-config') {
      return json({ ok: true, ...swapConfig(ctx.env) }, 200, { 'cache-control': 'public, max-age=300' });
    }
    if (path === '/api/swap/tokens') {
      const limited = rateLimit(req, 'swaptok', 60, 60_000);
      if (limited) return limited;
      const chain = String(url.searchParams.get('chain') || '');
      if (!SWAP_LIST_SRC[chain]) return json({ ok: false, error: 'no list for that chain' }, 400);
      return json({ ok: true, chain, tokens: await swapList(ctx, chain) }, 200, { 'cache-control': 'public, max-age=60' });
    }

    /* --------------------------------------------------------- /api/token */
    /* Resolve one mint so the boost modal can show the art and ticker as soon
       as a contract address is pasted. Paying is the wrong moment to discover
       which token you actually named. */
    if (path === '/api/token') {
      const limited = rateLimit(req, 'token', 60, 60_000);
      if (limited) return limited;

      const mint = url.searchParams.get('mint') || '';
      if (!isCA(mint)) return json({ ok: false, error: 'that is not a valid contract address' }, 400);

      /* prefer a feed we already hold — free, and already image-signed */
      /* check every warm cache, whichever sources happen to be loaded */
      const want = isEvmAddr(mint) ? mint.toLowerCase() : mint;
      for (const [sid, c] of caches) {
        const mode = sid;
        const hit = c.data?.tokens.find(t => (t.addr || t.mint) === want);
        if (hit) return json({ ok: true, token: hit, from: mode });
      }

      /* Not in any warm feed: resolve it on whatever chain it lives on. */
      const t = await resolveAnyToken(mint, ctx.env.IMG_SECRET);
      if (!t) return json({ ok: false, error: 'no token found with that contract address' }, 404);
      return json({ ok: true, token: t, from: t.chain || 'pump.fun' });
    }

    /* ------------------------------------------------------- /api/card */
    /* The share image. A PNG rather than the SVG it is built from, because X,
       Telegram and Discord all decline SVG in link previews. */
    if (path === '/api/card') {
      const limited = rateLimit(req, 'card', 60, 60_000);
      if (limited) return limited;

      const tf = url.searchParams.get('tf') || 'h24';
      if (!TF_LABEL[tf]) return json({ ok: false, error: 'unknown timeframe' }, 400);
      /* card art comes through the map's image proxy: edge-cached, with the
         gateway fallbacks already proven there (see logoDataUri) */
      const via = ctx.fetchImage ? (u => ctx.fetchImage(u, IMG_TTL)) : null;

      /* The leaderboard card: Smart money's two views are tables, so their
         share card is one — ten rows of picture, name and numbers. Cached
         per source, window, hour and names, like the bubble card. */
      if (url.searchParams.get('kind') === 'table') {
        const srcId = BOARD_SRC[url.searchParams.get('source') || 'smart'];
        if (!srcId || !(srcId.startsWith('smart') || srcId.startsWith('traders') || srcId.startsWith('callers'))) {
          return json({ ok: false, error: 'the table card is for Smart money and Callers' }, 400);
        }
        const snap = await snapshot(ctx, sourceOf(srcId));
        const hid = await hiddenSet(ctx);
        const traders = srcId.startsWith('traders');
        /* holdings rank by how many hold it; traders arrive ranked by realized */
        let pool = (snap.tokens || []).filter(t => !isHidden(hid, t));
        if (!traders) pool = [...pool].sort((a, b) => (b.heat || 0) - (a.heat || 0));
        const top = pickTen(pool, tf);
        if (top.length < 3) return json({ ok: false, error: 'not enough rows' }, 404);
        const seed = seedFor(top, Date.now());

        const store0 = globalThis.caches && globalThis.caches.default;
        const bk = new Request(url.origin + '/api/card/table/v2/' + srcId + ':' + tf + ':' + seed);
        if (store0) {
          const hit = await store0.match(bk);
          if (hit) return hit;
        }

        /* under a dollar is flat, not "\u2212$0" */
        const money = v => Math.abs(v) < 1 ? '$0' : (v >= 0 ? '+' : '\u2212') + (mcapLabel(Math.abs(v)) || '$0');
        const tone = v => v == null || Math.abs(v) < 1 ? T_DIM : v >= 0 ? T_UP : T_DN;
        const pct = v => v == null || !Number.isFinite(+v) ? '\u2014'
          : (v >= 0 ? '+' : '\u2212') + (Math.abs(v) >= 100 ? Math.round(Math.abs(v)).toLocaleString('en-US') : Math.abs(v).toFixed(1)) + '%';
        const logos = await Promise.all(top.map(t => logoDataUri(t, via).catch(() => null)));
        const period = { h24: '24H', d7: '7D', d30: '30D', h1: '1H' }[tf] || '24H';
        let spec;
        if (srcId.startsWith('callers')) {
          /* the hit rate is the ranking, so it leads; median peak says how big,
             calls says how much of a record it is */
          const win = { 'callers-daily': '24H', 'callers-weekly': '7D', 'callers-monthly': '30D' }[srcId] || '7D';
          spec = {
            title: 'TOP CALLERS ON PUMP.FUN', sub: win + ' \u00b7 HOW OFTEN THEIR CALLS HIT 2\u00d7', nameLabel: 'CALLER',
            cols: [{ label: 'HIT 2\u00d7', x: 760 }, { label: 'MEDIAN PEAK', x: 960 }, { label: 'CALLS', x: 1152 }],
            rows: top.map((t, i) => ({
              title: t.xh ? '@' + t.xh : t.sym, subtitle: t.xh ? t.sym : '', logo: logos[i],
              values: [{ text: Math.round((t.caller.hit2 || 0) * 100) + '%', color: T_UP },
                       { text: t.caller.med ? (+t.caller.med).toFixed(1) + '\u00d7' : '\u2014', color: '#ffffff' },
                       { text: String(t.caller.n || 0), color: '#c9d3de' }],
            })),
          };
        } else if (traders) {
          spec = {
            title: 'TOP TRADERS BY REALIZED PNL', sub: period + ' \u00b7 NOT PAPER GAINS', nameLabel: 'TRADER',
            cols: [{ label: 'BANKED', x: 760 }, { label: 'OPEN', x: 960 }, { label: 'TOTAL', x: 1152 }],
            rows: top.map((t, i) => ({
              title: t.xh ? '@' + t.xh : t.sym, subtitle: t.xh ? t.sym : '', logo: logos[i],
              values: [{ text: money(t.realized || 0), color: T_UP },
                       { text: t.unrealized == null ? '\u2014' : money(t.unrealized), color: tone(t.unrealized) },
                       { text: t.total == null ? '\u2014' : money(t.total), color: tone(t.total) }],
            })),
          };
        } else {
          spec = {
            title: TEN_TITLE[srcId] || 'WHAT TOP TRADERS HOLD', sub: period + ' · BY HOLDERS', nameLabel: 'TOKEN',
            cols: [{ label: 'HELD BY', x: 760 }, { label: period, x: 960 }, { label: 'MCAP', x: 1152 }],
            rows: top.map((t, i) => ({
              title: '$' + t.sym, subtitle: t.name && t.name !== t.sym ? t.name : '', logo: logos[i],
              values: [{ text: t.smartN + (t.smartN === 1 ? ' TRADER' : ' TRADERS'), color: '#ffffff' },
                       { text: pct(t.pc[tf]), color: t.pc[tf] >= 0 ? T_UP : T_DN },
                       { text: mcapLabel(t.mcap) || '\u2014', color: '#c9d3de' }],
            })),
          };
        }
        let svg;
        try { svg = buildTableSvg(spec); } catch { return json({ ok: false, error: 'not enough rows' }, 404); }
        const buf = await svgToPng(svg, CARD_W);
        const out = new Response(buf, {
          headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=600', 'access-control-allow-origin': '*' },
        });
        if (store0) await store0.put(bk, out.clone());
        return out;
      }

      /* The generative card: the top ten of a tab, drawn as the map draws
         them. Trending by default, because that tab is the one whose order is
         a claim worth a picture — pump.fun's own list leading, ours after.
         The seed is the hour and the tickers, so the cache key can be the
         same thing and a post never shows two pictures of one fact. */
      if (url.searchParams.get('kind') === 'bubbles') {
        const srcId = BOARD_SRC[url.searchParams.get('source') || 'trending'];
        if (!srcId) return json({ ok: false, error: 'unknown source' }, 400);

        const snap = await snapshot(ctx, sourceOf(srcId));
        const hid = await hiddenSet(ctx);
        const top = pickTen((snap.tokens || []).filter(t => !isHidden(hid, t)), tf);
        if (top.length < 3) return json({ ok: false, error: 'not enough measured movers' }, 404);
        const seed = seedFor(top, Date.now());

        const store0 = globalThis.caches && globalThis.caches.default;
        const bk = new Request(url.origin + '/api/card/bubbles/v4/' + srcId + ':' + tf + ':' + seed);
        if (store0) {
          const hit = await store0.match(bk);
          if (hit) return hit;
        }

        /* A trader's bubble carries money, not a percentage: what was
           banked, coloured by whether the trader is up overall. */
        const traders = srcId.startsWith('traders');
        /* smart money reads "6 TRADERS" where a token reads its percentage:
           that count is the thing the tab measures */
        const rows = traders
          ? top.map(t => ({ ...t, cardTitle: t.xh ? '@' + t.xh : t.sym, cardLabel: '+' + (mcapLabel(t.realized) || '$0'),
                            cardUp: !(t.total < 0) }))
          : srcId.startsWith('smart')
            ? top.map(t => ({ ...t, cardLabel: t.smartN + (t.smartN === 1 ? ' TRADER' : ' TRADERS'), cardUp: !(t.pc[tf] < 0) }))
            : top;
        const svg = await bubbleCardSvgFor(rows, tf, {
          title: TEN_TITLE[srcId] || 'TOP 10 TRENDING',
          sub: (TF_SHORT[tf] || '24H').toUpperCase() + (traders ? ' · REALIZED' : ''),
          seed, via,
        });
        if (!svg) return json({ ok: false, error: 'no measured changes' }, 404);
        const buf = await svgToPng(svg, CARD_W);
        const out = new Response(buf, {
          headers: {
            'content-type': 'image/png',
            'cache-control': 'public, max-age=600',
            'access-control-allow-origin': '*',
          },
        });
        if (store0) await store0.put(bk, out.clone());
        return out;
      }

      /* The ranked card. Same filters the poster uses, so what a project sees
         on the leaderboard is what the account would say about it. */
      if (url.searchParams.get('kind') === 'board') {
        const srcId = BOARD_SRC[url.searchParams.get('source') || 'pumpfun'];
        if (!srcId) return json({ ok: false, error: 'unknown source' }, 400);

        const store0 = globalThis.caches && globalThis.caches.default;
        const bk = new Request(url.origin + '/api/card/board/v1/' + srcId + ':' + tf);
        if (store0) {
          const hit = await store0.match(bk);
          if (hit) return hit;
        }

        const snap = await snapshot(ctx, sourceOf(srcId));
        const top = topMovers(snap.tokens || [], tf, 5, srcId);
        if (top.length < 3) return json({ ok: false, error: 'not enough movers' }, 404);

        const svg = await boardCardSvgFor(top, tf, 'TOP MOVERS', BOARD_SUB[srcId], via);
        if (!svg) return json({ ok: false, error: 'no measured changes' }, 404);
        const buf = await svgToPng(svg, CARD_W);
        const out = new Response(buf, {
          headers: {
            'content-type': 'image/png',
            'cache-control': 'public, max-age=600',
            'access-control-allow-origin': '*',
          },
        });
        if (store0) await store0.put(bk, out.clone());
        return out;
      }

      const found = await findToken(ctx, url.origin, {
        mint: url.searchParams.get('mint') || '',
        sym: (url.searchParams.get('sym') || '').toUpperCase(),
        srcId: url.searchParams.get('source') || '',
      });
      if (!found) return json({ ok: false, error: 'no token by that name' }, 404);

      /* Rendering costs real CPU and one post can bring a burst of identical
         requests, so the result is held at the edge. Five minutes is long
         enough to absorb that burst and short enough that the number on the
         card is still the number on the map. */
      const store = globalThis.caches && globalThis.caches.default;
      const ck = new Request(url.origin + '/api/card/v1/'
        + encodeURIComponent((found.t.mint || found.t.sym) + ':' + tf));
      if (store) {
        const hit = await store.match(ck);
        if (hit) return hit;
      }

      const svg = await cardSvgFor(found.t, tf, via);
      if (!svg) return json({ ok: false, error: 'no measured change for that window' }, 404);

      const png = await svgToPng(svg, CARD_W);
      const res = new Response(png, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=300',
          'access-control-allow-origin': '*',
        },
      });
      if (store) await store.put(ck, res.clone());
      return res;
    }

    /* ------------------------------------------------------------- /s/ */
    /* A share link. Crawlers read the Open Graph tags and show the card;
       people get a page with a way through to the map, because an image on
       its own is a dead end for a visitor. */
    /* The ranked share page. A leaderboard gives five projects a reason to
       repost instead of one, which is the whole reason it is published. */
    /* The page behind the generative card. Same shape as /s/top: crawlers get
       the picture, people get a way through to the map. */
    if (path === '/s/top10') {
      const tf = url.searchParams.get('tf') || 'h24';
      const srcId = BOARD_SRC[url.searchParams.get('source') || 'trending'];
      if (!TF_LABEL[tf] || !srcId) return Response.redirect(url.origin + '/', 302);

      const snap = await snapshot(ctx, sourceOf(srcId));
      const top = pickTen(snap.tokens || [], tf);
      if (top.length < 3) return Response.redirect(url.origin + '/', 302);

      const qs = (srcId === 'trending' ? '' : '?source=' + srcId);
      const q = 'kind=' + (srcId.startsWith('smart') || srcId.startsWith('traders') || srcId.startsWith('callers') ? 'table' : 'bubbles')
        + '&source=' + srcId + '&tf=' + tf;
      const desc = srcId.startsWith('callers')
        ? top.slice(0, 5).map(t => (t.xh ? '@' + t.xh : t.sym) + ' ' + Math.round((t.caller.hit2 || 0) * 100) + '% hit 2\u00d7').join(' · ')
        : srcId.startsWith('traders')
        ? top.slice(0, 6).map(t => (t.xh ? '@' + t.xh : t.sym) + ' +' + (mcapLabel(t.realized) || '$0')).join(' · ')
        : top.slice(0, 6).map(t => '$' + t.sym + ' ' + (Number(t.pc[tf]) >= 0 ? '+' : '')
          + Number(t.pc[tf]).toFixed(0) + '%').join(' · ');
      const share = url.origin + '/s/top10' + qs;

      return new Response(page({
        title: (TEN_SHARE[srcId] || 'Top 10') + ' — pumpbubble.fun',
        desc,
        canonical: url.origin + '/s/top10',
        cardUrl: url.origin + '/api/card?' + q,
        mapUrl: url.origin + '/?source=' + srcId,
        tweetUrl: 'https://twitter.com/intent/tweet?text='
          + encodeURIComponent(TEN_SHARE[srcId] || 'Top 10') + '&url=' + encodeURIComponent(share) + '&via=pumpbubblefun',
        alt: desc,
      }), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      });
    }

    if (path === '/s/top') {
      const tf = url.searchParams.get('tf') || 'h24';
      const srcId = BOARD_SRC[url.searchParams.get('source') || 'pumpfun'];
      if (!TF_LABEL[tf] || !srcId) return Response.redirect(url.origin + '/', 302);

      const snap = await snapshot(ctx, sourceOf(srcId));
      const top5 = topMovers(snap.tokens || [], tf, 5, srcId);
      /* Nothing to rank is not a page. Better the map than a card asserting a
         leaderboard we could not fill. */
      if (top5.length < 3) return Response.redirect(url.origin + '/', 302);

      const q = 'kind=board&source=' + srcId + '&tf=' + tf;
      const title = BOARD_TITLE[srcId] + ' — pumpbubble.fun';
      const desc = top5.map(t => '$' + t.sym + ' ' + (Number(t.pc[tf]) >= 0 ? '+' : '')
        + Number(t.pc[tf]).toFixed(0) + '%').join(' · ');
      const share = url.origin + '/s/top'
        + (srcId === 'pumpfun' ? '' : '?source=' + srcId);

      return new Response(page({
        title, desc,
        canonical: url.origin + '/s/top',
        cardUrl: url.origin + '/api/card?' + q,
        mapUrl: url.origin + '/' + (srcId === 'pumpfun' ? '' : '?source=' + srcId),
        tweetUrl: 'https://twitter.com/intent/tweet?text='
          + encodeURIComponent(BOARD_TITLE[srcId]) + '&url=' + encodeURIComponent(share) + '&via=pumpbubblefun',
        alt: desc,
      }), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      });
    }

    if (path === '/s' || path.startsWith('/s/')) {
      const home = Response.redirect(url.origin + '/', 302);
      const id = decodeURIComponent(path.slice(3).replace(/\/+$/, ''));
      const tf = url.searchParams.get('tf') || 'h24';
      if (!id || !TF_LABEL[tf]) return home;

      const asMint = isMint(id);
      const found = await findToken(ctx, url.origin, {
        mint: asMint ? id : '',
        sym: asMint ? '' : id.toUpperCase(),
        srcId: url.searchParams.get('source') || '',
      });
      const t = found && found.t;
      const pct = t && t.pc ? t.pc[tf] : null;
      /* No measured value means no card, and no card means no page — better a
         visitor lands on the map than on an image asserting a number we do not
         have. */
      if (!t || pct == null || !Number.isFinite(Number(pct))) return home;

      /* X caches a link preview for days. Stamping the URL with the value it
         is showing means a changed number is a new URL and gets refetched,
         while an unchanged one still hits their cache. */
      const v = String(Math.round(Number(pct) * 100));
      const q = (t.mint ? 'mint=' + encodeURIComponent(t.mint)
                        : 'sym=' + encodeURIComponent(t.sym) + '&source=' + found.srcId)
        + '&tf=' + tf + '&v=' + v;
      const key = encodeURIComponent(t.mint || t.sym);
      const share = url.origin + '/s/' + key + (tf === 'h24' ? '' : '?tf=' + tf);
      const text = '$' + t.sym + ' ' + pctLabel(pct) + ' in ' + (TF_SHORT[tf] || tf);

      return new Response(sharePage({
        origin: url.origin, t, tf, pct,
        cardUrl: url.origin + '/api/card?' + q,
        mapUrl: url.origin + '/' + (found.srcId === 'pumpfun' ? '' : '?source=' + found.srcId),
        tweetUrl: 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text)
          + '&url=' + encodeURIComponent(share) + '&via=pumpbubblefun',
      }), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=120',
        },
      });
    }

    /* ---------------------------------------------------------- /api/img */
    /* Signed proxy. Unsigned URLs are refused, so this can never be used as an
       open relay. See core.mjs → image proxy. */
    if (path === '/api/img') {
      const u = url.searchParams.get('u') || '';
      const s = url.searchParams.get('s') || '';
      if (!await verifyUrl(u, s, ctx.env.IMG_SECRET)) {
        return new Response('bad signature', { status: 403 });
      }
      let target;
      try { target = new URL(u); } catch { return new Response('bad url', { status: 400 }); }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return new Response('bad scheme', { status: 400 });
      }
      /* `return await`, not `return`: a bare returned promise escapes the
         try/catch below and surfaces as a 500 instead of a handled 502. */
      return await ctx.fetchImage(target.toString(), IMG_TTL);
    }

    /* ------------------------------------------------------- /api/boosts */
    if (path === '/api/boosts') {
      const { live, byMint } = await activeBoosts(ctx.store);
      return json({
        ok: true,
        tiers: Object.values(TIERS),
        treasury: ctx.env.TREASURY_WALLET || null,
        active: [...byMint.values()].sort((a, b) => b.spentUsd - a.spentUsd),
        count: live.length,
      });
    }

    /* -------------------------------------------------- /api/boost/order */
    if (path === '/api/boost/order' && req.method === 'POST') {
      /* Generous on purpose: quoting is stateless and costs nothing now, and
         mobile traffic shares IPs behind carrier NAT — a tight limit would
         block real buyers long before it inconvenienced anyone abusive. */
      const limited = rateLimit(req, 'order', 30, 600_000);
      if (limited) return limited;

      /* Never quote a price we cannot honour. Without KV a paid boost cannot be
         stored, and without an RPC a payment cannot be verified — in both cases
         the buyer's money would arrive and nothing would happen. Refusing the
         sale is the only honest option, and misconfiguration is exactly when
         this matters, so it is checked per order rather than assumed at boot. */
      if (!ctx.env.TREASURY_WALLET) {
        return json({ ok: false, error: 'boosts are not open yet — no treasury wallet configured' }, 503);
      }
      if (!ctx.store.available) {
        return json({ ok: false, error: 'boosts are temporarily closed — storage is not configured' }, 503);
      }
      if (!ctx.env.SOLANA_RPC) {
        return json({ ok: false, error: 'boosts are temporarily closed — no Solana RPC configured' }, 503);
      }
      const body = await req.json().catch(() => ({}));
      if (!isCA(body.mint)) {
        return json({ ok: false, error: 'that is not a valid contract address' }, 400);
      }
      /* One canonical spelling of the identifier, since EVM addresses arrive
         checksummed from one source and lowercase from another. */
      const caId = isEvmAddr(body.mint) ? body.mint.toLowerCase() : body.mint;
      /* A paid ad rides this route: same token resolution, same unique
         amount, same sweep. Only the Telegram bot may name a chat to notify —
         a web caller could otherwise point paid-notices at anyone. */
      const isAd = body.kind === 'ad';
      if (isAd && !AD_TIERS[body.tier]) return json({ ok: false, error: 'unknown ad slot' }, 400);
      const notify = ctx.fromBot && Number.isFinite(+body.notify) ? +body.notify : 0;

      /* Look in whichever feed the token would actually appear on. A
         bonding-curve token is as boostable as a graduated one, and a Base or
         Robinhood contract is as boostable as either — the payment is in SOL
         to a Solana treasury regardless of where the token lives. */
      const FEEDS = isEvmAddr(caId) ? ['base', 'robinhood'] : ['pumpfun', 'bonding'];
      let snap = null, tok = null;
      for (const f of FEEDS) {
        const cand = await snapshot(ctx, f).catch(() => null);
        const hit = cand?.tokens.find(t => (t.addr || t.mint) === caId);
        if (hit) { snap = cand; tok = hit; break; }
        if (!snap) snap = cand;
      }
      /* Not in either ranked feed — ask pump.fun directly. The feeds carry the
         top 300, so a smaller coin is invisible to them, and that is precisely
         the token whose community turns up wanting to be seen. A boost pulls it
         onto the map (see /api/tokens, which re-adds paid tokens that are not in
         the feed), so this sells something real.

         Still not a free-for-all: the address has to resolve to a token that
         actually trades somewhere. */
      /* A feed hit that cannot name its own chain is resolved rather than
         guessed: the chain ends up in a payment record and a wrong one there is
         a wrong number, not a cosmetic label. */
      if (tok && !tok.chain && isEvmAddr(caId)) {
        const live = await resolveAnyToken(caId, ctx.env.IMG_SECRET);
        if (live && live.chain) tok = { ...tok, chain: live.chain };
      }
      if (!tok) {
        tok = await resolveAnyToken(caId, ctx.env.IMG_SECRET);
        if (!tok) {
          return json({
            ok: false,
            error: 'no token found with that contract address',
          }, 404);
        }
      }

      /* Inventory cap. Gold is worth exactly what the traffic is worth, so
         over-selling destroys the thing being sold — CLAUDE.md treats the ~25%
         ceiling as non-negotiable. Refuse the sale that would breach it rather
         than discovering it afterwards in the smoke test. */
      if (snap && !isAd) {
        const { byMint } = await activeBoosts(ctx.store);
        const onScreen = visibleSet(snap.tokens, byMint);
        const projected = applyBoosts(onScreen.map(t => ({ ...t })), byMint);
        const target = projected.find(t => (t.addr || t.mint) === caId);
        /* Project through the same pooled curve the map will actually use —
           adding the tier's headline multiplier here would over-estimate the
           new gold and refuse sales that are in fact within the cap. */
        if (target) {
          const cur = byMint.get(caId);
          target.boost = bonusFromSpend((cur ? cur.liveUsd : 0) + tierOf(body.tier).usd);
        }
        if (goldShare(projected) > GOLD_CAP) {
          return json({
            ok: false,
            error: 'boost slots are full right now — too much of the map is already gold. Try again as current boosts decay.',
            goldShare: goldShare(projected),
          }, 503);
        }
      }

      /* amounts already in flight — the new quote must not collide with one */
      const inFlight = (await listPending(ctx.store)).map(o => o.lamports);

      /* An unknown or malformed code is dropped rather than rejected: a bad
         referral must never stop somebody buying. */
      const refCode = isCode(body.ref) && await getAffiliate(ctx.store, body.ref) ? body.ref : '';

      const order = await createOrder({
        taken: inFlight,
        ref: refCode,
        mint: caId,
        /* Which chain the advertised token lives on. The payment is SOL to a
           Solana treasury either way; this only decides how the identifier is
           validated and how the bubble is later re-added. */
        chain: tok?.chain || (isEvmAddr(caId) ? '' : 'solana'),
        /* identity is ours, resolved server-side — never whatever the client sent.
           Carried on the signed order so a token bought from outside the ranked
           feed still renders with its real art and name once it goes gold. */
        sym: tok?.sym || '',
        name: tok?.name || '',
        img: tok?.img || '',
        mcap: tok?.mcap || 0,
        /* which feed this bubble lives in, so a paid boost is re-added to the
           right map if the token later drops out of it */
        grad: tok ? !!tok.grad : true,
        tierId: body.tier,
        kind: isAd ? 'ad' : 'boost',
        solPrice: (snap?.sol > 0 ? snap.sol : await solPriceNow(ctx)),
        treasury: ctx.env.TREASURY_WALLET,
      });
      if (notify) order.notify = notify;

      /* An ad is not a size: say when it would start instead of projecting. */
      if (isAd) {
        const t = AD_TIERS[body.tier];
        const list = (await ctx.store.get(t.key)) || [];
        const startsAt = adSchedule(list, Date.now(), t.hours * 3600 * 1000, t.max);
        if (startsAt - Date.now() > AD_QUEUE_DAYS * 864e5) {
          return json({ ok: false, error: `${t.label} slots are sold out for the next ${AD_QUEUE_DAYS} days.` }, 409);
        }
        order.startsAt = startsAt;
        await addPending(ctx.store, order);
        const token = await signOrder(order, ctx.env.IMG_SECRET);
        return json({ ok: true, order, token });
      }

      /* Quote the actual result, not the headline multiplier. Boosts pool and
         the curve flattens, so the tenth buyer on a token genuinely gets less
         than the first — which is only fair if they can see it before paying. */
      const { byMint: liveNow } = await activeBoosts(ctx.store);
      const already = liveNow.get(caId);
      const beforeUsd = already ? already.liveUsd : 0;
      const before = bonusFromSpend(beforeUsd);
      const after = bonusFromSpend(beforeUsd + order.usd);
      order.projection = {
        from: +(1 + before).toFixed(2),
        to: +(1 + after).toFixed(2),
        gain: +(after - before).toFixed(3),
        stackedOn: already ? already.count : 0,
      };

      /* Refuse to sell something that would visibly do nothing. */
      if (order.projection.gain < 0.05) {
        return json({
          ok: false,
          error: `${tok?.sym || 'this token'} is already boosted to the maximum size. Boosts decay, so this frees up over the next hours.`,
          projection: order.projection,
        }, 409);
      }

      /* Remember it server-side so the payment can be reconciled even if this
         tab never comes back — which is the normal case on mobile, where the
         wallet takes over the screen. */
      await addPending(ctx.store, order);

      const token = await signOrder(order, ctx.env.IMG_SECRET);
      return json({ ok: true, order, token });
    }

    /* ------------------------------------------------- /api/boost/status */
    /* ------------------------------------------------ /api/boost/blockhash */
    /* The one thing the page cannot get for itself to pay from a connected
       wallet: a recent blockhash for the transfer it builds. The map's CSP
       keeps connect-src at 'self', so the RPC is asked here. Ten seconds per
       isolate — a blockhash stays usable for about a minute. */
    if (path === '/api/boost/blockhash') {
      const limited = rateLimit(req, 'blockhash', 20, 60_000);
      if (limited) return limited;
      if (!ctx.env.SOLANA_RPC) return json({ ok: false, error: 'no Solana RPC configured' }, 503);
      if (bhMem.v && Date.now() - bhMem.at < 10_000) return json({ ok: true, ...bhMem.v }, 200, { 'cache-control': 'no-store' });
      try {
        const r = await fetch(ctx.env.SOLANA_RPC, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }),
          signal: AbortSignal.timeout(8000),
        });
        const j = await r.json();
        const v = j && j.result && j.result.value;
        if (!v || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(v.blockhash || ''))) throw new Error('no blockhash');
        bhMem = { at: Date.now(), v: { blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight } };
        return json({ ok: true, ...bhMem.v }, 200, { 'cache-control': 'no-store' });
      } catch { return json({ ok: false, error: 'could not reach Solana' }, 502); }
    }

    if (path === '/api/boost/status') {
      /* Polling is cheap now that the treasury scan is shared and cached, so
         this only exists to stop a runaway client. */
      const limited = rateLimit(req, 'status', 90, 60_000);
      if (limited) return limited;

      const order = await readOrder(url.searchParams.get('t') || '', ctx.env.IMG_SECRET);
      /* A missing or edited order is indistinguishable from a forged one, and
         both get the same answer: this is not an order we issued. */
      if (!order) return json({ ok: false, error: 'unknown or tampered order' }, 400);

      /* If it is already paid for, say so without touching the chain. */
      const { live } = await activeBoosts(ctx.store);
      const already = live.find(b => b.id === order.id);
      if (already) return json({ ok: true, status: 'paid', order, boost: already });

      const rpcUrl = ctx.env.SOLANA_RPC;
      if (!rpcUrl) return json({ ok: false, error: 'no Solana RPC configured' }, 503);

      /* Quotes stop being offered after 30 minutes, but money that arrives late
         is still money: keep checking for a day so a slow payment activates
         instead of stranding. Only the quote expires, never the payment. */
      const late = Date.now() > order.expiresAt;
      if (Date.now() > order.createdAt + 864e5) {
        return json({ ok: true, status: 'expired', order });
      }

      let payment = null;
      try { payment = await findPayment(rpcUrl, order); }
      catch (e) { return json({ ok: true, status: 'pending', note: 'rpc: ' + e.message, order }); }

      if (!payment) return json({ ok: true, status: late ? 'expired' : 'pending', order });

      /* Commission is decided here, at confirmation, from the code signed into
         the order and the wallet that actually paid — never from the client and
         never recomputed later. */
      payment.ref = await resolveReferral(ctx.store, {
        code: order.ref, usd: order.usd, payer: payment.payer,
      });
      const boost = await activateBoost(ctx.store, order, payment);
      return json({ ok: true, status: 'paid', order, boost });
    }

    /* -------------------------------------------------- /api/boost/sweep */
    /* Reconciles arriving payments against pending orders. Called on a timer,
       and callable by anyone — it grants nothing that the chain has not already
       paid for, so there is nothing to protect. It is what makes a payment
       survive the buyer closing the tab. */
    /* Called by cron. Enriches the next slice of stock symbols with their
       monthly and yearly change; see src/stockwin.mjs for why it is gradual. */
    if (path === '/api/stocks/windows') {
      try {
        const snap = await snapshot(ctx, sourceOf('stocks'));
        const syms = (snap.tokens || []).map(t => t.sym).filter(Boolean);
        /* the Compute tab's companies too — half of them sit below the top 300 */
        const all = [...new Set([...syms, ...Object.values(COMPUTE_STOCKS).flat()])];
        return json({ ok: true, ...(await refreshWindows(ctx.store, all)) });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
      }
    }

    /* ------------------------------------------------------------ console */
    /* No link points here and there is no default path. With ADMIN_PATH or
       ADMIN_PASS unset this block does not exist, and the URL 404s like any
       other unknown one — a 401 would confirm that something is here. */
    if (adminEnabled(ctx.env)) {
      const root = adminPath(ctx.env);

      if (path === root) {
        return new Response(adminPage(root), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex, nofollow, noarchive',
          },
        });
      }

      if (path === root + '/api' && req.method === 'POST') {
        /* Throttle guessing, not use.

           The first version counted every request to this endpoint, which locked
           the operator out of their own console in seconds: the panel refetches
           the overview on load and again after every change, so eight requests
           per ten minutes is a handful of clicks. Wrong. What needs slowing down
           is somebody trying passwords, and a request that carries the right one
           is not that.

           So the password is checked first and only a *failure* costs an
           attempt. Eight per ten minutes still applies to guessing, because the
           password here is short and human-chosen. The counter is per-isolate
           and in memory, so treat it as a speed bump — the secret path is what
           keeps the door from being found at all. */
        /* Checked before the password so a spent budget costs nothing to
           reject, and so an attacker cannot keep the door open by guessing. */
        if (await lockedOut(ctx.store, req)) {
          return json({ ok: false, error: 'too many attempts, wait 10 minutes' }, 429);
        }

        if (!await authed(req, ctx.env)) {
          await noteFailure(ctx.store, req);
          return json({ ok: false, error: 'no' }, 401);
        }
        /* A right answer wipes the slate: two typos should never strand the
           one person who is supposed to be here. */
        await clearFailures(ctx.store, req);

        /* A separate, generous ceiling on authenticated use, so a runaway loop
           in the page cannot hammer KV — never low enough to interrupt a
           person clicking around. */
        const busy = rateLimit(req, 'adminuse', 240, 60_000);
        if (busy) return busy;

        let body = {};
        try { body = await req.json(); } catch { /* empty body is a bad action */ }
        const action = String(body.action || '');

        const readAds = async () => (await ctx.store.get('ads')) || [];
        const readBoosts = async () => (await ctx.store.get('boosts')) || [];

        if (action === 'overview') {
          const all = await readBoosts();
          const { live } = await activeBoosts(ctx.store);
          /* House boosts are the operator's own slot and were never paid for.
             Counting them as revenue would be inventing income. */
          const paid = all.filter(b => !b.house);
          const revenueUsd = paid.reduce((a, b) => a + (Number(b.usd) || 0), 0);

          let traffic = { viewsToday: 0, visitorsToday: 0, views7d: 0, visitors7d: 0 };
          try {
            const st = await statsSummary(ctx.store, 7);
            const days = (st && st.days) || [];
            traffic = {
              viewsToday: (st.today && st.today.views) || 0,
              visitorsToday: (st.today && st.today.visitors) || 0,
              views7d: days.reduce((a, d) => a + (d.views || 0), 0),
              visitors7d: days.reduce((a, d) => a + (d.visitors || 0), 0),
            };
          } catch { /* stats are a nice-to-have, not a reason to fail */ }

          const feeds = [];
          for (const id of ['pumpfun', 'majors', 'stocks', 'robinhood', 'base']) {
            try {
              const snap = await snapshot(ctx, sourceOf(id));
              const toks = snap.tokens || [];
              feeds.push({
                id, tokens: toks.length,
                solid: toks.filter(t => t.solid).length,
                age: Date.now() - (snap.ts || Date.now()),
              });
            } catch { feeds.push({ id, tokens: 0, solid: 0, age: null }); }
          }

          let seeds = { base: [], robinhood: [] };
          try { seeds.base = (await baseCache(ctx.store)).seeds || []; } catch {}
          try { seeds.robinhood = (await rhRegistry(ctx.store)).seeds || []; } catch {}

          const tg = await tgStatus(ctx.env, ctx.store).catch(e => ({ enabled: tgEnabled(ctx.env), error: String(e.message) }));
          let xbot = { configured: !!xCreds(ctx.env), postedToday: 0, would: null };
          try {
            const st = (await ctx.store.get(XBOT_KEY)) || {};
            xbot.postedToday = st.count || 0;
          } catch {}

          return json({
            ok: true,
            money: {
              revenueUsd,
              paidCount: paid.length,
              liveCount: live.length,
              treasury: ctx.env.TREASURY_WALLET || '',
            },
            traffic, feeds,
            ads: await readAds(),
            boosts: all.slice(-40).reverse(),
            hidden: (await ctx.store.get('hidden')) || [],
            arena: ctx.arena ? await (async () => {
              try {
                const [st, c] = await Promise.all([ctx.arena('state'), ctx.arena('cfg')]);
                return { tokens: (st.tokens || []).map(t => ({ key: t.key, sym: t.sym, taps: t.taps, award: t.award, lastTap: t.lastTap, added: t.added })),
                         idleHours: (c && c.cfg && c.cfg.idleHours) || 24 };
              } catch { return null; }
            })() : null,
            token: (await ctx.store.get('ourtoken')) || null,
            seeds, xbot, tg,
          });
        }

        if (action === 'ad.add') {
          const title = String(body.title || '').trim().slice(0, 24);
          const url = String(body.url || '').trim();
          if (!title) return json({ ok: false, error: 'title required' }, 400);
          if (url && !/^https:\/\//i.test(url)) {
            return json({ ok: false, error: 'url must be https' }, 400);
          }
          const img = String(body.img || '').trim();
          if (img && !/^https:\/\//i.test(img)) {
            return json({ ok: false, error: 'image must be https' }, 400);
          }
          /* Editing is saving under the same title; renaming names the old
             one in `prevTitle` so it is replaced rather than left behind. */
          const prev = String(body.prevTitle || '').toUpperCase();
          const hours = Math.max(0, Math.min(24 * 90, Number(body.hours) || 0));
          const ads = (await readAds()).filter(a => {
            const t = (a.title || '').toUpperCase();
            return t !== title.toUpperCase() && (!prev || t !== prev);
          });
          /* the four slots are the ads showing now — paid Map ads that have
             ended or are queued for later do not hold one */
          const showing = ads.filter(a => !(a.until > 0 && a.until < Date.now()) && !(a.from > Date.now()));
          if (showing.length >= 4) return json({ ok: false, error: 'the rail has four slots — remove one first' }, 400);
          ads.push({ title, sub: String(body.sub || 'sponsored').slice(0, 40), img, url,
                     at: Date.now(), until: hours ? Date.now() + hours * 36e5 : 0 });
          await ctx.store.put('ads', ads);
          return json({ ok: true });
        }

        if (action === 'ad.remove') {
          const t = String(body.title || '').toUpperCase();
          const ads = (await readAds()).filter(a => (a.title || '').toUpperCase() !== t);
          await ctx.store.put('ads', ads);
          return json({ ok: true });
        }

        if (action === 'boost.house') {
          const id = String(body.ca || body.mint || '').trim();
          let chain = String(body.chain || '').trim();
          const evm = /^0x[0-9a-f]{40}$/i.test(id);
          if (!evm && !isMint(id)) return json({ ok: false, error: 'not a mint or contract' }, 400);
          /* The chain comes from the token, not a dropdown: the same lookup a
             boost order uses names it. A dropdown was one more way to file a
             Robinhood token as Base. */
          if (evm && chain !== 'base' && chain !== 'robinhood') {
            try {
              const r = await resolveAnyToken(id, ctx.env.IMG_SECRET);
              chain = (r && r.chain) || '';
            } catch { chain = ''; }
            if (!chain) return json({ ok: false, error: 'could not find a market for that contract' }, 404);
          }

          /* Identity comes from the chain rather than from the form, so a house
             slot cannot be labelled as a token it is not. */
          let sym = '', name = '', img = '', mcap = 0;
          if (evm) {
            const r = await fetch('https://api.dexscreener.com/tokens/v1/' + chain + '/' + id.toLowerCase(),
              { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
            const arr = r.ok ? await r.json() : [];
            const best = (Array.isArray(arr) ? arr : []).sort((a, b) =>
              ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
            if (!best) return json({ ok: false, error: 'no pool for that contract' }, 404);
            sym = String((best.baseToken && best.baseToken.symbol) || '').slice(0, 12);
            name = String((best.baseToken && best.baseToken.name) || sym).slice(0, 48);
            img = (best.info && best.info.imageUrl) || '';
            mcap = Number(best.marketCap) || Number(best.fdv) || 0;
          } else {
            const t = await fetchCoin(id, ctx.env.IMG_SECRET);
            if (!t) return json({ ok: false, error: 'pump.fun has no token with that address' }, 404);
            /* fetchCoin signs the art and drops rawImg, so the proxy URL is what is left;
               the re-add path keeps a URL that already starts with /api/img? as is. */
            sym = t.sym; name = t.name; img = t.img || t.rawImg || ''; mcap = t.mcap;
          }

          const key = evm ? id.toLowerCase() : id;
          const all = await readBoosts();
          /* Size as the face will print it (×1.5 … ×6), or a spend for the
             older form. Duration in hours; 0 is until removed. */
          const size = Number(body.size);
          const usd = size > 1
            ? Math.max(1, Math.round(spendForBonus(size - 1) * 100) / 100)
            : Math.max(1, Math.min(10_000, Number(body.usd) || 400));
          const hours = Math.max(0, Math.min(24 * 365, Number(body.hours) || 0));
          const next = all.filter(b => b.mint !== key);
          next.push({
            mint: key, sym, name, img, mcap,
            ...(evm ? { chain } : {}),
            usd, spentUsd: usd, tier: 'house', mult: 0, size: size > 1 ? size : 0,
            at: Date.now(), until: hours ? Date.now() + hours * 36e5 : Date.now() + 100 * 365 * 864e5,
            house: true,
          });
          await ctx.store.put('boosts', next);
          return json({ ok: true, sym });
        }

        /* The official token. Identity comes from pump.fun, never from the
           form, so the strip cannot be made to name a mint as something it is
           not; and there is exactly one, because a page naming two "official"
           addresses has said nothing. */
        if (action === 'token.set') {
          const mint = String(body.mint || '').trim();
          if (!isMint(mint)) return json({ ok: false, error: 'not a mint' }, 400);
          const t = await fetchCoin(mint, ctx.env.IMG_SECRET);
          if (!t) return json({ ok: false, error: 'pump.fun has no token with that address' }, 404);
          await ctx.store.put('ourtoken', { mint, sym: t.sym, name: t.name, at: Date.now() });
          return json({ ok: true, sym: t.sym });
        }
        if (action === 'token.clear') {
          await ctx.store.put('ourtoken', null);
          return json({ ok: true });
        }

        /* Hidden from the map: off every tab, the rail and the share cards.
           Named from the chain where possible so the list says what it is. */
        if (action === 'hide.add') {
          const id = String(body.ca || '').trim();
          if (!isCA(id)) return json({ ok: false, error: 'not a contract address' }, 400);
          const key = /^0x/i.test(id) ? id.toLowerCase() : id;
          let sym = '';
          try { const r = await resolveAnyToken(id, ctx.env.IMG_SECRET); sym = (r && r.sym) || ''; } catch {}
          const list = ((await ctx.store.get('hidden')) || []).filter(h => h.key !== key);
          list.push({ key, sym, note: String(body.note || '').slice(0, 60), at: Date.now() });
          await ctx.store.put('hidden', list.slice(-500));
          hiddenCache.at = 0;
          return json({ ok: true, sym });
        }
        if (action === 'hide.remove') {
          const key = String(body.key || '');
          await ctx.store.put('hidden', ((await ctx.store.get('hidden')) || []).filter(h => h.key !== key));
          hiddenCache.at = 0;
          return json({ ok: true });
        }

        /* Tap wars, from the console. */
        if (action === 'tap.remove' || action === 'tap.reset') {
          if (!ctx.arena) return json({ ok: false, error: 'the arena is not running' }, 503);
          const r = await ctx.arena(action === 'tap.remove' ? 'remove' : 'reset', { key: String(body.key || '') });
          arenaCache.at = 0; cacheFor('taps').at = 0;
          return json(r, r.ok ? 200 : 400);
        }
        if (action === 'tap.config') {
          if (!ctx.arena) return json({ ok: false, error: 'the arena is not running' }, 503);
          const r = await ctx.arena('config', { cfg: { idleHours: body.idleHours } });
          arenaCache.at = 0;
          return json(r, r.ok ? 200 : 400);
        }

        if (action === 'boost.remove') {
          const mint = String(body.mint || '').trim();
          const all = await readBoosts();
          await ctx.store.put('boosts', all.filter(b => b.mint !== mint));
          return json({ ok: true });
        }

        if (action === 'seed.add' || action === 'seed.remove') {
          const chain = String(body.chain || '');
          const addr = String(body.addr || '').trim().toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(addr)) return json({ ok: false, error: 'not an address' }, 400);
          if (chain !== 'base' && chain !== 'robinhood') {
            return json({ ok: false, error: 'unknown chain' }, 400);
          }
          if (action === 'seed.add') {
            const r = chain === 'base' ? await baseSeed(ctx.store, [addr])
                                       : await rhSeed(ctx.store, [addr]);
            return json({ ok: true, ...r });
          }
          if (chain === 'base') {
            const c = await baseCache(ctx.store);
            await ctx.store.put('basechain', { ...c, seeds: (c.seeds || []).filter(a => a !== addr) });
          } else {
            const r = await rhRegistry(ctx.store);
            await ctx.store.put('rhchain', { ...r, seeds: (r.seeds || []).filter(a => a !== addr) });
          }
          return json({ ok: true });
        }

        /* The bot, from the console: full status, and a broadcast that goes
           only to people who opted in. `dry` counts recipients without sending,
           which is the button to press first. */
        if (action === 'tg.status') {
          return json({ ok: true, tg: await tgStatus(ctx.env, ctx.store) });
        }
        /* The mass DM (src/audience.mjs). `dm.status` also carries anyone the
           old KV opt-in list had, once, so nobody who opted in before is lost. */
        if (action === 'dm.status') {
          if (!ctx.audience) return json({ ok: false, error: 'the audience object is not deployed yet' }, 503);
          let st = await ctx.audience('status');
          if (!st.count) {
            let ids = [];
            try { ids = (await ctx.store.get('tg:users')) || []; } catch {}
            for (const id of ids.slice(0, 5000)) await ctx.audience('add', { id, src: 'optin' }).catch(() => null);
            if (ids.length) st = await ctx.audience('status');
          }
          const reviews = ((await ctx.store.get('dmads')) || []).filter(a => a.status === 'review' || a.status === 'sent' || a.status === 'rejected').slice(-20);
          return json({ ok: true, count: st.count || 0, job: st.job || null, reviews });
        }
        /* who is on the DM list: the newest first, or every record a page at a time */
        if (action === 'dm.list') {
          if (!ctx.audience) return json({ ok: false, error: 'the audience object is not deployed yet' }, 503);
          return json(await ctx.audience('list', { after: String(body.after || ''), limit: Math.min(200, Math.max(1, +body.limit || 100)), newest: !!body.newest }));
        }
        /* one message to one person before the list gets it: the same HTML,
           button and Unsubscribe the send would carry */
        if (action === 'dm.test') {
          if (!tgEnabled(ctx.env)) return json({ ok: false, error: 'bot is not configured' }, 400);
          const id = Math.floor(+body.id);
          if (!(id > 0)) return json({ ok: false, error: 'put a Telegram user id — the number in the list — in the test box' }, 400);
          const html = String(body.text || '').slice(0, 3500);
          if (!html.trim()) return json({ ok: false, error: 'write the message first' }, 400);
          const bt = String(body.buttonText || '').trim().slice(0, 40), bu = String(body.buttonUrl || '').trim();
          const buttons = bt && /^https:\/\/[^\s"'<>]{4,300}$/i.test(bu) ? [[{ text: bt, url: bu }]] : [];
          const r = await tgSendDm(ctx.env, id, html, buttons);
          return r === 'ok' ? json({ ok: true })
            : json({ ok: false, error: r === 'gone' ? 'that person has not pressed Start or has blocked the bot' : 'Telegram refused the message — check the HTML tags' }, 400);
        }
        /* every group the bot is in, set up or not, and the ones it left */
        if (action === 'tg.groups') {
          if (!tgEnabled(ctx.env)) return json({ ok: false, error: 'bot is not configured' }, 400);
          return json({ ok: true, groups: await tgGroups(ctx, { fresh: !!body.fresh }) });
        }
        if (action === 'dm.send') {
          if (!ctx.audience) return json({ ok: false, error: 'the audience object is not deployed yet' }, 503);
          const html = String(body.text || '').slice(0, 3500);
          const bt = String(body.buttonText || '').trim().slice(0, 40), bu = String(body.buttonUrl || '').trim();
          const buttons = bt && /^https:\/\/[^\s"'<>]{4,300}$/i.test(bu) ? [[{ text: bt, url: bu }]] : [];
          return json(await ctx.audience('start', { html, buttons, label: 'console' }));
        }
        /* the public smart-money channel the tracker posts top traders' buys to */
        if (action === 'tg.channel') {
          if (!tgEnabled(ctx.env)) return json({ ok: false, error: 'bot is not configured' }, 400);
          const r = await tgSetChannel(ctx.env, ctx.store, String(body.channel || ''));
          if (r.ok && ctx.audience) { try { await tgEnsureAudience(ctx); } catch {} }
          return json(r, r.ok ? 200 : 400);
        }
        if (action === 'dm.cancel') {
          if (!ctx.audience) return json({ ok: false, error: 'the audience object is not deployed yet' }, 503);
          return json(await ctx.audience('cancel'));
        }
        if (action === 'dm.approve' || action === 'dm.reject') {
          const list = (await ctx.store.get('dmads')) || [];
          const ad = list.find(a => a.id === String(body.id || ''));
          if (!ad || ad.status !== 'review') return json({ ok: false, error: 'no paid DM waiting with that id' }, 404);
          if (action === 'dm.reject') {
            ad.status = 'rejected'; ad.decidedAt = Date.now();
            await ctx.store.put('dmads', list);
            return json({ ok: true, ad });
          }
          if (!ctx.audience) return json({ ok: false, error: 'the audience object is not deployed yet' }, 503);
          const evm = isEvmAddr(ad.mint);
          const g = evm ? { chain: ad.chain, token: ad.mint, sym: String(ad.title || '').replace(/^\$/, '') } : { chain: 'solana', mint: ad.mint, sym: String(ad.title || '').replace(/^\$/, '') };
          const { html, buttons } = sponsoredDm(ad, tgTokenLinks(ctx.env, g));
          const r = await ctx.audience('start', { html, buttons, label: 'sponsored ' + ad.title });
          if (!r.ok) return json(r, 409);
          ad.status = 'sent'; ad.decidedAt = Date.now(); ad.jobId = r.job.id;
          await ctx.store.put('dmads', list);
          return json({ ok: true, ad, job: r.job });
        }
        if (action === 'tg.broadcast') {
          if (!tgEnabled(ctx.env)) return json({ ok: false, error: 'bot is not configured' }, 400);
          const r = await tgBroadcast(ctx.env, ctx.store, {
            audience: String(body.audience || ''),
            text: String(body.text || '').slice(0, 3500),
            after: Math.max(0, Number(body.after) || 0),
            dry: body.dry !== false,
          });
          return json(r, r.ok ? 200 : 400);
        }

        return json({ ok: false, error: 'unknown action' }, 400);
      }
    }

    /* Called by cron. Aggregates DefiLlama's DEX and fee overviews down to a
       few KB; the raw responses are ~6MB together and have no business inside a
       map build. See src/flows.mjs. */
    if (path === '/api/flows/refresh') {
      try {
        return json({ ok: true, ...(await refreshFlows(ctx.store)) });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
      }
    }

    /* Called by cron. Refreshes the Base token list at most once a day and
       prices one slice of it; see src/basechain.mjs. */
    /* Called by cron. Reads one slice of casino hot wallets and prices it with
       the majors feed; every wallet is refreshed within ~20 minutes. See
       src/casinos.mjs and the registry in src/casinowallets.mjs. */
    if (path === '/api/casinos/sweep') {
      try {
        const prices = {};
        try {
          const m = await snapshot(ctx, 'majors');
          for (const t of (m && m.tokens) || []) {
            if (['ETH', 'SOL', 'TRX', 'BNB', 'POL', 'MATIC'].includes(t.sym) && t.price > 0 && prices[t.sym] == null) prices[t.sym] = t.price;
          }
          if (!prices.POL && prices.MATIC) prices.POL = prices.MATIC;
        } catch { /* a wallet priced at nothing is visible as such */ }
        const r = await sweepCasinos(ctx.store, ctx.env, prices);
        return json({ ok: true, ...r, priced: Object.keys(prices) });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
      }
    }

    /* What the sweep has: per-casino totals, wallet counts, ages. Public, no
       addresses — the registry is in the repo for anyone who wants them. */
    if (path === '/api/casinos/hot') {
      const blob = await loadCasinoHot(ctx.store);
      if (!blob) return json({ ok: true, at: 0, casinos: [] });
      const { by, oldest } = casinoTotals(blob);
      const casinos = Object.entries(by).map(([name, c]) => ({
        name, usd: Math.round(c.usd), wallets: c.wallets, read: c.read, chains: c.chains,
      })).sort((a, b) => b.usd - a.usd);
      return json({ ok: true, at: blob.at || 0, oldestRead: oldest, hist: (blob.hist || []).length, casinos });
    }

    if (path === '/api/base/sweep') {
      try {
        const uni = await refreshUniverse(ctx.store);
        const swept = await baseSweep(ctx.store);
        return json({ ok: true, ...uni, ...swept });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
      }
    }

    /* Called by cron. Widens the Robinhood Chain registry by one tick's worth;
       see src/rhchain.mjs for why the list has to be accumulated at all. */
    if (path === '/api/robinhood/discover') {
      try {
        return json({ ok: true, ...(await discover(ctx.store)) });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
      }
    }

    /* Called by cron. Rebuilds every majors long-window in one pass, at most
       once a day; see src/cryptowin.mjs for why this one needs no warm-up. */
    if (path === '/api/majors/windows') {
      try {
        const snap = await snapshot(ctx, sourceOf('majors'));
        const syms = (snap.tokens || []).map(t => t.sym).filter(Boolean);
        /* the Compute tab's tokens too, most of them outside the top 250 and
           so outside cgmap — their CoinGecko ids come from src/compute.mjs */
        let ids = {};
        try { ids = computeCgIds((await snapshot(ctx, sourceOf('compute'))).tokens); } catch { /* next day */ }
        const all = [...new Set([...syms, ...Object.keys(ids)])];
        return json({ ok: true, ...(await refreshCryptoWin(ctx.store, all, false, ids)) });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
      }
    }

    /* Whether the X poster is live, and what it has done. Booleans and
       timestamps only — never the credentials, and never the account. */
    /* What the poster would say if it ran right now, without posting it.
       The content has to be judgeable before anybody hands it credentials. */
    if (path === '/api/xbot/preview') {
      const limited = rateLimit(req, 'xpreview', 20, 60_000);
      if (limited) return limited;
      const feed = async (src) => {
        try { return (await snapshot(ctx, sourceOf(src))).tokens || []; } catch { return []; }
      };
      const [pumpfun, majors, stocks] = await Promise.all(
        [feed('pumpfun'), feed('majors'), feed('stocks')]);
      const st = (await ctx.store.get(XBOT_KEY)) || { recent: {} };
      const post = buildPost({ pumpfun, majors, stocks }, ctx.env, st, Date.now(), url.origin);
      if (!post) return json({ ok: true, would: null, why: 'nothing worth posting' });
      return json({
        ok: true,
        would: { kind: post.kind, text: post.text, chars: post.text.length,
                 card: url.origin + post.share },
      });
    }

    /* ------------------------------------------------------- Telegram buybot
       Both webhooks answer 200 quickly and do the work inside waitUntil where
       one exists: Telegram retries a slow webhook and Helius counts one, and a
       retried buy is a duplicate alert. Neither route exists at all without the
       bot token, so an unconfigured deployment 404s here like any unknown path. */
    if (path === '/tg/webhook' || path === '/tg/trade') {
      if (!tgEnabled(ctx.env)) return null;
      if (req.method !== 'POST') return json({ ok: false }, 405);

      if (path === '/tg/webhook') {
        const given = req.headers.get('x-telegram-bot-api-secret-token') || '';
        if (given !== await tgWebhookSecret(ctx.env)) return json({ ok: false }, 401);
        let update = null;
        try { update = await req.json(); } catch { return json({ ok: true }); }
        ctx.solUsd = await solPriceNow(ctx).catch(() => 0);
        /* the bot buys through the same routes the site does: one order
           system, one inventory cap, one sweep. Rate limits key on the
           Telegram user, not on Telegram's servers. */
        ctx.self = (p, body, who = 'tg') => handle(new Request(url.origin + p, {
          method: body ? 'POST' : 'GET',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': 'tg-' + who },
          body: body ? JSON.stringify(body) : undefined,
        }), { ...ctx, fromBot: true }).then(r => r ? r.json() : null);
        const work = tgUpdate(ctx, update).catch(() => {});
        if (ctx.waitUntil) ctx.waitUntil(work); else await work;
        return json({ ok: true });
      }

      /* Helius sends the auth header we registered; a delivery without it is
         somebody else's POST. */
      const auth = req.headers.get('authorization') || '';
      if (!auth || auth !== await heliusAuth(ctx.env)) return json({ ok: false }, 401);
      let payload = null;
      try { payload = await req.json(); } catch { return json({ ok: true }); }
      const solUsd = await solPriceNow(ctx).catch(() => 0);
      /* the buys come from the Solana watcher unless SOL_BUYS=helius; a
         delivery is then only the wallet tracker's */
      const work = tgTrade(ctx, payload, solUsd, { buys: !solPolling(ctx.env) }).catch(() => {});
      if (ctx.waitUntil) ctx.waitUntil(work); else await work;
      return json({ ok: true });
    }

    /* Called from cron: registers the Telegram webhook once the token is set,
       so turning the bot on is one secret and nothing else. */
    if (path === '/api/tg/ensure') {
      try { return json({ ok: true, ...(await tgEnsure(ctx.env, ctx.store, ctx.audience || null)) }); }
      catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 502); }
    }

    /* How the polling objects are: alarm scheduled, writes working, last
       good read. Public, throttled and cached, nothing private in it — it
       exists because their free-plan failures are otherwise silent. */
    if (path === '/api/health/do') {
      const limitedH = rateLimit(req, 'dohealth', 20, 60_000);
      if (limitedH) return limitedH;
      if (doHealthMem.v && Date.now() - doHealthMem.at < 30_000) return json(doHealthMem.v);
      const ask = async (fn, ...a) => { try { return fn ? await fn(...a) : null; } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 160) }; } };
      const pick = d => d && { alarmInS: d.alarmInS, writeErr: d.writeErr || '', error: d.error || '',
        lastOkS: d.okAt ? Math.round((Date.now() - d.okAt) / 1000) : d.lastOk ? Math.round((Date.now() - d.lastOk) / 1000) : null,
        ticks: d.ticks ?? d.polls ?? null, lastError: String(d.lastError || d.err || '').slice(0, 120) };
      const [sol, callers, insiders] = await Promise.all([
        ask(ctx.sol, 'diag'), ask(ctx.callers, 'diag'), ask(ctx.insiders, 'diag'),
      ]);
      doHealthMem = { at: Date.now(), v: { ok: true, sol: pick(sol), callers: pick(callers), insiders: pick(insiders) } };
      return json(doHealthMem.v);
    }

    /* One person's trades for the Insiders tab: everything the watcher holds
       for them. The key is the table's own (source and name), checked here. */
    if (path === '/api/insiders/person') {
      const limitedP = rateLimit(req, 'inperson', 60, 60_000);
      if (limitedP) return limitedP;
      const key = String(url.searchParams.get('key') || '');
      if (!/^(congress|whitehouse|ceo):[^<>"\u0000-\u001f]{1,90}$/.test(key)) return json({ ok: false, error: 'bad key' }, 400);
      if (!ctx.insiders) return json({ ok: false, error: 'not configured' }, 503);
      try {
        const d = await ctx.insiders('person', { key });
        return json({ ok: true, rows: (d && d.rows) || [] }, 200, { 'cache-control': 'public, max-age=120' });
      } catch { return json({ ok: false, error: 'unavailable' }, 502); }
    }

    if (path === '/api/tg/status') {
      /* Public, so throttled and cached: every uncached call asks Telegram,
         asks Helius (billed in credits) and wakes three chain watchers. */
      const limitedS = rateLimit(req, 'tgstatus', 30, 60_000);
      if (limitedS) return limitedS;
      if (tgStatusMem.v && Date.now() - tgStatusMem.at < 60_000) return json(tgStatusMem.v);
      const st = await tgStatus(ctx.env, ctx.store).catch(e => ({ enabled: tgEnabled(ctx.env), error: String(e.message) }));
      /* Public: counts and whether it is on, never ids, never tokens. */
      /* each EVM watcher: how many tokens, when it last read the chain, its
         last error — never which groups */
      const evm = {};
      if (ctx.evm && st.enabled) {
        for (const chain of ['base', 'ethereum', 'robinhood']) {
          const s = await ctx.evm(chain, 'status').catch(() => null);
          if (s && s.tokens) evm[chain] = { tokens: s.tokens, lastReadS: s.okAt ? Math.round((Date.now() - s.okAt) / 1000) : null,
            polls: s.polls, buys: s.buys, sent: s.sent, error: s.errAt && s.errAt > (s.okAt || 0) ? s.err : '' };
        }
      }
      /* the Solana watcher the same way: which free RPC it is getting, and
         its last error if that is newer than its last good read */
      let sol = null;
      if (ctx.sol && st.enabled && solPolling(ctx.env)) {
        const s = await ctx.sol('status').catch(() => null);
        if (s && s.ok) sol = { tokens: s.tokens || 0, lastReadS: s.okAt ? Math.round((Date.now() - s.okAt) / 1000) : null,
          rpc: s.rpc || '', polls: s.polls, txs: s.txs, buys: s.buys, sent: s.sent, skipped: s.skipped, listReadS: s.listAt ? Math.round((Date.now() - s.listAt) / 1000) : null,
          error: s.errAt && s.errAt > (s.okAt || 0) ? s.err : '',
          last: s.last || null, cursors: s.cursors || 0, endpoints: s.eps || {},
          warn: s.warnAt && Date.now() - s.warnAt < 600_000 ? s.warn : '' };
      }
      tgStatusMem = { at: Date.now(), v: { ok: true, enabled: !!st.enabled, groups: st.groups || 0, subscribers: st.subscribers || 0, mints: st.mints || 0, sol, evm,
        profile: st.profile ? { ok: st.profile.ok, photo: st.profile.photo } : null } };
      return json(tgStatusMem.v);
    }

    if (path === '/api/xbot/status') {
      const st = (await ctx.store.get(XBOT_KEY)) || {};
      return json({
        ok: true,
        configured: !!xCreds(ctx.env),
        postedToday: st.count || 0,
        lastPostAt: st.lastAt || 0,
        onCooldown: Object.keys(st.recent || {}).length,
      });
    }

    if (path === '/api/boost/sweep') {
      if (!ctx.env.SOLANA_RPC || !ctx.env.TREASURY_WALLET) {
        return json({ ok: false, error: 'payments are not configured' }, 503);
      }
      const limited = rateLimit(req, 'sweep', 20, 60_000);
      if (limited) return limited;

      const activated = await sweepPayments(ctx.store, ctx.env.SOLANA_RPC, ctx.env.TREASURY_WALLET,
        args => resolveReferral(ctx.store, args));
      /* a buyer who paid from the bot hears it there, tab or no tab */
      if (tgEnabled(ctx.env)) {
        for (const b of activated) if (b && b.notify) await tgNotifyPaid(ctx.env, b).catch(() => null);
      }
      const pending = await listPending(ctx.store);
      return json({
        ok: true,
        activated: activated.map(b => ({ sym: b.sym, mint: b.mint, tier: b.tier, sig: b.sig })),
        stillPending: pending.length,
      });
    }

    /* ----------------------------------------------------- /api/affiliate */
    /* An affiliate's own statement. Built from the same public boost ledger, so
       what they see and what anyone can audit cannot disagree — which is the
       only reason to trust a commission number you did not compute yourself.
       The code is not a secret: it is in every link they share. */
    if (path === '/api/affiliate') {
      const limited = rateLimit(req, 'affiliate', 60, 60_000);
      if (limited) return limited;

      const code = (url.searchParams.get('code') || '').toLowerCase();
      if (!isCode(code)) return json({ ok: false, error: 'bad code' }, 400);
      const st = await statement(ctx.store, code);
      if (!st) return json({ ok: false, error: 'unknown affiliate code' }, 404);
      return json({ ok: true, ...st });
    }

    /* ------------------------------------------------ /api/boost/history */
    /* Public ledger. Every boost ever sold, with the transaction that paid for
       it, so anyone can check on-chain that the gold on this map was bought and
       not handed out. Being auditable is the point — publish it. */
    if (path === '/api/boost/history') {
      const all = (await ctx.store.get('boosts')) || [];
      const now = Date.now();
      return json({
        ok: true,
        count: all.length,
        treasury: ctx.env.TREASURY_WALLET || null,
        boosts: all
          .slice(-200)
          .reverse()
          .map(b => ({
            sym: b.sym, mint: b.mint, tier: b.tier, mult: b.mult,
            usd: b.usd, sol: b.sol,
            sig: b.sig,
            explorer: 'https://solscan.io/tx/' + b.sig,
            startedAt: b.startedAt, until: b.until,
            active: b.until > now,
          })),
      });
    }

    /* ---------------------------------------------------------- /api/ads */
    /* House ads live in KV so a slot can be sold without a deploy. */
    if (path === '/api/ads') {
      const raw = (await ctx.store.get('ads')) || [];
      /* Ad art goes through the signed proxy for the same reason token art
         does: the page is served img-src 'self', so any upstream URL renders as
         a broken image. A sold slot showing no logo is worse than an empty one,
         because the empty slot is at least an advert for the inventory. */
      const ads = [];
      /* a slot whose time is up is simply not served */
      for (const a of raw.filter(a => !(a.until > 0 && a.until < Date.now()) && !(a.from > Date.now()))) {
        let img = a.img || '';
        if (img && ctx.env.IMG_SECRET && !img.startsWith('/api/img?')) {
          try {
            img = '/api/img?u=' + encodeURIComponent(img) +
                  '&s=' + await signUrl(img, ctx.env.IMG_SECRET);
          } catch { img = ''; }
        }
        ads.push({ ...a, img });
      }
      /* Slots won by taps fill whatever is not sold. Sold ads always come
         first: a free slot is what is left over, never what displaces a
         paying one. */
      try {
        const ar = await arenaState(ctx);
        const open = Math.max(0, Math.min(TAP_AD_SLOTS, 4 - ads.length));
        for (const r of ((ar && ar.ad) || []).slice(0, open)) {
          ads.push({ title: r.sym, sub: fmtTaps(r.taps) + ' taps · won free', img: r.img || '', url: tapUrl(r), tap: true });
        }
      } catch { /* the rail without them */ }
      /* The site's own token rides along: the header strip that names the
         official contract address reads it here, so the one fetch the rail
         already makes also carries the one address visitors must not get
         wrong. Only the fields the strip prints leave the record. */
      let token = null;
      try {
        const o = await ctx.store.get('ourtoken');
        if (o && isMint(String(o.mint || ''))) {
          token = { mint: String(o.mint), sym: clean(String(o.sym || ''), 12), name: clean(String(o.name || ''), 48) };
        }
      } catch { token = null; }
      return json({ ok: true, ads, contact: ctx.env.AD_CONTACT || '', token, fill: await railFill(ctx) });
    }

    /* ------------------------------------------------------- /api/health */
    if (path === '/api/health') {
      dexStatus.memSize = _dexMemForTests().size;
      return json({
        ok: true,
        cachedAt: cacheFor('graduated').at,
        cachedTokens: cacheFor('graduated').data?.count || 0,
        lastError: cacheFor('graduated').err,
        modes: [...caches.keys()],
        treasury: !!ctx.env.TREASURY_WALLET,
        rpc: !!ctx.env.SOLANA_RPC,
        kv: !!ctx.store.available,
        imgSecret: !!ctx.env.IMG_SECRET,
        /* the one line that answers "why is nobody able to buy a boost?" */
        boostsOpen: !!(ctx.env.TREASURY_WALLET && ctx.env.SOLANA_RPC && ctx.store.available),
        dex: dexStatus,
      });
    }

    return null;   // not an API route — the adapter serves static files
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 502);
  }
}
