/* ==========================================================================
   pumpbubble.fun — casino hot-wallet balances

   The registry in casinowallets.mjs says which addresses are whose. This
   module reads what is in them — native coin plus the stablecoins — prices
   it, and keeps enough history to say whether the pile grew or shrank over a
   day and a week. That sum is what the Casinos tab draws for Stake, Roobet,
   Rainbet and the rest: not treasury, not volume, the money sitting in the
   wallets that pay out withdrawals, which is the one number an off-chain
   casino cannot keep off a public chain.

   **Chunked, because a cron tick is short.** Thirty-odd wallets across five
   chains, with Tron politely paced, is longer than a scheduled handler should
   run in one go. Each tick reads a slice and moves a cursor; every wallet is
   re-read within about twenty minutes. Totals are summed from the latest
   reading of each wallet whatever its age, and the blob carries per-wallet
   timestamps so a reading that has gone stale is visible rather than silent.

   **One KV write per tick**, and a wallet that fails to read keeps its last
   value with an error attached — a casino must not drop to zero because an
   RPC had a bad minute.

   RPCs are public and keyless, and tried in order: Cloudflare's own Ethereum
   gateway first, because it is inside the same network as the Worker.
   Solana uses SOLANA_RPC (Helius) when set. Tron goes to TronGrid, then to
   Tronscan's API when TronGrid refuses the shared egress.
   ========================================================================== */

import { WALLETS, SITES, ERC20, TRC20, SPL, NATIVE, STABLE } from './casinowallets.mjs';
import { clean } from './core.mjs';

export const KEY = 'casinos:hot';
export const SLICE = 8;                       // wallets per tick
const HIST_EVERY = 20 * 60 * 1000;           // a history point every 20 minutes
const HIST_KEEP = 8 * 24 * 3600 * 1000;      // a week, plus a day of slack
const TIMEOUT = 12000;

const RPCS = {
  ethereum: ['https://cloudflare-eth.com', 'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://rpc.ankr.com/eth'],
  polygon: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com', 'https://polygon.drpc.org'],
  bsc: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org', 'https://bsc.drpc.org'],
  solana: ['https://api.mainnet-beta.solana.com'],
};
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wid = w => w.chain + '|' + w.addr;

/* JSON-RPC against the first endpoint that answers. A provider that 429s or
   returns HTML is skipped for this call, not remembered — free endpoints have
   bad minutes, not bad days. */
async function rpc(urls, method, params) {
  let last = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const j = await r.json();
      if (j && j.error) throw new Error(j.error.message || 'rpc error');
      if (j && 'result' in j) return j.result;
      throw new Error('no result');
    } catch (e) { last = e; }
  }
  throw last || new Error('no rpc');
}

const balanceOfData = a => '0x70a08231' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

async function evmBalances(chain, addr) {
  const urls = RPCS[chain];
  const out = {};
  const wei = await rpc(urls, 'eth_getBalance', [addr, 'latest']);
  out[NATIVE[chain]] = Number(BigInt(wei)) / 1e18;
  for (const [sym, [contract, dec]] of Object.entries(ERC20[chain] || {})) {
    const h = await rpc(urls, 'eth_call', [{ to: contract, data: balanceOfData(addr) }, 'latest']);
    out[sym] = Number(BigInt(h && h !== '0x' ? h : '0x0')) / 10 ** dec;
  }
  return out;
}

async function tronBalances(addr) {
  /* TronGrid first. */
  try {
    const r = await fetch('https://api.trongrid.io/v1/accounts/' + addr, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT),
    });
    if (r.ok) {
      const j = await r.json();
      const a = (j.data || [])[0];
      if (a) {
        const out = { TRX: num(a.balance) / 1e6 };
        for (const row of a.trc20 || []) for (const [c, v] of Object.entries(row)) {
          for (const [sym, cc] of Object.entries(TRC20)) if (c === cc) out[sym] = num(v) / 1e6;
        }
        return out;
      }
    }
  } catch { /* fall through */ }
  /* Tronscan's public API, when TronGrid will not talk to the shared egress. */
  const r2 = await fetch('https://apilist.tronscanapi.com/api/accountv2?address=' + encodeURIComponent(addr), {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r2.ok) throw new Error('tron ' + r2.status);
  const j2 = await r2.json();
  const out = { TRX: num(j2.balance) / 1e6 };
  for (const t of j2.withPriceTokens || j2.trc20token_balances || []) {
    const id = t.tokenId || t.tokenAddress || '';
    for (const [sym, cc] of Object.entries(TRC20)) {
      if (id === cc) out[sym] = num(t.balance) / 10 ** num(t.tokenDecimal != null ? t.tokenDecimal : 6);
    }
  }
  return out;
}

async function solBalances(addr, env) {
  const urls = [env && env.SOLANA_RPC, ...RPCS.solana].filter(Boolean);
  const out = {};
  const lam = await rpc(urls, 'getBalance', [addr]);
  out.SOL = num(lam && lam.value) / 1e9;
  const ta = await rpc(urls, 'getTokenAccountsByOwner', [addr, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]);
  for (const v of (ta && ta.value) || []) {
    const info = v && v.account && v.account.data && v.account.data.parsed && v.account.data.parsed.info;
    if (!info) continue;
    for (const [sym, mint] of Object.entries(SPL)) {
      if (info.mint === mint) out[sym] = (out[sym] || 0) + num(info.tokenAmount && info.tokenAmount.uiAmount);
    }
  }
  return out;
}

async function readWallet(w, env) {
  if (w.chain === 'tron') return tronBalances(w.addr);
  if (w.chain === 'solana') return solBalances(w.addr, env);
  return evmBalances(w.chain, w.addr);
}

/* USD value of a balance map. A coin with no price counts nothing rather than
   something invented; the parts are kept so the card can say what it saw. */
function priceOut(parts, prices) {
  let usd = 0;
  for (const [sym, amt] of Object.entries(parts)) {
    const p = STABLE.has(sym) ? 1 : num(prices[sym]);
    if (amt > 0 && p > 0) usd += amt * p;
  }
  return usd;
}

export async function loadHot(store) {
  try { return (await store.get(KEY)) || null; } catch { return null; }
}

/* One tick: read a slice, fold it into the blob, append a history point when
   one is due. `prices` is {ETH, SOL, TRX, BNB, POL} from the majors feed. */
export async function sweepCasinos(store, env, prices = {}) {
  const blob = (await loadHot(store)) || { cursor: 0, wallets: {}, hist: [] };
  const n = WALLETS.length;
  const start = Math.min(num(blob.cursor), n - 1) || 0;
  const slice = [];
  for (let i = 0; i < Math.min(SLICE, n); i++) slice.push(WALLETS[(start + i) % n]);

  const now = Date.now();
  let read = 0, failed = 0;
  /* EVM and Solana in parallel, Tron one at a time with a gap. */
  const tron = slice.filter(w => w.chain === 'tron');
  const rest = slice.filter(w => w.chain !== 'tron');
  const results = await Promise.all(rest.map(async w => {
    try { return [w, await readWallet(w, env), '']; } catch (e) { return [w, null, String(e && e.message || e)]; }
  }));
  for (const w of tron) {
    try { results.push([w, await readWallet(w, env), '']); } catch (e) { results.push([w, null, String(e && e.message || e)]); }
    await sleep(600);
  }
  for (const [w, parts, err] of results) {
    const id = wid(w);
    const prev = blob.wallets[id] || {};
    if (parts) {
      read++;
      blob.wallets[id] = { usd: priceOut(parts, prices), parts, at: now, err: '' };
    } else {
      failed++;
      /* keep the last reading; say it failed */
      blob.wallets[id] = { ...prev, err, errAt: now };
    }
  }
  blob.cursor = (start + slice.length) % n;

  /* History: per-casino totals, one point per HIST_EVERY, trimmed to a week. */
  const by = totals(blob).by;
  const last = blob.hist[blob.hist.length - 1];
  if (!last || now - last.at >= HIST_EVERY) {
    const pt = { at: now, by: {} };
    for (const [c, v] of Object.entries(by)) pt.by[c] = Math.round(v.usd);
    blob.hist.push(pt);
    blob.hist = blob.hist.filter(h => now - h.at <= HIST_KEEP);
  }
  blob.at = now;
  try { await store.put(KEY, blob); } catch { /* next tick retries */ }
  return { ok: true, read, failed, cursor: blob.cursor, wallets: Object.keys(blob.wallets).length, hist: blob.hist.length };
}

/* Per-casino sums from the latest reading of each wallet. */
export function totals(blob) {
  const by = {};
  let oldest = Infinity;
  for (const w of WALLETS) {
    const r = blob && blob.wallets && blob.wallets[wid(w)];
    const c = by[w.casino] || (by[w.casino] = { usd: 0, wallets: 0, read: 0, chains: new Set(), parts: {} });
    c.wallets++;
    if (!r || !(r.at > 0)) continue;
    c.read++;
    c.usd += num(r.usd);
    c.chains.add(w.chain);
    for (const [sym, amt] of Object.entries(r.parts || {})) c.parts[sym] = (c.parts[sym] || 0) + num(amt);
    if (r.at < oldest) oldest = r.at;
  }
  for (const c of Object.values(by)) c.chains = [...c.chains];
  return { by, oldest: oldest === Infinity ? 0 : oldest };
}

/* Percentage change against the history point nearest to `ago` ms back, or
   null until such a point exists — a tab that has run for an hour does not
   get to claim a 24h move. */
function changeSince(hist, casino, nowUsd, ago, slack) {
  const now = Date.now();
  let best = null;
  for (const h of hist || []) {
    const d = Math.abs((now - h.at) - ago);
    if (d <= slack && (!best || d < best.d)) best = { d, v: h.by && h.by[casino] };
  }
  if (!best || !(best.v > 0) || !(nowUsd > 0)) return null;
  return (nowUsd / best.v - 1) * 100;
}

/* Rows for the map, one per casino, in the same shape flows.mjs uses. */
export async function hotCasinoRows(store) {
  const blob = await loadHot(store);
  if (!blob) return [];
  const { by } = totals(blob);
  const out = [];
  for (const [casino, c] of Object.entries(by)) {
    if (!(c.usd > 0)) continue;
    const name = clean(casino, 24);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const site = SITES[casino] || '';
    const domain = site ? site.replace(/^https?:\/\//, '') : '';
    out.push({
      id: 'casino:hot:' + slug,
      sym: name,
      name: name + ' — hot wallets',
      vol: c.usd,
      vol7d: null,
      change: changeSince(blob.hist, casino, c.usd, 24 * 3600e3, 4 * 3600e3),
      change7d: changeSince(blob.hist, casino, c.usd, 7 * 86400e3, 12 * 3600e3),
      wallets: c.wallets,
      walletsRead: c.read,
      chains: c.chains.map(ch => ch === 'bsc' ? 'BSC' : ch[0].toUpperCase() + ch.slice(1)),
      via: 'hot',
      site,
      logo: domain ? 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(domain) + '&sz=128' : '',
      slug,
    });
  }
  return out.sort((a, b) => b.vol - a.vol);
}
