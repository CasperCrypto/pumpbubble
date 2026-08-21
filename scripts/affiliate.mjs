/* ==========================================================================
   Manage affiliates.

     node scripts/affiliate.mjs add --code alice --wallet <sol> [--pct 20] [--name "Alice"]
     node scripts/affiliate.mjs list
     node scripts/affiliate.mjs stats --code alice
     node scripts/affiliate.mjs payout --code alice --usd 24.50 --sig <tx>

   Runs against a deployment over its own API for reads, and prints the exact
   `wrangler kv` command for writes — because writing straight to production KV
   from a script is how you lose a payouts ledger to a typo.
   ========================================================================== */

import { isCode, DEFAULT_PCT } from '../src/affiliates.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const arg = (n, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = (arg('base', 'https://pumpbubble.fun')).replace(/\/+$/, '');

const isWallet = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '');
const money = n => '$' + (Number(n) || 0).toFixed(2);

function kvPut(key, value) {
  const json = JSON.stringify(value).replace(/'/g, `'\\''`);
  return `npx wrangler kv key put --binding=BUBBLE_KV ${key} '${json}' --remote`;
}

async function readKV(key) {
  console.log(`\n  Read the current value first:\n\n    npx wrangler kv key get --binding=BUBBLE_KV ${key} --remote\n`);
}

switch (cmd) {
  case 'add': {
    const code = arg('code').toLowerCase(), wallet = arg('wallet');
    const pct = Number(arg('pct', String(DEFAULT_PCT)));
    const name = arg('name', '');
    if (!isCode(code)) { console.error('  --code must be 3-24 chars of a-z, 0-9, _ or -'); process.exit(1); }
    if (!isWallet(wallet)) { console.error('  --wallet must be a Solana address'); process.exit(1); }
    if (!(pct > 0 && pct <= 50)) { console.error('  --pct must be between 0 and 50'); process.exit(1); }

    const record = { code, wallet, name, pct, active: true, createdAt: Date.now() };
    console.log(`
  Affiliate:  ${code}
  Wallet:     ${wallet}
  Commission: ${pct}% of every boost bought through their link

  Their link:

    ${BASE}/?ref=${code}

  Their dashboard:

    ${BASE}/affiliate.html?code=${code}
`);
    await readKV('affiliates');
    console.log(`  Then merge this entry into it and write it back:\n
    ${kvPut('affiliates', { [code]: record })}
\n  (that command writes ONLY this affiliate — merge by hand into the object you
  read above, or the others are lost)\n`);
    break;
  }

  case 'list': {
    const r = await fetch(`${BASE}/api/boost/history`);
    const h = await r.json();
    const byCode = {};
    for (const b of (h.boosts || [])) {
      if (!b.ref || !b.ref.code) continue;
      const c = byCode[b.ref.code] ||= { referrals: 0, earned: 0 };
      c.referrals++; c.earned += b.ref.usd || 0;
    }
    const rows = Object.entries(byCode);
    if (!rows.length) { console.log('\n  no referred sales yet\n'); break; }
    console.log('\n  code'.padEnd(20) + 'referrals'.padStart(10) + 'earned'.padStart(12) + '\n');
    for (const [code, v] of rows.sort((a, b) => b[1].earned - a[1].earned)) {
      console.log('  ' + code.padEnd(18) + String(v.referrals).padStart(10) + money(v.earned).padStart(12));
    }
    console.log();
    break;
  }

  case 'stats': {
    const code = arg('code').toLowerCase();
    const r = await fetch(`${BASE}/api/affiliate?code=${encodeURIComponent(code)}`);
    const s = await r.json();
    if (!s.ok) { console.error('  ' + (s.error || 'not found')); process.exit(1); }
    console.log(`
  ${s.name || s.code}  (${s.code})
  wallet     ${s.wallet}
  rate       ${s.pct}%
  referrals  ${s.referrals}
  earned     ${money(s.earnedUsd)}
  paid       ${money(s.paidUsd)}
  OWED       ${money(s.owedUsd)}
`);
    for (const b of s.boosts.slice(0, 15)) {
      console.log(`   ${new Date(b.at).toISOString().slice(0, 16).replace('T', ' ')}  ` +
        `${(b.sym || '').padEnd(12)} ${b.tier.padEnd(6)} ${money(b.usd).padStart(8)} ` +
        `→ ${money(b.commissionUsd).padStart(7)}${b.voided ? '  VOID: ' + b.voided : ''}`);
    }
    console.log();
    break;
  }

  case 'payout': {
    const code = arg('code').toLowerCase();
    const usd = Number(arg('usd'));
    if (!isCode(code) || !(usd > 0)) { console.error('  need --code and --usd'); process.exit(1); }
    const entry = { code, usd, sig: arg('sig', ''), note: arg('note', ''), at: Date.now() };
    console.log(`
  Record a payout of ${money(usd)} to ${code}.

  Send the SOL first, then append this entry to the payouts ledger:
`);
    await readKV('payouts');
    console.log(`  ${kvPut('payouts', [entry])}\n
  (append to the array you read above — do not overwrite it)\n`);
    break;
  }

  default:
    console.log(`
  node scripts/affiliate.mjs add    --code alice --wallet <sol> [--pct 20] [--name "Alice"]
  node scripts/affiliate.mjs list
  node scripts/affiliate.mjs stats  --code alice
  node scripts/affiliate.mjs payout --code alice --usd 24.50 --sig <tx>

  --base <url>   target a different deployment (default https://pumpbubble.fun)
`);
}
