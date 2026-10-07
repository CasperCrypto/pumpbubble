/* ==========================================================================
   pumpbubble.fun — the Compute tab

   Two things on one tab: what an hour of a GPU costs right now, and the
   companies and tokens that sell compute, as bubbles.

   Asked for on 2026-10-07, two days after CME listed the first regulated
   compute futures (H100 and B200 rental indexes, a month of one GPU per
   contract). The contracts themselves barely trade yet — Kalshi's GPU markets
   and Hyperliquid's H100 perp showed no volume that day — while the trades
   around them do, so the tab shows the price of the thing and the market
   around it.

   **Where a GPU price may come from is the hard part, and it is a question of
   terms, not of what answers.** Read on 2026-10-07, all of these answered a
   keyless request and most of them may not be used here:

   - Vast.ai's terms forbid its prices as an input to "any index, benchmark,
     pricing index, price-comparison database" — which is this board.
   - RunPod's terms forbid access "through automated or non-human means".
   - Ornn's index (the one ICE's futures will settle on) has a free, keyless
     tier, and its terms forbid displaying even that publicly without a
     signed agreement. Worth asking for: the benchmark, on a free map.
   - Open datasets that aggregate the clouds (gpurentalprices.com, 22
     providers, daily) are CC BY 4.0 — usable, with a visible credit, which
     the operator does not want on the main UI (see docs/sources.md).

   So the board reads **Akash**, the decentralized compute market: its prices
   are its providers' own bids on a public chain, weighted by GPUs on offer,
   served keyless by its open-source console, with no reuse restriction found.
   Akash's H100 read $2.72 the day this was built, beside Ornn's $2.79 — an
   open market's price, which is what a crypto map should show anyway: the
   tokens of these networks are the bubbles under it.

   `boardRow` takes any number of providers and shows the middle typical
   price, so a second market slots in beside Akash without a new shape.
   Nothing is filled in: a model no market prices is left off the board.
   ========================================================================== */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) pumpbubble.fun/1.0';
const AKASH = 'https://console-api.akash.network/v1/gpu-prices';

const HOUR = 3600e3, DAY = 24 * HOUR;
export const HIST_KEY = 'gpu:hist';

/* The board, in the order a buyer thinks of them: the benchmark first (H100
   is what CME's first contract settles on), then up and down the range.
   Akash's model names, read off its live answer. */
export const GPUS = [
  { id: 'h100', label: 'H100', akash: [['h100', 'SXM5']] },
  { id: 'b200', label: 'B200', akash: [['b200']] },
  { id: 'b300', label: 'B300', akash: [['b300']] },
  { id: 'h200', label: 'H200', akash: [['h200']] },
  { id: 'a100', label: 'A100', akash: [['a100', 'SXM4', '80Gi']] },
  { id: 'pro6000', label: 'RTX PRO 6000', akash: [['pro6000se'], ['pro6000we']] },
  { id: 'rtx5090', label: 'RTX 5090', akash: [['rtx5090']] },
  { id: 'rtx4090', label: 'RTX 4090', akash: [['rtx4090']] },
];

/* A price per GPU-hour that could be real: zero and absurd are dropped
   rather than averaged in. */
const sane = p => Number.isFinite(p) && p >= 0.05 && p <= 60;
const cents = p => (p == null || !Number.isFinite(p) ? null : Math.round(p * 100) / 100);
const tenth = p => (p == null || !Number.isFinite(p) ? null : Math.round(p * 10) / 10);

export function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* ------------------------------------------------------------- quotes */
export function akashQuote(models, gpu) {
  const want = gpu.akash || [];
  const rows = (Array.isArray(models) ? models : []).filter(m => m && want.some(([model, iface, ram]) =>
    String(m.model || '').toLowerCase() === model
    && (!iface || String(m.interface || '') === iface)
    && (!ram || String(m.ram || '') === ram)));
  if (!rows.length) return null;
  let avail = 0, total = 0;
  for (const m of rows) {
    avail += +(m.availability && m.availability.available) || 0;
    total += +(m.availability && m.availability.total) || 0;
  }
  const typ = rows.map(m => +(m.price && m.price.weightedAverage)).filter(sane);
  /* the cheapest bid counts as "from" only while a GPU is actually free */
  const low = avail > 0 ? rows.map(m => +(m.price && m.price.min)).filter(sane) : [];
  if (!typ.length && !low.length) return null;
  return { p: 'akash', typical: typ.length ? Math.min(...typ) : null, from: low.length ? Math.min(...low) : null, avail, total };
}

/* One GPU model across markets: the middle typical price, and the cheapest
   price anyone quoted — a market's own typical price is rentable too, so it
   counts toward "from". */
export function boardRow(gpu, quotes) {
  const q = (quotes || []).filter(Boolean);
  const typ = q.map(x => x.typical).filter(sane);
  const low = [...typ, ...q.map(x => x.from).filter(sane)];
  return {
    id: gpu.id, label: gpu.label,
    price: cents(median(typ)),
    from: low.length ? cents(Math.min(...low)) : null,
    providers: typ.length,
    quotes: q.map(x => ({
      p: x.p, typical: cents(x.typical), from: cents(x.from),
      ...(x.total ? { avail: x.avail, total: x.total } : {}),
    })),
  };
}

/* ------------------------------------------------------------ history */
/* One point an hour, eight days kept: enough for a day's and a week's move.
   A change is measured against the newest point at least that old and not
   much older; without one it is null, never zero — a board that has run for
   an hour does not get to claim a daily move. */
export function pushHist(hist, rows, now = Date.now()) {
  const pts = Array.isArray(hist && hist.pts) ? hist.pts : [];
  const last = pts[pts.length - 1];
  if (last && now - last.t < 55 * 60e3) return null;
  const p = {};
  for (const r of rows || []) if (r && r.price != null) p[r.id] = r.price;
  if (!Object.keys(p).length) return null;
  return { pts: [...pts.filter(x => x && now - x.t <= 8 * DAY), { t: now, p }] };
}

export function changeSince(hist, id, ms, price, now = Date.now()) {
  if (!(price > 0)) return null;
  const slack = Math.max(3 * HOUR, ms * 0.15);
  let best = null;
  for (const x of (hist && hist.pts) || []) {
    const age = now - x.t;
    if (age < ms || age > ms + slack || !(x.p && x.p[id] > 0)) continue;
    if (!best || x.t > best.t) best = x;
  }
  return best ? ((price - best.p[id]) / best.p[id]) * 100 : null;
}

/* ------------------------------------------------------------- fetching */
const host = u => { try { return new URL(u).host; } catch { return 'upstream'; } };

async function getJson(url, init = {}, ms = 9000) {
  const r = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', 'user-agent': UA, ...(init.headers || {}) },
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(host(url) + ' ' + r.status);
  return r.json();
}

export async function fetchAkash() {
  const j = await getJson(AKASH);
  if (!j || !Array.isArray(j.models)) throw new Error('akash: no models');
  return j.models;
}

/* The board: each market read (one today), a failing one reported by name
   with its prices simply absent; then the day's and week's move from our own
   hourly history in KV — one write an hour. Models no market prices are left
   off rather than shown as dashes in a row of cards. */
export async function gpuBoard({ store, now = Date.now(), fetchers = {} } = {}) {
  const f = { akash: fetchAkash, ...fetchers };
  const errors = {};
  const attempt = async (name, fn) => {
    try { return await fn(); } catch (e) { errors[name] = String((e && e.message) || e).slice(0, 120); return null; }
  };
  const ak = await attempt('akash', () => f.akash());

  const rows = GPUS.map(g => boardRow(g, [ak ? akashQuote(ak, g) : null])).filter(r => r.price != null);

  let hist = null;
  try { hist = store ? await store.get(HIST_KEY) : null; } catch { /* no history yet */ }
  for (const r of rows) {
    r.ch24 = tenth(changeSince(hist, r.id, DAY, r.price, now));
    r.ch7 = tenth(changeSince(hist, r.id, 7 * DAY, r.price, now));
  }
  const next = pushHist(hist, rows, now);
  if (next && store) { try { await store.put(HIST_KEY, next); } catch { /* next hour */ } }
  return { at: now, gpus: rows, errors };
}

/* --------------------------------------------------------------- bubbles */
/* Who sells compute, as bubbles beside the price board.

   Tokens by CoinPaprika id, never by ticker — "GPU" alone is two different
   coins on CoinPaprika and "IO" is a word. Logos from CoinGecko's image
   host, because CoinCap's icon set (the wider market's) lacks six of these
   and CoinPaprika's own logo host answers 403. */
const CGI = 'https://coin-images.coingecko.com/coins/images/';
export const COMPUTE_TOKENS = [
  { cp: 'tao-bittensor', cg: 'bittensor', img: CGI + '28452/large/ARUsPeNQ_400x400.jpeg' },
  { cp: 'icp-internet-computer', cg: 'internet-computer', img: CGI + '14495/large/Internet_Computer_logo.png' },
  { cp: 'rndr-render-token', cg: 'render-token', img: CGI + '11636/large/rndr.png' },
  { cp: 'theta-theta-token', cg: 'theta-token', img: CGI + '2538/large/theta-token-logo.png' },
  { cp: 'akt-akash-network', cg: 'akash-network', img: CGI + '12785/large/akash-logo.png' },
  { cp: 'ath14-aethir', cg: 'aethir', img: CGI + '36179/large/logogram_circle_dark_green_vb_green_%281%29.png' },
  { cp: 'aioz-aioz-network', cg: 'aioz-network', img: CGI + '14631/large/aioz-logo-200.png' },
  { cp: 'glm-golem', cg: 'golem', img: CGI + '542/large/Golem_Submark_Positive_RGB.png' },
  { cp: 'chip-usdai', cg: 'chip-2', img: CGI + '102171777/large/CHIP_Token_Logo_Large.png' },
  { cp: 'lpt-livepeer', cg: 'livepeer', img: CGI + '7137/large/badge-logo-circuit-green.png' },
  { cp: 'io-ionet', cg: 'io', img: CGI + '37754/large/io_blackbg.png' },
  { cp: 'zero-gravity-0g', cg: 'zero-gravity', img: CGI + '69096/large/0G_1024x1024_Circular_Outlined.png' },
  { cp: 'pha-phala-network', cg: 'pha', img: CGI + '12451/large/phala.png' },
  { cp: 'nos-nosana', cg: 'nosana', img: CGI + '22553/large/POfb_I4u_400x400.jpg' },
  { cp: 'rlc-iexec-rlc', cg: 'iexec-rlc', img: CGI + '646/large/pL1VuXm.png' },
  { cp: 'zel-zelcash', cg: 'zelcash', img: CGI + '5163/large/Flux_symbol_blue-white.png' },
  { cp: 'gaib-gaib', cg: 'gaib', img: CGI + '70737/large/gaib.png' },
];

/* Listed companies by what they sell: the chips, the memory, the boxes and
   networks around them, and the clouds and data centres that rent them out.
   The four that are hyperscalers first and compute sellers second (Microsoft,
   Alphabet, Amazon, Meta) are left out on purpose — they would make this the
   big-tech map. Oracle stays: its growth is GPU rental. */
export const COMPUTE_STOCKS = {
  chips: ['NVDA', 'TSM', 'AVGO', 'AMD', 'ASML', 'ARM', 'INTC', 'MRVL', 'AMAT', 'LRCX', 'KLAC', 'ALAB', 'CRDO'],
  memory: ['MU', 'SNDK', 'WDC', 'STX'],
  hardware: ['DELL', 'ANET', 'SMCI', 'HPE', 'VRT', 'CLS', 'LITE', 'COHR', 'CIEN'],
  clouds: ['ORCL', 'CRWV', 'NBIS', 'EQIX', 'DLR', 'IREN', 'HUT', 'GLXY', 'CIFR', 'WULF', 'APLD', 'CORZ'],
};

/* American depositary shares the screener's own rule drops (a depositary
   line can quote the parent's cap against a fraction of a share), admitted
   here by name because each is exactly one ordinary share. */
export const ADS_OK = new Set(['ARM']);

/* The symbol → CoinGecko id pairs the monthly and yearly windows need
   (src/cryptowin.mjs is keyed by CoinGecko id). */
export function computeCgIds(coins) {
  const bySym = {};
  const byCp = new Map((coins || []).map(c => [String(c.id || '').replace(/^cg:/, ''), c]));
  for (const t of COMPUTE_TOKENS) {
    const c = byCp.get(t.cp);
    if (c && c.sym) bySym[c.sym] = t.cg;
  }
  return bySym;
}

/* Rows for the map, from the wider market's parsed list and the screener's.
   Each is a copy — the lists are shared with the Crypto and Stocks tabs. */
export function pickCompute(coins, stocks) {
  const out = [];
  const byCp = new Map((coins || []).map(c => [String(c.id || '').replace(/^cg:/, ''), c]));
  for (const t of COMPUTE_TOKENS) {
    const c = byCp.get(t.cp);
    if (!c) continue;
    out.push({ ...c, pc: { ...c.pc }, rawImg: t.img || c.rawImg, grp: 'tokens' });
  }
  const bySym = new Map();
  for (const s of stocks || []) {
    if (!s || !s.sym || bySym.has(s.sym)) continue;
    if (s.untrusted && !ADS_OK.has(s.sym)) continue;
    bySym.set(s.sym, s);
  }
  for (const [grp, list] of Object.entries(COMPUTE_STOCKS)) {
    for (const sym of list) {
      const s = bySym.get(sym);
      if (!s) continue;
      const { untrusted, companyKey, ...row } = s;
      out.push({ ...row, pc: { ...row.pc }, grp });
    }
  }
  return out;
}
