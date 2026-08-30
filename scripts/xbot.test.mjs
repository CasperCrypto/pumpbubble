/* ==========================================================================
   The X poster: signature correctness, and what it refuses to post.

       node scripts/xbot.test.mjs

   The signature is checked against the worked example published in X's own
   OAuth documentation. Those are documentation values, not credentials. A
   signature that is merely plausible comes back as a bare 401, so "it looked
   right" is not a standard this can be held to.

   The rest is about credibility. pump.fun's top mover is very often a token
   minted minutes ago showing six figures of percent — a real number that reads
   as a scam. Posting those would teach people to scroll past us.
   ========================================================================== */

import { sign, baseString, hmacSha1B64, pick, compose } from '../src/xbot.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };

/* ---- signature, in two independently checkable halves ----

   The end-to-end signature from X's worked example is not asserted here: the
   only copy of that value available was from memory, and an assertion against
   a half-remembered constant tests the memory, not the code. Both halves that
   actually carry risk are checked against sources that can be stated exactly. */

/* The MAC, against RFC 2202 test case 1 for HMAC-SHA1. */
{
  const key = ''.repeat(20);
  const want = 'thhBxlSPKGxpsUAyRk2P/hLNRoo=';   // b617318655057264e28bc0b6fb378c8ef146be00
  const got = await hmacSha1B64(key, 'Hi There');
  const hex = Buffer.from(got, 'base64').toString('hex');
  hex === 'b617318655057264e28bc0b6fb378c8ef146be00'
    ? ok('HMAC-SHA1 matches RFC 2202 vector', hex.slice(0, 16) + '...')
    : no('HMAC-SHA1 matches RFC 2202 vector', hex);
}

/* The base string, against the one published in X's OAuth documentation.
   This is the half that goes wrong in practice — parameter sorting, double
   encoding, and which parameters belong in it at all. */
{
  const got = baseString('POST', 'https://api.twitter.com/1.1/statuses/update.json', {
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    include_entities: 'true',
    oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
    oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1318622958',
    oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    oauth_version: '1.0',
  });
  const want = 'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json'
    + '&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog'
    + '%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg'
    + '%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958'
    + '%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb'
    + '%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen'
    + '%252C%2520a%2520signed%2520OAuth%2520request%2521';
  got === want ? ok('OAuth base string matches the published example')
               : no('OAuth base string', 'diverges at ' +
                   [...want].findIndex((c, n) => got[n] !== c));
}

/* And that sign() actually composes those two. */
{
  const params = { a: '1', oauth_nonce: 'n' };
  const direct = await hmacSha1B64('cs&ts', baseString('POST', 'https://e.x/p', params));
  const via = await sign('POST', 'https://e.x/p', params, 'cs', 'ts');
  direct === via ? ok('sign() composes base string and MAC')
                 : no('sign() composes base string and MAC');
}

/* ---- selection ---- */
const T = (o) => ({ mint: 'm' + Math.random(), sym: 'X', mcap: 500_000, vol: 50_000,
                    pc: { h24: 100 }, ...o });

const cases = [
  ['a fresh mint showing six figures of percent', T({ pc: { h24: 1452986 } })],
  ['a token below the market-cap floor', T({ mcap: 900 })],
  ['a token nobody is trading', T({ vol: 100 })],
  ['a move too small to be a story', T({ pc: { h24: 3 } })],
  ['a token with no 24h figure at all', T({ pc: { h24: null } })],
  ['a stock, which has no mint to link to', T({ mint: '' })],
  ['a token flagged unbacked', T({ dust: true })],
  ['a banned token', T({ banned: true })],
];
for (const [why, tok] of cases) {
  pick([tok], {}) === null ? ok('refuses ' + why) : no('refuses ' + why);
}

const good = T({ sym: 'POK', pc: { h24: 312.4 }, mcap: 4_200_000, mint: 'abc' });
pick([good], {}) === good ? ok('posts a real mover') : no('posts a real mover');

/* cooldown: the same token must not come round again the next day */
const st = { recent: { abc: Date.now() - 24 * 3600_000 } };
pick([good], st) === null ? ok('honours the repost cooldown') : no('honours the repost cooldown');

/* highest qualifying gain wins, not the highest gain overall */
const scam = T({ sym: 'SCAM', pc: { h24: 99999 }, mint: 'z' });
const real = T({ sym: 'REAL', pc: { h24: 400 }, mint: 'y' });
pick([scam, real], {}) === real ? ok('picks the best believable mover')
                                : no('picks the best believable mover');

/* ---- text ---- */
const text = compose(good, 'https://pumpbubble.fun');
text.includes('$POK +312%') && text.includes('/s/abc') && text.includes('$4.2M')
  ? ok('post reads correctly', JSON.stringify(text.split('\n')[0]))
  : no('post reads correctly', text);
text.length <= 280 ? ok('fits in a post', text.length + ' chars')
                   : no('fits in a post', text.length + ' chars');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
