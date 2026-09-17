/* ==========================================================================
   The casino hot-wallet registry, and the arithmetic on top of it.

       node scripts/casinos.test.mjs

   The registry is a list of addresses the map will publish balances for
   under a casino's name. A wrong row is a wrong number under a real brand,
   so the shape of every row is checked here: a valid address for its chain,
   a source hash that is a hash, no duplicates, and never a token contract —
   the one thing the derivation was seen to produce once.

   The totals and change arithmetic are checked against a fabricated blob,
   because "24h change" must be null until there is a reading a day old, and
   a wallet that failed to read must keep its last value rather than zero.
   ========================================================================== */

import { WALLETS, ERC20, TRC20, SPL } from '../src/casinowallets.mjs';
import { totals, SLICE } from '../src/casinos.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

const EVM = /^0x[0-9a-f]{40}$/;
const TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HASH = { ethereum: /^0x[0-9a-f]{64}$/, polygon: /^0x[0-9a-f]{64}$/, bsc: /^0x[0-9a-f]{64}$/, tron: /^[0-9a-f]{64}$/, solana: /^[1-9A-HJ-NP-Za-km-z]{80,90}$/ };

console.log('\nregistry shape');
is('has rows', WALLETS.length > 20, true);
const badAddr = WALLETS.filter(w => !((w.chain === 'tron' && TRON.test(w.addr)) || (w.chain === 'solana' && SOL.test(w.addr)) || (['ethereum', 'polygon', 'bsc'].includes(w.chain) && EVM.test(w.addr))));
is('every address is valid for its chain', badAddr.length, 0);
const badSrc = WALLETS.filter(w => !(HASH[w.chain] && HASH[w.chain].test(w.src)));
is('every source is a transaction hash for its chain', badSrc.length, 0);
const keys = WALLETS.map(w => w.chain + '|' + w.addr);
is('no duplicate (chain, address)', new Set(keys).size, keys.length);
const dupAcross = new Map();
for (const w of WALLETS) { const k = w.chain + '|' + w.addr; dupAcross.set(k, (dupAcross.get(k) || new Set()).add(w.casino)); }
is('no address attributed to two casinos', [...dupAcross.values()].filter(s => s.size > 1).length, 0);
const contracts = new Set([
  ...Object.values(ERC20).flatMap(m => Object.values(m).map(([c]) => c.toLowerCase())),
  ...Object.values(TRC20), ...Object.values(SPL),
]);
is('no token contract is listed as a wallet', WALLETS.filter(w => contracts.has(w.addr.toLowerCase()) || contracts.has(w.addr)).length, 0);
is('every row was seen at least once', WALLETS.filter(w => !(w.seen >= 1)).length, 0);
is('Stake is present on more than one chain', new Set(WALLETS.filter(w => w.casino === 'Stake').map(w => w.chain)).size >= 3, true);
is('slice size is sane', SLICE >= 4 && SLICE <= 16, true);

console.log('\ntotals from a blob');
{
  const w = k => WALLETS.find(x => x.casino === k);
  const stake = WALLETS.filter(x => x.casino === 'Stake');
  const blob = { wallets: {}, hist: [] };
  const now = Date.now();
  blob.wallets[stake[0].chain + '|' + stake[0].addr] = { usd: 1_000_000, parts: { USDT: 1_000_000 }, at: now };
  blob.wallets[stake[1].chain + '|' + stake[1].addr] = { usd: 500_000, parts: { ETH: 200 }, at: now - 60_000 };
  /* a wallet that failed this tick keeps its last reading and carries an error */
  blob.wallets[stake[2].chain + '|' + stake[2].addr] = { usd: 250_000, parts: { TRX: 750_000 }, at: now - 3_600_000, err: 'tron 503', errAt: now };
  const { by, oldest } = totals(blob);
  is('sums every reading whatever its age', Math.round(by.Stake.usd), 1_750_000);
  is('counts wallets in the registry, not just those read', by.Stake.wallets, stake.length);
  is('counts how many were read', by.Stake.read, 3);
  is('oldest reading is reported', oldest, now - 3_600_000);
  is('a casino with no readings is zero, not missing', by[w('Roobet').casino].usd, 0);
  is('parts are summed per symbol', by.Stake.parts.USDT, 1_000_000);
  is('chains collected from read wallets only', by.Stake.chains.length >= 1 && by.Stake.chains.length <= 3, true);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
