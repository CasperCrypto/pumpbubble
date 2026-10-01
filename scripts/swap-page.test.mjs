/* ==========================================================================
   The swap page's own code, lifted out of public/swap.html and run.

       node scripts/swap-page.test.mjs

   The page moves real money, so the parts that can be wrong without looking
   wrong are pinned here: amounts are integers in base units end to end (a
   float turns 0.1 SOL into 99999999 lamports), a transaction from Jupiter is
   checked against what was asked for before any wallet sees it, fees are
   counted only when the taker pays them, and a wallet only appears in the
   list when it can actually sign a Solana transaction.

   Markup and script share one file, as on the map, so the same text checks
   apply: every id the script reaches for exists, and the script parses.
   ========================================================================== */

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (Object.is(got, want) || (typeof got === 'bigint' && got === want)
  ? ok(n) : no(n, `got ${typeof got === 'bigint' ? got + 'n' : JSON.stringify(got)}, want ${typeof want === 'bigint' ? want + 'n' : JSON.stringify(want)}`));

const html = readFileSync(new URL('../public/swap.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

/* ------------------------------------------------------------ structure */
try { new Function(script); ok('the page script parses'); }
catch (e) { no('the page script parses', e.message); }

const declared = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
const reached = [...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
const missing = [...new Set(reached.filter(id => !declared.has(id)))];
missing.length ? no('every $(id) the script uses exists', 'missing: ' + missing.join(', '))
  : ok('every $(id) the script uses exists', reached.length + ' references');

is('no third-party script is loaded', /<script\s+src=/i.test(html), false);
is('no iframe', /<iframe/i.test(html), false);
is('the [hidden] rule is global', /\[hidden\]\{display:none!important\}/.test(html), true);

/* --------------------------------------------------- lift and run helpers */
const lift = (...names) => {
  const src = names.map(name => {
    const at = script.search(new RegExp('function ' + name + '\\s*\\('));
    if (at < 0) throw new Error('no function ' + name);
    const open = script.indexOf('{', at);
    let d = 0, i = open;
    for (; i < script.length; i++) {
      if (script[i] === '{') d++;
      else if (script[i] === '}' && --d === 0) { i++; break; }
    }
    return script.slice(at, i);
  }).join('\n');
  return new Function(src + '\nreturn {' + names.join(',') + '};')();
};

const { toUnits, fromUnits, maxSpend } = lift('toUnits', 'fromUnits', 'maxSpend');
is('0.1 SOL is 100000000 lamports', toUnits('0.1', 9), 100000000n);
is('1 token at 6 decimals', toUnits('1', 6), 1000000n);
is('a leading dot', toUnits('.5', 9), 500000000n);
is('digits past the decimals are cut, not rounded up', toUnits('0.1234567899', 9), 123456789n);
is('0.3 has no float residue', toUnits('0.3', 9), 300000000n);
is('garbage is zero', toUnits('abc', 9), 0n);
is('two dots is zero', toUnits('1.2.3', 9), 0n);
is('empty is zero', toUnits('', 9), 0n);
is('a lone dot is zero', toUnits('.', 9), 0n);
is('negative is zero', toUnits('-1', 9), 0n);
is('zero decimals', toUnits('12', 0), 12n);
is('base units back to text', fromUnits('2270690', 6), '2.27069');
is('whole numbers have no dot', fromUnits('1000000000', 9), '1');
is('dust keeps its zeros', fromUnits('5', 9), '0.000000005');
is('zero', fromUnits('0', 6), '0');
is('not a number is zero', fromUnits('bad', 6), '0');
is('round trip', fromUnits(toUnits('22757.970001', 6), 6), '22757.970001');
is('MAX keeps the reserve back', maxSpend(1000000000n, 12000000n), 988000000n);
is('MAX under the reserve is nothing', maxSpend(5000000n, 12000000n), 0n);

const { fmtAmt, fmtUsd, fmtPrice, fmtPct } = lift('trimFix', 'fmtAmt', 'fmtUsd', 'fmtPrice', 'fmtPct');
is('big amounts get commas', fmtAmt('22757.97'), '22,758');
is('millions', fmtAmt('1234567'), '1.23M');
is('small amounts keep four decimals', fmtAmt('2.27069'), '2.2707');
is('under one', fmtAmt('0.1'), '0.1');
is('dust', fmtAmt('0.000000005'), '<0.000001');
is('nothing', fmtAmt('0'), '0');
is('dollars', fmtUsd(11.927), '$11.93');
is('thousands', fmtUsd(1048117), '$1.05M');
is('no dollars is a dash', fmtUsd(0), '—');
is('a price under a dollar keeps four significant digits', fmtPrice(0.5250866), '$0.5251');
is('a tiny price is not exponent notation', fmtPrice(0.00001234), '$0.00001234');
is('an unmeasured change is blank, not +0%', fmtPct(null), '');
is('a gain', fmtPct(206.58), '+207%');
is('a loss uses a real minus', fmtPct(-5.78), '−5.8%');

const { b64ToBytes, bytesToB64, b58 } = lift('b64ToBytes', 'bytesToB64', 'b58');
const sample = new Uint8Array(70000).map((_, i) => (i * 31) % 256);
is('base64 round trip over a chunk boundary', bytesToB64(b64ToBytes(bytesToB64(sample))), bytesToB64(sample));
is('base64 matches Node', bytesToB64(sample), Buffer.from(sample).toString('base64'));
is('base58: the reference vector', b58(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U');
is('base58: leading zeros become ones', b58(new Uint8Array([0, 0, 0x28, 0x7f, 0xb4, 0xcd])), '11233QC4');
is('base58: an all-zero key', b58(new Uint8Array(32)), '1'.repeat(32));

/* ------------------------------------------- what Jupiter hands back */
const { orderOk, netLamports, routeOf, humanErr } = lift('orderOk', 'netLamports', 'routeOf', 'humanErr');
const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'zbwV3VTUHJpgzKhxRysHtoTyhS7dFcVqABkgKWZpump';
const ME = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const want = { inputMint: SOL, outputMint: MINT, amount: '10000000', taker: ME };
const order = { inputMint: SOL, outputMint: MINT, inAmount: '10000000', taker: ME, transaction: 'A'.repeat(800), requestId: 'r-1' };
is('the order that was asked for passes', orderOk(order, want), true);
is('a different output mint is refused', orderOk({ ...order, outputMint: SOL }, want), false);
is('a different amount in is refused', orderOk({ ...order, inAmount: '99999999' }, want), false);
is('a transaction for another wallet is refused', orderOk({ ...order, taker: MINT }, want), false);
is('no transaction, nothing to sign', orderOk({ ...order, transaction: null }, want), false);
is('no request id, nothing to execute', orderOk({ ...order, requestId: '' }, want), false);
is('no wallet, never signed', orderOk(order, { ...want, taker: '' }), false);

is('fees the taker pays are counted', netLamports({ taker: ME,
  signatureFeeLamports: 5000, signatureFeePayer: ME, prioritizationFeeLamports: 8870, prioritizationFeePayer: ME,
  rentFeeLamports: 1488440, rentFeePayer: ME }), 1502310n);
is('fees someone else pays are not', netLamports({ taker: ME,
  signatureFeeLamports: 5000, signatureFeePayer: 'JupiterPays111111111111111111111111111111111', rentFeeLamports: 0, rentFeePayer: null }), 0n);
is('no taker, no fee to show', netLamports({ signatureFeeLamports: 5000 }), 0n);
is('the route names each venue once', routeOf({ routePlan: [
  { swapInfo: { label: 'Pump.fun Amm' } }, { swapInfo: { label: 'Meteora' } }, { swapInfo: { label: 'Pump.fun Amm' } }] }), 'Pump.fun Amm + Meteora');

is('gasless minimum, said plainly', /little SOL/.test(humanErr('Minimum $5 for gasless', 'buy', 'UDR')), true);
is('not enough SOL on a buy', humanErr('Insufficient funds', 'buy', 'UDR'), 'Not enough SOL for this amount plus network fees.');
is('not enough of the token on a sell', humanErr('Insufficient funds', 'sell', 'UDR'), 'You do not hold that much $UDR.');
is('anything else passes through, capped', humanErr('x'.repeat(400), 'buy', 'UDR').length, 160);
is('no quote for a huge amount, said plainly', /smaller amount/.test(humanErr('Failed to get quotes', 'sell', 'USDT')), true);

/* --------------------------------------------------------- wallets */
const { isSolanaWallet, walletIcon, walletLinks } = lift('isSolanaWallet', 'walletIcon', 'walletLinks');
const feat = { 'standard:connect': { connect() {} }, 'solana:signTransaction': { signTransaction() {} } };
is('a Solana wallet that signs is listed', isSolanaWallet({ name: 'Phantom', chains: ['solana:mainnet'], features: feat }), true);
is('sign-and-send alone is enough', isSolanaWallet({ chains: ['solana:mainnet'], features: {
  'standard:connect': {}, 'solana:signAndSendTransaction': {} } }), true);
is('an EVM-only wallet is not', isSolanaWallet({ chains: ['eip155:1'], features: feat }), false);
is('a wallet that cannot sign is not', isSolanaWallet({ chains: ['solana:mainnet'], features: { 'standard:connect': {} } }), false);
is('a wallet that cannot connect is not', isSolanaWallet({ chains: ['solana:mainnet'], features: { 'solana:signTransaction': {} } }), false);
is('junk is not', isSolanaWallet(null), false);
is('a data: icon is shown', walletIcon({ icon: 'data:image/svg+xml;base64,PHN2Zz4=' }).startsWith('data:image/svg+xml'), true);
is('a remote icon is not', walletIcon({ icon: 'https://evil.example/x.png' }), '');
is('a javascript: icon is not', walletIcon({ icon: 'javascript:alert(1)' }), '');
const links = walletLinks('https://pumpbubble.fun/swap?mint=' + MINT, 'https://pumpbubble.fun');
is('phone: open this page inside Phantom', links[0].href,
  'https://phantom.app/ul/browse/' + encodeURIComponent('https://pumpbubble.fun/swap?mint=' + MINT) + '?ref=' + encodeURIComponent('https://pumpbubble.fun'));
is('and inside Solflare', links[1].href.startsWith('https://solflare.com/ul/v1/browse/https%3A%2F%2Fpumpbubble.fun%2Fswap'), true);

const { cleanAmount } = lift('cleanAmount');
is('a comma is a decimal point', cleanAmount('0,5', 9), '0.5');
is('letters are dropped', cleanAmount('1a2', 9), '12');
is('one dot only', cleanAmount('1.2.3', 9), '1.23');
is('decimals capped at the token\'s', cleanAmount('0.1234567', 6), '0.123456');

/* ------------------------------------------------------- the picker */
/* The page opens on the swap; picking a token is a sheet with search, paste,
   popular tokens, the map's trending and the wallet's own. Its rows draw
   token names and art from Jupiter — strings the token's creator chose. */
is('the paste-only first screen is gone', /id="pick"/.test(html), false);
is('the picker is there, with its search', /id="pk"/.test(html) && /id="pkIn"/.test(html), true);
is('both sides of the swap are buttons', /<button class="tok" id="inTok"/.test(html) && /<button class="tok" id="outTok"/.test(html), true);
const popular = [...script.matchAll(/'([1-9A-HJ-NP-Za-km-z]{32,44})', \/\/ [A-Z]+/g)].map(m => m[1]);
is('popular tokens are written as real addresses', popular.length >= 5 && new Set(popular).size === popular.length, true);

const escLine = (script.match(/var esc = function[^\n]*\n/) || [''])[0];
const liftWith = (pre, ...names) => new Function(pre + names.map(name => {
  const at = script.search(new RegExp('function ' + name + '\\s*\\('));
  if (at < 0) throw new Error('no function ' + name);
  let d = 0, i = script.indexOf('{', at);
  for (; i < script.length; i++) { if (script[i] === '{') d++; else if (script[i] === '}' && --d === 0) { i++; break; } }
  return script.slice(at, i);
}).join('\n') + '\nreturn {' + names.join(',') + '};')();
const gwLines = (script.match(/var IPFS_GW = [^\n]*\n/) || [''])[0] + (script.match(/var IPFS_DEAD = [^\n]*\n/) || [''])[0];
const A = liftWith(gwLines, 'ipfsPath', 'iconSrc', 'nextSrc', 'tsym');
const { iconSrc, nextSrc } = A;
const CID = 'bafkreibk3covs5ltyqxa272uodhculbr6kea6betidfwy3ajsav2vjzyum';
is('our signed proxy passes', iconSrc('/api/img?u=x&s=y'), '/api/img?u=x&s=y');
is('https art passes', iconSrc('https://arweave.net/hQiPZOsRZXGXBJd'), 'https://arweave.net/hQiPZOsRZXGXBJd');
is('http art does not', iconSrc('http://example.com/a.png'), '');
is('javascript: does not', iconSrc('javascript:alert(1)'), '');
is('data: does not — that is for wallet icons only', iconSrc('data:image/svg+xml;base64,PHN2Zz4='), '');
is('a quote cannot leave the attribute', iconSrc('https://x.example/a"onerror="alert(1)'), '');
is('nor an angle bracket', iconSrc('https://x.example/<script>'), '');
is('ipfs:// is read from filebase', iconSrc('ipfs://' + CID), 'https://ipfs.filebase.io/ipfs/' + CID);
is('the dead nftstorage gateway (WIF\'s icon) too', iconSrc('https://' + CID + '.ipfs.nftstorage.link'), 'https://ipfs.filebase.io/ipfs/' + CID);
is('and the dead Cloudflare one', iconSrc('https://cf-ipfs.com/ipfs/' + CID), 'https://ipfs.filebase.io/ipfs/' + CID);
is('a path inside the content survives', iconSrc('https://w3s.link/ipfs/' + CID + '/logo.png'), 'https://ipfs.filebase.io/ipfs/' + CID + '/logo.png');
is('a working gateway is left alone', iconSrc('https://ipfs.io/ipfs/' + CID), 'https://ipfs.io/ipfs/' + CID);
is('a failed ipfs.io picture asks filebase', nextSrc('https://ipfs.io/ipfs/' + CID), 'https://ipfs.filebase.io/ipfs/' + CID);
is('then pinata', nextSrc('https://ipfs.filebase.io/ipfs/' + CID), 'https://gateway.pinata.cloud/ipfs/' + CID);
is('then gives up', nextSrc('https://gateway.pinata.cloud/ipfs/' + CID), '');
is('a picture that is not IPFS has no second gateway', nextSrc('https://arweave.net/x'), '');
is('Jupiter\'s "$WIF" is the ticker WIF', A.tsym('$WIF'), 'WIF');

const P = liftWith(escLine + gwLines + 'var SUB = {}, BAD = {};\n', 'trimFix', 'fmtAmt', 'fmtUsd', 'fmtPrice', 'fmtPct', 'short',
  'ipfsPath', 'iconSrc', 'tsym', 'initial', 'live', 'avatar', 'ic', 'fromJup', 'fromFill', 'rowHtml');
is('a ticker never prints two dollar signs', P.rowHtml(P.fromJup({ id: MINT, symbol: '$WIF' }), 0).includes('$$'), false);
const evil = P.fromJup({ id: MINT, symbol: '<img src=x onerror=alert(1)>', name: '"><script>alert(1)</script>',
  icon: 'https://x.example/a.png', decimals: 6, mcap: 1234567, usdPrice: 0.0012, isVerified: true, stats24h: { priceChange: 12.5 } });
const row = P.rowHtml(evil, 0);
is('a hostile symbol is escaped in a row', row.includes('<img src=x'), false);
is('a hostile name is escaped too', row.includes('<script>'), false);
is('Jupiter\'s verified badge shows', row.includes('#i-verified'), true);
is('the row carries its index', /data-i="0"/.test(row), true);
is('a rising token reads green', row.includes('class="up"'), true);
is('decimals come with the row', evil.dec, 6);
const fill = P.fromFill({ mint: MINT, sym: 'UDR', img: '/api/img?u=a&s=b', pc: 18936.4, rank: 1 });
is('a trending row keeps the map\'s rank', P.rowHtml(fill, 3).includes('#1 trending'), true);
is('and its art through our proxy', P.rowHtml(fill, 3).includes('src="/api/img?u=a&amp;s=b"'), true);
is('an unmeasured move is null, not zero', P.fromFill({ mint: MINT, sym: 'X', pc: null }).chg, null);
const held = P.fromJup({ id: MINT, symbol: 'UDR', usdPrice: 2 });
held.bal = '1500'; held.usd = 3000;
is('a wallet row shows what it holds and what that is worth', /1,500 UDR/.test(P.rowHtml(held, 1)) && P.rowHtml(held, 1).includes('<b>$3K</b>'), true);
is('an address Jupiter has not indexed is still offered', P.rowHtml({ mint: MINT, raw: true }, 0).includes('Use this address'), true);

const { sumAmounts } = lift('sumAmounts');
is('token accounts add up exactly', sumAmounts([{ amount: '9007199254740993' }, { amount: '7' }]), 9007199254741000n);
is('junk accounts count as nothing', sumAmounts([{ amount: 'x' }, null, {}]), 0n);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
