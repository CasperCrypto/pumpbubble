/* ==========================================================================
   pumpbubble.fun — buys, read off a Solana transaction

   A buy is not a label somebody's parser attached to a transaction; it is a
   wallet whose token balance went up while its SOL balance went down. That is
   the whole definition, and it is read straight from the transaction's own
   pre/post balances — which every Solana node publishes for every transaction
   and which cannot be wrong about what happened, whatever the instructions
   claimed to be doing.

   Working from balances rather than from a decoded swap means one parser covers
   the pump.fun bonding curve, PumpSwap, Raydium, Meteora, Jupiter routes and
   whatever launches next month. It also means a plain wallet-to-wallet transfer
   is *not* a buy — the receiver's SOL did not move — and an airdrop is not a buy
   either, which is the mistake a "token balance increased" heuristic makes on
   every launch day.

   Pure functions. No fetch, no env. Tested against a fixture in
   scripts/tgbot.test.mjs.
   ========================================================================== */

const LAMPORTS = 1e9;

/* A "buy" that moved less SOL than this is a transfer that happened to include
   a small balance change (rent, a wrap/unwrap round-trip). 0.0005 SOL is under
   ten cents at any price SOL has traded at. */
export const MIN_SOL = 0.0005;

const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };

/* Account keys come in two shapes depending on encoding — plain strings, or
   {pubkey, signer, writable} objects — and are followed by the addresses a
   lookup table loaded, writable first then readonly, which is the order the
   balance arrays index them in. */
export function accountList(tx) {
  const msg = (tx && tx.transaction && tx.transaction.message) || {};
  const meta = (tx && tx.meta) || {};
  const base = (msg.accountKeys || []).map(k => typeof k === 'string' ? k : (k && k.pubkey) || '');
  const la = meta.loadedAddresses || {};
  return base.concat(la.writable || [], la.readonly || []);
}

/* Who signed. jsonParsed keys carry a `signer` flag; raw keys put the signers
   first and the header says how many. With neither, the fee payer — always
   the first key, always a signer — is the only one we can be sure of. Loaded
   addresses never sign, so they are never in this set. */
export function signers(tx) {
  const msg = (tx && tx.transaction && tx.transaction.message) || {};
  const keys = msg.accountKeys || [];
  const out = new Set();
  if (keys.length && typeof keys[0] === 'object') {
    for (const k of keys) if (k && k.signer && k.pubkey) out.add(k.pubkey);
    if (out.size) return out;
  }
  const n = Math.max(1, num(msg.header && msg.header.numRequiredSignatures) || 1);
  for (let i = 0; i < Math.min(n, keys.length); i++) {
    const k = keys[i];
    out.add(typeof k === 'string' ? k : (k && k.pubkey) || '');
  }
  return out;
}

/* Per-owner token balance for one mint, before and after, in UI units. An
   owner can hold the same mint in several token accounts (an ATA and a
   leftover), so balances are summed per owner rather than read per account. */
function ownerBalances(entries, mint) {
  const out = new Map();
  for (const e of entries || []) {
    if (!e || e.mint !== mint || !e.owner) continue;
    const ui = e.uiTokenAmount || {};
    const amt = ui.uiAmount != null ? num(ui.uiAmount)
      : num(ui.amount) / Math.pow(10, num(ui.decimals));
    out.set(e.owner, (out.get(e.owner) || 0) + amt);
  }
  return out;
}

function decimalsOf(entries, mint) {
  for (const e of entries || []) {
    if (e && e.mint === mint && e.uiTokenAmount) return num(e.uiTokenAmount.decimals);
  }
  return 0;
}

/* Every buy of a tracked mint inside one transaction.

   `tracked` is a Set of mint addresses. Returns [] for a failed transaction,
   for a transaction touching none of them, and for a balance change that is not
   a purchase. Each buy:

     { mint, buyer, sol, tokens, decimals, newHolder, sig, slot, blockTime }

   `sol` is what left the buyer's wallet net of the network fee when the buyer
   also paid it — the fee is the chain's, not the token's. `newHolder` means the
   buyer held none of this mint before the transaction, read from the same
   balances rather than guessed from whether we have seen the wallet before. */
export function parseBuys(tx, tracked) {
  if (!tx || !tx.meta || tx.meta.err) return [];
  const meta = tx.meta;
  const keys = accountList(tx);
  if (!keys.length) return [];
  const feePayer = keys[0];
  const signed = signers(tx);
  const fee = num(meta.fee);
  const sig = (tx.transaction && tx.transaction.signatures && tx.transaction.signatures[0]) || '';

  /* Which tracked mints does this transaction touch at all? */
  const mints = new Set();
  for (const e of [].concat(meta.preTokenBalances || [], meta.postTokenBalances || [])) {
    if (e && tracked.has(e.mint)) mints.add(e.mint);
  }
  if (!mints.size) return [];

  const out = [];
  for (const mint of mints) {
    const pre = ownerBalances(meta.preTokenBalances, mint);
    const post = ownerBalances(meta.postTokenBalances, mint);

    /* The buyer is the signer who gained the most of the token.

       Signer, not merely "whoever gained": on a *sell* the pool's balances
       look exactly like a buyer's — tokens up, SOL down — because the pool did
       buy them, from the seller. A pool never signs a transaction and a person
       always does, so requiring a signature is what tells a buy from the other
       side of a sell. It also rules out a router's fee account receiving a
       sliver of tokens. */
    let buyer = '', gained = 0;
    for (const owner of new Set([...pre.keys(), ...post.keys()])) {
      if (!signed.has(owner)) continue;
      const d = (post.get(owner) || 0) - (pre.get(owner) || 0);
      if (d > gained) { gained = d; buyer = owner; }
    }
    if (!buyer || !(gained > 0)) continue;

    /* SOL that left the buyer's own account. A buy routed through a separate
       fee payer (some bots) still has the buyer signing and paying for the
       tokens from their own balance; only the network fee lands elsewhere. */
    const idx = keys.indexOf(buyer);
    const paidFee = buyer === feePayer;
    const preL = num((meta.preBalances || [])[idx]);
    const postL = num((meta.postBalances || [])[idx]);
    let lamports = preL - postL - (paidFee ? fee : 0);
    const sol = lamports / LAMPORTS;

    /* No SOL out means no purchase — a transfer in, an airdrop, a claim. */
    if (!(sol >= MIN_SOL)) continue;

    out.push({
      mint,
      buyer,
      sol,
      tokens: gained,
      decimals: decimalsOf(meta.postTokenBalances, mint) || decimalsOf(meta.preTokenBalances, mint),
      newHolder: !(pre.get(buyer) > 0),
      sig,
      slot: num(tx.slot),
      blockTime: num(tx.blockTime),
    });
  }
  return out;
}

/* A Helius raw webhook delivers an array of transactions; be lenient about a
   single object or a wrapper, since a payload shape that moves should degrade
   to "no buys", never to a throw inside a webhook handler. */
export function buysFromPayload(payload, tracked) {
  const list = Array.isArray(payload) ? payload
    : (payload && Array.isArray(payload.transactions)) ? payload.transactions
    : payload ? [payload] : [];
  const out = [];
  for (const tx of list) {
    try { out.push(...parseBuys(tx, tracked)); } catch { /* one bad row, not the batch */ }
  }
  return out;
}
