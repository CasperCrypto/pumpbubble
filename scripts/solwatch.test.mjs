/* ==========================================================================
   Solana buy alerts, polled — the cursor rules and the RPC handling.

       node scripts/solwatch.test.mjs

   The two failures that matter: a group flooded with an hour of old buys
   (a first look, or a cursor from before a long sleep, must post nothing
   old), and a buy lost or posted twice because an endpoint misbehaved (a
   429, a refused batch, a transaction it had not caught up with yet). Every
   RPC here is a fake fetch shaped like the real answers the three free
   endpoints gave on 2026-10-02 — including PublicNode's one-getTransaction-
   per-batch refusal, word for word.
   ========================================================================== */

import { watchList, pickNew, rpcCall, Endpoints, readTxs, readSpread, poll, rpcList, solPolling, host, LIMIT_BENCH_MS,
  RPCS, MAX_AGE_S, TX_MAX, SINGLE_MAX } from '../src/solwatch.mjs';
import { buysFromPayload } from '../src/solbuy.mjs';
import { addrHash } from '../src/helius.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const MINT = 'MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POOL = 'PoolBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BUYER = 'BuyerCccccccccccccccccccccccccccccccccccccc';
const NOW = 1_800_000_000_000;
const T = NOW / 1000;
const sig = (n, slot, age = 2, err = null) => ({ signature: 's' + n, slot, blockTime: T - age, err });

/* a transaction in getTransaction's json encoding: BUYER pays 1 SOL (+fee)
   and gains 1,000 of MINT */
const txOf = (n) => ({
  slot: 100 + n, blockTime: T - 2,
  transaction: { signatures: ['s' + n], message: { header: { numRequiredSignatures: 1 }, accountKeys: [BUYER, POOL, 'TokAcct111111111111111111111111111111111111'] } },
  meta: {
    err: null, fee: 5000,
    preBalances: [2_000_005_000, 0, 0], postBalances: [1_000_000_000, 0, 0],
    preTokenBalances: [{ accountIndex: 2, mint: MINT, owner: BUYER, uiTokenAmount: { uiAmount: 0, decimals: 6, amount: '0' } }],
    postTokenBalances: [{ accountIndex: 2, mint: MINT, owner: BUYER, uiTokenAmount: { uiAmount: 1000, decimals: 6, amount: '1000000000' } }],
    loadedAddresses: { writable: [], readonly: [] },
  },
});

/* A fake endpoint: answers each JSON-RPC item from `handlers`, with knobs for
   the ways the real ones refuse. Records what it was asked. */
function fakeNet(spec) {
  const asked = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    const s = spec[url] || {};
    asked.push({ url, body });
    const res = (status, obj, raw) => ({ status, ok: status >= 200 && status < 300, text: async () => raw != null ? raw : JSON.stringify(obj) });
    if (s.status429) return res(429, { jsonrpc: '2.0', error: { code: 429, message: 'Too many requests for a specific RPC call' } });
    if (s.html) return res(521, null, '<!DOCTYPE html><html>down</html>');
    const answer = (q) => {
      const h = (s.handlers || {})[q.method];
      return h ? { jsonrpc: '2.0', id: q.id, result: h(q.params) } : { jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'no' } };
    };
    if (Array.isArray(body)) {
      if (s.noTxBatch && body.some(q => q.method === 'getTransaction') && body.length > 1) {
        return res(400, { jsonrpc: '2.0', error: { code: -32600, message: "Maximum number of 'getTransaction' calls in a batch request is 1. To increase limits, get a personal token" } });
      }
      const out = body.map(answer);
      return res(200, s.reverse ? out.reverse() : out);
    }
    return res(200, answer(body));
  };
  return { fetcher, asked };
}

console.log('\nwhat to poll');
{
  is('mint and pool, deduped', watchList([{ mint: MINT, pool: POOL }, { mint: MINT, pool: '' }, { mint: 'Other111', pool: POOL }]), [MINT, POOL, 'Other111']);
  is('nothing followed, nothing polled', watchList([]), []);
  is('junk rows are skipped', watchList([null, {}, { pool: POOL }]), [POOL]);
}

console.log('\ncursors');
{
  /* first look: remember, post nothing */
  const a = pickNew({ [MINT]: [sig(9, 109), sig(8, 108)] }, {}, { now: NOW });
  is('first look posts nothing', a.sigs, []);
  is('first look remembers the newest', a.next[MINT], 's9');

  /* later: new ones, newest first, across addresses, each once */
  const b = pickNew({ [MINT]: [sig(12, 112), sig(10, 110)], [POOL]: [sig(11, 111), sig(10, 110)] }, { [MINT]: 's9', [POOL]: 's9' }, { now: NOW });
  is('new signatures, newest first, once each', b.sigs, ['s12', 's11', 's10']);
  is('each address moves to its newest', [b.next[MINT], b.next[POOL]], ['s12', 's11']);

  const c = pickNew({ [MINT]: [sig(14, 114, 2, { InstructionError: [0, 'x'] }), sig(13, 113)] }, { [MINT]: 's12' }, { now: NOW });
  is('a failed transaction is not read', c.sigs, ['s13']);

  const d = pickNew({ [MINT]: [sig(20, 120, 5), sig(19, 119, MAX_AGE_S + 60)] }, { [MINT]: 's1' }, { now: NOW });
  is('a cursor from before a long sleep posts nothing old', d.sigs, ['s20']);

  const e = pickNew({ [MINT]: [sig(21, 121), sig(20, 120)] }, { [MINT]: 's19' }, { now: NOW, seen: new Set(['s20']) });
  is('already read elsewhere: skipped', e.sigs, ['s21']);

  const f = pickNew({ [MINT]: null, [POOL]: [] }, { [MINT]: 's5', [POOL]: 's6' }, { now: NOW });
  is('a failed call keeps its cursor', [f.next[MINT], f.next[POOL], f.sigs.length], ['s5', 's6', 0]);

  const many = Array.from({ length: 30 }, (_, i) => sig(100 + i, 1000 + i)).reverse();
  const g = pickNew({ [MINT]: many }, { [MINT]: 's1' }, { now: NOW });
  is('a burst is capped, newest kept', [g.sigs.length, g.sigs[0], g.skipped], [TX_MAX, 's129', 30 - TX_MAX]);
}

console.log('\nRPC answers');
{
  const net = fakeNet({ 'https://a.test': { reverse: true, handlers: { getSlot: () => 7, getBalance: () => ({ value: 1 }) } } });
  const r = await rpcCall('https://a.test', [{ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }, { jsonrpc: '2.0', id: 2, method: 'nope', params: [] }, { jsonrpc: '2.0', id: 3, method: 'getBalance', params: [] }], net.fetcher);
  is('a batch answers in request order, null where an item failed', r, [7, null, { value: 1 }]);

  try { await rpcCall('https://a.test', [{ jsonrpc: '2.0', id: 1, method: 'nope' }, { jsonrpc: '2.0', id: 2, method: 'nope' }], net.fetcher); no('every item failing throws'); }
  catch (e) { /a\.test/.test(e.message) ? ok('every item failing is the endpoint failing — thrown, not a quiet market') : no('every item failing', e.message); }
  const late = fakeNet({ 'https://a.test': { handlers: { getTransaction: () => null } } });
  const nulls = await rpcCall('https://a.test', [{ jsonrpc: '2.0', id: 1, method: 'getTransaction' }, { jsonrpc: '2.0', id: 2, method: 'getTransaction' }], late.fetcher);
  is('…but transactions not served yet are nulls, not a failure', [nulls, nulls.errors.length], [[null, null], 0]);

  const lim = fakeNet({ 'https://b.test': { status429: true } });
  try { await rpcCall('https://b.test', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, lim.fetcher); no('429 throws'); }
  catch (e) { e.limited ? ok('429 throws as a rate limit') : no('429 throws as a rate limit', e.message); }

  const pn = fakeNet({ 'https://c.test': { noTxBatch: true, handlers: { getTransaction: () => ({}) } } });
  try { await rpcCall('https://c.test', [{ jsonrpc: '2.0', id: 1, method: 'getTransaction' }, { jsonrpc: '2.0', id: 2, method: 'getTransaction' }], pn.fetcher); no('refused batch throws'); }
  catch (e) { e.noBatch ? ok('PublicNode\'s refusal reads as "no batch"') : no('refused batch', e.message); }

  const down = fakeNet({ 'https://d.test': { html: true } });
  try { await rpcCall('https://d.test', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, down.fetcher); no('an HTML error page throws'); }
  catch (e) { /521/.test(e.message) && e.message.includes('d.test') ? ok('an HTML error page throws, naming the host') : no('html', e.message); }

  is('hosts only, never a path that might hold a key', host('https://rpc.example.com/v2/SECRET?api-key=x'), 'rpc.example.com');
}

console.log('\nendpoints');
{
  const eps = new Endpoints(['https://a.test', 'https://b.test']);
  eps.sit('https://a.test', NOW);
  is('a benched endpoint sits out', eps.live(NOW + 1000), ['https://b.test']);
  is('…for a minute', eps.live(NOW + 61_000), ['https://a.test', 'https://b.test']);
  eps.sit('https://b.test', NOW);
  is('everyone benched: try them all anyway', eps.live(NOW + 1000), ['https://a.test', 'https://b.test']);

  is('the free endpoints, Solana\'s own first', RPCS[0], 'https://api.mainnet-beta.solana.com');
  is('SOL_POLL_RPC goes first', rpcList({ SOL_POLL_RPC: 'https://my.rpc/?k=1' })[0], 'https://my.rpc/?k=1');
  is('…only when it is https', rpcList({ SOL_POLL_RPC: 'http://my.rpc' })[0], RPCS[0]);
  is('polling is the default', solPolling({}), true);
  is('SOL_BUYS=helius switches it off', solPolling({ SOL_BUYS: ' Helius ' }), false);
  is('anything else keeps it on', solPolling({ SOL_BUYS: 'poll' }), true);
}

console.log('\none poll, end to end');
{
  let head = [sig(2, 102), sig(1, 101)];
  const txs = { s1: txOf(1), s2: txOf(2), s3: txOf(3) };
  let lag = new Set();                                    // signatures B has listed but not served yet
  const net = fakeNet({
    'https://a.test': { status429: true },
    'https://b.test': { noTxBatch: true, handlers: {
      getSignaturesForAddress: ([addr, o]) => {
        const rows = addr === MINT ? head : [];
        if (!o.until) return rows.slice(0, o.limit);
        const i = rows.findIndex(r => r.signature === o.until);
        return (i < 0 ? rows : rows.slice(0, i)).slice(0, o.limit);
      },
      getTransaction: ([s]) => lag.has(s) ? null : (txs[s] || null),
    } },
  });
  const eps = new Endpoints(['https://a.test', 'https://b.test']);
  const p1 = await poll([MINT, POOL], {}, eps, { now: NOW, fetcher: net.fetcher });
  is('first poll: the rate-limited endpoint is skipped', p1.rpc, 'b.test');
  is('first poll: cursors only', [p1.txs.length, p1.next[MINT]], [0, 's2']);
  is('first look asks for one signature', net.asked.find(x => x.url === 'https://b.test').body[0].params[1].limit, 1);

  head = [sig(4, 104), sig(3, 103), sig(2, 102), sig(1, 101)];
  txs.s4 = txOf(4);
  lag = new Set(['s4']);
  const p2 = await poll([MINT, POOL], p1.next, eps, { now: NOW + 4000, fetcher: net.fetcher });
  is('second poll: the new buy is read, singly where batches are refused', p2.txs.map(t => t.transaction.signatures[0]), ['s3']);
  is('…and the one not served yet comes back next time', p2.again, ['s4']);
  is('…the endpoint is remembered as one-at-a-time', eps.single.has('https://b.test'), true);

  lag = new Set();
  const p3 = await poll([MINT, POOL], p2.next, eps, { now: NOW + 8000, retry: p2.again, fetcher: net.fetcher });
  is('third poll: the late one arrives, nothing twice', p3.txs.map(t => t.transaction.signatures[0]), ['s4']);

  const buys = buysFromPayload(p2.txs, new Set([MINT]));
  is('a polled transaction is a buy to the same parser Helius fed', buys.length === 1 && [buys[0].buyer, +buys[0].sol.toFixed(4), buys[0].tokens], [BUYER, 1, 1000]);

  const p4 = await poll([], p3.next, eps, { now: NOW, fetcher: net.fetcher });
  is('nothing followed: no calls, cursors dropped', [p4.txs.length, Object.keys(p4.next).length], [0, 0]);
  const p5 = await poll([POOL], { [MINT]: 's4', [POOL]: 's0' }, eps, { now: NOW + 12000, fetcher: net.fetcher });
  is('an unfollowed address\'s cursor falls away', Object.keys(p5.next), [POOL]);
}

console.log('\nbursts and spreading');
{
  /* a capped burst reads the pool's signatures first: they are swaps */
  const mintRows = Array.from({ length: 15 }, (_, i) => sig(300 + i, 3000 + i)).reverse();
  const poolRows = [sig(250, 2500)];                                  // older than every mint one
  const h = pickNew({ [MINT]: mintRows, [POOL]: poolRows }, { [MINT]: 's1', [POOL]: 's1' }, { now: NOW, prefer: new Set([POOL]) });
  is('a capped burst takes the pool\'s first', [h.sigs[0], h.sigs.length, h.skipped], ['s250', TX_MAX, 16 - TX_MAX]);

  const net = fakeNet({
    'https://a.test': { handlers: { getTransaction: ([s]) => txOf(+s.slice(1)) } },
    'https://b.test': { status429: true },
    'https://c.test': { handlers: { getTransaction: ([s]) => txOf(+s.slice(1)) } },
  });
  const eps = new Endpoints(['https://a.test', 'https://b.test', 'https://c.test']);
  const sigs = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const got = await readSpread(eps, 'https://a.test', sigs, net.fetcher, NOW);
  const hosts = [...new Set(net.asked.map(x => x.url))].sort();
  is('a poll\'s reads are spread over every endpoint', hosts, ['https://a.test', 'https://b.test', 'https://c.test']);
  is('…the rate-limited share comes back empty for a retry', got.map(t => t ? t.transaction.signatures[0] : null), ['s1', null, 's3', 's4', null, 's6']);
  is('…and that endpoint sits out fifteen seconds, not a minute', [eps.live(NOW + 1000).includes('https://b.test'), eps.live(NOW + LIMIT_BENCH_MS + 1).includes('https://b.test')], [false, true]);
  const rep = eps.report(NOW + 2000);
  is('status names the host and its error, nothing else', [Object.keys(rep), rep['b.test'].benched, /429/.test(rep['b.test'].err)], [['b.test'], true, true]);

  const dead = fakeNet({ 'https://a.test': { status429: true }, 'https://c.test': { html: true } });
  const eps2 = new Endpoints(['https://a.test', 'https://c.test']);
  try { await readSpread(eps2, 'https://a.test', ['s1', 's2'], dead.fetcher, NOW); no('every share failing throws'); }
  catch { ok('every share failing is a failed poll'); }
}

console.log('\nsubrequests');
{
  const net = fakeNet({ 'https://c.test': { noTxBatch: true, handlers: { getTransaction: ([s]) => txOf(+s.slice(1)) } } });
  const eps = new Endpoints(['https://c.test']);
  eps.single.add('https://c.test');
  const sigs = Array.from({ length: 12 }, (_, i) => 's' + i);
  const got = await readTxs(eps, 'https://c.test', sigs, net.fetcher);
  is(`one at a time: at most ${SINGLE_MAX} calls, the rest wait`, [net.asked.length, got.filter(Boolean).length, got.filter(x => x === null).length], [SINGLE_MAX, SINGLE_MAX, 12 - SINGLE_MAX]);
}

console.log('\nHelius set fingerprint');
{
  is('order and repeats do not change it', addrHash(['b', 'a', 'a']), addrHash(['a', 'b']));
  is('a different set does', addrHash(['a', 'b']) === addrHash(['a', 'c']), false);
  is('empty is stable', addrHash([]), addrHash([]));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
