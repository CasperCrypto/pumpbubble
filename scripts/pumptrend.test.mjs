/* ==========================================================================
   pump.fun's trending board, shaped for the map.

       node scripts/pumptrend.test.mjs

   The board is somebody else's ranking and the map draws it under our name,
   so what is checked here is the translation: a window the activity endpoint
   did not answer stays null rather than becoming zero; the one-way rule that
   took USWS off the tab still applies; Robinhood Chain rows land on the right
   chain with the right id shape; and the merge keeps pump.fun's order intact
   above everything we computed ourselves.
   ========================================================================== */

import { shapeMover, MIN_MCAP } from '../src/pumptrend.mjs';
import { mergeMovers, HOT_COUNT } from '../src/trending.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const NOW = 1_800_000_000_000;
const row = (o = {}) => ({
  m: 'GTBxUiw6wJdmmkCGZgRHLyYxqu1vG4KtRpeox6yDpump', c: 'solana:mainnet', n: 'Jean Phil', t: 'JEANPHIL',
  i: 'https://ipfs.io/ipfs/bafy', mc: 9_290_545, vUsd: 21_256_830, vUsd24h: 21_256_830, vUsd1h: 2_521_656,
  p: 100, tx5: 2007, age: 83_820, kol: 43, bc: 100_493, sc: 85_343, txc: 185_836, nh: 16_102,
  t10: 13.37, dh: 1.36, bo: 0.05, pg: 'pump', ath: 12_115_845, ...o,
});
const act = (o = {}) => ({
  '5m': { numTxs: 1702, volumeUSD: 108_919, numBuys: 992, numSells: 710, numBuyers: 570, numSellers: 556, numUsers: 996, priceChangePercent: -5.44 },
  '1h': { numTxs: 30_478, volumeUSD: 2_457_953, numBuys: 16_797, numSells: 13_681, numBuyers: 6637, numSellers: 6013, numUsers: 8835, priceChangePercent: -4.05 },
  '6h': { numTxs: 92_957, volumeUSD: 8_903_743, numBuys: 51_007, numSells: 41_950, numBuyers: 16_369, numSellers: 13_964, numUsers: 20_246, priceChangePercent: 45.7 },
  '24h': { numTxs: 186_290, volumeUSD: 21_283_770, numBuys: 100_723, numSells: 85_567, numBuyers: 28_279, numSellers: 23_453, numUsers: 32_012, priceChangePercent: 280_200 },
  ...o,
});

console.log('\nshape — a Solana row with activity');
{
  const t = shapeMover(row(), act(), 1, 1, NOW);
  is('is a token', !!t, true);
  is('chain', t.chain, 'solana');
  is('id is the mint', t.id, 'GTBxUiw6wJdmmkCGZgRHLyYxqu1vG4KtRpeox6yDpump');
  is('mint set, addr empty', t.mint.length > 30 && t.addr === '', true);
  is('market cap from the board', t.mcap, 9_290_545);
  is('24h volume prefers the activity figure', t.vol, 21_283_770);
  is('24h change from activity', t.pc.h24, 280_200);
  is('5m change from activity', t.pc.m5, -5.44);
  is('long windows are null, not zero', t.pc.d7 === null && t.pc.d30 === null && t.pc.y1 === null, true);
  is('buys/sells from activity 24h', t.txns.buys + '/' + t.txns.sells, '100723/85567');
  is('distinct buyers carried', t.txns.buyers, 28_279);
  is('holders, top10, dev, kol, tx5 carried', [t.holders, t.top10, t.dev, t.kol, t.tx5].join(','), '16102,13.37,1.36,43,2007');
  is('rank and via', t.rank + ':' + t.via, '1:pump');
  is('from pumpfun for a Solana row', t.from, 'pumpfun');
  is('graduated', t.grad, true);
  is('age in hours', Math.round(t.ageH), 23);
  is('new flag under 24h', t.flags.includes('new'), true);
  is('solid', t.solid, true);
  is('rawImg is kept for signing', typeof t.rawImg, 'string');
}

console.log('\nshape — absent is not zero');
{
  const t = shapeMover(row(), undefined, 5, 1, NOW);
  is('no activity → every window null', [t.pc.m5, t.pc.h1, t.pc.h6, t.pc.h24].every(v => v === null), true);
  is('no activity → volume from the board', t.vol, 21_256_830);
  is('no activity → buys/sells from the board lifetime counts', t.txns.buys + '/' + t.txns.sells, '100493/85343');
  is('no activity → no distinct buyers claimed', t.txns.buyers, null);
  is('window says which it was', t.txns.window, 'all');
  const t2 = shapeMover(row(), act({ '24h': undefined }), 5, 1, NOW);
  is('a missing 24h window is null while 1h is present', t2.pc.h24 === null && t2.pc.h1 === -4.05, true);
}

console.log('\nshape — what is refused or flagged');
{
  /* WSOS, seen live at #6: $44M cap, 14 holders, 19 buyers, 2 sells. */
  const t = shapeMover(row({ mc: 44_440_000, nh: 14, bc: 30, sc: 2 }),
    act({ '24h': { numBuys: 33, numSells: 2, numBuyers: 19, numSellers: 2, numUsers: 20, volumeUSD: 90_000, priceChangePercent: 1 } }), 6, 1, NOW);
  is('one-way market flagged', t.flags.includes('oneway'), true);
  is('…and not solid', t.solid, false);
  is('a dust cap is dropped', shapeMover(row({ mc: MIN_MCAP - 1 }), act(), 3, 1, NOW), null);
  is('an unknown chain is dropped', shapeMover(row({ c: 'eip155:1234567' }), act(), 3, 1, NOW), null);
  is('a row with no chain and a base58 mint is Solana', shapeMover(row({ c: '' }), act(), 3, 1, NOW).chain, 'solana');
  is('copycat when the ticker is shared', shapeMover(row(), act(), 3, 3, NOW).flags.includes('copycat'), true);
  is('dev flag at 10%', shapeMover(row({ dh: 12 }), act(), 3, 1, NOW).flags.includes('dev'), true);
  is('no dev flag under 10%', shapeMover(row({ dh: 1.4 }), act(), 3, 1, NOW).flags.includes('dev'), false);
  is('top10 flag at 50%', shapeMover(row({ t10: 57.5 }), act(), 3, 1, NOW).flags.includes('top10'), true);
  is('hostile ticker is cleaned', shapeMover(row({ t: '<b>x</b>' }), act(), 3, 1, NOW).sym.includes('<'), false);
  is('bad address is dropped', shapeMover(row({ m: 'not-an-address' }), act(), 3, 1, NOW), null);
}

console.log('\nshape — Robinhood Chain');
{
  const t = shapeMover(row({ m: '0x181f9463B85c8D40CE9eD4eB64B42fdDe7824Ff5', c: 'eip155:4663', pg: 'pons', t: 'PONS' }), act(), 9, 1, NOW);
  is('chain', t.chain, 'robinhood');
  is('id is chain:lowercase address', t.id, 'robinhood:0x181f9463b85c8d40ce9ed4eb64b42fdde7824ff5');
  is('addr set, mint empty', t.addr.length === 42 && t.mint === '', true);
  is('from robinhood', t.from, 'robinhood');
}

console.log('\nmerge — pump.fun order first, ours after');
{
  const movers = [1, 2, 3].map(r => ({ id: 'm' + r, mint: 'm' + r, rank: r, solid: true, via: 'pump' }));
  movers.push({ id: 'm4', mint: 'm4', rank: 4, solid: false, via: 'pump' });         // one-way, refused
  const ours = [{ id: 'm2', mint: 'm2', heat: 900 }, { id: 'c1', mint: 'c1', heat: 500 }, { id: 'c2', mint: 'c2', heat: 20 }];
  const out = mergeMovers(movers, ours, 10);
  is('order: board ranks, then computed by heat', out.map(t => t.id).join(','), 'm1,m2,m3,c1,c2');
  is('the not-solid board row is gone', out.some(t => t.id === 'm4'), false);
  is('board heat is 1e6/rank', out[0].heat + ',' + out[2].heat, (1e6) + ',' + (1e6 / 3));
  is('a token on both lists is the board row', out[1].via, 'pump');
  is('board heat stays above computed heat', out[2].heat > out[3].heat, true);
  is('hot is the head of the merged list', out.filter(t => t.hot).length, Math.min(HOT_COUNT, out.length));
  is('empty board leaves the computed list', mergeMovers([], ours, 10).map(t => t.id).join(','), 'm2,c1,c2');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
