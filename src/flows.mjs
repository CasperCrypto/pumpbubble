/* ==========================================================================
   pumpbubble.fun — chains and launchpads

   Two views that are not about individual tokens: where trading is happening
   across chains, and which launchpad is actually busy. Both are bubbles for the
   same reason the tokens are — the eye compares areas far faster than it reads
   a table of nine-digit numbers.

   **Size is what the thing does, not what it holds.** The obvious measure for a
   chain is TVL, and DefiLlama publishes it for 466 of them, but TVL is money
   parked rather than money moving. DEX volume is the flow. For launchpads TVL
   is worse than imperfect, it is wrong: a launchpad holds nothing, and
   DefiLlama duly reports pump.fun and Pons at $0 TVL. What a launchpad does is
   take fees, and those are published — Pons V2 at $5.2M in 24h against
   pump.fun's $1.4M is the real answer to which one is busy.

   So chains are sized by 24h DEX volume and launchpads by 24h fees, and neither
   number is invented: both are measured and published by DefiLlama, which is
   already the one aggregator that answers Cloudflare's egress reliably.

   The two source responses are 1.8MB and 4.1MB, far too much to pull into a map
   build, so a cron tick aggregates them down to a few KB in KV and the map reads
   that.
   ========================================================================== */

/* The project's own sanitiser. These names reach the page and the share
   card, and a hand-rolled copy of it here shipped a broken character class
   that took the whole module out of the build. */
import { clean } from './core.mjs';
import { hotCasinoRows } from './casinos.mjs';

const DEXS = 'https://api.llama.fi/overview/dexs'
  + '?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';
const FEES = 'https://api.llama.fi/overview/fees'
  + '?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';
/* The protocol list, for casino bankrolls. Large, so it rides the same
   twenty-minute cron tick as the other two. */
const PROTOS = 'https://api.llama.fi/protocols';

export const KEY = 'flows';

/* Neither figure moves fast enough to be worth six megabytes every five
   minutes. */
export const FRESH_MS = 20 * 60 * 1000;

const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
/* A change nobody reported is null, not zero. */
const pick = v => (v == null || !Number.isFinite(+v)) ? null : +v;
/* bsc -> BSC, off_chain -> Off Chain, robinhood -> Robinhood. */
const SHOUT = new Set(['bsc', 'bnb', 'eos', 'icp', 'iotex', 'xdc', 'zksync']);
const title = slug => String(slug || '').split(/[_\s-]+/)
  .filter(Boolean)
  .map(w => SHOUT.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))
  .join(' ');

async function jget(url, ms = 25000) {
  const r = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error('llama ' + r.status);
  return r.json();
}

/* Chains, from the per-chain breakdown each DEX reports.

   `breakdown24h` is {chain: {protocol: volume}}, which is the exact split —
   dividing a multi-chain protocol's total by how many chains it lists would
   credit Solana and a testnet equally. The colour is each protocol's own 1d
   change, weighted by what it actually did on that chain, so a chain's number
   is the volume-weighted move of the venues on it. */
function chainsFrom(dexs) {
  const vol = new Map();
  const wsum = new Map();
  const w7sum = new Map();

  for (const p of (dexs && dexs.protocols) || []) {
    const bd = p.breakdown24h;
    if (!bd || typeof bd !== 'object') continue;
    const ch = pick(p.change_1d);
    const ch7 = pick(p.change_7d);
    for (const [chain, byProto] of Object.entries(bd)) {
      let v = 0;
      for (const amt of Object.values(byProto || {})) v += num(amt);
      if (!(v > 0)) continue;
      vol.set(chain, (vol.get(chain) || 0) + v);
      if (ch != null) wsum.set(chain, (wsum.get(chain) || 0) + ch * v);
      if (ch7 != null) w7sum.set(chain, (w7sum.get(chain) || 0) + ch7 * v);
    }
  }

  const out = [];
  for (const [chain, v] of vol) {
    /* DefiLlama keys the breakdown by slug — "bsc", "off_chain" — which is not
       what anyone calls them. DefiLlama's own chain pages take the title-cased
       form, so this is both the label and the link. */
    const name = clean(title(chain), 32);
    if (!name || v <= 0) continue;
    const w = wsum.get(chain);
    const w7 = w7sum.get(chain);
    out.push({
      id: 'chain:' + name.toLowerCase(),
      sym: name,
      name: name + ' — 24h DEX volume',
      vol: v,
      change: w == null ? null : w / v,
      change7d: w7 == null ? null : w7 / v,
      /* No 7d *volume* for a chain: the overview breaks down by chain for 24h
         and 30d only, and slicing a protocol's global weekly total across the
         chains it happens to list would be a number we invented rather than one
         anybody published. The 7d *change* is weighted the same way the 1d is,
         so it is measured. */
      vol7d: null,
      /* Keyed by the original slug, not the title-cased label. */
      logo: 'https://icons.llamao.fi/icons/chains/rsz_'
        + encodeURIComponent(String(chain).toLowerCase()) + '?w=48&h=48',
    });
  }
  return out.sort((a, b) => b.vol - a.vol).slice(0, 60);
}

/* Launchpads, by what they earned in 24h.

   `change_1d` is the day against the day before. Where it is missing, today
   against the trailing weekly average says the same thing from data that is
   present — and stays null when neither exists rather than reporting a flat
   day nobody measured. */
/* A floor, because the tail here is not data.

   Fees span $6.75 to $5.2M across the sixty DefiLlama lists — a 774,000× range,
   with twenty-six of them under a thousand dollars. A contract that took $6.75
   yesterday is not competing with pump.fun and Pons, and putting it on the same
   map costs twice: it spends a bubble slot, and it stretches the log domain so
   the launchpads anyone is actually asking about all come out the same size.
   Above $1,000 the list is thirty-four venues spanning 3.7 decades, which is
   the same visual range the chains map has. */
const MIN_FEES = 1000;

/* "Rainbow Token Launchpad" on a tab called Launchpads is nineteen characters
   of label to say two of information, and it is what pushes these names past
   what fits inside a small bubble. */
const dropSuffix = n => n.replace(/\s+launchpads?$/i, '').trim() || n;

function padsFrom(fees) {
  const out = [];
  for (const p of (fees && fees.protocols) || []) {
    if (!/launchpad/i.test(p.category || '')) continue;
    const v = num(p.total24h);
    if (!(v >= MIN_FEES)) continue;

    let ch = pick(p.change_1d);
    if (ch == null) {
      const wk = num(p.total7d) / 7;
      if (wk > 0) ch = ((v - wk) / wk) * 100;
    }

    const name = dropSuffix(clean(p.displayName || p.name, 24));
    if (!name) continue;
    out.push({
      id: 'pad:' + (p.slug || name.toLowerCase()),
      sym: name,
      name: name + ' — 24h fees',
      vol: v,
      change: ch,
      change7d: pick(p.change_7d),
      vol7d: num(p.total7d) || null,
      logo: typeof p.logo === 'string' && /^https:\/\//.test(p.logo) ? p.logo : '',
      slug: p.slug || '',
    });
  }
  return out.sort((a, b) => b.vol - a.vol).slice(0, 60);
}

/* Prediction markets, by what was wagered in 24h.

   Kalshi at ~$420M a day and Polymarket at ~$150M is where the betting money
   actually is. Both sit in the `dexs` overview already fetched here; the house
   take comes from the `fees` overview by slug and rides along for the card.
   Sized by volume because that is how a betting venue's size is stated
   anywhere — handle, not revenue. Same $1,000 floor as launchpads. */
const MIN_BET_VOL = 1000;

function takeBySlug(fees, cats) {
  const take = new Map();
  for (const p of (fees && fees.protocols) || []) {
    if (!cats.test(p.category || '')) continue;
    const k = p.slug || (p.displayName || p.name || '').toLowerCase();
    take.set(k, { d1: num(p.total24h), d7: num(p.total7d) });
  }
  return take;
}

/* One brand, one bubble.

   DefiLlama lists Polymarket as three protocols — International (Polygon),
   US (the CFTC-regulated exchange), Combos — because they are three adapters.
   Drawn as three bubbles next to one Kalshi, each looked like a fifth of it
   when the brand is a third: $78M + $67M + $1M against $423M. That is the
   map misreading its own data. Rows whose name matches a brand here are
   summed into one, with the split kept for the card. The change is
   volume-weighted across the parts; the house take and week are summed.

   Kalshi's figure was checked independently before this was written: its
   public trade tape runs ~8,000 trades a minute, and extrapolating one
   minute of it gives ≈$428M a day against DefiLlama's $423M. The 2.9× gap
   to Polymarket is the same over 7d and 30d. It is real. */
const BRANDS = [
  { name: 'Polymarket', test: /^Polymarket(\s|$)/i, slug: 'polymarket' },
];

function predictionFrom(dexs, fees) {
  const CAT = /prediction market/i;
  const take = takeBySlug(fees, CAT);
  const rows = [];
  for (const p of (dexs && dexs.protocols) || []) {
    if (!CAT.test(p.category || '')) continue;
    const v = num(p.total24h);
    if (!(v > 0)) continue;
    const name = clean(p.displayName || p.name, 28);
    if (!name) continue;
    const k = p.slug || name.toLowerCase();
    const t = take.get(k) || null;
    rows.push({
      id: 'pm:' + k,
      sym: name,
      name: name + ' — 24h volume',
      vol: v,
      vol7d: num(p.total7d) || null,
      change: pick(p.change_1d),
      change7d: pick(p.change_7d),
      fees24h: t ? t.d1 : null,
      fees7d: t ? t.d7 : null,
      chains: (p.chains || []).slice(0, 4).map(c => clean(String(c), 20)).filter(Boolean),
      logo: typeof p.logo === 'string' && /^https:\/\//.test(p.logo) ? p.logo : '',
      slug: p.slug || '',
    });
  }

  const out = [];
  for (const b of BRANDS) {
    const parts = rows.filter(r => b.test.test(r.sym));
    if (parts.length < 2) continue;
    const vol = parts.reduce((s, r) => s + r.vol, 0);
    const w = key => {
      let num_ = 0, den = 0;
      for (const r of parts) if (r[key] != null) { num_ += r[key] * r.vol; den += r.vol; }
      return den > 0 ? num_ / den : null;
    };
    const sum = key => parts.some(r => r[key] != null) ? parts.reduce((s, r) => s + (r[key] || 0), 0) : null;
    out.push({
      id: 'pm:' + b.slug,
      sym: b.name,
      name: b.name + ' — 24h volume',
      vol,
      vol7d: sum('vol7d'),
      change: w('change'),
      change7d: w('change7d'),
      fees24h: sum('fees24h'),
      fees7d: sum('fees7d'),
      chains: [...new Set(parts.flatMap(r => r.chains))].slice(0, 4),
      logo: (parts.find(r => r.logo) || {}).logo || '',
      slug: b.slug,
      /* the split, largest first, for the card */
      parts: parts.sort((a, c) => c.vol - a.vol).map(r => ({
        name: r.sym.replace(b.test, '').trim() || r.sym, vol: r.vol,
      })),
    });
    for (const r of parts) r.merged = true;
  }
  for (const r of rows) if (!r.merged) out.push(r);

  return out.filter(r => r.vol >= MIN_BET_VOL).sort((a, b) => b.vol - a.vol).slice(0, 60);
}

/* On-chain casinos, by bankroll.

   This tab was asked for as "Stake, Shuffle, BC.Game". None of those can go on
   it, and the reason is worth keeping: they are off-chain companies that
   accept crypto, and they publish nothing. Not in DefiLlama under any name
   (the one "Stake" match is Binance's staked ETH), no volume, no fees. The
   only proxies are paid — labelled hot-wallet flows or web traffic — and a map
   of casino *tokens* would omit Stake, which has none and is the largest. A
   map missing its biggest player by construction lies by omission.

   What DefiLlama does list is 38 on-chain casinos ("Luck Games"), and this is
   the one flow view sized by what a venue *holds* rather than what it does.
   Deliberately: a volume adapter exists for five of the 38, so sizing by
   volume draws five bubbles and calls it a market, while every one of them
   publishes its bankroll — and bankroll is how the casino industry itself
   states size, because it is what the house can pay out. Volume and the house
   take ride along in the card where an adapter exists, and are a dash where
   not. Yield lotteries (PoolTogether, Ample) are excluded: a no-loss lottery
   is not a casino and would have taken the top three slots.

   Colour is the bankroll's own 1d / 7d change, from the same list. */
const MIN_BANKROLL = 1000;

function casinosFrom(protos, dexs, fees) {
  const CAT = /^luck games$/i;
  const vol = new Map();
  for (const p of (dexs && dexs.protocols) || []) {
    if (p.slug) vol.set(p.slug, { d1: num(p.total24h), d7: num(p.total7d) });
  }
  const take = takeBySlug(fees, CAT);
  const out = [];
  for (const p of Array.isArray(protos) ? protos : []) {
    if (!CAT.test(p.category || '')) continue;
    const tvl = num(p.tvl);
    if (!(tvl >= MIN_BANKROLL)) continue;
    const name = clean(p.name, 28);
    if (!name) continue;
    const k = p.slug || name.toLowerCase();
    const v = vol.get(k) || null, t = take.get(k) || null;
    out.push({
      id: 'casino:' + k,
      sym: name,
      name: name + ' — bankroll',
      vol: tvl,
      vol7d: null,
      wagered24h: v ? v.d1 : null,
      change: pick(p.change_1d),
      change7d: pick(p.change_7d),
      fees24h: t ? t.d1 : null,
      fees7d: t ? t.d7 : null,
      chains: (p.chains || []).slice(0, 4).map(c => clean(String(c), 20)).filter(Boolean),
      logo: typeof p.logo === 'string' && /^https:\/\//.test(p.logo) ? p.logo : '',
      slug: p.slug || '',
    });
  }
  return out.sort((a, b) => b.vol - a.vol).slice(0, 60);
}

export async function loadFlows(store) {
  try { return (await store.get(KEY)) || null; } catch { return null; }
}

/* Called from cron. Returns counts so a scheduled run says what it did. */
export async function refreshFlows(store, force = false) {
  const have = await loadFlows(store);
  if (!force && have && (Date.now() - (have.at || 0)) < FRESH_MS) {
    return {
      cached: true,
      chains: (have.chains || []).length, pads: (have.pads || []).length,
      prediction: (have.prediction || []).length, casinos: (have.casinos || []).length,
    };
  }

  const [dexs, fees, protos] = await Promise.allSettled([jget(DEXS), jget(FEES), jget(PROTOS, 40000)]);
  const D = dexs.status === 'fulfilled' ? dexs.value : null;
  const F = fees.status === 'fulfilled' ? fees.value : null;
  const P = protos.status === 'fulfilled' ? protos.value : null;

  const chains = D ? chainsFrom(D) : [];
  const pads = F ? padsFrom(F) : [];
  /* Prediction needs the dexs side; casinos need the protocol list. The fees
     side only decorates either. */
  const prediction = D ? predictionFrom(D, F) : [];
  const casinos = P ? casinosFrom(P, D, F) : [];

  /* Half an answer must not overwrite a whole one: if a side came back empty
     and we already had it, keep what we had. */
  const keep = (fresh, name) => fresh.length ? fresh : ((have && have[name]) || []);
  const next = {
    at: Date.now(),
    chains: keep(chains, 'chains'),
    pads: keep(pads, 'pads'),
    prediction: keep(prediction, 'prediction'),
    casinos: keep(casinos, 'casinos'),
  };
  if (!next.chains.length && !next.pads.length && !next.prediction.length && !next.casinos.length) {
    return { chains: 0, pads: 0, prediction: 0, casinos: 0, error: 'every upstream empty' };
  }

  try { await store.put(KEY, next); } catch { /* next tick retries */ }
  return {
    chains: next.chains.length, pads: next.pads.length,
    prediction: next.prediction.length, casinos: next.casinos.length,
    dexs: dexs.status, fees: fees.status, protos: protos.status,
  };
}

/* Shape either list as map tokens. Size comes from `vol`, which is DEX volume
   for a chain and fees for a launchpad — different units in different views,
   never mixed inside one. */
function shape(rows, kind) {
  return (rows || []).map(r => ({
    id: r.id,
    mint: '',
    addr: '',
    sym: r.sym,
    name: r.name,
    rawImg: r.logo || '',
    img: '',
    /* `mcap` is what sizes a bubble everywhere else on the map, so the measure
       goes there rather than teaching the renderer a second field. */
    mcap: r.vol,
    vol: r.vol,
    ath: 0,
    liq: 0,
    price: 0,
    kind,
    slug: r.slug || '',
    vol7d: r.vol7d || null,
    /* Betting venues only: the house take and what kind of venue it is. Null
       where the fees overview has no adapter for the slug. */
    fees24h: r.fees24h == null ? null : r.fees24h,
    fees7d: r.fees7d == null ? null : r.fees7d,
    wagered24h: r.wagered24h == null ? null : r.wagered24h,
    chains: r.chains || [],
    /* Hot-wallet casinos: how the number was measured, how many wallets, and
       where the site is for the Open button. */
    via: r.via || 'llama',
    wallets: r.wallets || 0,
    walletsRead: r.walletsRead || 0,
    site: r.site || '',
    /* a merged brand's split, for the card */
    parts: Array.isArray(r.parts) ? r.parts : [],
    pc: {
      m5: null, h1: null, h6: null,
      h24: pick(r.change),
      d7: pick(r.change7d),
      d30: null, y1: null,
    },
    copies: 1, flags: [], solid: true,
  }));
}

export async function chainTokens(store) {
  const f = await loadFlows(store);
  return f ? shape(f.chains, 'chain') : [];
}

export async function padTokens(store) {
  const f = await loadFlows(store);
  return f ? shape(f.pads, 'pad') : [];
}

export async function predictionTokens(store) {
  const f = await loadFlows(store);
  return f ? shape(f.prediction, 'pm') : [];
}

/* The Casinos tab is two lists in one unit — dollars held on-chain.

   The off-chain casinos (Stake, Roobet, Rainbet…) are their hot-wallet
   balances, read from public RPCs against the registry in casinowallets.mjs.
   The on-chain casinos (Ape Church, Suigar…) are their contract bankroll from
   DefiLlama. Both are "what the house holds where we can see it", which is
   why they share a map; the card says which kind each one is. */
export async function casinoTokens(store) {
  const [f, hot] = await Promise.all([loadFlows(store), hotCasinoRows(store).catch(() => [])]);
  const llama = f ? (f.casinos || []) : [];
  return shape(hot.concat(llama).sort((a, b) => b.vol - a.vol), 'casino');
}
