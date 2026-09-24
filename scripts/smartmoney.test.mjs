/* ==========================================================================
   Smart money — what pump.fun's top traders by realized profit are holding.

       node scripts/smartmoney.test.mjs

   The tab's number is "held by N top traders". So what is pinned: a trader
   on two boards is one trader, a token is counted once per holder, more
   holders outranks one rich holder, dust and banned coins never appear, and
   a window pump.fun did not answer stays null.
   ========================================================================== */

import { tradersFrom, holdings, scoreOf, shapeHolding, MIN_VOL, MIN_MCAP } from '../src/smartmoney.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const B58 = '123456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
const W = i => 'W' + B58[i % 50] + 'x'.repeat(40);
const M = i => 'M' + B58[i % 50] + 'y'.repeat(36) + 'pump';
const SOL = 1399811149, RH = 4663;
const pos = (i, chainId = SOL, sym = 'T' + i) => ({ mint: M(i), chainId, symbol: sym, imageUri: 'https://x/' + i + '.png' });
const entry = (i, realized, positions, o = {}) => ({ walletAddress: W(i), username: 'u' + i, xUsername: 'x' + i, realizedPnlUsd: realized, topPositions: positions, ...o });

console.log('\ntraders, each once');
{
  const daily = { entries: [entry(1, 50_000, [pos(1), pos(2)]), entry(2, 30_000, [pos(1)])] };
  const monthly = { entries: [entry(1, 900_000, [pos(3)]), entry(3, 400_000, [pos(1)])] };
  const t = tradersFrom([['daily', daily], ['monthly', monthly]]);
  is('a wallet on two boards is one trader', t.length, 3);
  const one = t.find(x => x.wallet === W(1));
  is('…with their best realized figure', one.realized, 900_000);
  is('…and the positions from every board', one.positions.map(p => p.mint).sort().join(','), [M(1), M(2), M(3)].sort().join(','));
  is('a trader with nothing realized is not a top trader here', tradersFrom([['daily', { entries: [entry(9, 0, [pos(9)])] }]]).length, 0);
  is('a bad wallet is dropped', tradersFrom([['daily', { entries: [{ walletAddress: 'nope', realizedPnlUsd: 5, topPositions: [pos(1)] }] }]]).length, 0);
  is('an X handle that is not a legal handle is not kept', tradersFrom([['daily', { entries: [entry(4, 10, [pos(4)], { xUsername: 'not a handle!' })] }]])[0].xh, '');
}

console.log('\nwho holds what');
{
  const traders = tradersFrom([['daily', { entries: [
    entry(1, 50_000, [pos(1), pos(2)]), entry(2, 30_000, [pos(1)]), entry(3, 5_000_000, [pos(5)]), entry(4, 10, [pos(1)]),
  ] }]]);
  const h = holdings(traders);
  const byMint = new Map(h.map(x => [x.mint, x]));
  is('a token is counted once per holder', byMint.get(M(1)).holders.length, 3);
  is('…richest holder first', byMint.get(M(1)).holders[0].name, 'u1');
  const ranked = h.sort((a, b) => scoreOf(b) - scoreOf(a)).map(x => x.mint);
  is('three holders outrank one whale', ranked[0], M(1));
  is('…the whale’s single token comes next', ranked[1], M(5));
  const rh = holdings(tradersFrom([['daily', { entries: [entry(1, 10, [pos(7, RH)])] }]]));
  is('an unknown chain id is dropped, a known one kept', rh.length === 1 && rh[0].chain === 'robinhood', true);
}

console.log('\ninto a bubble');
{
  const h = { key: M(1), mint: M(1), chain: 'solana', sym: 'GOON', img: '', holders: [
    { wallet: W(1), name: 'u1', xh: 'x1', realized: 50_000 }, { wallet: W(2), name: 'u2', xh: '', realized: 30_000 } ] };
  const coin = { mint: M(1), symbol: 'GOON', name: 'Goon', usd_market_cap: 2_000_000, image_uri: 'https://x/g.png', complete: true };
  const act = { '1h': { priceChangePercent: 4, volumeUSD: 20_000 }, '24h': { priceChangePercent: 31, volumeUSD: 400_000, numBuys: 900, numSells: 800 } };
  const t = shapeHolding(h, coin, act);
  is('held by two', t.smartN, 2);
  is('the card names them, richest first', t.smartWho.map(w => w.name).join(','), 'u1,u2');
  is('market cap from pump.fun’s coin record', t.mcap, 2_000_000);
  is('24h change from pump.fun’s activity', t.pc.h24, 31);
  is('5m was not answered, so it is null — not zero', t.pc.m5, null);
  is('no week, month or year is claimed', [t.pc.d7, t.pc.d30, t.pc.y1].every(v => v === null), true);
  is('it is a token: the mint is kept, so Boost and Buy work', t.mint, M(1));
  is('dust — no volume — is not a bubble', shapeHolding(h, coin, { '24h': { volumeUSD: MIN_VOL - 1 } }), null);
  is('dust — no market cap — is not a bubble', shapeHolding(h, { ...coin, usd_market_cap: MIN_MCAP - 1 }, act), null);
  is('pump.fun’s banned coin is not a bubble', shapeHolding(h, { ...coin, is_banned: true }, act), null);
  /* wrapped ETH, as measured: $324B of cap on $10.9M a day */
  is('a wrapped major carrying the underlying coin’s cap is not a bubble',
    shapeHolding(h, { ...coin, usd_market_cap: 324_287_707_344 }, { ...act, '24h': { ...act['24h'], volumeUSD: 10_870_880 } }), null);
  is('…while a real $330M coin trading $6.6M a day is',
    !!shapeHolding(h, { ...coin, usd_market_cap: 334_341_666 }, { ...act, '24h': { ...act['24h'], volumeUSD: 6_625_364 } }), true);
  const evm = shapeHolding({ ...h, chain: 'robinhood', mint: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' }, coin, act);
  is('a Robinhood token keys by chain and lowercase address', evm.id, 'robinhood:0xabcdef0123456789abcdef0123456789abcdef01');
  is('…with no mint', evm.mint, '');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
