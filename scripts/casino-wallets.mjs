/* ==========================================================================
   Build and verify the casino hot-wallet registry (src/casinowallets.mjs).

       node scripts/casino-wallets.mjs seeds          # collect seed hashes
       node scripts/casino-wallets.mjs derive         # hashes -> addresses
       node scripts/casino-wallets.mjs verify         # balances vs reference
       node scripts/casino-wallets.mjs rows           # print rows to paste

   Three stages, each writing a JSON next to this file, so any one can be
   re-run and inspected:

   1. seeds   — public "biggest transactions" lists that attribute a hash to a
                casino. Only hash, chain, direction and the name are kept.
                Nothing the tracker computes is stored or displayed.
   2. derive  — every hash is fetched from its chain and the casino's side
                taken: recipient of a deposit, sender of a withdrawal. This is
                the step that makes the registry ours: the address comes from
                the transaction, not from anyone's label.
   3. verify  — an address with code is a contract and is rejected (the USDC
                token contract arrived once via a malformed transaction). Then
                balances are read and summed per casino and printed against a
                reference total, if one is supplied in REF below. Ours should
                come out *under* the reference (fewer wallets, fewer chains)
                and never over; over means a wrong wallet.

   Everything here is public RPC. No keys. Tron is paced to its unauthenticated
   limit, which is why derive takes a few minutes.
   ========================================================================== */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { ERC20, TRC20, SPL, NATIVE, STABLE } from '../src/casinowallets.mjs';

const here = p => new URL('./' + p, import.meta.url);
const stage = process.argv[2] || 'help';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };

/* Reference totals for the verify stage, in USD. Update by hand from a public
   tracker when re-verifying; they are a sanity bound, not a data source. */
const REF = { Stake: 176.22e6, Rainbet: 111.41e6, Shuffle: 25.56e6, Roobet: 25.46e6, 'BC.Game': 22.11e6, Duel: 17.06e6, '1win': 14.98e6, Gamdom: 7.40e6, 'Sportsbet.io': 6.09e6, Yeet: 4.80e6, Winna: 1.69e6 };

const RPC = {
  ethereum: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com', 'https://eth.drpc.org'],
  polygon: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
  bsc: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'],
  solana: ['https://api.mainnet-beta.solana.com'],
};
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function rpc(urls, method, params) {
  let last;
  for (const url of urls) for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
      const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
    } catch (e) { last = e; await sleep(800); }
  }
  throw last;
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function hex2b58(hex) {
  const bytes = Buffer.from(hex, 'hex');
  const chk = crypto.createHash('sha256').update(crypto.createHash('sha256').update(bytes).digest()).digest().subarray(0, 4);
  let n = BigInt('0x' + Buffer.concat([bytes, chk]).toString('hex')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  return s;
}
const topicAddr = t => '0x' + t.slice(26);

/* ------------------------------------------------------------------ seeds */
async function seeds() {
  const CH = { ETH: 'ethereum', TRX: 'tron', SOL: 'solana', BSC: 'bsc', POLYGON: 'polygon' };
  const qs = [];
  for (const d of [1, 7, 14, 30]) qs.push(`days=${d}&limit=50`);
  for (const d of [7, 14, 30]) for (const c of ['ETH', 'TRON', 'SOL', 'POLYGON', 'BSC']) qs.push(`days=${d}&limit=50&chain=${c}`);
  const seen = new Map();
  for (const q of qs) {
    try {
      const r = await fetch('https://www.circus.fyi/api/biggest-tx?' + q, { headers: { accept: 'application/json', 'user-agent': 'pumpbubble-registry/1.0' }, signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      for (const [dir, arr] of [['D', j.deposits || []], ['W', j.withdrawals || []]]) for (const x of arr) {
        const chain = CH[x.chain]; if (!chain) continue;
        const k = chain + ':' + x.txHash;
        if (!seen.has(k)) seen.set(k, { casino: x.casinoName, dir, chain, hash: x.txHash });
      }
    } catch (e) { console.log('skip', q, e.message); }
    await sleep(500);
  }
  const rows = [...seen.values()];
  fs.writeFileSync(here('casino-seeds.json'), JSON.stringify(rows));
  const by = {}; for (const r of rows) by[r.casino] = (by[r.casino] || 0) + 1;
  console.log(rows.length, 'seeds', JSON.stringify(by));
}

/* ----------------------------------------------------------------- derive */
async function evmSide(chain, hash) {
  const [tx, rc] = await Promise.all([rpc(RPC[chain], 'eth_getTransactionByHash', [hash]), rpc(RPC[chain], 'eth_getTransactionReceipt', [hash])]);
  if (!tx) return null;
  const logs = (rc && rc.logs || []).filter(l => l.topics && l.topics[0] === TRANSFER && l.topics.length === 3);
  if (logs.length) { logs.sort((a, b) => (BigInt(b.data) > BigInt(a.data) ? 1 : -1)); return { from: topicAddr(logs[0].topics[1]), to: topicAddr(logs[0].topics[2]) }; }
  return { from: tx.from, to: tx.to };
}
async function tronSide(hash) {
  const norm = a => /^0x[0-9a-fA-F]{40}$/.test(a) ? hex2b58('41' + a.slice(2)) : /^41[0-9a-fA-F]{40}$/.test(a) ? hex2b58(a) : a;
  const r = await fetch('https://api.trongrid.io/v1/transactions/' + hash + '/events', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  const ev = (j.data || []).filter(e => e.event_name === 'Transfer' && e.result);
  if (ev.length) { ev.sort((a, b) => (BigInt(b.result.value || 0) > BigInt(a.result.value || 0) ? 1 : -1)); return { from: norm(ev[0].result.from), to: norm(ev[0].result.to) }; }
  const ri = await fetch('https://api.trongrid.io/wallet/gettransactioninfobyid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: hash }), signal: AbortSignal.timeout(20000) });
  const info = await ri.json();
  const logs = (info && info.log || []).filter(l => l.topics && l.topics[0] === TRANSFER.slice(2) && l.topics.length === 3);
  if (logs.length) { logs.sort((a, b) => (BigInt('0x' + b.data) > BigInt('0x' + a.data) ? 1 : -1)); return { from: hex2b58('41' + logs[0].topics[1].slice(24)), to: hex2b58('41' + logs[0].topics[2].slice(24)) }; }
  const r2 = await fetch('https://api.trongrid.io/wallet/gettransactionbyid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: hash }), signal: AbortSignal.timeout(20000) });
  const t = await r2.json(); const c = t && t.raw_data && t.raw_data.contract && t.raw_data.contract[0]; const v = c && c.parameter && c.parameter.value;
  return v && v.owner_address && v.to_address ? { from: hex2b58(v.owner_address), to: hex2b58(v.to_address) } : null;
}
async function solSide(hash) {
  const tx = await rpc(RPC.solana, 'getTransaction', [hash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
  if (!tx) return null;
  const meta = tx.meta || {}; const pre = new Map(), post = new Map();
  for (const b of meta.preTokenBalances || []) pre.set(b.owner + '|' + b.mint, num(b.uiTokenAmount.uiAmount));
  for (const b of meta.postTokenBalances || []) post.set(b.owner + '|' + b.mint, num(b.uiTokenAmount.uiAmount));
  let from = '', to = '', best = 0, worst = 0;
  for (const k of new Set([...pre.keys(), ...post.keys()])) { const d = (post.get(k) || 0) - (pre.get(k) || 0); if (d > best) { best = d; to = k.split('|')[0]; } if (d < worst) { worst = d; from = k.split('|')[0]; } }
  if (to || from) return { from, to };
  const keys = tx.transaction.message.accountKeys.map(k => k.pubkey); let iF = 0, iT = 0, dF = 0, dT = 0;
  for (let i = 0; i < keys.length; i++) { const d = (meta.postBalances[i] || 0) - (meta.preBalances[i] || 0); if (d < dF) { dF = d; iF = i; } if (d > dT) { dT = d; iT = i; } }
  return { from: keys[iF], to: keys[iT] };
}
async function derive() {
  const rows = JSON.parse(fs.readFileSync(here('casino-seeds.json')));
  const reg = new Map(); let ok = 0, fail = 0;
  for (const s of rows) {
    let r = null;
    try { r = s.chain === 'tron' ? await tronSide(s.hash) : s.chain === 'solana' ? await solSide(s.hash) : await evmSide(s.chain, s.hash); } catch {}
    await sleep(s.chain === 'tron' ? 1100 : 220);
    const addr = r ? (s.dir === 'D' ? r.to : r.from) : '';
    if (!addr) { fail++; continue; }
    ok++;
    const k = s.casino + '|' + s.chain + '|' + addr;
    const e = reg.get(k) || { casino: s.casino, chain: s.chain, addr, seen: 0, src: s.hash };
    e.seen++; reg.set(k, e);
    process.stdout.write(`\r${ok + fail}/${rows.length}  ok ${ok}  failed ${fail}   `);
  }
  console.log();
  const out = [...reg.values()].sort((a, b) => a.casino.localeCompare(b.casino) || b.seen - a.seen);
  fs.writeFileSync(here('casino-registry.json'), JSON.stringify(out, null, 1));
  console.log(out.length, 'addresses ->', 'scripts/casino-registry.json');
}

/* ----------------------------------------------------------------- verify */
const balanceOfData = a => '0x70a08231' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
async function balances(w) {
  if (w.chain === 'tron') {
    const r = await fetch('https://api.trongrid.io/v1/accounts/' + w.addr, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    const a = ((await r.json()).data || [])[0] || {}; const out = { TRX: num(a.balance) / 1e6 };
    for (const row of a.trc20 || []) for (const [c, v] of Object.entries(row)) for (const [sym, cc] of Object.entries(TRC20)) if (c === cc) out[sym] = num(v) / 1e6;
    return out;
  }
  if (w.chain === 'solana') {
    const out = { SOL: num((await rpc(RPC.solana, 'getBalance', [w.addr])).value) / 1e9 };
    const ta = await rpc(RPC.solana, 'getTokenAccountsByOwner', [w.addr, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]);
    for (const v of ta.value || []) { const i = v.account.data.parsed.info; for (const [sym, mint] of Object.entries(SPL)) if (i.mint === mint) out[sym] = (out[sym] || 0) + num(i.tokenAmount.uiAmount); }
    return out;
  }
  const out = { [NATIVE[w.chain]]: Number(BigInt(await rpc(RPC[w.chain], 'eth_getBalance', [w.addr, 'latest']))) / 1e18 };
  for (const [sym, [c, dec]] of Object.entries(ERC20[w.chain] || {})) out[sym] = Number(BigInt((await rpc(RPC[w.chain], 'eth_call', [{ to: c, data: balanceOfData(w.addr) }, 'latest'])) || '0x0')) / 10 ** dec;
  return out;
}
async function verify() {
  const reg = JSON.parse(fs.readFileSync(here('casino-registry.json')));
  const px = { USDT: 1, USDC: 1, 'USDC.e': 1 };
  const m = await fetch('https://pumpbubble.fun/api/tokens?source=majors').then(r => r.json());
  for (const t of m.tokens) if (['ETH', 'SOL', 'TRX', 'BNB', 'POL', 'MATIC'].includes(t.sym) && t.price > 0 && px[t.sym] == null) px[t.sym] = t.price;
  if (!px.POL && px.MATIC) px.POL = px.MATIC;
  const per = new Map(); const keep = [];
  for (const w of reg) {
    if (w.chain !== 'tron' && w.chain !== 'solana') {
      const code = await rpc(RPC[w.chain], 'eth_getCode', [w.addr, 'latest']).catch(() => '0x');
      if (code && code !== '0x') { console.log('REJECT contract', w.casino, w.chain, w.addr); continue; }
    }
    let b = {}; try { b = await balances(w); } catch (e) { console.log('read failed', w.casino, w.chain, w.addr, e.message); }
    await sleep(w.chain === 'tron' ? 1100 : 250);
    let usd = 0; for (const [sym, amt] of Object.entries(b)) usd += amt * (STABLE.has(sym) ? 1 : num(px[sym]));
    per.set(w.casino, (per.get(w.casino) || 0) + usd); keep.push(w);
    console.log(w.casino.padEnd(13), w.chain.padEnd(9), w.addr.slice(0, 14).padEnd(15), ('×' + w.seen).padStart(4), ('$' + Math.round(usd).toLocaleString()).padStart(14));
  }
  fs.writeFileSync(here('casino-registry.json'), JSON.stringify(keep, null, 1));
  console.log('\nper casino — ours vs reference (ours should be under, never over):');
  for (const [c, usd] of [...per].sort((a, b) => b[1] - a[1])) {
    const ref = REF[c];
    console.log(' ', c.padEnd(13), ('$' + (usd / 1e6).toFixed(2) + 'M').padStart(10), ref ? `  ref $${(ref / 1e6).toFixed(2)}M  ${(usd / ref * 100).toFixed(0)}%${usd > ref * 1.15 ? '  <-- OVER, check this' : ''}` : '  (no reference)');
  }
}

function rows() {
  const reg = JSON.parse(fs.readFileSync(here('casino-registry.json')));
  for (const r of reg) console.log(`  { casino: ${JSON.stringify(r.casino)}, chain: ${JSON.stringify(r.chain)}, addr: ${JSON.stringify(r.addr)}, seen: ${r.seen}, src: ${JSON.stringify(r.src)} },`);
}

if (stage === 'seeds') await seeds();
else if (stage === 'derive') await derive();
else if (stage === 'verify') await verify();
else if (stage === 'rows') rows();
else console.log('usage: node scripts/casino-wallets.mjs seeds|derive|verify|rows');
