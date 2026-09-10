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

const DEXS = 'https://api.llama.fi/overview/dexs'
  + '?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';
const FEES = 'https://api.llama.fi/overview/fees'
  + '?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';

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

export async function loadFlows(store) {
  try { return (await store.get(KEY)) || null; } catch { return null; }
}

/* Called from cron. Returns counts so a scheduled run says what it did. */
export async function refreshFlows(store, force = false) {
  const have = await loadFlows(store);
  if (!force && have && (Date.now() - (have.at || 0)) < FRESH_MS) {
    return { cached: true, chains: (have.chains || []).length, pads: (have.pads || []).length };
  }

  const [dexs, fees] = await Promise.allSettled([jget(DEXS), jget(FEES)]);

  const chains = dexs.status === 'fulfilled' ? chainsFrom(dexs.value) : [];
  const pads = fees.status === 'fulfilled' ? padsFrom(fees.value) : [];

  /* Half an answer must not overwrite a whole one: if a side came back empty
     and we already had it, keep what we had. */
  const next = {
    at: Date.now(),
    chains: chains.length ? chains : ((have && have.chains) || []),
    pads: pads.length ? pads : ((have && have.pads) || []),
  };
  if (!next.chains.length && !next.pads.length) {
    return { chains: 0, pads: 0, error: 'both upstreams empty' };
  }

  try { await store.put(KEY, next); } catch { /* next tick retries */ }
  return {
    chains: next.chains.length, pads: next.pads.length,
    dexs: dexs.status, fees: fees.status,
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
