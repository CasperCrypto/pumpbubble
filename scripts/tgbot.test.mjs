/* ==========================================================================
   What the buybot posts, and what it refuses to call a buy.

       node scripts/tgbot.test.mjs

   Two things have to hold without anyone watching. A "buy" alert is only ever
   posted for a wallet whose tokens went up *and* whose SOL went down — a
   transfer, an airdrop and a sell all move token balances and none of them is
   a purchase. And every string a token controls is escaped before it lands in
   an HTML caption posted to somebody else's group: the ticker is typed by the
   minter, and `<b>` has been tried.
   ========================================================================== */

import { parseBuys, buysFromPayload, accountList, signers, MIN_SOL } from '../src/solbuy.mjs';
import { formatBuy, emojiRow, tgEsc, fmtQty, fmtUsd, command, settingsView, EMOJIS, MINBUYS, STEPS, buyTier, buyMeter, solShort, qtyShort } from '../src/tgbot.mjs';
import { heliusKey } from '../src/helius.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
const near = (n, got, want, eps = 1e-9) => (Math.abs(got - want) <= eps ? ok(n) : no(n, `got ${got}, want ${want}`));

/* ---------------------------------------------------------------- fixture */

const MINT = '7V4vYUApSWg1CWBHSxaEWZ8irJAU4q8pPmpZS3mJpump';
const OTHER = '2YKhbSSAwyy7CHmKR7nvPviQe8voXYKoMKQekPwHpump';
const BUYER = 'Fg9ySwkcZGCpAaEuA3ah1u4zQfhbJd14S8TmpoBYiw1F';
const CURVE = '6k8T4fXq5vt3asVnywaHgfw4ApRexGHupbUU8e3TsW1C';
const SIG = '39ZYX34L71Tw9deuaak6mLvYGeZYS1qBK4s9CL8CBSXtFdqhKcYcz64Z37AbwihX6ffDTVfBSZ6PS3b1DM1rVsVq';
const LAM = 1e9;

const bal = (owner, amount, decimals = 6) => ({
  accountIndex: 0, mint: MINT, owner,
  uiTokenAmount: { amount: String(Math.round(amount * 10 ** decimals)), decimals, uiAmount: amount, uiAmountString: String(amount) },
});

/* A pump.fun curve buy: 0.4897 SOL spent plus a 5000-lamport fee, buyer gets
   11,453,237.88 tokens, held none before. */
function buyTx(o = {}) {
  const spent = o.spent ?? 0.4897, fee = 5000;
  const preBuyer = 10 * LAM, postBuyer = preBuyer - spent * LAM - fee;
  return {
    blockTime: 1757600000, slot: 300000000,
    meta: {
      err: o.err ?? null, fee,
      loadedAddresses: { writable: [], readonly: [] },
      preBalances: [preBuyer, 50 * LAM, 1 * LAM],
      postBalances: [postBuyer, 50 * LAM + spent * LAM, 1 * LAM],
      preTokenBalances: [bal(CURVE, 800_000_000), ...(o.held ? [bal(BUYER, o.held)] : [])],
      postTokenBalances: [bal(CURVE, 800_000_000 - 11_453_237.88), bal(BUYER, (o.held || 0) + 11_453_237.88)],
    },
    transaction: { message: { accountKeys: [BUYER, CURVE, MINT], header: { numRequiredSignatures: 1 } }, signatures: [SIG] },
  };
}

/* ------------------------------------------------------------ the parser */

console.log('\nparser — what counts as a buy');
{
  const [b, ...rest] = parseBuys(buyTx(), new Set([MINT]));
  is('one buy from a curve purchase', rest.length, 0);
  is('buyer is the wallet whose tokens rose', b && b.buyer, BUYER);
  near('SOL spent is net of the network fee', b && b.sol, 0.4897, 1e-6);
  near('tokens received', b && b.tokens, 11_453_237.88, 1e-3);
  is('new holder when none were held before', b && b.newHolder, true);
  is('signature carried', b && b.sig, SIG);
  is('decimals carried', b && b.decimals, 6);
}
{
  const [b] = parseBuys(buyTx({ held: 500 }), new Set([MINT]));
  is('existing holder when some were held before', b && b.newHolder, false);
}
is('a failed transaction is not a buy', parseBuys(buyTx({ err: { InstructionError: [0, 'Custom'] } }), new Set([MINT])).length, 0);
is('an untracked mint is ignored', parseBuys(buyTx(), new Set([OTHER])).length, 0);
is('no tracked mints, no work', parseBuys(buyTx(), new Set()).length, 0);

{
  /* A transfer: tokens move from one wallet to another, SOL only pays the fee. */
  const tx = buyTx();
  tx.meta.preBalances = [10 * LAM, 50 * LAM, 1 * LAM];
  tx.meta.postBalances = [10 * LAM - 5000, 50 * LAM, 1 * LAM];
  is('a wallet-to-wallet transfer is not a buy', parseBuys(tx, new Set([MINT])).length, 0);
}
{
  /* An airdrop: tokens arrive, nothing paid at all (someone else paid the fee). */
  const tx = buyTx();
  tx.transaction.message.accountKeys = [CURVE, BUYER, MINT];
  tx.meta.preBalances = [50 * LAM, 10 * LAM, 1 * LAM];
  tx.meta.postBalances = [50 * LAM - 5000, 10 * LAM, 1 * LAM];
  is('an airdrop is not a buy', parseBuys(tx, new Set([MINT])).length, 0);
}
{
  /* A sell: buyer's tokens fall, SOL rises. */
  const tx = buyTx();
  tx.meta.preTokenBalances = [bal(CURVE, 800_000_000), bal(BUYER, 1_000_000)];
  tx.meta.postTokenBalances = [bal(CURVE, 801_000_000), bal(BUYER, 0)];
  tx.meta.preBalances = [10 * LAM, 50 * LAM, 1 * LAM];
  tx.meta.postBalances = [10 * LAM + 0.3 * LAM - 5000, 50 * LAM - 0.3 * LAM, 1 * LAM];
  is('a sell is not a buy', parseBuys(tx, new Set([MINT])).length, 0);
}
{
  /* A bot pays the fee and co-signs; the buyer is the second signer and pays
     for the tokens from their own account. The pool sits in a lookup table. */
  const PAYER = '11111111111111111111111111111112';
  const tx = buyTx();
  tx.transaction.message.accountKeys = [PAYER, BUYER, MINT];
  tx.transaction.message.header = { numRequiredSignatures: 2 };
  tx.meta.loadedAddresses = { writable: [CURVE], readonly: [] };
  const spent = 0.25 * LAM;
  tx.meta.preBalances = [1 * LAM, 10 * LAM, 1 * LAM, 50 * LAM];
  tx.meta.postBalances = [1 * LAM - 5000, 10 * LAM - spent, 1 * LAM, 50 * LAM + spent];
  const [b] = parseBuys(tx, new Set([MINT]));
  is('second signer is the buyer, not the fee payer', b && b.buyer, BUYER);
  near('SOL read from the buyer, no fee deducted for a non-payer', b && b.sol, 0.25, 1e-6);
  is('loaded addresses are appended after static keys', accountList(tx)[3], CURVE);
  is('loaded addresses are not signers', signers(tx).has(CURVE), false);
}
{
  /* The pool side of a sell: tokens up, SOL down, indistinguishable from a
     buyer by balances alone. It did not sign, so it is not reported. */
  const tx = buyTx();
  tx.meta.preTokenBalances = [bal(CURVE, 800_000_000), bal(BUYER, 1_000_000)];
  tx.meta.postTokenBalances = [bal(CURVE, 801_000_000), bal(BUYER, 0)];
  tx.meta.preBalances = [10 * LAM, 50 * LAM, 1 * LAM];
  tx.meta.postBalances = [10 * LAM + 0.3 * LAM - 5000, 50 * LAM - 0.3 * LAM, 1 * LAM];
  is('the pool side of a sell is not a buy', parseBuys(tx, new Set([MINT])).length, 0);
}
{
  /* jsonParsed marks signers explicitly; a non-signer with a positive delta
     is skipped even when listed first. */
  const tx = buyTx();
  tx.transaction.message.accountKeys = [{ pubkey: CURVE, signer: false }, { pubkey: BUYER, signer: true }, { pubkey: MINT, signer: false }];
  delete tx.transaction.message.header;
  tx.meta.preBalances = [50 * LAM, 10 * LAM, 1 * LAM];
  tx.meta.postBalances = [50 * LAM + 0.4897 * LAM, 10 * LAM - 0.4897 * LAM - 5000, 1 * LAM];
  const [b] = parseBuys(tx, new Set([MINT]));
  is('signer flag honoured on object keys', b && b.buyer, BUYER);
}
{
  /* Object-shaped account keys, as jsonParsed encodes them. */
  const tx = buyTx();
  tx.transaction.message.accountKeys = [{ pubkey: BUYER, signer: true }, { pubkey: CURVE }, { pubkey: MINT }];
  is('accountKeys as objects', accountList(tx)[0], BUYER);
  is('still parses', parseBuys(tx, new Set([MINT])).length, 1);
}
{
  /* Two token accounts for the same owner are one holding. */
  const tx = buyTx();
  tx.meta.postTokenBalances = [bal(CURVE, 800_000_000 - 11_453_237.88), bal(BUYER, 10_000_000), bal(BUYER, 1_453_237.88)];
  const [b] = parseBuys(tx, new Set([MINT]));
  near('balances summed per owner', b && b.tokens, 11_453_237.88, 1e-3);
}
{
  const tx = buyTx({ spent: MIN_SOL / 2 });
  is('dust below MIN_SOL is not a buy', parseBuys(tx, new Set([MINT])).length, 0);
}
is('payload as array', buysFromPayload([buyTx(), buyTx()], new Set([MINT])).length, 2);
is('payload as single object', buysFromPayload(buyTx(), new Set([MINT])).length, 1);
is('payload as wrapper', buysFromPayload({ transactions: [buyTx()] }, new Set([MINT])).length, 1);
is('garbage payload is zero buys, not a throw', buysFromPayload([null, 42, 'x', {}], new Set([MINT])).length, 0);

/* --------------------------------------------------------- the formatter */

console.log('\nformatter — what reaches the group');
const group = { chatId: -100, mint: MINT, sym: 'POK', emoji: '✔️', step: 20, style: 'classic', socials: { web: 'https://pokmart.com/', x: 'https://x.com/pokmartcom' } };
const token = { mint: MINT, sym: 'POK', name: 'Pokmart', mcap: 3917, grad: false, price: 0.00000034 };
const buy = { mint: MINT, buyer: BUYER, sol: 0.4897, tokens: 11_453_237.88, newHolder: true, sig: SIG };

{
  const { caption, keyboard } = formatBuy({ buy, token, group, solUsd: 104, botName: 'pumpbubblebot' });
  ok('caption', '\n' + caption.split('\n').map(l => '        ' + l).join('\n'));
  is('header names the token', caption.includes('<b>POK BUY!</b>'), true);
  is('new holder flagged 🆕', caption.startsWith('🆕'), true);
  is('SOL and dollars', caption.includes('SOL</b> 0.4897 ($50.93)'), true);
  is('token amount with separators', caption.includes('11,453,237.88'), true);
  is('tx link', caption.includes('solscan.io/tx/' + SIG), true);
  is('wallet link', caption.includes('solscan.io/account/' + BUYER), true);
  is('market cap', caption.includes('<b>MCap:</b> $3,917'), true);
  is('socials rendered', caption.includes('pokmart.com') && caption.includes('x.com/pokmartcom'), true);
  is('bonding token charts on pump.fun', keyboard.inline_keyboard[0][0].url.startsWith('https://pump.fun/coin/'), true);
  is('bubble button is the share page', keyboard.inline_keyboard[0][1].url, 'https://pumpbubble.fun/s/' + MINT);
  is('boost button opens the purchase in the bot', keyboard.inline_keyboard[1][1].url, 'https://t.me/pumpbubblebot?start=boost_' + MINT);
  is('the unsold sponsor line sells itself', caption.includes('t.me/pumpbubblebot?start=ads'), true);
  const nameless = formatBuy({ buy: { sol: 1, tokens: 1, newHolder: false }, token: { mint: MINT, sym: 'X' }, group: { mint: MINT, sym: 'X' }, solUsd: 1 });
  is('without the bot’s name, boost falls back to the site', nameless.keyboard.inline_keyboard[1][1].url, 'https://pumpbubble.fun/?boost=' + MINT);
  const paid = formatBuy({ buy: { sol: 1, tokens: 1, newHolder: false }, token: { mint: MINT, sym: 'X' }, group: { mint: MINT, sym: 'X', style: 'classic' }, solUsd: 1,
    botName: 'pumpbubblebot', ad: { title: '$<b>ZCAT</b>', name: 'Anon <i>Cat</i>', url: 'https://pumpbubble.fun/s/' + MINT } });
  is('a paid sponsor line links the token', paid.caption.includes('📣 <b>Ad:</b> <a href="https://pumpbubble.fun/s/' + MINT + '">'), true);
  is('its ticker and name are escaped', paid.caption.includes('<b>ZCAT</b>') || paid.caption.includes('<i>Cat</i>'), false);
  const sm = formatBuy({ buy: { sol: 1, tokens: 1, newHolder: false }, token: { mint: MINT, sym: 'X' }, group: { mint: MINT, sym: 'X', style: 'classic' }, solUsd: 1,
    smart: { rank: 3, when: 'this week', realized: 74400, xh: 'CookerFlips', name: 'cooker' } }).caption;
  is('a top trader’s buy is tagged', sm.includes('🧠 <b>SMART BUY</b> — @CookerFlips, #3 on pump.fun this week by profit banked (+$74,400)'), true);
  const sm2 = formatBuy({ buy: { sol: 1, tokens: 1, newHolder: false }, token: { mint: MINT, sym: 'X' }, group: { mint: MINT, sym: 'X' }, solUsd: 1,
    smart: { rank: 7, when: 'today', realized: 1000, xh: 'not a handle!', name: '<b>x</b>' } }).caption;
  is('no @ on an illegal handle, and the name is escaped', sm2.includes('@not') || sm2.includes('<b>x</b>'), false);
  is('no tag for an ordinary buyer', formatBuy({ buy: { sol: 1, tokens: 1 }, token: { mint: MINT }, group: { mint: MINT }, solUsd: 1 }).caption.includes('SMART'), false);
  const kol = formatBuy({ buy: { sol: 1, tokens: 1, newHolder: false }, token: { mint: MINT, sym: 'X' }, group: { mint: MINT, sym: 'X', style: 'classic' }, solUsd: 1,
    caller: { rank: 2, xh: 'BeanCalls', name: 'bean', hit2: 0.625, n: 16 } }).caption;
  is('a top caller’s buy is tagged, with their record', kol.includes('📣 <b>TOP CALLER BUY</b> — @BeanCalls, #2 caller on pump.fun this week — 63% of their 16 calls hit 2×'), true);
  const kol2 = formatBuy({ buy: { sol: 1, tokens: 1, newHolder: false }, token: { mint: MINT, sym: 'X' }, group: { mint: MINT, sym: 'X' }, solUsd: 1,
    caller: { rank: 9, xh: '', name: '<i>sneaky</i>', hit2: null, n: 0 } }).caption;
  is('a caller with no handle is named, escaped, and no record is invented', kol2.includes('<i>sneaky</i>') || kol2.includes('% of'), false);
  const both = formatBuy({ buy: { sol: 1, tokens: 1, newHolder: false }, token: { mint: MINT, sym: 'X' }, group: { mint: MINT, sym: 'X', style: 'classic' }, solUsd: 1,
    smart: { rank: 3, when: 'this week', realized: 74400, xh: 'CookerFlips' }, caller: { rank: 2, xh: 'CookerFlips', hit2: 0.5, n: 10 } }).caption;
  is('a wallet that is both says both', both.includes('SMART BUY') && both.includes('TOP CALLER BUY'), true);
  const bad = formatBuy({ buy: { sol: 1, tokens: 1, newHolder: false }, token: { mint: MINT, sym: 'X' }, group: { mint: MINT, sym: 'X' }, solUsd: 1,
    ad: { title: '$X', url: 'javascript:alert(1)' } });
  is('an ad with a non-http link is not printed', bad.caption.includes('javascript:'), false);
  is('buy button opens our swap page when no referral is set', keyboard.inline_keyboard[1][0].url, 'https://pumpbubble.fun/swap?mint=' + MINT);
}
{
  const { keyboard } = formatBuy({ buy, token: { ...token, grad: true }, group, solUsd: 104 });
  is('graduated token charts on DexScreener', keyboard.inline_keyboard[0][0].url.startsWith('https://dexscreener.com/solana/'), true);
}
{
  const { keyboard } = formatBuy({ buy, token, group, solUsd: 104, env: { REF_PROVIDER: 'jupiter', REF_CODE: 'abc' } });
  is('buy button uses the referral when configured', /jup/.test(keyboard.inline_keyboard[1][0].url) && !/jup\.ag\/swap\/SOL-/.test(keyboard.inline_keyboard[1][0].url) || keyboard.inline_keyboard[1][0].url.includes('abc'), true);
}
{
  const { caption } = formatBuy({ buy: { ...buy, sol: 12, newHolder: false }, token, group, solUsd: 104 });
  is('four figures is a whale 🐋', caption.startsWith('🐋'), true);
}
{
  const { caption } = formatBuy({ buy: { ...buy, newHolder: false }, token, group, solUsd: 104 });
  is('existing holder is 🟢', caption.startsWith('🟢'), true);
  is('position reads Holder', caption.includes('<b>Position:</b> Holder'), true);
}
{
  const { caption } = formatBuy({ buy, token, group, solUsd: 104, test: true });
  is('test alerts say so', caption.startsWith('🧪 <b>TEST</b>'), true);
}

console.log('\nformatter — the bubble style (the default)');
{
  const bub = { ...group, style: undefined };
  const { caption, keyboard } = formatBuy({ buy, token, group: bub, solUsd: 104, botName: 'pumpbubblebot', rank: { rank: 4 } });
  ok('caption', '\n' + caption.split('\n').map(l => '        ' + l).join('\n'));
  const [t50] = [buyTier(50.93)];
  is('the title: tier, token and the dollars', caption.split('\n')[0], t50[1] + ' <b>POK BUY</b> · <b>$50.93</b>');
  is('the meter and the tier', caption.split('\n')[1], '<b>' + buyMeter(50.93) + '</b> ' + t50[2]);
  is('the receipt: short numbers, then market cap and new holder, then the links',
    /<blockquote>0\.4897 SOL → <b>11\.45M POK<\/b>\nMCap <b>\$3,917<\/b> · 🆕 New holder\n<a href="https:\/\/solscan\.io\/tx\/[^"]+">Tx<\/a> · <a href="https:\/\/solscan\.io\/account\/[^"]+">Buyer<\/a> · <a href="https:\/\/pokmart\.com\/">Web<\/a> · <a href="https:\/\/x\.com\/pokmartcom">𝕏<\/a><\/blockquote>/.test(caption), true);
  is('no row of emoji, no "by @bot" line, no blank lines', caption.includes('✔️✔️') || caption.includes('by @') || caption.includes('\n\n'), false);
  is('its place on the map and the open ad slot, on one line', caption.split('\n').pop(),
    '🫧 <a href="https://pumpbubble.fun/s/' + MINT + '">#4 trending on pumpbubble</a> · <a href="https://t.me/pumpbubblebot?start=ads">📢 Your token here</a>');
  is('six lines when nobody notable bought', caption.split('\n').length, 6);
  is('the same buttons', keyboard.inline_keyboard[1][0].url, 'https://pumpbubble.fun/swap?mint=' + MINT);
  is('tiers by size', [5, 150, 900, 3000, 25000].map(u => buyTier(u)[2]).join(' '), 'SHRIMP FISH DOLPHIN SHARK WHALE');
  is('the meter grows with the buy', [10, 100, 1000, 10000, 100000].map(u => buyMeter(u).split('█').length - 1).join(' '), '2 4 6 8 10');
  is('nothing bought, an empty meter', buyMeter(0), '░'.repeat(10));
  is('half a SOL reads 0.5', solShort(0.5), '0.5');
  is('and 12.3456 reads 12.35', solShort(12.3456), '12.35');
  is('and 250 reads 250', solShort(250), '250');
  is('a token amount in millions', qtyShort(11453237.88), '11.45M');
  is('in thousands, whole', qtyShort(10455.88), '10,456');
  is('in billions', qtyShort(2.5e9), '2.5B');
  const tagged = formatBuy({ buy, token, group: bub, solUsd: 104,
    smart: { rank: 3, when: 'this week', realized: 74400, xh: 'CookerFlips' }, caller: { rank: 2, xh: 'BeanCalls', hit2: 0.625, n: 16 } }).caption;
  is('a top trader, said short', tagged.includes('🧠 <b>Smart buy</b> · @CookerFlips · #3 on pump.fun this week · +$74,400 banked'), true);
  is('a top caller, said short', tagged.includes('📣 <b>Top caller</b> · @BeanCalls · #2 this week · 63% of 16 calls hit 2×'), true);
  is('a test says so, quietly', formatBuy({ buy, token, group: bub, solUsd: 104, test: true }).caption.split('\n')[0].endsWith('· <i>test</i>'), true);
  const paidAd = formatBuy({ buy, token, group: bub, solUsd: 104, botName: 'pumpbubblebot', ad: { title: '$ZCAT', name: 'Anon Cat', url: 'https://pumpbubble.fun/s/' + MINT } }).caption;
  is('a paid ad gets its own line', paidAd.includes('📢 <b>Ad</b> · <a href="https://pumpbubble.fun/s/' + MINT + '">$ZCAT</a> — Anon Cat'), true);
  is('and the open-slot pitch steps aside', paidAd.includes('Your token here'), false);
  const evil = formatBuy({ buy, token: { ...token, sym: '<b>x</b>' }, group: { ...bub, sym: '<b>x</b>' }, solUsd: 104 }).caption;
  is('a hostile ticker cannot inject markup here either', /<b>x<\/b>|<img/.test(evil), false);
  is('a rank past fifty is not claimed', formatBuy({ buy, token, group: bub, solUsd: 104, rank: { rank: 80 } }).caption.includes('#80'), false);
  const evm = formatBuy({ buy: { sol: 0.01, usd: 30, tokens: 1e6, buyer: '0x' + '1'.repeat(40), sig: '0x' + 'f'.repeat(64) },
    token: { sym: 'TOK', mcap: 30000 }, group: { chain: 'base', token: '0x' + 'a'.repeat(40), sym: 'TOK' }, solUsd: 3000 }).caption;
  is('an EVM buy pays in ETH and links Basescan', evm.includes('0.01 ETH → <b>1M TOK</b>') && evm.includes('basescan.org/tx/'), true);
  is('and claims nothing about holding', evm.includes('New holder'), false);
  const sv = settingsView({ sym: 'POK', emoji: '🐸', step: 20 }, 'style');
  is('the style page offers both, bubble ticked', sv.kb[0].map(b => b.text).join(' | '), '✅ 🫧 Bubble | 😀 Classic');
  is('the main settings name the style', settingsView({ sym: 'POK', style: 'classic' }).text.includes('Style Classic'), true);
}

console.log('\nformatter — hostile input');
{
  const evil = { ...token, sym: '<b>x</b>', name: '<img src=x onerror=alert(1)>' };
  const { caption } = formatBuy({ buy, token: evil, group: { ...group, sym: '<b>x</b>' }, solUsd: 104 });
  /* clean() strips the brackets server-side before tgEsc ever sees them, so
     the assertion is the outcome — the header carries exactly our one <b> —
     not the mechanism. */
  const head = caption.split('\n')[0];
  is('ticker cannot inject markup into the header', (head.match(/<\/?b>/g) || []).length, 2);
  is('no raw tag survives from the token', /<img/.test(caption), false);
}
{
  const bad = { ...group, socials: { web: 'javascript:alert(1)', x: 'data:text/html,hi', tg: 'https://t.me/ok' } };
  const { caption } = formatBuy({ buy, token, group: bad, solUsd: 104 });
  is('javascript: link dropped', caption.includes('javascript:'), false);
  is('data: link dropped', caption.includes('data:'), false);
  is('https link kept', caption.includes('https://t.me/ok'), true);
}
{
  const { caption } = formatBuy({ buy, token, group: { ...group, socials: { web: 'https://a.b/?x=1&y="><script>' } }, solUsd: 104 });
  is('attribute-breaking characters escaped in href', caption.includes('&quot;&gt;&lt;script&gt;') || !caption.includes('"><script>'), true);
}
{
  const { caption } = formatBuy({ buy, token, group: { ...group, emoji: '<script>' }, solUsd: 104 });
  is('emoji is escaped too', caption.includes('<script>'), false);
}
{
  const { caption } = formatBuy({ buy: { ...buy, sig: '<b>', buyer: 'not-a-key' }, token, group, solUsd: 104 });
  is('a malformed signature gets no link', caption.includes('solscan.io/tx/'), false);
  is('a malformed wallet gets no link', caption.includes('solscan.io/account/'), false);
}

console.log('\nhelpers');
is('emojiRow $0 → 1', emojiRow(0, '🟢', 20), '🟢');
is('emojiRow $50 / step 20 → 3', emojiRow(50, '🟢', 20), '🟢🟢🟢');
is('emojiRow caps at 30', [...emojiRow(1e9, '🟢', 20)].length, 30);
is('emojiRow escapes', emojiRow(0, '<', 20), '&lt;');
is('tgEsc', tgEsc('a<b>&c'), 'a&lt;b&gt;&amp;c');
is('fmtQty big', fmtQty(11453237.88), '11,453,237.88');
is('fmtQty small', fmtQty(0.00001234), '0.00001234');
is('fmtUsd', fmtUsd(3917), '$3,917');
is('fmtUsd M', fmtUsd(2_450_000), '$2.45M');
is('command bare', JSON.stringify(command('/setup')), JSON.stringify({ cmd: 'setup', arg: '' }));
is('command with bot suffix and arg', JSON.stringify(command('/setup@pumpbubblebot ' + MINT)), JSON.stringify({ cmd: 'setup', arg: MINT }));
is('command case-insensitive', command('/SETUP x').cmd, 'setup');
is('not a command', command('hello /setup'), null);
is('helius key from HELIUS_KEY', heliusKey({ HELIUS_KEY: 'k1' }), 'k1');
is('helius key parsed from a Helius RPC URL', heliusKey({ SOLANA_RPC: 'https://mainnet.helius-rpc.com/?api-key=abc-123' }), 'abc-123');
is('no key from a non-Helius RPC', heliusKey({ SOLANA_RPC: 'https://api.mainnet-beta.solana.com' }), '');

/* ---------------------------------------------------------- settings menu */
{
  const g = { sym: '<b>X&Y</b>', emoji: '🔥', step: 50, minBuy: 25, media: null, socials: { x: 'https://x.com/a', web: 'javascript:alert(1)' } };
  const pages = ['main', 'emoji', 'min', 'step', 'media', 'links', 'stop'];
  const all = pages.flatMap(p => settingsView(g, p).kb.flat());
  const enc = new TextEncoder();
  is('every settings button fits Telegram’s 64-byte callback limit', all.every(b => enc.encode(b.callback_data).length <= 64), true);
  is('every settings button is a cfg: action', all.every(b => /^cfg:[a-z]+(:[a-z0-9]+)?$/.test(b.callback_data)), true);
  is('a hostile ticker is escaped on every page', pages.every(p => !settingsView(g, p).text.includes('<b>X&Y</b>')), true);
  is('main page: style, media, emoji, min, step, test, links, guard, stop', settingsView(g).kb.flat().length, 9);
  is('the current emoji is ticked', settingsView(g, 'emoji').kb.flat().find(b => b.text.startsWith('✅')).callback_data, 'cfg:emoji:' + EMOJIS.indexOf('🔥'));
  is('the current minimum is ticked', settingsView(g, 'min').kb.flat().find(b => b.text.startsWith('✅')).callback_data, 'cfg:min:' + MINBUYS.indexOf(25));
  is('the current step is ticked', settingsView(g, 'step').kb.flat().find(b => b.text.startsWith('✅')).callback_data, 'cfg:step:' + STEPS.indexOf(50));
  is('a zero minimum reads "All"', settingsView({ ...g, minBuy: 0 }, 'min').kb[0][0].text, '✅ All');
  is('no media, no Remove button', settingsView(g, 'media').kb.flat().some(b => b.callback_data === 'cfg:media:off'), false);
  is('media set, Remove appears', settingsView({ ...g, media: { kind: 'photo', id: 'f' } }, 'media').kb.flat().some(b => b.callback_data === 'cfg:media:off'), true);
  is('a javascript: link is not listed', settingsView(g, 'links').text.includes('Web'), false);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
