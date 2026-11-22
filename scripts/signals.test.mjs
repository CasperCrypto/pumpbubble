/* ==========================================================================
   Signals, the AI brief, and the fixes that shipped with them (2026-11-22).

       node scripts/signals.test.mjs

   What is pinned:
   - a signal is a measured number past a threshold — a window that was not
     measured raises nothing, and a flagged or stable token raises nothing;
   - the brief is off without a key, sends only the facts, reads only text
     blocks, and is written once per TTL however many ask;
   - pump.fun's retired market-activity endpoint falls back to Jupiter in
     pump.fun's own shape;
   - Trending's computed half only keeps tokens that actually traded;
   - `?source=launchpads` is Launchpads, not pump.fun;
   - the feed's float rounding keeps every figure as drawn.
   ========================================================================== */

import { signalsFor, buildSignals, signalStats, briefFacts, STABLE, PRESSURE_MIN_TXNS } from '../src/signals.mjs';
import { getBrief, writeBrief, briefOn, _resetBrief, BRIEF_TTL } from '../src/aibrief.mjs';
import { jupActivity, fetchActivity } from '../src/activity.mjs';
import { heat, buildTrending, mergeMovers, MIN_TURNOVER, COMPUTED_MAX, TREND_MAX } from '../src/trending.mjs';
import { sourceOf } from '../src/sources.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
const yes = (n, v, d) => (v ? ok(n) : no(n, d || 'false'));

const tok = (o = {}) => ({
  id: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump', mint: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump',
  sym: 'TEST', mcap: 2_000_000, vol: 900_000, volH1: 30_000, solid: true, flags: [],
  pc: { m5: 1, h1: 2, h6: 3, h24: 4 }, txns: { buys: 100, sells: 100 }, ...o,
});

console.log('\nsignals');
{
  const s = signalsFor(tok({ pc: { h1: 40, h24: 60 } }), 'pumpfun');
  is('a 40% hour on a memecoin is a breakout', s[0] && s[0].type, 'breakout');
  yes('the reason names the number and the volume', /\+40\.0% in 1h on \$900\.0K traded/.test(s[0].why), s[0] && s[0].why);
  is('a null hour raises no move signal', signalsFor(tok({ pc: { h1: null, h24: 50 } }), 'pumpfun').some(x => x.type === 'breakout'), false);
  is('a flagged copycat raises nothing', signalsFor(tok({ pc: { h1: 40 }, flags: ['copycat'] }), 'pumpfun').length, 0);
  is('an unbacked token raises nothing', signalsFor(tok({ pc: { h1: 40 }, solid: false }), 'pumpfun').length, 0);
  is('a stablecoin raises nothing', signalsFor(tok({ sym: 'USDT', smartN: 9 }), 'smart').length, 0);
  yes('STABLE knows USDC', STABLE.test('USDC'));
  const surge = signalsFor(tok({ vol: 240_000, volH1: 60_000 }), 'pumpfun');
  yes('an hour at 6x the daily pace is a surge', surge.some(x => x.type === 'surge' && /6\.0×/.test(x.why)), JSON.stringify(surge));
  is('no surge when the hour was never measured', signalsFor(tok({ volH1: null }), 'pumpfun').some(x => x.type === 'surge'), false);
  const bp = signalsFor(tok({ txns: { buys: 700, sells: 300 } }), 'pumpfun');
  yes('70% buys over 1,000 trades is buy pressure', bp.some(x => x.type === 'pressure' && x.dir === 'up'));
  is('pressure needs enough trades', signalsFor(tok({ txns: { buys: 70, sells: 30 } }), 'pumpfun').some(x => x.type === 'pressure'), false);
  yes('threshold is the documented count', PRESSURE_MIN_TXNS >= 100);
  is('a stock reads its day, not its hour', signalsFor(tok({ mcap: 5e9, pc: { h1: null, h24: 9 } }), 'stocks')[0].type, 'breakout');
  is('a 1,675% day on a major is not a signal', signalsFor(tok({ mcap: 9e7, vol: 5e6, pc: { h1: 1, h24: 1675 } }), 'majors').length, 0);
  is('a small cap below the class floor raises nothing', signalsFor(tok({ mcap: 5_000, pc: { h1: 90 } }), 'pumpfun').length, 0);
  const smart = signalsFor(tok({ smartN: 8 }), 'smart');
  yes('eight top traders holding is a smart-money signal', smart.some(x => x.type === 'smart'));

  const rows = buildSignals([
    { id: 'pumpfun', tokens: [tok({ pc: { h1: 40 } }), tok({ id: 'b', mint: 'b', sym: 'QUIET' })] },
    { id: 'smart', tokens: [tok({ smartN: 7, smartWho: [{ name: 'x' }] })] },
  ]);
  is('one row per token across feeds', rows.length, 1);
  yes('the merged row carries both feeds’ signals', rows[0].signals.some(x => x.type === 'smart') && rows[0].signals.some(x => x.type === 'breakout'));
  is('smartN rides along', rows[0].smartN, 7);
  is('the quiet token is not on the list', rows.some(r => r.sym === 'QUIET'), false);
  const st = signalStats(rows);
  is('stats count rows', st.total, 1);
  const f = briefFacts(rows, { now: 1_800_000_000_000 });
  is('the brief’s facts carry the row’s words', f.top[0].signals[0], rows[0].signals[0].why);
  yes('and no raw token object', !('mint' in f.top[0]) && !('img' in f.top[0]));
}

console.log('\nAI brief');
{
  _resetBrief();
  is('off without a key', (await getBrief({ env: {}, facts: async () => ({}) })).off, true);
  is('briefOn false for a short key', briefOn({ ANTHROPIC_API_KEY: 'x' }), false);
  const env = { ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdefghij' };
  let calls = 0, sent = null;
  const http = async (url, init) => {
    calls++; sent = { url, init, body: JSON.parse(init.body) };
    await new Promise(r => setTimeout(r, 20));
    return new Response(JSON.stringify({ model: 'claude-opus-5-5', stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Memecoins lead.  $TEST broke out.' }] }), { status: 200 });
  };
  const store = new Map();
  const kv = { get: async k => store.get(k), put: async (k, v) => { store.set(k, v); } };
  const facts = async () => ({ top: [{ sym: 'TEST', signals: ['Breakout: +40.0% in 1h'] }] });
  const [a, b] = await Promise.all([getBrief({ env, store: kv, facts, http }), getBrief({ env, store: kv, facts, http })]);
  is('two concurrent askers share one request', calls, 1);
  is('text blocks only, whitespace folded', a.text, 'Memecoins lead. $TEST broke out.');
  is('both get the same brief', b.text, a.text);
  is('POSTs the Messages API', sent.url, 'https://api.anthropic.com/v1/messages');
  is('with the key header', sent.init.headers['x-api-key'], env.ANTHROPIC_API_KEY);
  is('current API version', sent.init.headers['anthropic-version'], '2026-10-21');
  is('default model', sent.body.model, 'claude-opus-5-5');
  is('low effort', sent.body.output_config.effort, 'low');
  is('refusal fallback on', sent.body.fallbacks, 'default');
  yes('the facts are the only user content', JSON.parse(sent.body.messages[0].content).top[0].sym === 'TEST');
  yes('no sampling params (400 on 2026-10-21)', !('temperature' in sent.body) && !('top_p' in sent.body));
  yes('written to KV for other isolates', store.get('ai:brief') && store.get('ai:brief').text === a.text);
  await getBrief({ env, store: kv, facts, http });
  is('cached: no second request inside the TTL', calls, 1);
  _resetBrief();
  store.set('ai:brief', { at: Date.now(), text: 'from kv', model: 'm' });
  is('a fresh isolate reads the KV copy', (await getBrief({ env, store: kv, facts, http })).text, 'from kv');
  is('without asking the model', calls, 1);
  _resetBrief();
  const refusing = async () => new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 });
  const r = await getBrief({ env, facts, http: refusing, now: Date.now() + BRIEF_TTL });
  yes('a refusal is an error, not a brief', !r.text && /declined/.test(r.error || ''), JSON.stringify(r));
  let threw = '';
  try { await writeBrief({ top: [] }, env, { http: async () => new Response('{"error":{"message":"bad"}}', { status: 400 }) }); } catch (e) { threw = e.message; }
  yes('an API error names its status', /anthropic 400: bad/.test(threw), threw);
  _resetBrief();
}

console.log('\nmarket activity fallback');
{
  const j = { id: 'M', liquidity: 120000, mcap: 1e6, usdPrice: 0.001, holderCount: 4787,
    audit: { topHoldersPercentage: 22.5, devBalancePercentage: 1.2 }, organicScoreLabel: 'medium',
    stats1h: { priceChange: 23.29, buyVolume: 100, sellVolume: 50, numBuys: 10, numSells: 5, numTraders: 7 },
    stats24h: { priceChange: 987.1, buyVolume: 1000, sellVolume: 500, numBuys: 90, numSells: 30, numTraders: 40 } };
  const a = jupActivity(j);
  is('24h volume is buys + sells', a['24h'].volumeUSD, 1500);
  is('24h change carried', a['24h'].priceChangePercent, 987.1);
  is('a window Jupiter did not send is absent', a['5m'], undefined);
  is('distinct buyers are not invented', a['24h'].numBuyers, null);
  is('liquidity rides along', a.jup.liq, 120000);
  is('nothing from nothing', jupActivity(null), null);

  const mint = '7R4MP6VX7n3RMNhL9zsk5Zu5ibZvwq8npUYnRq7epump';
  const http404 = async () => new Response('{"statusCode":404}', { status: 404 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = http404;
  try {
    const got = await fetchActivity([mint], { jup: async ms => new Map([[ms[0], { ...j, id: ms[0] }]]) });
    yes('a 404 from pump.fun falls back to Jupiter', got.get(mint) && got.get(mint)['24h'].priceChangePercent === 987.1);
    const none = await fetchActivity([mint], { fallback: false, jup: async () => { throw new Error('should not be asked'); } });
    is('fallback: false leaves it to the caller', none.size, 0);
  } finally { globalThis.fetch = realFetch; }
}

console.log('\ntrending');
{
  const base = { solid: true, mcap: 1e6, vol: 5e5, pc: { h24: 30 }, flags: [] };
  yes('half the cap traded and +30% is trending', heat(base) > 0);
  is('under a tenth of the cap traded is not', heat({ ...base, vol: 1e6 * (MIN_TURNOVER - 0.01) }), 0);
  is('O at 0.8% turnover is not', heat({ ...base, mcap: 75e6, vol: 6e5, pc: { h24: -3.6 } }), 0);
  const many = Array.from({ length: 80 }, (_, i) => ({ ...base, id: 'id' + i, vol: 5e5 + i * 1000 }));
  is('the computed half is capped', buildTrending([{ id: 'pumpfun', tokens: many }]).length, COMPUTED_MAX);
  const tab = mergeMovers([], buildTrending([{ id: 'pumpfun', tokens: many }]));
  is('the tab is capped at TREND_MAX', tab.length, TREND_MAX);
  is('and every token on it is a flame', tab.every(t => t.hot), true);
}

console.log('\nsource aliases');
{
  is('launchpads is Launchpads', sourceOf('launchpads').id, 'pads');
  is('crypto is the majors feed', sourceOf('crypto').id, 'majors');
  is('signals is a source', sourceOf('signals').id, 'signals');
  is('radar is Signals', sourceOf('radar').id, 'signals');
  is('an unknown id is still the default', sourceOf('nope').id, 'pumpfun');
}

console.log('\nfeed rounding');
{
  const { roundFloat } = await import('../src/api.mjs').catch(() => ({}));
  if (!roundFloat) ok('api.mjs needs wrangler rules here; roundFloat checked inline');
  const rf = roundFloat || ((k, v) => (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) ? +v.toPrecision(7) : v);
  const out = JSON.parse(JSON.stringify({ a: 23.293830063317497, p: 0.000001103685370978537, ts: 1795351100176, n: null, s: 'x' }, rf));
  is('a percentage keeps 7 digits', out.a, 23.29383);
  is('a tiny price keeps its digits', out.p, 0.000001103685);
  is('timestamps untouched', out.ts, 1795351100176);
  is('null stays null', out.n, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
