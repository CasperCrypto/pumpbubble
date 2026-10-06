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

import { shapeCoin, chainOf, MIN_MCAP, HOT_RANKS } from '../src/pumptrend.mjs';
import { mergeMovers, HOT_COUNT } from '../src/trending.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const NOW = 1_800_000_000_000;
/* A great-coins row, as pump.fun returns it. */
const coin = (o = {}) => ({
  mint: 'GTBxUiw6wJdmmkCGZgRHLyYxqu1vG4KtRpeox6yDpump', name: 'Jean Phil', symbol: 'JEANPHIL',
  image_uri: 'https://ipfs.io/ipfs/bafy', created_timestamp: NOW - 83_820_000, complete: true,
  last_trade_timestamp: NOW - 1000, market_cap: 79_457, usd_market_cap: 8_743_974, ath_market_cap: 110_000,
  chain_id: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', protocol: 'pump', verified: false, boost_mode: 'COMPLETED',
  website: 'https://linktr.ee/JeanPhilanthrope', is_banned: false, ...o,
});
/* Its movers-board entry, for the extras. */
const extra = (o = {}) => ({ nh: 16_102, t10: 13.37, dh: 1.36, kol: 43, tx5: 2007, bc: 100_493, sc: 85_343, vUsd24h: 21_256_830, vUsd1h: 2_521_656, ...o });
const act = (o = {}) => ({
  '5m': { numTxs: 1702, volumeUSD: 108_919, numBuys: 992, numSells: 710, numBuyers: 570, numSellers: 556, numUsers: 996, priceChangePercent: -5.44 },
  '1h': { numTxs: 30_478, volumeUSD: 2_457_953, numBuys: 16_797, numSells: 13_681, numBuyers: 6637, numSellers: 6013, numUsers: 8835, priceChangePercent: -4.05 },
  '6h': { numTxs: 92_957, volumeUSD: 8_903_743, numBuys: 51_007, numSells: 41_950, numBuyers: 16_369, numSellers: 13_964, numUsers: 20_246, priceChangePercent: 45.7 },
  '24h': { numTxs: 186_290, volumeUSD: 21_283_770, numBuys: 100_723, numSells: 85_567, numBuyers: 28_279, numSellers: 23_453, numUsers: 32_012, priceChangePercent: 280_200 },
  ...o,
});

console.log('\nshape — a Solana row with activity and board extras');
{
  const t = shapeCoin(coin(), act(), extra(), 1, 1, NOW);
  is('is a token', !!t, true);
  is('chain from a genesis-hash chain id', t.chain, 'solana');
  is('id is the mint', t.id, 'GTBxUiw6wJdmmkCGZgRHLyYxqu1vG4KtRpeox6yDpump');
  is('mint set, addr empty', t.mint.length > 30 && t.addr === '', true);
  is('market cap in USD', t.mcap, 8_743_974);
  is('24h volume from activity', t.vol, 21_283_770);
  is('24h change from activity', t.pc.h24, 280_200);
  is('5m change from activity', t.pc.m5, -5.44);
  is('long windows are null, not zero', t.pc.d7 === null && t.pc.d30 === null && t.pc.y1 === null, true);
  is('buys/sells from activity 24h', t.txns.buys + '/' + t.txns.sells, '100723/85567');
  is('distinct buyers carried', t.txns.buyers, 28_279);
  is('holders, top10, dev, kol, tx5 from the board', [t.holders, t.top10, t.dev, t.kol, t.tx5].join(','), '16102,13.37,1.36,43,2007');
  is('rank, via, HOT', t.rank + ':' + t.via + ':' + t.pumpHot, '1:pump:true');
  is('from pumpfun for a Solana row', t.from, 'pumpfun');
  is('graduated', t.grad, true);
  is('age in hours', Math.round(t.ageH), 23);
  is('new flag under 24h', t.flags.includes('new'), true);
  is("ath scaled from SOL to USD by the row's own ratio", Math.round(t.ath), Math.round(110_000 * 8_743_974 / 79_457));
  is('website kept when https', t.website.startsWith('https://'), true);
  is('solid', t.solid, true);
  is('rawImg is kept for signing', typeof t.rawImg, 'string');
  is('not HOT past the fifth row', shapeCoin(coin(), act(), extra(), HOT_RANKS + 1, 1, NOW).pumpHot, false);
}

console.log('\nshape — absent is not zero');
{
  const t = shapeCoin(coin(), undefined, undefined, 5, 1, NOW);
  is('no activity, no board → every window null', [t.pc.m5, t.pc.h1, t.pc.h6, t.pc.h24].every(v => v === null), true);
  is('no activity, no board → volume is 0 and nothing is claimed', t.vol, 0);
  is('no activity, no board → no txns at all', t.txns, null);
  is('no board → holders null', t.holders, null);
  const t2 = shapeCoin(coin(), undefined, extra(), 5, 1, NOW);
  is('no activity, board present → lifetime buys/sells from the board', t2.txns.buys + '/' + t2.txns.sells, '100493/85343');
  is('…and no distinct buyers claimed', t2.txns.buyers, null);
  is('…window says which it was', t2.txns.window, 'all');
  is('…volume from the board', t2.vol, 21_256_830);
  const t3 = shapeCoin(coin(), act({ '24h': undefined }), extra(), 5, 1, NOW);
  is('a missing 24h window is null while 1h is present', t3.pc.h24 === null && t3.pc.h1 === -4.05, true);
}

console.log('\nshape — what is refused or flagged');
{
  /* WSOS, seen live at #6 on the movers board: $44M cap, 14 holders, 19 buyers, 2 sells. */
  const t = shapeCoin(coin({ usd_market_cap: 44_440_000 }),
    act({ '24h': { numBuys: 33, numSells: 2, numBuyers: 19, numSellers: 2, numUsers: 20, volumeUSD: 90_000, priceChangePercent: 1 } }), extra({ nh: 14 }), 6, 1, NOW);
  is('one-way market flagged', t.flags.includes('oneway'), true);
  is('…and not solid', t.solid, false);
  is('a banned coin is not solid', shapeCoin(coin({ is_banned: true }), act(), extra(), 3, 1, NOW).solid, false);
  is('dust is dropped', shapeCoin(coin({ usd_market_cap: MIN_MCAP - 1 }), act(), extra(), 3, 1, NOW), null);
  is('an unknown chain is dropped', shapeCoin(coin({ chain_id: 'eip155:1234567' }), act(), extra(), 3, 1, NOW), null);
  is('no chain id and a base58 mint is Solana', shapeCoin(coin({ chain_id: undefined }), act(), extra(), 3, 1, NOW).chain, 'solana');
  is('copycat when the ticker is shared', shapeCoin(coin(), act(), extra(), 3, 3, NOW).flags.includes('copycat'), true);
  is('dev flag at 10%', shapeCoin(coin(), act(), extra({ dh: 12 }), 3, 1, NOW).flags.includes('dev'), true);
  is('no dev flag under 10%', shapeCoin(coin(), act(), extra({ dh: 1.4 }), 3, 1, NOW).flags.includes('dev'), false);
  is('top10 flag at 50%', shapeCoin(coin(), act(), extra({ t10: 57.5 }), 3, 1, NOW).flags.includes('top10'), true);
  is('hostile ticker is cleaned', shapeCoin(coin({ symbol: '<b>x</b>' }), act(), extra(), 3, 1, NOW).sym.includes('<'), false);
  is('javascript: website is dropped', shapeCoin(coin({ website: 'javascript:alert(1)' }), act(), extra(), 3, 1, NOW).website, '');
  is('bad address is dropped', shapeCoin(coin({ mint: 'not-an-address' }), act(), extra(), 3, 1, NOW), null);
}

console.log('\nshape — other chains');
{
  const t = shapeCoin(coin({ mint: '0x181f9463B85c8D40CE9eD4eB64B42fdDe7824Ff5', chain_id: 'eip155:4663', protocol: 'pons', symbol: 'FN' }), act(), undefined, 9, 1, NOW);
  is('Robinhood Chain', t.chain, 'robinhood');
  is('id is chain:lowercase address', t.id, 'robinhood:0x181f9463b85c8d40ce9ed4eb64b42fdde7824ff5');
  is('addr set, mint empty', t.addr.length === 42 && t.mint === '', true);
  is('from robinhood', t.from, 'robinhood');
  is('BSC', shapeCoin(coin({ mint: '0xD83e689e1637a4B2175a312DCeF1Cd2063457777', chain_id: 'eip155:56' }), act(), undefined, 9, 1, NOW).chain, 'bsc');
  is("chainOf handles the board's form too", chainOf('solana:mainnet', ''), 'solana');
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

console.log('\nmerge — one bubble per ticker');
{
  const movers = [
    { id: 'a', mint: 'a', sym: 'MISO', rank: 1, solid: true },
    { id: 'b', mint: 'b', sym: 'LAMBO', rank: 2, solid: true },
    { id: 'c', mint: 'c', sym: 'miso', rank: 3, solid: true },       // same ticker, lower rank
    { id: 'd', mint: 'd', sym: '', rank: 4, solid: true },           // no ticker: never merged away
    { id: 'e', mint: 'e', sym: '', rank: 5, solid: true },
  ];
  const ours = [{ id: 'f', mint: 'f', sym: 'LAMBO', heat: 900 }, { id: 'g', mint: 'g', sym: 'LIT', heat: 500 }, { id: 'h', addr: '0xh', sym: 'LIT', heat: 400 }];
  const out = mergeMovers(movers, ours, 20);
  is('the higher-ranked MISO stays, the other goes', out.map(t => t.id).join(','), 'a,b,d,e,g');
  is('pump.fun rank survives the gap', out.find(t => t.id === 'd').heat, 1e6 / 4);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
