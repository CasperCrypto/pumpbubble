/* ==========================================================================
   pumpbubble.fun — Robinhood Chain discovery

   The first version of this source ranked the chain by Blockscout's
   `circulating_market_cap` and got a map of bridged assets. Blockscout only
   knows a market cap for tokens its own price feed covers, so LINK — bridged,
   thirty-three holders, barely used here — sat at the top with $9B while
   ROBINCAT, thirteen thousand holders and trading hard, came back as `null`
   and was dropped entirely. A meme coin doing $129M of volume was missing for
   the same reason.

   No single endpoint ranks this chain:

     · Blockscout sorts by its own market cap, which is null for exactly the
       tokens we care about, so they sort last and are never reachable. Its
       other sorts are worse — by holders the top is airdrop spam, one token
       with 1.6M holders and no market at all.
     · GeckoTerminal ranks it properly and 429s Cloudflare on every request.
     · DexScreener knows precisely which tokens trade and what they are worth,
       and offers no chain-wide listing: search caps at thirty results.
     · The chain's own RPC 429s after two calls.

   So discovery is accumulated rather than fetched. Each cron tick spends a few
   requests widening a registry of addresses — Blockscout's priced head, plus
   one rotating DexScreener search — and the registry is what the map is built
   from. DexScreener then prices whatever is in it, and *that* is the ranking:
   a real market cap for a token that really trades, rather than whichever list
   happened to be sortable.

   The registry only grows within its cap, so a token that was found once stays
   found even on a tick that does not look for it.
   ========================================================================== */

const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com/api/v2';
const DEXS = 'https://api.dexscreener.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) pumpbubble.fun/1.0';

export const KEY = 'rhchain';

/* Blockscout answers a request with no User-Agent at all with a 403 challenge
   page, which is why Node's bare fetch fails against it and ours does not. */
const HEAD = { accept: 'application/json', 'user-agent': UA };

/* A hard stop on a registry that would otherwise grow with every token ever
   launched on the chain. Comfortably more than the map shows, because most of
   what is found turns out to have no pool and gets pruned on the next pass. */
const MAX_REGISTRY = 900;

/* Every query on this chain comes back full of one ticker's clones — forty-four
   tokens call themselves ROBINCAT, thirty call themselves ROBIN — so a single
   page is nearly worthless and both search engines cap. Discovery therefore
   pages, and keeps its place between ticks: each run continues where the last
   one stopped, and moves to the next term when a term runs dry. */
const PAGES_PER_TICK = 3;

/* Search has no chain filter, so a term's worth is how much of its thirty
   results land on this chain. Measured, not guessed:

     robin 30/30   pons 30/30   hood 27/30   robincat 27/30   amc 23/30
     cat 5/30      chain 1/30   weth 0/30

   Generic memecoin words are almost worthless — "cat" returns five Robinhood
   pairs and twenty-five from everywhere else. Words this chain actually uses
   return nearly a full page. So the fixed list is the chain's own vocabulary,
   and everything after it is bootstrapped: every ticker already discovered
   becomes the next search term, because a token here is named like its
   neighbours and searching one surfaces thirty more. Discovery seeds itself
   instead of depending on me guessing this week's memecoins. */
const SEED_TERMS = [
  'robin', 'pons', 'hood', 'robinhood', 'hoodcat', 'rh', 'rhc',
  /* Chain-scoped search makes generic memecoin words useful again: on
     DexScreener "cat" spent twenty-five of its thirty results on other chains,
     while here every result is a token on this one. */
  'cat', 'dog', 'meme', 'coin', 'moon', 'pepe', 'baby', 'doge', 'ai',
  'rocket', 'king', 'gold', 'trump', 'elon', 'wif', 'shib', 'bonk', 'duck',
];

/* One term a tick once warm; a handful on a cold registry so the first map is
   not nearly empty. Discovery is not urgent — thirty requests a tick to a free
   endpoint is how it stops answering. */
const COLD_TERMS = 5;

async function jget(url, ms = 12000) {
  const r = await fetch(url, { headers: HEAD, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(r.status + ' ' + url.slice(0, 60));
  return r.json();
}

/* EVM addresses arrive checksummed from one source and lowercase from another,
   so the registry stores one casing and every comparison uses it. */
const norm = a => String(a || '').toLowerCase();
const isAddr = a => /^0x[0-9a-f]{40}$/.test(norm(a));

/* Blockscout's priced head. Worth keeping in the mix: it is the only source
   that reliably surfaces the large bridged tokens, which do belong on a map of
   the chain even though they are not what anyone came to look at. */
async function fromBlockscout(pages = 2) {
  const found = [];
  let url = BLOCKSCOUT + '/tokens?type=ERC-20';
  for (let p = 0; p < pages; p++) {
    let j;
    try { j = await jget(url); } catch { break; }
    const items = (j && j.items) || [];
    if (!items.length) break;
    for (const r of items) if (isAddr(r.address_hash)) found.push(norm(r.address_hash));
    const np = j && j.next_page_params;
    if (!np) break;
    const qs = new URLSearchParams({ type: 'ERC-20' });
    for (const [k, v] of Object.entries(np)) if (v != null) qs.set(k, String(v));
    url = BLOCKSCOUT + '/tokens?' + qs;
  }
  return found;
}

/* A ticker is written by whoever launched the token, and it is about to become
   a search term in a URL and a key in storage. One of them turned out to be a
   four-thousand-character concatenation of every symbol on the chain. */
const safeTerm = sy => {
  const t = String(sy || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return t.length >= 3 && t.length <= 20 ? t : '';
};

/* Discovery searches Blockscout, not DexScreener.

   DexScreener's search is cross-chain and caps at thirty, so a query spends
   most of its results elsewhere: "robin" comes back full of pairs from other
   chains, and ROBINCAT — which trades here against $295k of liquidity — never
   made it into a single page. Blockscout only knows this chain, so all fifty of
   its results count, and it matches on name as well as symbol.

   DexScreener remains the authority on what a token is worth. It is simply not
   the way to find out the token exists. */
async function fromSearch(term, cursor, pages = PAGES_PER_TICK) {
  const addrs = [], syms = [];
  let next = cursor || null;
  /* Whether anything at all came back. A failed request used to leave the
     cursor exactly where it was and report "more pages", so discovery retried
     the same page every tick, forever, adding nothing — one timeout was enough
     to freeze it permanently. */
  let ok = 0;
  for (let p = 0; p < pages; p++) {
    const qs = new URLSearchParams({ type: 'ERC-20', q: term });
    if (next) for (const [k, v] of Object.entries(next)) if (v != null) qs.set(k, String(v));
    let j;
    try { j = await jget(BLOCKSCOUT + '/tokens?' + qs); } catch { break; }
    ok++;
    const items = (j && j.items) || [];
    if (!items.length) { next = null; break; }
    for (const r of items) {
      if (isAddr(r.address_hash)) addrs.push(norm(r.address_hash));
      const sy = safeTerm(r.symbol);
      if (sy) syms.push(sy);
    }
    next = (j && j.next_page_params) || null;
    if (!next) break;
  }
  return { addrs, syms, next, ok: ok > 0 };
}

const EMPTY = { addrs: [], syms: [], seeds: [], at: 0, term: 0, cursor: null };

export async function loadRegistry(store) {
  try {
    const r = await store.get(KEY);
    if (!Array.isArray(r && r.addrs)) return { ...EMPTY };
    return {
      addrs: r.addrs, syms: Array.isArray(r.syms) ? r.syms : [],
      /* Hand-added addresses. Discovery pages through a chain where any one
         query returns a swarm of clones, so a token can take a long time to be
         reached; these jump the queue and are never pruned. */
      seeds: Array.isArray(r.seeds) ? r.seeds : [],
      at: r.at || 0, term: r.term || 0, cursor: r.cursor || null,
    };
  } catch { return { ...EMPTY }; }
}

/* Fixed vocabulary first, then every ticker already found. */
function termsFor(reg) {
  const seen = new Set(SEED_TERMS);
  const out = [...SEED_TERMS];
  for (const sym of reg.syms || []) {
    const k = safeTerm(sym);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/* Widen the registry by one tick's worth. Returns counts so a scheduled run
   says what it did rather than reporting silent success. */
export async function discover(store) {
  const reg = await loadRegistry(store);
  const seen = new Set(reg.addrs);
  const syms = new Set(reg.syms);
  const before = seen.size;

  const terms = termsFor(reg);
  const term = terms[(reg.term || 0) % terms.length];
  const cold = !reg.addrs.length;

  const [head, found] = await Promise.all([
    fromBlockscout(2),
    /* A cold registry walks further on its first run so the very first map is
       not nearly empty. */
    fromSearch(term, reg.cursor, cold ? 6 : PAGES_PER_TICK),
  ]);

  for (const a2 of [...head, ...found.addrs]) {
    if (seen.size >= MAX_REGISTRY) break;
    seen.add(a2);
  }
  /* Tickers are kept past the address cap: they are what the next search is
     made of, and they cost almost nothing to store. */
  for (const sy of found.syms) if (syms.size < 800) syms.add(sy);

  /* Move on when the term is spent. Blockscout stops advancing its cursor after
     about five pages — it keeps returning the same fifty rows alongside a
     next_page_params that never terminates — so "the server says there is more"
     is not a usable signal on its own. What is: whether this tick actually
     learned anything. A pass that adds nothing has finished with the term,
     whether the cursor admits it or not, and a failed request has too. */
  const gained = seen.size - before;
  const more = !!found.next && found.ok && gained > 0;
  const next = {
    addrs: [...seen],
    syms: [...syms],
    at: Date.now(),
    term: more ? (reg.term || 0) : (((reg.term || 0) + 1) % Math.max(1, terms.length)),
    cursor: more ? found.next : null,
  };
  try { await store.put(KEY, next); } catch { /* next tick retries */ }
  return {
    known: next.addrs.length, added: gained,
    term, more, pool: terms.length,
  };
}

/* Drop what turned out to have no market, so the cap holds tokens that exist
   rather than the first nine hundred addresses discovery happened to see. A
   token with no pool cannot be bought and has no price to show. */
/* Pin an address so it is always in the map, whatever discovery has reached. */
export async function seed(store, addrs) {
  const reg = await loadRegistry(store);
  const good = (addrs || []).map(norm).filter(isAddr);
  if (!good.length) return { seeds: (reg.seeds || []).length, added: 0 };
  const seeds = new Set([...(reg.seeds || []), ...good]);
  const all = new Set([...reg.addrs, ...good]);
  const next = { ...reg, seeds: [...seeds], addrs: [...all] };
  await store.put(KEY, next);
  return { seeds: next.seeds.length, added: seeds.size - (reg.seeds || []).length };
}

export async function prune(store, priced) {
  const reg = await loadRegistry(store);
  if (reg.addrs.length < MAX_REGISTRY * 0.9) return { pruned: 0 };
  const pinned = new Set(reg.seeds || []);
  const keep = reg.addrs.filter(a => priced.has(a) || pinned.has(a));
  if (!keep.length) return { pruned: 0 };
  const pruned = reg.addrs.length - keep.length;
  try { await store.put(KEY, { ...reg, addrs: keep }); } catch { return { pruned: 0 }; }
  return { pruned };
}

/* Price everything in the registry, thirty at a time, and keep only what
   actually trades. DexScreener is the authority here: a token it has no pool
   for cannot be bought, and a market cap for it would be a number with nothing
   behind it. */
export async function priceAll(addrs) {
  const batches = [];
  for (let i = 0; i < addrs.length; i += 30) batches.push(addrs.slice(i, i + 30));

  const best = new Map();
  for (let i = 0; i < batches.length; i += 4) {
    const group = batches.slice(i, i + 4);
    const res = await Promise.allSettled(group.map(b =>
      jget(DEXS + '/tokens/v1/robinhood/' + b.join(','), 8000)));
    for (const r of res) {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
      for (const p of r.value) {
        const a = p && p.baseToken && norm(p.baseToken.address);
        if (!a) continue;
        /* A token can have several pools; the deepest one is the price that
           somebody could actually trade against. */
        const prev = best.get(a);
        const liq = (p.liquidity && p.liquidity.usd) || 0;
        const prevLiq = (prev && prev.liquidity && prev.liquidity.usd) || 0;
        if (!prev || liq > prevLiq) best.set(a, p);
      }
    }
  }
  return best;
}
