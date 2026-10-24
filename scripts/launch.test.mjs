/* ==========================================================================
   The Launch Kit (src/launch.mjs, src/tokenpage.mjs).

       node scripts/launch.test.mjs

   What is pinned:
     - a real PumpPortal create (an unsigned one, built for a public address
       and a throwaway key) reads as two signers, the creator paying, the
       token key signing, only allowed programs — and the same transaction
       with another payer, another key or a stranger's program is refused;
     - a transaction counts as signed only when both slots carry a signature;
     - what a creator types is checked field by field, links only https and
       to the right hosts, a ticker letters and digits;
     - a picture is judged by its bytes;
     - files are content-addressed and written once; a launch is recorded
       once and listed newest first;
     - the cost cap leaves room for the dev buy and the fees, not more;
     - the token page escapes every string a minter typed and keeps only
       https links.
   ========================================================================== */

import { readFileSync } from 'node:fs';
import { b58enc, b58dec, isKey, b64dec, b64enc, checkLaunch, imageType, contentId, metadata, LaunchBook, parseTx, checkCreateTx,
  sigSlot, signed, costCap, groupLink, PUMP_PROGRAM, rpcUrl } from '../src/launch.mjs';
import { tokenPage } from '../src/tokenpage.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); } };

console.log('\nbase58');
{
  const k = new Uint8Array(32).map((_, i) => i * 7 + 1);
  ok('round trip', b58dec(b58enc(k)).every((x, i) => x === k[i]));
  ok('leading zeros survive', b58enc(new Uint8Array([0, 0, 5])) === '116' && b58dec('116').length === 3);
  ok('a public key is 32 bytes of base58', isKey(PUMP_PROGRAM) && !isKey('0x' + 'a'.repeat(40)) && !isKey('abc') && !isKey(''));
}

console.log('\nthe real create transaction');
const fx = JSON.parse(readFileSync(new URL('./fixtures/pumpportal-create.json', import.meta.url), 'utf8'));
const bytes = b64dec(fx.tx);
const tx = parseTx(bytes);
{
  ok('two signers: the creator, then the token key', tx.nsig === 2 && tx.signers[0] === fx.user && tx.signers[1] === fx.mint, JSON.stringify(tx.signers));
  ok('a v0 message', tx.version === 0);
  ok('it calls pump.fun', tx.instructions.some(i => i.program === PUMP_PROGRAM));
  ok('the check passes it', checkCreateTx(tx, { user: fx.user, mint: fx.mint }) === '', checkCreateTx(tx, { user: fx.user, mint: fx.mint }));
  ok('another payer is refused', /payer/.test(checkCreateTx(tx, { user: fx.mint, mint: fx.mint })));
  ok('another token key is refused', /token key/.test(checkCreateTx(tx, { user: fx.user, mint: PUMP_PROGRAM })));
  const odd = { ...tx, instructions: tx.instructions.concat([{ program: 'Evi1111111111111111111111111111111111111111' }]) };
  ok('a stranger\'s program is refused', /unexpected program/.test(checkCreateTx(odd, { user: fx.user, mint: fx.mint })));
  ok('no pump.fun call is not a create', /not a pump\.fun create/.test(checkCreateTx({ ...tx, instructions: tx.instructions.filter(i => i.program !== PUMP_PROGRAM) }, { user: fx.user, mint: fx.mint })));
  ok('as built, it is signed by neither', !signed(bytes, tx, fx.user) && !signed(bytes, tx, fx.mint));
  const both = new Uint8Array(bytes);
  both.fill(7, sigSlot(tx, fx.user), sigSlot(tx, fx.user) + 64);
  ok('one signature is not both', signed(both, tx, fx.user) && !signed(both, tx, fx.mint));
  both.fill(9, sigSlot(tx, fx.mint), sigSlot(tx, fx.mint) + 64);
  ok('both slots signed', signed(both, tx, fx.user) && signed(both, tx, fx.mint));
  ok('the message starts after the signatures', tx.msgStart === 1 + 64 * 2 && tx.message.length === bytes.length - tx.msgStart);
  let threw = false;
  try { parseTx(bytes.subarray(0, 100)); } catch { threw = true; }
  ok('a cut transaction does not parse', threw);
}

console.log('\nthe form');
{
  const good = checkLaunch({ name: '  Bubble Cat ', symbol: '$bcat', description: 'hi\n\n\n\nthere', twitter: 'https://x.com/bcat', telegram: 'https://t.me/bcat', website: 'https://bcat.example' });
  ok('a good form passes, cleaned', good.ok && good.value.name === 'Bubble Cat' && good.value.symbol === 'BCAT' && good.value.description === 'hi\n\nthere');
  const bad = checkLaunch({ name: '', symbol: 'TOO-LONG-TICKER', twitter: 'https://evil.example/x', telegram: 'http://t.me/x', website: 'javascript:alert(1)' });
  ok('each bad field is named', ['name', 'symbol', 'twitter', 'telegram', 'website'].every(f => bad.errors.includes(f)), bad.errors.join());
  ok('markup is stripped from a name', checkLaunch({ name: '<img src=x>Cat', symbol: 'C' }).value.name === 'img src=xCat');
  ok('a ticker is letters and digits', !checkLaunch({ name: 'a', symbol: 'C A T' }).ok && checkLaunch({ name: 'a', symbol: 'cat9' }).value.symbol === 'CAT9');
  const md = metadata(good.value, 'https://pumpbubble.fun/m/abc.png');
  ok('the metadata pump.fun reads, with our name', md.image.endsWith('.png') && md.createdOn === 'https://pumpbubble.fun' && md.twitter && md.showName === true);
  ok('empty links are left out of the metadata', !('twitter' in metadata(checkLaunch({ name: 'a', symbol: 'A' }).value, 'x')));
}

console.log('\npictures and files');
{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  ok('a PNG by its bytes', imageType(png) === 'image/png');
  ok('a JPEG, a GIF and a WebP', imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === 'image/jpeg'
    && imageType(new TextEncoder().encode('GIF89a......')) === 'image/gif' && imageType(new TextEncoder().encode('RIFF....WEBPVP8 ')) === 'image/webp');
  ok('an SVG or a script is not a picture', imageType(new TextEncoder().encode('<svg onload=alert(1)>')) === '' && imageType(new TextEncoder().encode('<script>x</script>')) === '');
  const id = await contentId(png);
  ok('a content id is 32 hex characters, stable', /^[0-9a-f]{32}$/.test(id) && id === await contentId(png) && id !== await contentId(new Uint8Array([1])));
  const m = new Map(), store = { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); } }, B = new LaunchBook(store);
  await B.putFile(id, 'image/png', png);
  await B.putFile(id, 'image/gif', png);
  const f = await B.getFile(id);
  ok('a file is written once and read back whole', f.type === 'image/png' && f.bytes.length === png.length && f.bytes.every((x, i) => x === png[i]));
  ok('base64 round trip', b64dec(b64enc(png)).every((x, i) => x === png[i]));
  ok('a launch is recorded once', await B.record({ mint: fx.mint, sym: 'FIX', at: 1 }) && !(await B.record({ mint: fx.mint, sym: 'AGAIN' })));
  await B.record({ mint: PUMP_PROGRAM, sym: 'TWO', at: 2 });
  const r = await B.recent(10);
  ok('newest first', r[0].sym === 'TWO' && r[1].sym === 'FIX');
  ok('a non-key is not recorded', !(await B.record({ mint: 'nope' })) && (await B.get('nope')) === null);
}

console.log('\nmoney and links');
{
  ok('the cost cap is the dev buy, its margin and 0.05 SOL', costCap(1) === Math.round((1.12 + 0.05) * 1e9) && costCap(0) === 0.05e9 && costCap(-3) === 0.05e9);
  ok('the group link carries the token and asks for the rights', groupLink('pumpbubblebot', fx.mint) === 'https://t.me/pumpbubblebot?startgroup=setup_' + fx.mint + '&admin=delete_messages+restrict_members+pin_messages+invite_users+change_info');
  ok('the setup payload fits Telegram\'s 64', ('setup_' + fx.mint).length <= 64);
  ok('Alchemy when keyed, never a key in a log', rpcUrl({ ALCHEMY_KEY: 'abcdefgh123' }).endsWith('/v2/abcdefgh123') && rpcUrl({}).startsWith('https://'));
}

console.log('\nthe token page');
{
  const html = tokenPage({ origin: 'https://pumpbubble.fun', t: { mint: fx.mint, sym: '<b>X', name: 'A "quoted" <script>alert(1)</script>', img: '/api/img?u=a&s=b', mcap: 12345, pc: { h24: 12.5 } },
    raw: { description: 'line one\n<img src=x onerror=1>', twitter: 'javascript:alert(1)', telegram: 'https://t.me/real', website: 'http://plain.example', creator: fx.user, created_timestamp: Date.now() - 3600e3 }, launched: { mint: fx.mint } });
  ok('no markup a minter typed survives', !/<script>alert|<img src=x onerror|<b>X/.test(html));
  ok('their text is shown, escaped', html.includes('&lt;b&gt;X') && html.includes('&lt;img src=x onerror=1&gt;'));
  ok('only https links are kept', !html.includes('javascript:alert') && !html.includes('http://plain.example') && html.includes('https://t.me/real'));
  ok('Buy goes to our swap', html.includes('href="/swap?mint=' + fx.mint + '"'));
  ok('the bot link sets it up for this token', html.includes('startgroup=setup_' + fx.mint));
  ok('launched with us says so, and every page says launch yours', html.includes('Launched with pumpbubble') && html.includes('href="/launch"'));
  ok('the market cap and the move', html.includes('$12.3K') && html.includes('+12.5%'));
}

console.log('\nthe token\'s own links');
{
  const { ownLinks, checkLinks, linksMessage, verifySig, launchOp, claimLink } = await import('../src/launch.mjs');
  const own = ownLinks('https://pumpbubble.fun', fx.mint);
  ok('page, group and X exist before the launch', own.website.endsWith('/t/' + fx.mint) && own.telegram.endsWith('/tg/' + fx.mint) && own.twitter.endsWith('/x/' + fx.mint));
  ok('our own links pass pump.fun\'s metadata as https', Object.values(own).every(u => /^https:\/\//.test(u)));
  const cl = checkLinks({ x: 'https://x.com/bcat', telegram: 'https://t.me/bcat', website: 'https://bcat.example' });
  ok('a creator may point them at their accounts', cl.ok && cl.links.x && cl.links.tg && cl.links.web);
  const bad = checkLinks({ x: 'https://evil.example/x', telegram: 'javascript:alert(1)', website: 'http://plain.example' });
  ok('only X to X, Telegram to t.me, a site over https', !bad.ok && bad.bad.join() === 'x,telegram,website');
  ok('the claim link carries a code, not the token', claimLink('pumpbubblebot', 'ABC123def456').includes('startgroup=launch_ABC123def456') && ('launch_' + 'x'.repeat(24)).length <= 64);

  /* a creator's key signs; a stranger's does not count */
  const { webcrypto: wc } = await import('node:crypto');
  const kp = await wc.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = b58enc(new Uint8Array(await wc.subtle.exportKey('raw', kp.publicKey)));
  const at = Date.now(), msg = linksMessage(fx.mint, { x: 'https://x.com/bcat' }, at);
  const sig = new Uint8Array(await wc.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(msg)));
  ok('the message names the token, each link and the time', msg.includes('token: ' + fx.mint) && msg.includes('x: https://x.com/bcat') && msg.includes('telegram: -') && msg.endsWith('time: ' + at));
  ok('the creator\'s signature verifies', await verifySig(pub, msg, sig));
  ok('another key\'s does not', !(await verifySig(fx.user, msg, sig)));
  ok('a changed link does not', !(await verifySig(pub, linksMessage(fx.mint, { x: 'https://x.com/evil' }, at), sig)));
  ok('garbage is not a signature', !(await verifySig(pub, msg, new Uint8Array(10))) && !(await verifySig('nope', msg, sig)));

  /* the object's operations */
  const m = new Map(), B = new LaunchBook({ get: async k => m.get(k), put: async (k, v) => { m.set(k, v); } });
  const c = await launchOp(B, { op: 'newClaim', mint: fx.mint });
  ok('a claim code is made for a token', c.ok && /^[1-9A-HJ-NP-Za-km-z]{12,24}$/.test(c.code));
  const u1 = await launchOp(B, { op: 'useClaim', code: c.code }), u2 = await launchOp(B, { op: 'useClaim', code: c.code });
  ok('it opens once, and only once', u1.ok && u1.mint === fx.mint && !u2.ok);
  ok('a made-up code opens nothing', !(await launchOp(B, { op: 'useClaim', code: 'AAAAAAAAAAAAAAAA' })).ok);
  await launchOp(B, { op: 'pend', chat: -100, mint: fx.mint });
  ok('a bind can wait for admin rights', (await launchOp(B, { op: 'pending', chat: -100 })).mint === fx.mint);
  await launchOp(B, { op: 'clearPending', chat: -100 });
  ok('and is cleared when done', !(await launchOp(B, { op: 'pending', chat: -100 })).ok);
  await launchOp(B, { op: 'setLinks', mint: fx.mint, patch: { invite: 'https://t.me/+abc', chat: -100 } });
  await launchOp(B, { op: 'setLinks', mint: fx.mint, patch: { x: 'https://x.com/bcat' } });
  const L = (await launchOp(B, { op: 'links', mint: fx.mint })).links;
  ok('links merge: the invite stays when X is set', L.invite === 'https://t.me/+abc' && L.x === 'https://x.com/bcat');
  ok('a file op refuses a bad id', !(await launchOp(B, { op: 'putFile', id: '../x', b64: 'AA' })).ok && !(await launchOp(B, { op: 'nope' })).ok);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
