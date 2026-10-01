/* ==========================================================================
   EVM buy alerts — decoding Swap events into buys.

       node scripts/evmbuy.test.mjs

   The one thing that must never happen is a sell posted as a buy, and the
   sign conventions differ by DEX: v3 reports the pool's delta, v4 the
   swapper's, v2 and Solidly carry In and Out separately. Each is tested in
   both directions, with the v4 case taken from a real Robinhood Chain swap
   (0x9f0a9e6c…: 0.0026 ETH in, 114,012,650 tokens out).
   ========================================================================== */

import { decodeSwap, buysFrom, poolsFrom, TOPIC, CHAINS, rpcUrls } from '../src/evmbuy.mjs';
import { formatBuy, tokenLinks } from '../src/tgbot.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const w = v => { let b = BigInt(v); if (b < 0n) b += 1n << 256n; return b.toString(16).padStart(64, '0'); };
const data = (...vs) => '0x' + vs.map(w).join('');
const TOKEN = '0x77fb49d6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WETH = '0x4200000000000000000000000000000000000006';
const ETH0 = '0x0000000000000000000000000000000000000000';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

console.log('\ndecoding');
{
  /* v4, real: ETH is currency0, the token currency1; swapper's side */
  const pool = { id: '0x' + '4f'.repeat(32), v4: true, tokenIs0: false, quote: ETH0 };
  const buy = decodeSwap({ topics: [TOPIC.V4, pool.id], data: data(-2600000000000000n, 114012650494706168839450n, 1n, 1n, 0n, 3000n) }, pool);
  is('v4 buy: tokens out', buy.tokenOut, 114012650494706168839450n);
  is('v4 buy: ETH in', buy.quoteIn, 2600000000000000n);
  is('v4 sell is a sell', decodeSwap({ topics: [TOPIC.V4, pool.id], data: data(2600000000000000n, -114012650494706168839450n, 1n, 1n, 0n, 3000n) }, pool), 'sell');

  /* v3: the pool's side — the pool paying out the token is a buy */
  const p3 = { id: '0xpool', tokenIs0: true, quote: WETH };
  const b3 = decodeSwap({ topics: [TOPIC.V3], data: data(-5000n, 7n, 1n, 1n, 0n) }, p3);
  is('v3 buy: pool paid the token', b3 && b3.tokenOut, 5000n);
  is('v3 buy: pool received WETH', b3 && b3.quoteIn, 7n);
  is('v3 sell is a sell', decodeSwap({ topics: [TOPIC.V3], data: data(5000n, -7n, 1n, 1n, 0n) }, p3), 'sell');
  is('pancake v3 decodes like v3', decodeSwap({ topics: [TOPIC.PCS3], data: data(-5000n, 7n, 1n, 1n, 0n, 0n, 0n) }, p3).tokenOut, 5000n);
  const p3b = { ...p3, tokenIs0: false };
  is('v3 with the token as token1', decodeSwap({ topics: [TOPIC.V3], data: data(9n, -40n, 1n, 1n, 0n) }, p3b).tokenOut, 40n);

  /* v2 and Solidly: In and Out */
  const p2 = { id: '0xpair', tokenIs0: false, quote: WETH };
  const b2 = decodeSwap({ topics: [TOPIC.V2], data: data(3n, 0n, 0n, 900n) }, p2);
  is('v2 buy: token1 out, token0 in', b2 && b2.tokenOut, 900n);
  is('v2 sell is a sell', decodeSwap({ topics: [TOPIC.V2], data: data(0n, 900n, 3n, 0n) }, p2), 'sell');
  is('solidly decodes like v2', decodeSwap({ topics: [TOPIC.SOLIDLY], data: data(3n, 0n, 0n, 900n) }, p2).quoteIn, 3n);
  is('an unknown event is nothing', decodeSwap({ topics: ['0xdead'], data: data(1n) }, p2), null);
}

console.log('\nbuys');
{
  const pools = [{ id: '0xpair', tokenIs0: false, quote: WETH }, { id: '0xusd', tokenIs0: true, quote: USDC }];
  const tokens = { [TOKEN]: { sym: 'TOK', dec: 18, supply: 1e9, pools } };
  const logs = [
    { address: '0xPAIR', topics: [TOPIC.V2], data: data(10n ** 16n, 0n, 0n, 10n ** 24n), transactionHash: '0xa', blockNumber: '0x10' },
    { address: '0xusd', topics: [TOPIC.V3], data: data(-(10n ** 24n), 30n * 10n ** 6n, 1n, 1n, 0n), transactionHash: '0xb', blockNumber: '0x11' },
    /* a route through the token: bought in one pool, sold in the other, same tx */
    { address: '0xpair', topics: [TOPIC.V2], data: data(10n ** 16n, 0n, 0n, 10n ** 24n), transactionHash: '0xc', blockNumber: '0x12' },
    { address: '0xusd', topics: [TOPIC.V3], data: data(10n ** 24n, -30n * 10n ** 6n, 1n, 1n, 0n), transactionHash: '0xc', blockNumber: '0x12' },
    { address: '0xother', topics: [TOPIC.V2], data: data(1n, 0n, 0n, 1n), transactionHash: '0xd', blockNumber: '0x12' },
  ];
  const out = buysFrom(logs, tokens, 'base', 3000);
  is('two buys; the route and the stranger are not', out.length, 2);
  const eth = out.find(b => b.tx === '0xa'), usd = out.find(b => b.tx === '0xb');
  is('pool addresses match case-insensitively', !!eth, true);
  is('a WETH buy is priced in ETH', eth.eth, 0.01);
  is('and in dollars at the ETH price', eth.usd, 30);
  is('tokens by the token’s decimals', eth.tokens, 1e6);
  is('market cap from the trade’s own price', Math.round(eth.mcap), 30000);
  is('a USDC buy is priced in dollars', usd.usd, 30);
  is('and in ETH at the ETH price', usd.eth, 0.01);
  is('no ETH price: a WETH buy still counts, in ETH', buysFrom(logs.slice(0, 1), tokens, 'base', 0)[0].eth, 0.01);
}

console.log('\npools');
{
  const pairs = [
    { chainId: 'base', dexId: 'aerodrome', pairAddress: '0xAAAaaaAAAaaaAAAaaaAAAaaaAAAaaaAAAaaaAAAa', baseToken: { address: TOKEN }, quoteToken: { address: WETH }, liquidity: { usd: 5 } },
    { chainId: 'base', dexId: 'uniswap', pairAddress: '0x' + 'ab'.repeat(32), baseToken: { address: TOKEN }, quoteToken: { address: ETH0 }, liquidity: { usd: 50 } },
    { chainId: 'base', dexId: 'uniswap', pairAddress: '0xBBBbbbBBBbbbBBBbbbBBBbbbBBBbbbBBBbbbBBBb', baseToken: { address: TOKEN }, quoteToken: { address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' }, liquidity: { usd: 99 } },
    { chainId: 'ethereum', dexId: 'uniswap', pairAddress: '0xCCCcccCCCcccCCCcccCCCcccCCCcccCCCcccCCCc', baseToken: { address: TOKEN }, quoteToken: { address: WETH }, liquidity: { usd: 999 } },
  ];
  const ps = poolsFrom(pairs, TOKEN, 'base');
  is('pools on the chain asked for, with a priceable other side', ps.length, 2);
  is('deepest first', ps[0].v4, true);
  is('a v4 id is kept whole', ps[0].id, '0x' + 'ab'.repeat(32));
  is('native ETH sorts first in v4: the token is currency1', ps[0].tokenIs0, false);
  is('a cbBTC pool is skipped', ps.some(p => p.id.startsWith('0xbbb')), false);
  is('addresses are lowercased', ps[1].id, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  is('an Alchemy key goes first, then the public list', rpcUrls('robinhood', { ALCHEMY_KEY: 'k' })[0], 'https://robinhood-mainnet.g.alchemy.com/v2/k');
  is('without one, the public RPC', rpcUrls('robinhood', {})[0], CHAINS.robinhood.rpc[0]);
}

console.log('\nthe alert');
{
  const g = { chain: 'base', token: TOKEN, sym: 'TOK', emoji: '🔵', step: 10, style: 'classic', socials: {} };
  const buy = { sol: 0.01, usd: 30, tokens: 1e6, buyer: '0x' + '1'.repeat(40), sig: '0x' + 'f'.repeat(64) };
  const { caption, keyboard } = formatBuy({ buy, token: { sym: 'TOK', mcap: 30000, addr: TOKEN }, group: g, solUsd: 3000, botName: 'pumpbubblebot' });
  is('paid in ETH, not SOL', caption.includes('<b>ETH</b> 0.0100'), true);
  is('in dollars', caption.includes('($30)'), true);
  is('the tx links to basescan', caption.includes('https://basescan.org/tx/0x' + 'f'.repeat(64)), true);
  is('the wallet links to basescan', caption.includes('https://basescan.org/address/0x' + '1'.repeat(40)), true);
  is('no holder claim it cannot back', caption.includes('Position'), false);
  is('market cap from the trade', caption.includes('$30,000'), true);
  const buyUrl = keyboard.inline_keyboard[1][0].url;
  is('Buy goes to our swap on Base', buyUrl, 'https://pumpbubble.fun/swap?chain=base&token=' + TOKEN.toLowerCase());
  is('Chart goes to DexScreener on Base', keyboard.inline_keyboard[0][0].url, 'https://dexscreener.com/base/' + TOKEN);
  is('and on Robinhood Chain, which Uniswap never served', tokenLinks({}, { ...g, chain: 'robinhood' }).buy, 'https://pumpbubble.fun/swap?chain=robinhood&token=' + TOKEN.toLowerCase());
  const bad = formatBuy({ buy: { ...buy, sig: 'javascript:alert(1)', buyer: '<b>' }, token: { sym: '<i>X</i>' }, group: g, solUsd: 3000 }).caption;
  is('a malformed hash or wallet is not a link', bad.includes('javascript:') || bad.includes('address/<b>') || bad.includes('Buyer'), false);
  is('a hostile ticker is escaped', bad.includes('<i>X</i>'), false);
  const sol = formatBuy({ buy: { sol: 1, tokens: 5, newHolder: true, buyer: '', sig: '' }, token: { mint: 'So11111111111111111111111111111111111111112' }, group: { mint: 'So11111111111111111111111111111111111111112', sym: 'S', style: 'classic' }, solUsd: 100 }).caption;
  is('Solana alerts still say SOL and New Holder', sol.includes('<b>SOL</b>') && sol.includes('New Holder'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
