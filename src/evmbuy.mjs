/* ==========================================================================
   pumpbubble.fun — buy alerts on EVM chains: Base, Ethereum, Robinhood Chain

   Solana buys arrive by Helius webhook and are read off balances
   (src/solbuy.mjs). EVM chains have no Helius, so a Durable Object per chain
   (`EvmWatch` in worker/index.js) polls the tracked pools' **Swap events**
   every few seconds with one batched `eth_getLogs`, and this file turns each
   event into a buy. Polling is the honest shape for a Worker: a websocket
   would have to be held open by something that never sleeps.

   Every constant below was read off real transactions before it was written,
   because a wrong topic hash fails the way this project's worst bugs fail —
   silently, with an empty result that looks like a quiet market:

   | event                 | topic0       | who uses it (seen live)                        |
   |-----------------------|--------------|------------------------------------------------|
   | Uniswap v2 Swap       | 0xd78ad95f…  | Uniswap v2 (Base)                              |
   | Solidly Swap          | 0xb3e27736…  | Aerodrome classic pools (Base)                 |
   | Uniswap v3 Swap       | 0xc42079f9…  | Uniswap v3, Aerodrome CL, Ramses, "up" (RH)    |
   | Pancake v3 Swap       | 0x19b47279…  | PancakeSwap v3 (Base), "giga" (Robinhood)      |
   | Uniswap v4 Swap       | 0x40e9cecb…  | the PoolManager singleton, pool id in topic 1  |

   **The signs are not the same everywhere, and that is the whole trap.**
   v3's amounts are the *pool's* delta (positive = the pool received). v4's are
   the *swapper's* (positive = the swapper received) — checked on a real
   Robinhood swap: amount0 −0.0026 ETH, equal to the transaction's value, and
   amount1 +114,012,650 tokens, equal to the PoolManager→wallet transfer. v2 and
   Solidly carry In and Out separately and need no sign at all.

   Robinhood Chain trades mostly on Uniswap v4 (fourteen of the thirty pairs
   sampled), priced in native ETH or USDG; Base mostly on Aerodrome and
   Uniswap v3. A pool is followed only when its other side is ETH/WETH or a
   dollar stablecoin, so every alert can say what was paid in dollars without
   pricing a third asset.
   ========================================================================== */

export const TOPIC = {
  V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  SOLIDLY: '0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b',
  V3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  PCS3: '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83',
  V4: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
};
const ETH0 = '0x0000000000000000000000000000000000000000';

/* Per chain: where to ask, how often, and what counts as money. The public
   RPCs are the fallback; ALCHEMY_KEY (one key serves all three) is the fix
   when a public one rate-limits — Robinhood's answered 429 after a burst of
   queries during the probe. */
export const CHAINS = {
  base: {
    name: 'Base', native: 'ETH', every: 4000, maxRange: 400, blockSec: 2,
    rpc: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'],
    alchemy: 'base-mainnet',
    poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    explorer: 'https://basescan.org', dex: 'base', uniswap: 'base',
    quotes: {
      '0x4200000000000000000000000000000000000006': { sym: 'WETH', dec: 18, eth: true },
      [ETH0]: { sym: 'ETH', dec: 18, eth: true },
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { sym: 'USDC', dec: 6 },
      '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { sym: 'USDbC', dec: 6 },
      '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { sym: 'USDT', dec: 6 },
    },
  },
  ethereum: {
    name: 'Ethereum', native: 'ETH', every: 12000, maxRange: 60, blockSec: 12,
    rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://cloudflare-eth.com'],
    alchemy: 'eth-mainnet',
    poolManager: '0x000000000004444c5dc75cb358380d2e3de08a90',
    explorer: 'https://etherscan.io', dex: 'ethereum', uniswap: 'mainnet',
    quotes: {
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { sym: 'WETH', dec: 18, eth: true },
      [ETH0]: { sym: 'ETH', dec: 18, eth: true },
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { sym: 'USDC', dec: 6 },
      '0xdac17f958d2ee523a2206206994597c13d831ec7': { sym: 'USDT', dec: 6 },
      '0x6b175474e89094c44da98b954eedeac495271d0f': { sym: 'DAI', dec: 18 },
    },
  },
  robinhood: {
    name: 'Robinhood Chain', native: 'ETH', every: 4000, maxRange: 1500, blockSec: 0.1,
    rpc: ['https://rpc.mainnet.chain.robinhood.com'],
    alchemy: 'robinhood-mainnet',
    /* read off the chain: the emitter of every v4 Swap and ModifyLiquidity */
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    explorer: 'https://robinhoodchain.blockscout.com', dex: 'robinhood', uniswap: '',
    quotes: {
      '0x0bd7d308f8e1639fab988df18a8011f41eacad73': { sym: 'WETH', dec: 18, eth: true },
      [ETH0]: { sym: 'ETH', dec: 18, eth: true },
      /* USDG: 106,552,907 raw paid for a ~$106 buy on the probe — six decimals */
      '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { sym: 'USDG', dec: 6 },
    },
  },
};

export const isChain = c => Object.prototype.hasOwnProperty.call(CHAINS, c);
export const rpcUrls = (chain, env = {}) => {
  const c = CHAINS[chain];
  if (!c) return [];
  const key = env.ALCHEMY_KEY ? String(env.ALCHEMY_KEY) : '';
  return (key ? ['https://' + c.alchemy + '.g.alchemy.com/v2/' + encodeURIComponent(key)] : []).concat(c.rpc);
};

/* ------------------------------------------------------------ pool choice */

/* From DexScreener's pairs for a token: the pools worth watching on one
   chain. Deepest first, four at most, only the ones whose other side we can
   price in dollars. A v4 pool is a 32-byte id inside the PoolManager; the rest
   are contracts. token0 is the lower address — v4 included, where native ETH
   is the zero address and so always currency0. */
export function poolsFrom(pairs, token, chain, max = 4) {
  const c = CHAINS[chain];
  if (!c) return [];
  token = String(token).toLowerCase();
  const out = [];
  const ranked = (pairs || []).filter(p => p && p.chainId === chain)
    .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  for (const p of ranked) {
    const base = String(p.baseToken && p.baseToken.address || '').toLowerCase();
    const quoteAddr = String(p.quoteToken && p.quoteToken.address || '').toLowerCase();
    const other = base === token ? quoteAddr : quoteAddr === token ? base : '';
    const q = other && c.quotes[other];
    if (!q) continue;
    const id = String(p.pairAddress || '').toLowerCase();
    const v4 = /^0x[0-9a-f]{64}$/.test(id);
    if (!v4 && !/^0x[0-9a-f]{40}$/.test(id)) continue;
    if (out.some(o => o.id === id)) continue;
    out.push({ id, v4, tokenIs0: token < other, quote: other, dex: String(p.dexId || '') });
    if (out.length >= max) break;
  }
  return out;
}

/* ---------------------------------------------------------------- decoding */

const word = (data, i) => String(data || '').replace(/^0x/, '').slice(i * 64, i * 64 + 64);
const u256 = h => h ? BigInt('0x' + h) : 0n;
const s256 = h => { let v = u256(h); if (v >= 1n << 255n) v -= 1n << 256n; return v; };
const addrOf = topic => '0x' + String(topic || '').slice(-40).toLowerCase();

/* One Swap log against the pool it came from → { tokenOut, quoteIn } in raw
   units when it was a buy of our token, 'sell' when it was the other way
   (a route passing through the token shows as both), null otherwise. */
export function decodeSwap(log, pool) {
  const t0 = log && log.topics && log.topics[0];
  const d = log && log.data;
  let tok, quo;               // signed, from the swapper's side: + received, − paid
  if (t0 === TOPIC.V2 || t0 === TOPIC.SOLIDLY) {
    const [a0In, a1In, a0Out, a1Out] = [0, 1, 2, 3].map(i => u256(word(d, i)));
    tok = pool.tokenIs0 ? a0Out - a0In : a1Out - a1In;
    quo = pool.tokenIs0 ? a1Out - a1In : a0Out - a0In;
  } else if (t0 === TOPIC.V3 || t0 === TOPIC.PCS3) {
    /* the pool's delta: flip it to the swapper's */
    const a0 = -s256(word(d, 0)), a1 = -s256(word(d, 1));
    tok = pool.tokenIs0 ? a0 : a1;
    quo = pool.tokenIs0 ? a1 : a0;
  } else if (t0 === TOPIC.V4) {
    const a0 = s256(word(d, 0)), a1 = s256(word(d, 1));
    tok = pool.tokenIs0 ? a0 : a1;
    quo = pool.tokenIs0 ? a1 : a0;
  } else return null;
  if (tok > 0n && quo < 0n) return { tokenOut: tok, quoteIn: -quo };
  if (tok < 0n && quo > 0n) return 'sell';
  return null;
}

const toNum = (raw, dec) => Number(raw) / 10 ** dec;

/* The logs of one poll → buys, priced. A transaction that both buys and sells
   the same token is a route passing through it, not a buy. */
export function buysFrom(logs, tokens, chain, ethUsd) {
  const c = CHAINS[chain];
  const byPool = new Map();
  for (const [addr, t] of Object.entries(tokens || {})) {
    for (const p of t.pools || []) byPool.set(p.id, { token: addr, t, p });
  }
  const seen = new Map();     // tx|token -> {buys, sold}
  for (const l of logs || []) {
    const key = l.topics && l.topics[0] === TOPIC.V4 ? String(l.topics[1]).toLowerCase() : String(l.address).toLowerCase();
    const hit = byPool.get(key);
    if (!hit) continue;
    const r = decodeSwap(l, hit.p);
    if (!r) continue;
    const k = l.transactionHash + '|' + hit.token;
    const e = seen.get(k) || { hit, buys: [], sold: false, log: l };
    if (r === 'sell') e.sold = true; else e.buys.push(r);
    seen.set(k, e);
  }
  const out = [];
  for (const e of seen.values()) {
    if (e.sold || !e.buys.length) continue;
    const { token, t, p } = e.hit;
    const q = c.quotes[p.quote];
    let tokens = 0, paid = 0;
    for (const b of e.buys) { tokens += toNum(b.tokenOut, t.dec || 18); paid += toNum(b.quoteIn, q.dec); }
    const usd = q.eth ? paid * (ethUsd || 0) : paid;
    const eth = q.eth ? paid : (ethUsd > 0 ? paid / ethUsd : 0);
    if (!(tokens > 0) || !(usd > 0 || eth > 0)) continue;
    /* the trade's own price times supply: live, and needs no DexScreener */
    const mcap = usd > 0 && t.supply > 0 ? (usd / tokens) * t.supply : 0;
    out.push({
      chain, token, sym: t.sym, tx: e.log.transactionHash,
      block: parseInt(e.log.blockNumber, 16) || 0,
      tokens, eth, usd, mcap, quote: q.sym, paid,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ RPC */

export async function rpc(urls, body, ms = 8000) {
  let last = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'pumpbubble.fun/1.0' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
      });
      if (r.status === 429) { last = new Error('429 ' + url.replace(/\/v2\/.*/, '/v2/…')); last.limited = true; continue; }
      const j = await r.json();
      if (Array.isArray(body)) {
        if (!Array.isArray(j)) throw new Error('batch not supported');
        const err = j.find(x => x && x.error);
        if (err) throw new Error(JSON.stringify(err.error).slice(0, 160));
        return body.map(b => (j.find(x => x.id === b.id) || {}).result);
      }
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 160));
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error('no rpc');
}

/* decimals() and totalSupply() for a token, once, at /setup. */
export async function tokenFacts(chain, token, env) {
  const urls = rpcUrls(chain, env);
  const call = (id, data) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: token, data }, 'latest'] });
  let r;
  try { r = await rpc(urls, [call(1, '0x313ce567'), call(2, '0x18160ddd')]); }
  catch { r = [await rpc(urls, call(1, '0x313ce567')).catch(() => null), await rpc(urls, call(2, '0x18160ddd')).catch(() => null)]; }
  const dec = r[0] ? Number(u256(String(r[0]).replace(/^0x/, '').slice(-64) || '0')) : 18;
  const raw = r[1] ? u256(String(r[1]).replace(/^0x/, '').slice(-64) || '0') : 0n;
  return { dec: dec > 0 && dec <= 36 ? dec : 18, supply: toNum(raw, dec > 0 && dec <= 36 ? dec : 18) };
}

/* ETH in dollars: Kraken, then Coinbase. Both answer Cloudflare's egress
   (Kraken is already on the list in CLAUDE.md of hosts that do). */
export async function ethUsd() {
  try {
    const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=XETHZUSD', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    const v = +(j && j.result && j.result.XETHZUSD && j.result.XETHZUSD.c && j.result.XETHZUSD.c[0]);
    if (v > 0) return v;
  } catch {}
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    const v = +(j && j.data && j.data.amount);
    if (v > 0) return v;
  } catch {}
  return 0;
}

/* ------------------------------------------------------------ one poll */

/* Everything one alarm does, apart from posting: head, the swap logs since
   the last poll, and the buyers. `state` is {last}; returns {buys, head}. */
export async function poll(chain, tokens, state, env, ethPrice) {
  const c = CHAINS[chain];
  const urls = rpcUrls(chain, env);
  /* the head block with its timestamp, so each buy can carry an approximate
     block time and the alert its latency */
  const hb = await rpc(urls, { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] });
  const head = parseInt(hb && hb.number, 16), headTs = parseInt(hb && hb.timestamp, 16) || 0;
  if (!(head > 0)) throw new Error('no head');
  let from = state.last ? state.last + 1 : head - Math.min(c.maxRange, 20);
  if (head - from > c.maxRange) from = head - c.maxRange;      // behind: skip ahead, never flood a group with history
  if (from > head) return { buys: [], head };
  const pools = Object.values(tokens || {}).flatMap(t => t.pools || []);
  const addrs = [...new Set(pools.filter(p => !p.v4).map(p => p.id))];
  const ids = [...new Set(pools.filter(p => p.v4).map(p => p.id))];
  const range = { fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16) };
  const reqs = [];
  if (addrs.length) reqs.push({ jsonrpc: '2.0', id: 11, method: 'eth_getLogs', params: [{ ...range, address: addrs, topics: [[TOPIC.V2, TOPIC.SOLIDLY, TOPIC.V3, TOPIC.PCS3]] }] });
  if (ids.length) reqs.push({ jsonrpc: '2.0', id: 12, method: 'eth_getLogs', params: [{ ...range, address: c.poolManager, topics: [TOPIC.V4, ids] }] });
  if (!reqs.length) return { buys: [], head };
  const res = await rpc(urls, reqs);
  const logs = res.flat().filter(Boolean);
  const buys = buysFrom(logs, tokens, chain, ethPrice);
  for (const b of buys) b.ts = headTs ? headTs - (head - b.block) * c.blockSec : 0;
  /* the buyer is whoever signed: routers and v4's PoolManager sit between
     the pool and the wallet, so the swap's own `to` is rarely the person */
  const txs = [...new Set(buys.map(b => b.tx))].slice(0, 25);
  if (txs.length) {
    try {
      const got = await rpc(urls, txs.map((h, i) => ({ jsonrpc: '2.0', id: 100 + i, method: 'eth_getTransactionByHash', params: [h] })));
      const who = new Map(txs.map((h, i) => [h, got[i] && got[i].from ? String(got[i].from).toLowerCase() : '']));
      for (const b of buys) b.buyer = who.get(b.tx) || '';
    } catch { /* the alert goes out without a wallet link */ }
  }
  return { buys, head };
}
