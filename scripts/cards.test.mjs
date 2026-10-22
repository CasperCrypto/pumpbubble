/* ==========================================================================
   Cards — Collector Crypt's gacha machines, pulls and big hits.

       node scripts/cards.test.mjs

   What is pinned:
     - the switch: only CARDS_TAB = "on" turns the feed on;
     - a machine's face reads "$50 Elite", not the whole product name;
     - expected value is shown against the price AND as what a sell-back
       returns, and a machine with no price is dropped rather than divided by;
     - a pull's multiple uses the price of the machine that sold it, and a
       machine the list does not name gives no multiple — never a guess;
     - art: the resized CDN copy where the API carries one, a gacha-site path
       made absolute, anything else refused;
     - the hour window: one row per pull, newest first, nothing older;
     - the board: a partner's adopted copy counts toward its parent, a
       partner machine with sales of its own gets a bubble, value back is
       value out over price in, and the storefront split is counted;
     - the read: no machines fails the build, a failed pulls read does not.
   ========================================================================== */

import { cardsOn, machineSym, cardMachine, cardPull, mergePulls, cardsBoard, readCards, CC_GACHA, PULL_WINDOW_MS } from '../src/cards.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
const near = (n, got, want, eps = 1e-9) => (got != null && Math.abs(got - want) < eps ? ok(n) : no(n, `got ${got}, want ${want}`));

const NOW = Date.parse('2026-10-22T10:30:00Z');
const machine = (code, price, extra = {}) => ({
  code, name: code, price, ev: price * 1.1, instantBuyback: 85, public: true, parentCode: null,
  odds: { common: 0.8, uncommon: 0.15, rare: 0.04, epic: 0.01 },
  tierRanges: { epic: { start: 250, end: 5001 } },
  stock: { common: 261, uncommon: 198, rare: 227, epic: 200 },
  thumbnailUrl: '/' + code + '.png', ...extra,
});
const win = (nft, pack, value, minsAgo, extra = {}) => ({
  winner: '3kptmgeBCrMkqikycRzaFRb8Qrxi91XHkhcHBB9xXJPC', nft_address: nft, pack_type: pack, prize_tier: 4,
  insuredValue: value, memo_slug: 'cc', created_at: new Date(NOW - minsAgo * 60000).toISOString(),
  nft: { content: {
    metadata: { name: 'short', json_name: '2026 #102 Sacred Ash PSA 10 Japanese', attributes: [{ trait_type: 'Category', value: 'Pokemon' }] },
    files: [{ uri: 'https://nft.collectorcrypt.com/front/X1', cc_cdn: 'https://d1xpxki1g4htqu.cloudfront.net/abc',
      cdn_uri: 'https://cdn.helius-rpc.com/cdn-cgi/image//https://nft.collectorcrypt.com/front/X1' }],
  } }, ...extra,
});

console.log('\nthe switch');
is('on is on', cardsOn({ CARDS_TAB: 'on' }), true);
is('ON is on', cardsOn({ CARDS_TAB: 'ON' }), true);
is('off is off', cardsOn({ CARDS_TAB: 'off' }), false);
is('unset is off', cardsOn({}), false);
/* `CARDS` is the share-card Durable Object's binding: a var of that name
   would not even deploy, and the binding must not read as a switch */
is('the CARDS binding is not the switch', cardsOn({ CARDS: { idFromName() {} } }), false);
is('no env is off', cardsOn(undefined), false);

console.log('\nmachine faces');
is('price and the name\'s word', machineSym('Elite Pokémon Gacha Pack', 50), '$50 Elite');
is('a price inside the name is not said twice', machineSym('Soccer $50 Pack', 50), '$50 Soccer');
is('thousands read as K', machineSym('Mythic Pokémon Gacha Pack', 2500), '$2.5K Mythic');
is('a bare number in the name goes', machineSym('Riftbound 50', 50), '$50 Riftbound');
is('two words while they fit', machineSym('One Piece Ocean Blue Pack', 50), '$50 One Piece');
is('angle brackets stripped', machineSym('<b>Evil</b> Pack', 25).includes('<'), false);

console.log('\nmachines');
{
  const m = cardMachine(machine('pokemon_50', 50, { ev: 54.82636457295829, instantBuyback: 85 }));
  near('edge is EV over price', m.edge, (54.82636457295829 / 50 - 1) * 100);
  near('sell-back is EV x buyback over price', m.sellBack, 54.82636457295829 * 0.85 / 50);
  is('buyback as a share', m.back, 0.85);
  is('a path becomes the gacha site', m.thumb, CC_GACHA + '/pokemon_50.png');
  is('an absolute https thumb is kept', cardMachine(machine('a', 5, { thumbnailUrl: 'https://x.vercel-storage.com/t.jpg' })).thumb, 'https://x.vercel-storage.com/t.jpg');
  is('a javascript: thumb is refused', cardMachine(machine('a', 5, { thumbnailUrl: 'javascript:alert(1)' })).thumb, '');
  const coded = cardMachine(machine('ejup_poke_300', 300, { name: 'ejup_poke_300', menuCategory: 'Jupiter', public: false }));
  is('a machine named with its code is called by its storefront', [coded.name, coded.sym], ['Jupiter pack', '$300 Jupiter']);
  is('a real name with spaces is kept', cardMachine(machine('degen_100', 100, { name: 'exclusive low ev, high potential win' })).name, 'exclusive low ev, high potential win');
  is('no price, no machine', cardMachine(machine('a', 0)), null);
  is('no code, no machine', cardMachine({ price: 5 }), null);
  is('EV missing stays null, not zero', cardMachine(machine('a', 5, { ev: null })).edge, null);
  is('a buyback over 100% is not a share', cardMachine(machine('a', 5, { instantBuyback: 400 })).back, null);
}

console.log('\npulls');
{
  const byCode = new Map([['pokemon_50', cardMachine(machine('pokemon_50', 50))],
    ['jup_50', cardMachine(machine('jup_50', 52, { public: false, parentCode: 'pokemon_50' }))]]);
  const p = cardPull(win('N1', 'pokemon_50', 400, 1), byCode);
  is('the full card name', p.card, '2026 #102 Sacred Ash PSA 10 Japanese');
  near('multiple of the pack price', p.mult, 8);
  is('tier named', p.tier, 'common');
  is('the resized copy, 160 wide', p.img, 'https://cdn.helius-rpc.com/cdn-cgi/image/width=160,format=auto/https://nft.collectorcrypt.com/front/X1');
  const q = cardPull(win('N2', 'jup_50', 104, 1, { memo_slug: 'jupiter' }), byCode);
  near('a partner pack uses its own price', q.mult, 2);
  is('and folds onto the machine it adopted', q.machine, 'pokemon_50');
  is('the storefront', q.via, 'jupiter');
  const u = cardPull(win('N3', 'mystery_250', 500, 1), byCode);
  is('an unknown machine has no price', u.price, null);
  is('and no multiple', u.mult, null);
  is('no address, no pull', cardPull({ ...win('', 'pokemon_50', 1, 1) }, byCode), null);
  is('no time, no pull', cardPull({ ...win('N4', 'pokemon_50', 1, 1), created_at: 'nope' }, byCode), null);
  const bare = win('N5', 'pokemon_50', 1, 1);
  bare.nft.content.files = [{ uri: 'https://nft.collectorcrypt.com/front/X5' }];
  is('without the CDN copy, the original', cardPull(bare, byCode).img, 'https://nft.collectorcrypt.com/front/X5');
}

console.log('\nthe hour');
{
  const byCode = new Map([['pokemon_50', cardMachine(machine('pokemon_50', 50))]]);
  const a = cardPull(win('A', 'pokemon_50', 10, 5), byCode);
  const b = cardPull(win('B', 'pokemon_50', 10, 50), byCode);
  const c = cardPull(win('C', 'pokemon_50', 10, 70), byCode);
  const kept = mergePulls([b, c], [a, b], NOW);
  is('one row per pull, newest first, the hour only', kept.map(p => p.nft), ['A', 'B']);
  is('an empty read keeps the window', mergePulls(kept, [], NOW).length, 2);
  is('the window is an hour', PULL_WINDOW_MS, 3600000);
}

console.log('\nthe board');
{
  const raw = [machine('pokemon_50', 50), machine('pokemon_500', 500),
    machine('jup_50', 52, { public: false, parentCode: 'pokemon_50' }),
    machine('ejup_100', 100, { public: false }), machine('quiet_partner', 80, { public: false })];
  const machines = raw.map(cardMachine);
  const byCode = new Map(machines.map(m => [m.code, m]));
  const pulls = [
    cardPull(win('P1', 'pokemon_50', 30, 2), byCode),
    cardPull(win('P2', 'jup_50', 600, 3, { memo_slug: 'jupiter' }), byCode),
    cardPull(win('P3', 'ejup_100', 90, 4, { memo_slug: 'jupiter' }), byCode),
    cardPull(win('P4', 'mystery_250', 900, 20), byCode),
  ];
  const hits = [cardPull(win('H1', 'pokemon_500', 4000, 300, { prize_tier: 1 }), byCode),
    cardPull(win('H2', 'pokemon_50', 9000, 600, { prize_tier: 1 }), byCode)];
  const { machines: rows, meta } = cardsBoard({ machines, pulls, hits }, NOW);
  const by = Object.fromEntries(rows.map(r => [r.code, r]));
  is('the adopted copy has no bubble of its own', 'jup_50' in by, false);
  is('its sales count for its parent', by.pokemon_50.opened, 2);
  near('in dollars', by.pokemon_50.openedUsd, 102);
  is('the best hit of the window', by.pokemon_50.best.value, 600);
  is('a partner machine that sold gets a bubble', 'ejup_100' in by, true);
  is('one that did not, does not', 'quiet_partner' in by, false);
  is('our own machine is there unopened', by.pokemon_500.opened, 0);
  is('busiest first', rows[0].code, 'pokemon_50');
  is('every pull counted', meta.opened, 4);
  near('dollars in: priced pulls only', meta.openedUsd, 202);
  near('value back: out over in, priced only', meta.back, (30 + 600 + 90) / 202);
  is('the window\'s best card, unknown machines included', meta.best.value, 900);
  is('with no multiple where the machine has no price', meta.best.mult, null);
  is('storefronts counted, ties by name', meta.via, [{ slug: 'cc', n: 2 }, { slug: 'jupiter', n: 2 }]);
  is('the window, in minutes', meta.windowMin, 20);
  is('big hits, biggest first', meta.hits.map(h => h.nft), ['H2', 'H1']);
  is('and how many hours they span', meta.hitsH, 10);
  const empty = cardsBoard({ machines, pulls: [], hits: [] }, NOW).meta;
  is('no pulls: no value back, not 0%', empty.back, null);
  is('no pulls: a zero window', empty.windowMin, 0);
}

console.log('\nthe read');
{
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const seen = [];
  const get = async url => {
    seen.push(url);
    if (url.endsWith('/api/machines')) return reply({ machines: [machine('pokemon_50', 50)] });
    if (url.includes('epic=true')) return reply({ success: true, data: [win('H', 'pokemon_50', 5000, 60, { prize_tier: 1 })] });
    return reply({ success: true, data: [win('P', 'pokemon_50', 40, 1)] });
  };
  const r = await readCards(get, 'https://cc.test');
  is('three reads', seen.length, 3);
  is('machines, pulls and hits', [r.machines.length, r.pulls.length, r.hits.length], [1, 1, 1]);
  is('the hit is epic', r.hits[0].tier, 'epic');
  const down = async url => url.endsWith('/api/machines') ? reply({ machines: [machine('pokemon_50', 50)] }) : reply({}, 503);
  const d = await readCards(down, 'https://cc.test');
  is('a failed pulls read is an empty list', [d.pulls.length, d.pullsOk], [0, false]);
  let threw = '';
  try { await readCards(async () => reply({ machines: [] }), 'https://cc.test'); } catch (e) { threw = e.message; }
  is('no machines fails the build', /no machines/.test(threw), true);
  threw = '';
  try { await readCards(async () => reply({}, 500), 'https://cc.test'); } catch (e) { threw = e.message; }
  is('a refused machines read fails it too', /500/.test(threw), true);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
