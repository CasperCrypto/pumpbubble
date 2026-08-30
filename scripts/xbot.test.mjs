/* ==========================================================================
   What the X account is allowed to say.

       node scripts/xbot.test.mjs

   This runs unattended, from our own brand account, with nobody reading the
   draft. Two things therefore have to hold without supervision: it never
   publishes a number we did not measure, and it never tags an account chosen
   by an anonymous stranger.

   The second one is the sharp edge. pump.fun's `twitter` field is typed in by
   whoever minted the coin, so a scam token can name @elonmusk and we would tag
   him — from our account, next to a price. That is the test that matters most
   in this file.
   ========================================================================== */

import { credible, topMovers, handleOf, build, COMPOSERS, TYPES } from '../src/xbot.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const tok = (o = {}) => ({
  mint: 'M' + (o.sym || 'X'), sym: 'X', name: 'X',
  mcap: 500_000, vol: 50_000, pc: { h24: 60 }, ...o,
});

/* ------------------------------------------------- what may be posted at all */
is('rejects an unmeasured window', credible(tok({ pc: { h24: null } })), false);
is('rejects undefined as a change', credible(tok({ pc: {} })), false);
is('rejects the fresh-mint moonshot', credible(tok({ pc: { h24: 1452986 } })), false);
is('rejects a dust market cap', credible(tok({ mcap: 900 })), false);
is('rejects a token nobody is trading', credible(tok({ vol: 12 })), false);
is('rejects a banned token', credible(tok({ banned: true })), false);
is('rejects a flat token', credible(tok({ pc: { h24: 2 } })), false);
is('accepts a believable mover', credible(tok({ pc: { h24: 312 } })), true);

/* A stock has no mint and no DexScreener volume line; the cap gate carries it.
   And the band is per class: +4% is a real day for a mega-cap and nothing at
   all for a memecoin, which is why the stocks card found no movers when both
   were judged by the same threshold. */
is('accepts a stock with no volume field',
  credible({ sym: 'NVDA', mcap: 4e12, pc: { h24: 40 } }, 'h24', 'stocks'), true);
is('accepts a normal-sized stock move',
  credible({ sym: 'NVDA', mcap: 4e12, pc: { h24: 4.2 } }, 'h24', 'stocks'), true);
is('rejects that same move for a memecoin',
  credible(tok({ pc: { h24: 4.2 } })), false);
is('rejects a penny stock', credible({ sym: 'ZZZ', mcap: 4e6, pc: { h24: 9 } }, 'h24', 'stocks'), false);
is('rejects an impossible stock move',
  credible({ sym: 'ZZZ', mcap: 4e12, pc: { h24: 400 } }, 'h24', 'stocks'), false);

/* ------------------------------------------------------------------ ranking */
{
  const list = [
    tok({ sym: 'A', pc: { h24: 40 } }),
    tok({ sym: 'B', pc: { h24: 900 } }),
    tok({ sym: 'C', pc: { h24: 1e9 } }),   /* filtered, not ranked first */
    tok({ sym: 'D', pc: { h24: 120 } }),
  ];
  const top = topMovers(list, 'h24', 5);
  is('ranks by gain, highest first', top.map(t => t.sym).join(''), 'BDA');
  is('drops the absurd one', top.some(t => t.sym === 'C'), false);
}

/* -------------------------------------------------------- who we may tag */
const ON = { XBOT_MENTIONS: '1' };

is('no mention unless switched on',
  handleOf({ sym: 'FONE', twitter: 'https://x.com/fonecoin' }, {}), '');

is('tags a handle that matches the ticker',
  handleOf({ sym: 'FONE', name: 'Fone', twitter: 'https://x.com/fonecoin' }, ON), '@fonecoin');

/* The whole point. */
is('refuses a hijacked handle',
  handleOf({ sym: 'FONE', name: 'Fone', twitter: 'https://twitter.com/elonmusk' }, ON), '');
is('refuses a handle claiming a rival project',
  handleOf({ sym: 'SCAM', name: 'Scam', twitter: 'https://x.com/coinbase' }, ON), '');
is('refuses an intent URL',
  handleOf({ sym: 'I', name: 'I', twitter: 'https://twitter.com/intent/tweet?text=x' }, ON), '');
is('refuses junk in the field',
  handleOf({ sym: 'A', name: 'A', twitter: 'not a url' }, ON), '');
is('refuses an empty field', handleOf({ sym: 'A', name: 'A' }, ON), '');

/* ------------------------------------------------------------- composition */
const feeds = {
  pumpfun: [tok({ sym: 'POK', pc: { h24: 312 } }), tok({ sym: 'FONE', pc: { h24: 88 } }),
            tok({ sym: 'WIF', pc: { h24: 44 } })],
  majors: Array.from({ length: 30 }, (_, i) =>
    ({ sym: 'C' + i, mcap: 1e9, pc: { h24: i % 3 === 0 ? -2 : 5 } })),
  /* Realistic equity moves, not memecoin ones — the point of the per-class band. */
  stocks: [{ sym: 'NVDA', mcap: 4e12, pc: { h24: 6.1 } },
           { sym: 'AAPL', mcap: 3e12, pc: { h24: 4.4 } },
           { sym: 'TSM', mcap: 1e12, pc: { h24: 3.2 } }],
};
const ORIGIN = 'https://pumpbubble.fun';

for (const kind of ['mover', 'board', 'market', 'stocks']) {
  const out = COMPOSERS[kind]({ ...feeds, origin: ORIGIN, env: {}, state: { recent: {} }, now: Date.now() });
  if (!out || !out.text) { no(`${kind} composes`, 'returned nothing'); continue; }
  const bad = /NaN|undefined|null|Infinity/.test(out.text);
  if (bad) no(`${kind} composes`, 'placeholder leaked: ' + out.text.replace(/\n/g, ' | '));
  else if (out.text.length > 280) no(`${kind} composes`, out.text.length + ' chars, over the limit');
  else ok(`${kind} composes`, out.text.length + ' chars');
}

/* A thin feed must not produce a post about nothing. */
{
  const empty = { pumpfun: [], majors: [], stocks: [] };
  is('builds nothing from empty feeds', build(empty, {}, { recent: {} }, Date.now(), ORIGIN), null);
}

/* Every day of the rotation has to land on a real composer. */
{
  const missing = TYPES.filter(k => typeof COMPOSERS[k] !== 'function');
  if (missing.length) no('rotation names real composers', missing.join(', '));
  else ok('rotation names real composers', TYPES.length + ' slots');
}

/* A token posted about this week is not posted about again. */
{
  const t = feeds.pumpfun[0];
  const state = { recent: { [t.mint]: Date.now() } };
  const out = COMPOSERS.mover({ ...feeds, origin: ORIGIN, env: {}, state, now: Date.now() });
  is('respects the repost cooldown', out && out.mint === t.mint, false);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
