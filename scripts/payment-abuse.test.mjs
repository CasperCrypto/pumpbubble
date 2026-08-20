/* ==========================================================================
   Payment abuse tests.

   These cover the cases that cannot be produced against a real chain on
   demand — underpayment, overpayment, replays, payments aimed at the wrong
   wallet — by standing a fake Solana RPC in front of the real matching code.
   Everything below `findPayment` is the production path, untouched.

       node scripts/payment-abuse.test.mjs
   ========================================================================== */

import { createOrder, findPayment, scanTreasury, activateBoost, TIERS } from '../src/boosts.mjs';

const TREASURY = '6k8T4fXq5vt3asVnywaHgfw4ApRexGHupbUU8e3TsW1C';
const PAYER = 'PayerWa11etAddressAAAAAAAAAAAAAAAAAAAAAAAAA';
const RPC = 'https://fake-rpc.test';
const SOL_PRICE = 85;

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };

/* ------------------------------------------------------------ fake chain */
let CHAIN = [];   // [{ signature, lamports, blockTime, to, err, keys }]

globalThis.fetch = async (url, opts) => {
  const { method, params } = JSON.parse(opts.body);
  const reply = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    { status: 200, headers: { 'content-type': 'application/json' } });

  if (method === 'getSignaturesForAddress') {
    const addr = params[0];
    return reply(CHAIN
      .filter(t => t.to === addr || (t.keys || []).includes(addr))
      .map(t => ({ signature: t.signature, blockTime: t.blockTime, slot: 1, err: t.err || null })));
  }
  if (method === 'getTransaction') {
    const t = CHAIN.find(x => x.signature === params[0]);
    if (!t) return reply(null);
    /* index 0 payer, index 1 recipient, then any extra keys (e.g. a reference) */
    const keys = [PAYER, t.to, ...(t.keys || [])];
    return reply({
      meta: {
        err: t.err || null,
        preBalances: [10e9, 5e9, 0, 0, 0],
        postBalances: [10e9 - t.lamports, 5e9 + t.lamports, 0, 0, 0],
      },
      transaction: { message: { accountKeys: keys.map(pubkey => ({ pubkey })) } },
    });
  }
  return reply(null);
};

const newOrder = async (tierId = 'pump') => createOrder({
  mint: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
  sym: 'TEST', tierId, solPrice: SOL_PRICE, treasury: TREASURY,
});

/* force a fresh scan, since the production cache is 10s and tests run faster */
const check = async order => {
  await scanTreasury(RPC, TREASURY, true);
  return findPayment(RPC, order);
};

const secondsNow = () => Math.floor(Date.now() / 1000);

/* ============================================================== the tests */
console.log('\n== paying less than the full amount ==');

{
  const o = await newOrder('pump');                       // $49
  CHAIN = [{ signature: 'sig_short_1', lamports: o.lamports - 1, blockTime: secondsNow(), to: TREASURY }];
  const p = await check(o);
  p ? no('1 lamport short', 'ACTIVATED — underpayment accepted')
    : ok('1 lamport short', 'no boost');
}
{
  const o = await newOrder('pump');
  CHAIN = [{ signature: 'sig_short_2', lamports: Math.floor(o.lamports / 2), blockTime: secondsNow(), to: TREASURY }];
  const p = await check(o);
  p ? no('paying half', 'ACTIVATED') : ok('paying half', 'no boost');
}
{
  const o = await newOrder('whale');                      // $149
  const spark = await newOrder('spark');                  // $9
  CHAIN = [{ signature: 'sig_cheap', lamports: spark.lamports, blockTime: secondsNow(), to: TREASURY }];
  const p = await check(o);
  p ? no('paying the $9 price for the $149 tier', 'ACTIVATED')
    : ok('paying the $9 price for the $149 tier', 'no boost');
}
{
  const o = await newOrder('pump');
  CHAIN = [{ signature: 'sig_dust', lamports: 1, blockTime: secondsNow(), to: TREASURY }];
  const p = await check(o);
  p ? no('dust payment of 1 lamport', 'ACTIVATED') : ok('dust payment of 1 lamport', 'no boost');
}
{
  /* many small payments that add up to the price but are individually wrong */
  const o = await newOrder('pump');
  const third = Math.floor(o.lamports / 3);
  CHAIN = [1, 2, 3].map(i => ({ signature: 'sig_drip_' + i, lamports: third, blockTime: secondsNow(), to: TREASURY }));
  const p = await check(o);
  p ? no('three part-payments totalling the price', 'ACTIVATED')
    : ok('three part-payments totalling the price', 'no boost — amounts are matched individually');
}

console.log('\n== paying the right amount to the wrong place ==');
{
  const o = await newOrder('pump');
  CHAIN = [{ signature: 'sig_wrong_dest', lamports: o.lamports, blockTime: secondsNow(), to: PAYER }];
  const p = await check(o);
  p ? no('exact amount sent to another wallet', 'ACTIVATED') : ok('exact amount sent to another wallet', 'no boost');
}
{
  const o = await newOrder('pump');
  CHAIN = [{ signature: 'sig_failed', lamports: o.lamports, blockTime: secondsNow(), to: TREASURY, err: { InstructionError: [0, 'Custom'] } }];
  const p = await check(o);
  p ? no('failed transaction', 'ACTIVATED') : ok('failed transaction', 'no boost');
}
{
  const o = await newOrder('pump');
  /* a payment that landed before the quote existed cannot belong to it */
  CHAIN = [{ signature: 'sig_old', lamports: o.lamports, blockTime: secondsNow() - 7200, to: TREASURY }];
  const p = await check(o);
  p ? no('replaying an older payment of the same size', 'ACTIVATED')
    : ok('replaying an older payment of the same size', 'no boost');
}

console.log('\n== paying correctly ==');
let goodOrder, goodPayment;
{
  goodOrder = await newOrder('pump');
  CHAIN = [{ signature: 'sig_good', lamports: goodOrder.lamports, blockTime: secondsNow(), to: TREASURY }];
  goodPayment = await check(goodOrder);
  goodPayment ? ok('exact amount', `${goodPayment.received} SOL matched`)
              : no('exact amount', 'REJECTED a valid payment');
}
{
  const o = await newOrder('pump');
  CHAIN = [{ signature: 'sig_over', lamports: o.lamports + 50_000_000, blockTime: secondsNow(), to: TREASURY,
             keys: [o.reference] }];
  const p = await check(o);
  p ? ok('overpaying via Solana Pay', 'accepted — the reference key identifies the order')
    : no('overpaying via Solana Pay', 'rejected, so an overpayment strands');
}
{
  const o = await newOrder('pump');
  CHAIN = [{ signature: 'sig_under_ref', lamports: Math.floor(o.lamports / 2), blockTime: secondsNow(), to: TREASURY,
             keys: [o.reference] }];
  const p = await check(o);
  p ? no('underpaying via Solana Pay', 'ACTIVATED — reference must not excuse a short payment')
    : ok('underpaying via Solana Pay', 'no boost');
}

console.log('\n== one payment, one boost ==');
{
  const store = (() => { const m = new Map(); return {
    async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; })();
  await activateBoost(store, goodOrder, goodPayment);
  await activateBoost(store, goodOrder, goodPayment);
  await activateBoost(store, { ...goodOrder, id: 'ord_different', mult: 4 }, goodPayment);
  const boosts = await store.get('boosts');
  boosts.length === 1 ? ok('replaying one payment for several boosts', 'only 1 boost stored')
                      : no('replaying one payment for several boosts', `${boosts.length} boosts stored`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
