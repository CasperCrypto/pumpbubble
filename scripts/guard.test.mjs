/* ==========================================================================
   The group guard — join captcha and the welcome message.

       node scripts/guard.test.mjs

   The captcha has to hold its answer back (the buttons carry only an index),
   let a member through on the right tap, throw them out after two wrong ones
   or when the clock runs out, and forget them either way. A join announced
   twice is one join. The newest welcome hands back the one to delete.
   ========================================================================== */

import { Guard, runGuard, memoryGuard, OPTIONS, TRIES, CAPTCHA, DUP_MS } from '../src/guard.mjs';
import { welcomeText, settingsView } from '../src/tgbot.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const T = 1_800_000_000_000;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

console.log('\ncaptcha');
{
  const g = new Guard({ chatId: -100 });
  const j = g.join(42, T, { captcha: true, ttlMin: 5, rnd });
  is('a join with the captcha on returns a challenge', j.captcha, true);
  is(`${OPTIONS} options`, j.options.length, OPTIONS);
  is('options are distinct', new Set(j.options).size, OPTIONS);
  is('options come from the emoji set', j.options.every(e => CAPTCHA.includes(e)), true);
  is('the target is one of the options', j.options.includes(j.target), true);
  is('the answer index is not in the challenge', 'answer' in j, false);
  is('five minutes to answer', j.until - T, 5 * 60_000);
  const right = j.options.indexOf(j.target);
  is('the right tap passes', g.answer(42, right, T + 1000).result, 'ok');
  is('and the member is forgotten', Object.keys(g.pending).length, 0);
  is('an answer after that is for nobody', g.answer(42, right, T + 2000).result, 'none');
}
{
  const g = new Guard();
  const j = g.join(7, T, { captcha: true, rnd });
  const wrong = (j.options.indexOf(j.target) + 1) % OPTIONS;
  const r1 = g.answer(7, wrong, T + 1);
  is('a wrong tap is a warning first', r1.result, 'wrong');
  is('with tries left', r1.left, TRIES - 1);
  is('the second wrong tap fails', g.answer(7, wrong, T + 2).result, 'fail');
  is('a failed member is forgotten', Object.keys(g.pending).length, 0);
}
{
  const g = new Guard({ chatId: -5 });
  g.join(1, T, { captcha: true, ttlMin: 2, rnd });
  g.setMsg(1, 555);
  g.join(2, T + 60_000, { captcha: true, ttlMin: 2, rnd });
  is('the alarm is set for the first to expire', g.nextDue(), T + 2 * 60_000);
  is('nobody expires early', g.expired(T + 60_000).length, 0);
  const out = g.expired(T + 2 * 60_000 + 1);
  is('the first expires on time', out.length, 1);
  is('with its captcha message to delete', out[0].msg, 555);
  is('and its id as a number', out[0].uid, 1);
  is('the second is still waiting', Object.keys(g.pending).join(), '2');
  is('an answer after the clock is expired', (() => { const h = new Guard(); const c = h.join(9, T, { captcha: true, rnd }); return h.answer(9, c.options.indexOf(c.target), T + 11 * 60_000).result; })(), 'expired');
  is('an unknown ttl falls back to five minutes', new Guard().join(3, T, { captcha: true, ttlMin: 999, rnd }).ttl, 5);
}

console.log('\njoins');
{
  const g = new Guard();
  is('a join without the captcha is just a join', g.join(5, T).captcha, false);
  is('the same join announced again is a duplicate', g.join(5, T + 1000).dup, true);
  is('after the window it is a new join', !!g.join(5, T + DUP_MS + 1).dup, false);
  g.join(6, T, { captcha: true, rnd });
  is('a member with a captcha pending is not challenged twice', g.join(6, T + DUP_MS * 2, { captcha: true, rnd }).dup, true);
  const pk = g.peek(6, T + 1000);
  is('peek shows the options for private-chat verification', pk.ok && pk.options.length === OPTIONS, true);
  is('and the target, never the index', pk.options.includes(pk.target) && !('answer' in pk), true);
  is('peek after the clock shows nothing', g.peek(6, T + 11 * 60_000).ok, false);
  is('drop forgets a challenge the bot could not enforce', g.drop(6).ok, true);
}

console.log('\nwelcome and storage');
{
  const g = new Guard();
  is('the first welcome has nothing to delete', g.welcome(100).prev, 0);
  is('the next one returns the last to delete', g.welcome(101).prev, 100);
  g.join(8, T, { captcha: true, rnd });
  const back = Guard.from(JSON.parse(JSON.stringify(g.toJSON())));
  is('pending survives storage', Object.keys(back.pending).join(), '8');
  is('the last welcome survives storage', back.lastWelcome, 101);
  is('the dedupe window is memory only', 'recent' in g.toJSON(), false);
  is('runGuard refuses an unknown op', runGuard(g, 'nope').ok, false);
  const mem = memoryGuard();
  const a = await mem(-1, 'join', { uid: 1, captcha: true });
  const b = await mem(-2, 'join', { uid: 1, captcha: true });
  is('groups are separate', !!(a.captcha && b.captcha), true);
}

console.log('\nwelcome text');
{
  const g = { sym: 'ZCAT', guard: { text: 'Hi {name}, welcome to {group} <b>{sym}</b>' } };
  const t = welcomeText(g, { title: '<Cats & co>' }, { id: 12, first_name: '<img src=x>' });
  is('an admin’s own HTML is escaped', t.includes('<b>ZCAT</b>'), false);
  is('a hostile first name is escaped', t.includes('<img'), false);
  is('the name is a mention', t.includes('tg://user?id=12'), true);
  is('the group title is escaped', t.includes('&lt;Cats &amp; co&gt;'), true);
  const d = welcomeText({ sym: 'ZCAT' }, { title: 'G' }, { id: 1, first_name: 'Ann' });
  is('the default names the token as a cashtag', d.includes('$ZCAT'), true);
}

console.log('\nsettings');
{
  const g = { sym: 'X', guard: { captcha: true, ttl: 10 } };
  const v = settingsView(g, 'guard');
  is('the guard page shows the captcha on', v.kb[0][0].text.startsWith('✅'), true);
  is('private-chat verification off by default', v.kb[1][0].text.startsWith('⬜') && v.kb[1][0].callback_data === 'cfg:gdm', true);
  is('and the welcome off', v.kb[2][0].text.startsWith('⬜'), true);
  is('ten minutes is ticked', v.kb[4].find(b => b.text.startsWith('✅')).text, '✅ 10 min');
  is('the main page has a Guard button', settingsView(g).kb.flat().some(b => b.callback_data === 'cfg:guard'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
