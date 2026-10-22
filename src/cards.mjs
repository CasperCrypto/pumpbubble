/* ==========================================================================
   pumpbubble.fun — Cards: Collector Crypt's gacha machines, and what comes
   out of them.

   Collector Crypt sells graded trading cards (Pokémon first, then One Piece,
   sports, watches) as packs on Solana. You pay a machine's price in USDC and
   get one card, which can be sold straight back at 85–93% of its insured
   value. Measured in Q3 2026: $433.5M of packs, 21,876 buyers, 548 wallets
   ≥ $100K making up 83% of it. Their own public endpoints, keyless, carry all
   of it:

   - `GET gacha.collectorcrypt.com/api/machines` — every machine (127 on
     2026-10-22): price, odds per tier, the tier's value range, live stock,
     the instant-buyback share, and `ev`, the expected insured value of the
     next pack at today's stock. 33 are Collector Crypt's own (`public`);
     the rest are partners' (Jupiter, Solflare, Slabz…) with their own fee.
   - `…/api/getAllWinners?count=200` — the latest 200 pulls, about fifteen
     minutes of them: the card, its insured value, the machine, the buyer,
     and `memo_slug`, the storefront that sold the pack (cc, jupiter…).
   - `…&epic=true` — the latest 200 top-tier pulls, about twelve hours: the
     big hits.

   EV here is in insured value, Collector Crypt's own price for the card.
   Selling back pays `instantBuyback`% of it, so a pack at 110% EV returns
   about 93% if sold back at once. Both are shown, never only the first.

   Read on request within the feed's lifetime (api.mjs → cardsSnapshot), with
   no Durable Object: nobody looking means no reads. Pulls are kept per
   isolate for an hour, so a machine's "opened" figure covers more than one
   sample, and the window it covers is stated.

   **Off until Collector Crypt agrees.** Their Terms of Service (revised
   2026-06-09) cover their APIs and license them "solely for User's personal
   use" unless the company expressly authorises commercial use, and they bar
   automated monitoring and copying. Their docs and their own post ("Our APIs
   are open. Come chat with our team about hosting our Gachas on your site")
   point to a yes, but a yes is not a keyless 200. `CARDS_TAB = "on"` in
   wrangler.toml turns the feed and the tab on. See docs/sources.md.
   ========================================================================== */

import { clean } from './core.mjs';

export const CC_GACHA = 'https://gacha.collectorcrypt.com';
export const PULL_WINDOW_MS = 60 * 60_000;
const MAX_PULLS = 2000;
const TIER = { 1: 'epic', 2: 'rare', 3: 'uncommon', 4: 'common' };

export const cardsOn = env => String((env && env.CARDS_TAB) || '').toLowerCase() === 'on';

const num = v => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const money = p => p >= 1000 ? (+(p / 1000).toFixed(1)) + 'K' : String(Math.round(p));
const STOP = /^(gacha|pack|packs|pok[eé]mon|the|\d+)$/i;

/* "Elite Pokémon Gacha Pack" at $50 → "$50 Elite"; "Soccer $50 Pack" →
   "$50 Soccer". A bubble's face has room for a price and a word or two. */
export function machineSym(name, price) {
  const words = clean(name, 80).replace(/\$\d[\d,.]*/g, ' ').split(/\s+/).filter(w => w && !STOP.test(w));
  let head = '';
  for (const w of words) { if ((head + ' ' + w).trim().length > 14) break; head = (head + ' ' + w).trim(); }
  head = head || clean(words[0] || 'Pack', 14);
  return (price > 0 ? '$' + money(price) + ' ' : '') + head;
}

/* A machine's art: the absolute URL as given, or a path on the gacha site. */
function thumbUrl(u) {
  u = String(u || '');
  if (/^https:\/\/[^\s"'<>]+$/.test(u)) return u;
  if (/^\/[\w./-]+$/.test(u)) return CC_GACHA + u;
  return '';
}

export function cardMachine(m) {
  if (!m || !m.code) return null;
  const price = num(m.price), ev = num(m.ev), bb = num(m.instantBuyback);
  if (!(price > 0)) return null;
  const odds = m.odds || {}, stock = m.stock || {}, epic = (m.tierRanges && m.tierRanges.epic) || {};
  /* 55 of 127 partner machines are named with their code ("ejup_poke_300");
     those are called by their storefront instead: "Jupiter pack". */
  const given = clean(m.name || m.shortName || '', 80);
  const coded = !given || given === m.code || /^[\w-]+$/.test(given) && given.includes('_');
  const name = coded ? clean(m.menuCategory || 'Partner', 24) + ' pack' : given;
  return {
    code: clean(m.code, 40),
    name,
    sym: machineSym(name, price),
    cat: clean(m.menuCategory || '', 24),
    price, ev,
    /* the share of insured value a sell-back pays, 0..1 */
    back: bb != null && bb >= 0 && bb <= 100 ? bb / 100 : null,
    /* expected card value against the price, in % — the bubble's colour */
    edge: ev != null ? (ev / price - 1) * 100 : null,
    /* what the next pack returns, as a share of its price, if sold back at once */
    sellBack: ev != null && bb != null ? ev * bb / 100 / price : null,
    public: !!m.public,
    parent: m.parentCode ? clean(m.parentCode, 40) : '',
    odds: { epic: num(odds.epic), rare: num(odds.rare), uncommon: num(odds.uncommon), common: num(odds.common) },
    epicFrom: num(epic.start), epicTo: num(epic.end),
    stock: { epic: num(stock.epic), rare: num(stock.rare), uncommon: num(stock.uncommon), common: num(stock.common) },
    thumb: thumbUrl(m.thumbnailUrl || m.image),
  };
}

/* A card photo is ~190 KB at full size. The API also carries a resized copy
   on Helius's image CDN, which at 160px wide is ~17 KB — the size a table
   row needs. Full size is only the fallback. */
function cardImg(f, meta) {
  const cdn = String((f && f.cdn_uri) || '');
  if (/^https:\/\/cdn\.helius-rpc\.com\/cdn-cgi\/image\/\/https:\/\/[^\s"'<>]+$/.test(cdn)) {
    return cdn.replace('/cdn-cgi/image//', '/cdn-cgi/image/width=160,format=auto/');
  }
  for (const u of [f && f.cc_cdn, f && f.uri, meta && meta.image]) {
    if (/^https:\/\/[^\s"'<>]+$/.test(String(u || ''))) return String(u);
  }
  return '';
}

/* One pull. The price is the machine's that sold it, partners' included; a
   machine the list does not name has no price, and so no multiple — never
   one guessed from the code. `machine` folds a partner's copy onto the
   Collector Crypt machine it was adopted from. */
export function cardPull(w, byCode) {
  if (!w || !w.nft_address) return null;
  const content = (w.nft && w.nft.content) || {};
  const meta = content.metadata || {};
  const attrs = {};
  for (const a of meta.attributes || []) if (a && a.trait_type) attrs[a.trait_type] = a.value;
  const at = Date.parse(w.created_at || w.timestamp || '');
  if (!Number.isFinite(at)) return null;
  const m = byCode.get(w.pack_type) || null;
  const value = num(w.insuredValue);
  const price = m ? m.price : null;
  const nft = clean(w.nft_address, 60);
  return {
    id: nft + ':' + at, nft, at,
    card: clean(meta.json_name || meta.name || '', 120),
    cat: clean(attrs.Category || '', 24),
    value, price,
    mult: value != null && price > 0 ? value / price : null,
    pack: clean(w.pack_type || '', 40),
    packName: m ? m.name : '',
    machine: m ? (m.parent || m.code) : '',
    tier: TIER[w.prize_tier] || '',
    wallet: clean(w.winner || '', 60),
    via: clean(w.memo_slug || '', 24),
    img: cardImg((content.files || [])[0], meta),
  };
}

/* The hour of pulls this isolate has seen, newest first, one row per pull. */
export function mergePulls(kept, fresh, now = Date.now(), windowMs = PULL_WINDOW_MS) {
  const by = new Map();
  for (const p of [...(fresh || []), ...(kept || [])]) {
    if (p && p.at && now - p.at <= windowMs && !by.has(p.id)) by.set(p.id, p);
  }
  return [...by.values()].sort((a, b) => b.at - a.at).slice(0, MAX_PULLS);
}

/* The tab: the machines worth a bubble — Collector Crypt's own, plus any
   partner machine that sold in the window — each with what it sold, and the
   window's totals. "Value back" is insured value out over pack price in,
   for the pulls whose machine has a price. */
export function cardsBoard({ machines = [], pulls = [], hits = [] }, now = Date.now()) {
  const sold = new Map();
  let opened = 0, paid = 0, back = 0, top = null;
  const via = new Map();
  for (const p of pulls) {
    opened++;
    if (p.value != null && (!top || p.value > top.value)) top = p;
    if (p.via) via.set(p.via, (via.get(p.via) || 0) + 1);
    if (p.price > 0 && p.value != null) { paid += p.price; back += p.value; }
    const k = p.machine || p.pack;
    const s = sold.get(k) || { n: 0, usd: 0, best: null };
    s.n++;
    if (p.price > 0) s.usd += p.price;
    if (p.value != null && (!s.best || p.value > s.best.value)) s.best = p;
    sold.set(k, s);
  }
  const rows = machines
    .filter(m => !m.parent && (m.public || sold.has(m.code)))
    .map(m => {
      const s = sold.get(m.code) || { n: 0, usd: 0, best: null };
      return { ...m, opened: s.n, openedUsd: s.usd,
        best: s.best ? { card: s.best.card, value: s.best.value, mult: s.best.mult, at: s.best.at } : null };
    })
    .sort((a, b) => b.openedUsd - a.openedUsd || b.price - a.price);
  const oldest = pulls.length ? Math.min(...pulls.map(p => p.at)) : now;
  const hitsSorted = [...hits].filter(p => p.value != null).sort((a, b) => b.value - a.value);
  const hitsOldest = hits.length ? Math.min(...hits.map(p => p.at)) : now;
  return {
    machines: rows,
    meta: {
      at: now,
      windowMin: Math.max(0, Math.round((now - oldest) / 60000)),
      opened, openedUsd: paid,
      back: paid > 0 ? back / paid : null,
      /* the window's best card, of every pull kept, not only the rows sent */
      best: top ? { card: top.card, value: top.value, mult: top.mult, at: top.at } : null,
      via: [...via.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([slug, n]) => ({ slug, n })),
      hitsH: Math.max(0, Math.round((now - hitsOldest) / 36e5)),
      pulls, hits: hitsSorted,
    },
  };
}

/* The three reads, together; a machines list that does not answer fails the
   build (an empty tab is not a market), a pulls read that does not answer
   leaves the window as it was. */
export async function readCards(get = fetch, base = CC_GACHA) {
  const one = async path => {
    const r = await get(base + path, { headers: { accept: 'application/json', 'user-agent': 'pumpbubble.fun/1.0' },
      signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error('Collector Crypt ' + r.status + ' ' + path.split('?')[0]);
    return r.json();
  };
  const [mj, wj, ej] = await Promise.all([
    one('/api/machines'),
    one('/api/getAllWinners?count=200').catch(() => null),
    one('/api/getAllWinners?count=200&epic=true').catch(() => null),
  ]);
  const machines = ((mj && mj.machines) || []).map(cardMachine).filter(Boolean);
  if (!machines.length) throw new Error('Collector Crypt listed no machines');
  const byCode = new Map(machines.map(m => [m.code, m]));
  const rows = j => ((j && j.data) || []).map(w => cardPull(w, byCode)).filter(Boolean);
  return { machines, pulls: rows(wj), hits: rows(ej), pullsOk: !!wj, hitsOk: !!ej };
}
