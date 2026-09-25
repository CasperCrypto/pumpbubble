/* ==========================================================================
   The wallet tracker.

       node scripts/tracker.test.mjs

   A followed wallet's swap is read off balances like a group's buy, from the
   wallet's side: it signed, SOL (native or wrapped) went one way and exactly
   one token the other. Everything else — a transfer, an airdrop, a failed
   transaction, a token-for-token route, somebody else's signature — is not
   a trade to tell anyone about.
   ========================================================================== */

import { parseWalletSwaps } from '../src/solbuy.mjs';
import { Audience, memoryStorage, MAX_FOLLOWS } from '../src/audience.mjs';
import { formatSwap } from '../src/tgbot.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const W = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const OTHER = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const MINT = '7V4vYUApSWg1CWBHSxaEWZ8irJAU4q8pPmpZS3mJpump';
const MINT2 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const WSOL = 'So11111111111111111111111111111111111111112';
const SIG = '5'.repeat(88);
const bal = (owner, mint, ui) => ({ owner, mint, uiTokenAmount: { uiAmount: ui, decimals: 6 } });
const tx = ({ signer = W, preSol = 10e9, postSol = 8e9, pre = [], post = [], err = null, fee = 5000 } = {}) => ({
  slot: 1, blockTime: 1_800_000_000,
  transaction: { signatures: [SIG], message: { accountKeys: [{ pubkey: signer, signer: true }, { pubkey: 'Pool1111111111111111111111111111111111111111', signer: false }] } },
  meta: { err, fee, preBalances: [preSol, 0], postBalances: [postSol, 0], preTokenBalances: pre, postTokenBalances: post },
});
const set = new Set([W]);

console.log('\nreading swaps');
{
  const buy = parseWalletSwaps(tx({ post: [bal(W, MINT, 1000)] }), set);
  is('a buy: token up, SOL down', buy.length === 1 && buy[0].side, 'buy');
  is('SOL spent, net of the fee the wallet paid', +buy[0].sol.toFixed(6), 1.999995);
  is('a first buy is a new holder', buy[0].newHolder, true);
  const sell = parseWalletSwaps(tx({ preSol: 8e9, postSol: 10e9, pre: [bal(W, MINT, 1000)], post: [bal(W, MINT, 0)] }), set);
  is('a sell: token down, SOL up', sell[0].side, 'sell');
  is('selling everything says so', sell[0].closed, true);
  const wrapped = parseWalletSwaps(tx({ preSol: 10e9, postSol: 10e9 - 5000, pre: [bal(W, WSOL, 3)], post: [bal(W, WSOL, 1), bal(W, MINT, 50)] }), set);
  is('wrapped SOL counts as SOL', wrapped.length === 1 && +wrapped[0].sol.toFixed(3), 2);
  is('a transfer in is not a buy', parseWalletSwaps(tx({ preSol: 10e9, postSol: 10e9 - 5000, post: [bal(W, MINT, 1000)] }), set).length, 0);
  is('a failed transaction is nothing', parseWalletSwaps(tx({ err: { x: 1 }, post: [bal(W, MINT, 1000)] }), set).length, 0);
  is('a token-for-token swap is left out', parseWalletSwaps(tx({ pre: [bal(W, MINT2, 5)], post: [bal(W, MINT, 1000), bal(W, MINT2, 0)] }), set).length, 0);
  is('a wallet nobody follows is ignored', parseWalletSwaps(tx({ signer: OTHER, post: [bal(OTHER, MINT, 1000)] }), set).length, 0);
  const fromPool = tx({ post: [bal(W, MINT, 1000)] });
  fromPool.transaction.message.accountKeys = [{ pubkey: OTHER, signer: true }, { pubkey: W, signer: false }];
  fromPool.meta.preBalances = [10e9, 10e9]; fromPool.meta.postBalances = [10e9, 8e9];
  is('the followed wallet must have signed', parseWalletSwaps(fromPool, set).length, 0);
}

console.log('\nfollowing');
{
  const a = new Audience(memoryStorage());
  is('follow a wallet', (await a.follow(1, W, 'whale')).added, true);
  is('following it twice keeps one row and the new name', (await a.follow(1, W, 'big whale')).list.length === 1 && (await a.following(1))[0].label, 'big whale');
  await a.follow(2, W);
  const r = await a.route([W]);
  is('a delivery reaches both followers', r.by[W].map(x => x.uid).join(), '1,2');
  is('each with their own name for it', r.by[W][0].label, 'big whale');
  is('every followed wallet is watched', (await a.wallets()).join(), W);
  is('not a wallet is refused', (await a.follow(1, 'nope')).ok, false);
  for (let i = 0; i < MAX_FOLLOWS; i++) await a.follow(3, '1111111111111111111111111111111' + 'ABCDEFGHJKLMN'[i]);
  is(`${MAX_FOLLOWS} is the limit`, (await a.follow(3, OTHER)).ok, false);
  await a.unfollow(1, W);
  is('unfollow removes them from the delivery', (await a.route([W])).by[W].map(x => x.uid).join(), '2');
  await a.smart(5, true); await a.smart(6, true); await a.smart(6, false);
  is('the top-trader switch', (await a.smartFans()).join(), '5');
  await a.add(2); await a.purge(2);
  is('purge ends every follow', (await a.route([W])).by[W], undefined);
  is('and the list entry', await a.count(), 0);
  is('a wallet nobody follows is no longer watched', (await a.wallets()).includes(W), false);
}

console.log('\nthe alert');
{
  const s = { wallet: W, mint: MINT, side: 'buy', sol: 2, tokens: 1000, newHolder: true, sig: SIG };
  const { text, keyboard } = formatSwap({ s, token: { sym: '<b>POK</b>', mcap: 3917, mint: MINT }, who: 'whale <i>', solUsd: 150 });
  is('a buy reads as one', text.startsWith('🟢 <b>BUY</b>'), true);
  is('with the dollars', text.includes('($300)'), true);
  is('names and tickers are escaped', text.includes('<b>POK</b>') || text.includes('whale <i>'), false);
  is('Copy buy opens the swap', keyboard.inline_keyboard[0][0].text === '⚡ Copy buy' && keyboard.inline_keyboard[0][0].url.startsWith('https://'), true);
  const sm = formatSwap({ s: { ...s, side: 'sell', closed: true }, token: { sym: 'POK', mint: MINT }, smart: { rank: 3, when: 'this week', xh: 'CookerFlips', name: 'cooker' }, solUsd: 150 }).text;
  is('a top trader is named with their rank', sm.includes('🧠 @CookerFlips · #3 on pump.fun this week'), true);
  is('a full exit says so', sm.startsWith('🔴 <b>SELL</b>') && sm.includes('sold all'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
