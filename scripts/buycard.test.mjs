/* ==========================================================================
   The buy card — the picture on a buy alert.

       node scripts/buycard.test.mjs

   What is pinned:
     - the card says what the alert says: the money, what was swapped, the
       market cap, a new holder or how much the position grew, and — when the
       buyer is somebody — that they are a top trader or a top KOL;
     - a ticker is attacker-controlled: escaped, and replaced when the font
       cannot draw it;
     - the alert path: a group's own media wins; no media means the card; the
       card switched off, a failed render or Telegram refusing the upload all
       still post the buy as text — a card is never a missed buy.
   ========================================================================== */

import { buyCardSpec, buildBuyCardSvg, usdText, shortAmt, paidText } from '../src/buycard.mjs';
import { sendAlert } from '../src/tgbot.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); } };

console.log('\nwhat the card says');
{
  const token = { sym: 'HELL', img: '/api/img?u=https%3A%2F%2Fipfs.io%2Fipfs%2Fx&s=y', mcap: 1_580_000 };
  const a = buyCardSpec({ buy: { sol: 0.507, tokens: 162_479, pre: 3_532_000, newHolder: false }, token, usd: 278.18, rank: 12 });
  ok('a growing position is a percentage', a.pos === '+4.6%', a.pos);
  ok('an ordinary buy is a NEW BUY', a.tag === 'NEW BUY' && !a.line);
  ok('art and size carried', a.img === token.img && a.mcap === 1_580_000 && a.rank === 12);
  const n = buyCardSpec({ buy: { sol: 1, tokens: 5, newHolder: true }, token, usd: 180 });
  ok('a first buy is a new holder', n.pos === 'NEW HOLDER');
  ok('a whale is a WHALE BUY', buyCardSpec({ buy: { sol: 40, tokens: 1 }, token, usd: 7000, whale: true }).tag === 'WHALE BUY');
  const s = buyCardSpec({ buy: { sol: 3, tokens: 9 }, token, usd: 1700, smart: { rank: 3, period: 'weekly' } });
  ok('a top trader is named, with the board', s.tag === 'TOP TRADER BUY' && s.line === '#3 ON PUMP.FUN THIS WEEK BY PROFIT BANKED', s.line);
  const k = buyCardSpec({ buy: { sol: 3, tokens: 9 }, token, usd: 1700, caller: { rank: 2, hit2: 0.63 } });
  ok('a top KOL is named, with their record', k.tag === 'TOP KOL BUY' && k.line.includes('#2 CALLER') && k.line.includes('63%'), k.line);
  ok('a trader outranks a caller', buyCardSpec({ buy: {}, token, usd: 1, smart: { rank: 1 }, caller: { rank: 1 } }).tag === 'TOP TRADER BUY');
  ok('an unknown position says nothing', buyCardSpec({ buy: { sol: 1, tokens: 5 }, token, usd: 1 }).pos === '');
  ok('a nothing-in spec is still a spec', buyCardSpec({}).tag === 'NEW BUY');

  ok('money', usdText(278.184) === '$278.18' && usdText(7120.55) === '$7,121' && usdText(2_400_000) === '$2.40M');
  ok('amounts', shortAmt(162479) === '162.5K' && shortAmt(980000) === '980K' && shortAmt(12_400_000) === '12.4M' && shortAmt(1.5e9) === '1.5B');
  ok('what was paid', paidText(0.507) === '0.507' && paidText(3.1) === '3.1' && paidText(41.2) === '41.2' && paidText(1250.4) === '1,250');
}

console.log('\nthe picture');
{
  const svg = buildBuyCardSvg(buyCardSpec({ buy: { sol: 0.5, tokens: 1e5, newHolder: true }, token: { sym: 'HELL', mcap: 1.58e6 }, usd: 90, smart: { rank: 3, period: 'weekly' } }), 'data:image/png;base64,AAAA');
  ok('ticker, money, swap, chips, the trader line', svg.includes('$HELL') && svg.includes('$90.00') && svg.includes('0.5 SOL  FOR  100K $HELL') && svg.includes('$1.58M') && svg.includes('#3 ON PUMP.FUN'));
  ok('the art is drawn inside the bubble', svg.includes('href="data:image/png;base64,AAAA"') && svg.includes('clip-path="url(#lg)"'));
  ok('our name on every card', svg.includes('PUMPBUBBLE.FUN') && svg.includes('@PUMPBUBBLEBOT'));
  const evil = buildBuyCardSvg({ sym: '<img src=x onerror=1>', usd: 1, tag: 'NEW BUY' });
  ok('a hostile ticker is drawn as text, never as markup', !evil.includes('<img') && evil.includes('$&lt;img src=x onerror=1&gt;'));
  ok('an ampersand is escaped', buildBuyCardSvg({ sym: 'A&B', usd: 1 }).includes('$A&amp;B'));
  ok('a ticker the font cannot draw is replaced', buildBuyCardSvg({ sym: '猫猫', usd: 1 }).includes('$TOKEN'));
  ok('no art is a letter, not a hole', buildBuyCardSvg({ sym: 'HELL', usd: 1 }, null).includes('>H</text>'));
  ok('a hostile art URL is escaped', !buildBuyCardSvg({ sym: 'X', usd: 1 }, 'data:x" onload="1').includes('" onload="'));
}

console.log('\nthe alert path');
{
  const calls = [];
  const real = globalThis.fetch;
  let refuseUpload = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const m = u.match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
    if (!m) return new Response('nope', { status: 404 });
    const body = init.body instanceof FormData ? Object.fromEntries([...init.body.keys()].map(k => [k, init.body.get(k)])) : JSON.parse(init.body || '{}');
    calls.push({ method: m[1], body });
    if (m[1] === 'sendPhoto' && init.body instanceof FormData && refuseUpload) return new Response(JSON.stringify({ ok: false, description: 'Bad Request: IMAGE_PROCESS_FAILED' }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
  };
  const PNG = new Uint8Array(4000).fill(7).buffer;
  const cards = (answer) => ({ idFromName: () => 'id', get: () => ({ fetch: async () => answer() }) });
  const env = (answer) => ({ TG_BOT_TOKEN: 't', CARDS: cards(answer) });
  const store = { get: async () => null, put: async () => {} };
  const card = buyCardSpec({ buy: { sol: 1, tokens: 1 }, token: { sym: 'HELL' }, usd: 100 });
  const pngAnswer = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });

  calls.length = 0;
  await sendAlert(env(pngAnswer), store, -100, { mint: 'm' }, 'caption', { inline_keyboard: [] }, { card });
  ok('no media: the card goes as an uploaded photo', calls.length === 1 && calls[0].method === 'sendPhoto' && calls[0].body.photo instanceof Blob && calls[0].body.caption === 'caption');
  ok('the buttons travel as JSON in the upload', calls[0] && calls[0].body.reply_markup === JSON.stringify({ inline_keyboard: [] }));

  calls.length = 0;
  await sendAlert(env(pngAnswer), store, -100, { mint: 'm', media: { kind: 'animation', id: 'gif1' } }, 'caption', {}, { card });
  ok('the group\'s own GIF wins', calls.length === 1 && calls[0].method === 'sendAnimation' && calls[0].body.animation === 'gif1');

  calls.length = 0;
  await sendAlert(env(pngAnswer), store, -100, { mint: 'm', card: false }, 'caption', {}, { card });
  ok('switched off: text', calls.length === 1 && calls[0].method === 'sendMessage');

  calls.length = 0;
  await sendAlert(env(() => new Response('boom', { status: 500 })), store, -100, { mint: 'm' }, 'caption', {}, { card });
  ok('a failed render: text', calls.length === 1 && calls[0].method === 'sendMessage');

  calls.length = 0;
  await sendAlert({ TG_BOT_TOKEN: 't' }, store, -100, { mint: 'm' }, 'caption', {}, { card });
  ok('no renderer deployed: text', calls.length === 1 && calls[0].method === 'sendMessage');

  calls.length = 0;
  refuseUpload = true;
  const sent = await sendAlert(env(pngAnswer), store, -100, { mint: 'm' }, 'caption', {}, { card });
  ok('Telegram refuses the picture: the buy still posts as text', calls.map(c => c.method).join(',') === 'sendPhoto,sendMessage' && sent && sent.message_id === 7);
  refuseUpload = false;
  globalThis.fetch = real;
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
