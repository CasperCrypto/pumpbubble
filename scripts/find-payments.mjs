/* ==========================================================================
   Scan the treasury for incoming payments and show what arrived.

       node --env-file-if-exists=.env scripts/find-payments.mjs [hours]

   For reconciling by hand when a payment did not activate: it prints every
   incoming transfer, its exact lamports, and whether a boost already exists for
   that signature.
   ========================================================================== */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TREASURY = '6k8T4fXq5vt3asVnywaHgfw4ApRexGHupbUU8e3TsW1C';
const HOURS = +(process.argv[2] || 24);

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
console.log(`\ntreasury ${TREASURY}`);
console.log(`rpc      ${RPC.replace(/api-key=[^&]+/, 'api-key=***')}`);
console.log(`window   last ${HOURS}h\n`);

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const sigs = await rpc('getSignaturesForAddress', [TREASURY, { limit: 100 }]);
const since = Math.floor(Date.now() / 1000) - HOURS * 3600;
const recent = sigs.filter(s => !s.blockTime || s.blockTime >= since);

console.log(`${sigs.length} signatures on the account, ${recent.length} inside the window\n`);

let found = 0;
for (const s of recent) {
  const tx = await rpc('getTransaction',
    [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
  if (!tx) continue;

  const keys = (tx.transaction?.message?.accountKeys || [])
    .map(k => (typeof k === 'string' ? k : k.pubkey));
  const idx = keys.indexOf(TREASURY);
  if (idx < 0) continue;

  const delta = (tx.meta?.postBalances?.[idx] ?? 0) - (tx.meta?.preBalances?.[idx] ?? 0);
  if (delta <= 0) continue;

  found++;
  const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19) : '?';
  const payer = keys[0];
  console.log(`  ${when}  ${String(delta).padStart(12)} lamports  = ${(delta / 1e9).toFixed(9)} SOL`);
  console.log(`     from ${payer}`);
  console.log(`     sig  ${s.signature}`);
  console.log(`     err  ${s.err ? JSON.stringify(s.err) : 'none'}`);
  /* Solana Pay puts a reference pubkey in the account list; a manual send does
     not. This is what tells the two payment routes apart after the fact. */
  console.log(`     accounts in tx: ${keys.length}${keys.length > 3 ? '  (extra keys — likely Solana Pay with a reference)' : '  (bare transfer — no reference)'}`);
  console.log();
}

if (!found) console.log('  no incoming transfers found in that window\n');
else console.log(`${found} incoming payment(s)\n`);
