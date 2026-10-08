/* ==========================================================================
   The Compute tab — what a GPU hour costs, and who sells compute.

       node scripts/compute.test.mjs

   The failures that matter: a price that is not one (a provider's zero, an
   offer for eight GPUs read as the price of one, a median over a truncated
   list), a move claimed before there is history to measure it against, and
   the wrong asset on the map (a coin picked by a ticker another coin shares,
   a depositary line whose cap describes something else). The provider rows
   below are shaped like the real answer Akash's console gave on 2026-10-07;
   the board's shape (`boardRow`) is tested with several markets because a
   second one is meant to slot in beside it.
   ========================================================================== */

import {
  GPUS, HIST_KEY, median, akashQuote, boardRow, pushHist, changeSince,
  gpuBoard, COMPUTE_TOKENS, COMPUTE_STOCKS, ADS_OK, pickCompute, computeCgIds, gpuFeed,
} from '../src/compute.mjs';
import { refreshWindows as refreshCryptoWin } from '../src/cryptowin.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const g = id => GPUS.find(x => x.id === id);
const HOUR = 3600e3, DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

console.log('\nmedian');
is('odd count is the middle', median([3, 1, 2]), 2);
is('even count is the mean of the middle two', median([4, 1, 2, 3]), 2.5);
is('nothing is null, not zero', median([]), null);

console.log('\nAkash — weighted average, and "from" only while a GPU is free');
{
  const models = [
    { model: 'h100', ram: '80Gi', interface: 'SXM5', availability: { total: 68, available: 23 }, price: { min: 2.04, weightedAverage: 2.72 } },
    { model: 'a100', ram: '80Gi', interface: 'SXM4', availability: { total: 200, available: 20 }, price: { min: 1.07, weightedAverage: 1.67 } },
    { model: 'a100', ram: '80Gi', interface: 'PCIe', availability: { total: 1, available: 1 }, price: { min: 1.33, weightedAverage: 1.33 } },
    { model: 'rtx5090', ram: '32Gi', interface: 'PCIe', availability: { total: 10, available: 0 }, price: { min: 0.57, weightedAverage: 0.68 } },
  ];
  is('H100 SXM5', akashQuote(models, g('h100')), { p: 'akash', typical: 2.72, from: 2.04, avail: 23, total: 68 });
  is('A100 SXM4 80 GB only, not the PCIe card', akashQuote(models, g('a100')).typical, 1.67);
  const pro = akashQuote([
    { model: 'pro6000se', ram: '96Gi', interface: 'PCIe', availability: { total: 25, available: 10 }, price: { min: 1.49, weightedAverage: 2.02 } },
    { model: 'pro6000we', ram: '96Gi', interface: 'PCIe', availability: { total: 1, available: 0 }, price: { min: 1.44, weightedAverage: 1.44 } },
  ], g('pro6000'));
  is('two listings weighted by GPUs: one card with nothing free does not set the price', Math.round(pro.typical * 100) / 100, 2);
  is('"from" only from a listing with a GPU free', pro.from, 1.49);
  is('nothing free: a market price, but no "from"', akashQuote(models, g('rtx5090')), { p: 'akash', typical: 0.68, from: null, avail: 0, total: 10 });
  is('a model nobody lists is no quote', akashQuote(models, g('b200')), null);
}

console.log('\nthe board row — the middle provider, the cheapest quote');
{
  const r = boardRow(g('h100'), [
    { p: 'vast', typical: 3.78, from: 1.91, gpus: 13 },
    { p: 'runpod', typical: 3.49, from: 2.69 },
    { p: 'akash', typical: 2.72, from: 2.04, avail: 23, total: 68 },
  ]);
  is('three providers: the middle one', r.price, 3.49);
  is('"from" is the cheapest quote anywhere', r.from, 1.91);
  is('providers counted', r.providers, 3);
  is('each provider kept for the tooltip', r.quotes.map(q => q.p), ['vast', 'runpod', 'akash']);
  const two = boardRow(g('b200'), [{ p: 'vast', typical: 6.25, from: 6.25 }, null, { p: 'runpod', typical: 6.79, from: 5.98 }]);
  is('two providers: halfway', two.price, 6.52);
  is('a typical price can be the cheapest too', boardRow(g('h200'), [{ p: 'runpod', typical: 4.59, from: null }]).from, 4.59);
  const none = boardRow(g('b200'), [null, null, null]);
  is('no provider: a dash, not a zero', [none.price, none.from, none.providers], [null, null, 0]);
}

console.log('\nhistory — one point an hour, a move only against a real point');
{
  const rows = [{ id: 'h100', price: 3.0 }, { id: 'b200', price: null }];
  const h1 = pushHist(null, rows, NOW);
  is('first point written', h1 && h1.pts.length, 1);
  is('a model with no price is not recorded', Object.keys(h1.pts[0].p), ['h100']);
  is('not again inside the hour', pushHist(h1, rows, NOW + 30 * 60e3), null);
  const h2 = pushHist(h1, rows, NOW + HOUR);
  is('again after an hour', h2.pts.length, 2);
  const old = { pts: [{ t: NOW - 9 * DAY, p: { h100: 9 } }, { t: NOW - 2 * HOUR, p: { h100: 3 } }] };
  is('points past eight days are dropped', pushHist(old, rows, NOW).pts.map(x => x.t), [NOW - 2 * HOUR, NOW]);

  const hist = { pts: [
    { t: NOW - 7 * DAY - 2 * HOUR, p: { h100: 4.0 } },
    { t: NOW - DAY - HOUR, p: { h100: 2.5 } },
    { t: NOW - DAY - 20 * 60e3, p: { h100: 2.4 } },
    { t: NOW - 3 * HOUR, p: { h100: 2.9 } },
  ] };
  is('24h: against the newest point at least a day old', Math.round(changeSince(hist, 'h100', DAY, 3.0, NOW) * 100) / 100, 25);
  is('7d: against the point a week back', Math.round(changeSince(hist, 'h100', 7 * DAY, 3.0, NOW) * 100) / 100, -25);
  is('no point old enough: null, never zero', changeSince({ pts: [{ t: NOW - 3 * HOUR, p: { h100: 2 } }] }, 'h100', DAY, 3, NOW), null);
  is('a point far older than asked does not stand in', changeSince({ pts: [{ t: NOW - 3 * DAY, p: { h100: 2 } }] }, 'h100', DAY, 3, NOW), null);
  is('no price now: no move', changeSince(hist, 'h100', DAY, null, NOW), null);
}

console.log('\nthe board end to end — the market failing, models left off');
{
  const store = { m: new Map(), puts: 0, async get(k) { return this.m.get(k) ?? null; }, async put(k, v) { this.puts++; this.m.set(k, v); } };
  store.m.set(HIST_KEY, { pts: [{ t: NOW - DAY - HOUR, p: { h100: 2.5 } }] });
  const models = [
    { model: 'h100', ram: '80Gi', interface: 'SXM5', availability: { total: 68, available: 20 }, price: { min: 2.04, weightedAverage: 3.0 } },
    { model: 'b300', ram: '288Gi', interface: 'SXM6', availability: { total: 16, available: 0 }, price: { min: null, weightedAverage: null } },
  ];
  const b = await gpuBoard({ store, now: NOW, fetchers: { akash: async () => models } });
  const h100 = b.gpus.find(r => r.id === 'h100');
  is('only priced models are on the board — B300 listed with no price is not', b.gpus.map(r => r.id), ['h100']);
  is('H100 at the market\'s weighted price', [h100.price, h100.from], [3, 2.04]);
  is('24h move from the stored point', h100.ch24, 20);
  is('7d: no point that old yet', h100.ch7, null);
  is('no errors', b.errors, {});
  is('one history write', store.puts, 1);
  await gpuBoard({ store, now: NOW + 10 * 60e3, fetchers: { akash: async () => models } });
  is('no second write inside the hour', store.puts, 1);
  const dead = await gpuBoard({ store: null, now: NOW, fetchers: { akash: async () => { throw new Error('console-api.akash.network 503'); } } });
  is('the market down: an empty board, the error named', [dead.gpus.length, dead.errors], [0, { akash: 'console-api.akash.network 503' }]);
}

console.log('\nthe bubbles — the right assets, as copies');
{
  const coin = (id, sym, mcap) => ({ id: 'cg:' + id, sym, name: sym, mcap, rawImg: 'coincap:' + sym, pc: { h24: 1 } });
  const coins = [
    coin('tao-bittensor', 'TAO', 2.9e9),
    coin('io-ionet', 'IO', 7.1e7),
    coin('io-some-other-io', 'IO', 1e6),          // a second "IO": picked by id, never by ticker
    coin('bitcoin-btc', 'BTC', 2e12),              // not a compute token
  ];
  const stock = (sym, extra = {}) => ({ id: 'stock:' + sym, sym, name: sym, mcap: 1e11, pc: { h24: 2 }, companyKey: sym.toLowerCase(), untrusted: false, ...extra });
  const stocks = [stock('NVDA'), stock('MU'), stock('ARM', { untrusted: true }), stock('TSM'), stock('XYZ'),
    stock('ASML', { untrusted: true, name: 'ASML depositary' })];
  const rows = pickCompute(coins, stocks);
  const ids = rows.map(r => r.id);
  is('tokens by CoinPaprika id: the real IO, not its namesake', ids.filter(x => x.startsWith('cg:')), ['cg:tao-bittensor', 'cg:io-ionet']);
  is('the logo is CoinGecko\'s, not the ticker-keyed one', rows.find(r => r.id === 'cg:io-ionet').rawImg.startsWith('https://coin-images.coingecko.com/'), true);
  is('ARM is a one-share ADS and is admitted', ids.includes('stock:ARM'), true);
  is('any other depositary line is not', ids.includes('stock:ASML'), false);
  is('a company not on the list is not', ids.includes('stock:XYZ'), false);
  is('groups', Object.fromEntries(rows.map(r => [r.sym, r.grp])), { TAO: 'tokens', IO: 'tokens', NVDA: 'chips', TSM: 'chips', ARM: 'chips', MU: 'memory' });
  const nv = rows.find(r => r.sym === 'NVDA');
  is('the screener\'s working fields are not sent', ['untrusted', 'companyKey'].some(k => k in nv), false);
  nv.pc.h24 = 99;
  is('rows are copies: the shared list is untouched', stocks[0].pc.h24, 2);
  is('symbol → CoinGecko id for the long windows', computeCgIds(coins), { TAO: 'bittensor', IO: 'io' });
}

console.log('\nthe open feed — the strip numbers, nothing added');
{
  const board = { at: Date.UTC(2026, 9, 8, 12), gpus: [{ id: 'h100', label: 'H100', price: 2.72, from: 2.04, ch24: null, ch7: -1.5,
    quotes: [{ p: 'akash', typical: 2.72, from: 2.04, avail: 20, total: 68 }] }] };
  const f = gpuFeed(board, null);
  is('one row per model, in the strip\'s numbers', f.gpus[0], { id: 'h100', model: 'H100', usdPerHour: 2.72, fromUsdPerHour: 2.04,
    change24h: null, change7d: -1.5, gpusFree: 20, gpusListed: 68 });
  is('says what the number is', /posted/i.test(f.what) && /not trades/.test(f.what), true);
  is('timestamped', f.at, '2026-10-08T12:00:00.000Z');
  is('no history unless asked', 'history' in f, false);
  const h = gpuFeed(board, { pts: [{ t: Date.UTC(2026, 9, 8, 11), p: { h100: 2.7 } }] });
  is('history on request', h.history, [{ at: '2026-10-08T11:00:00.000Z', usdPerHour: { h100: 2.7 } }]);
  is('no board: not ok, nothing invented', [gpuFeed(null, null).ok, gpuFeed(null, null).gpus.length], [false, 0]);
}

console.log('\nthe lists themselves');
{
  const syms = Object.values(COMPUTE_STOCKS).flat();
  is('no company in two groups', syms.length, new Set(syms).size);
  is('no token twice', COMPUTE_TOKENS.length, new Set(COMPUTE_TOKENS.map(t => t.cp)).size);
  is('every token has a logo and a CoinGecko id', COMPUTE_TOKENS.every(t => /^https:\/\//.test(t.img) && t.cg), true);
  is('every admitted ADS is on a list', [...ADS_OK].every(s => syms.includes(s)), true);
  is('GPU ids unique', GPUS.length, new Set(GPUS.map(x => x.id)).size);
  const evm = COMPUTE_TOKENS.filter(t => t.eth), sol = COMPUTE_TOKENS.filter(t => t.mint);
  is('Ethereum contracts are addresses', evm.every(t => /^0x[0-9a-f]{40}$/.test(t.eth)), true);
  is('Solana mints look like mints', sol.every(t => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.mint)), true);
  is('no token is on two chains here', COMPUTE_TOKENS.every(t => !(t.eth && t.mint)), true);
}

console.log('\nlong windows — a newly added coin does not wait a day');
{
  const day = 86400;
  const t = Math.floor(Date.now() / 1000);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const u = String(url);
    const ids = decodeURIComponent(u.split('/').pop()).split(',');
    const at = u.includes('/historical/') ? +u.split('/historical/')[1].split('/')[0] : t;
    const coins = {};
    for (const k of ids) coins[k] = { price: u.includes('/current/') ? 120 : 100, timestamp: at };
    return new Response(JSON.stringify({ coins }), { status: 200 });
  };
  try {
    const store = { m: new Map(), async get(k) { return this.m.get(k) ?? null; }, async put(k, v) { this.m.set(k, v); } };
    const r1 = await refreshCryptoWin(store, ['TAO'], false, { TAO: 'bittensor' });
    is('a symbol cgmap lacks is priced through its given id', [r1.refreshed, store.m.get('cryptowin').w.TAO.d30], [1, 20]);
    const before = calls;
    const r2 = await refreshCryptoWin(store, ['TAO'], false, { TAO: 'bittensor' });
    is('the same ids inside the day: nothing asked', [r2.fresh, calls - before], [true, 0]);
    const r3 = await refreshCryptoWin(store, ['TAO', 'IO'], false, { TAO: 'bittensor', IO: 'io' });
    is('a new id: read now, not tomorrow', [r3.fresh, r3.refreshed], [undefined, 2]);
    store.m.set('cryptowin', { at: Date.now(), w: { BTC: { d30: 1, y1: 2 } } });
    const r4 = await refreshCryptoWin(store, ['TAO'], false, { TAO: 'bittensor' });
    is('a record from before `tried` existed keeps its day', r4.fresh, true);
    void day;
  } finally { globalThis.fetch = realFetch; }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
