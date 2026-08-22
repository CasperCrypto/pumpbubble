/* ==========================================================================
   pumpbubble.fun — the bid board

   Boosts are rented: you pay a fixed price, your bubble is gold for a while,
   the effect decays. Bids are the opposite and that is the point: a bid is
   permanent until somebody pays more. Rank is the bid, nothing else.

   Why both exist
   --------------
   They sell to different people. A $9 boost is an impulse buy for a small
   community. The board is a status game between the communities who care about
   being #1 — and because the price only ratchets upward, the ceiling is set by
   how much they want it rather than by our price list.

   Mechanically, a bid is the same payment as a boost — unique lamport amount,
   verified on chain, swept if the tab closes — so the whole of boosts.mjs is
   reused. Only the ledger differs: no decay, and rank is derived by sorting.

   Design notes that are load-bearing
   ----------------------------------
   - **Bids accumulate per token.** Paying again tops up rather than replacing,
     so defending a rank costs only the difference. That is what makes a bidding
     war affordable enough to actually happen.
   - **Nothing is refunded, ever, and the copy says so before payment.** Being
     outbid is the product working, not a failure.
   - **Rank is derived, never stored.** A stored rank is a second source of
     truth that will eventually disagree with the amounts, and the amounts are
     the thing people can verify on chain.
   ========================================================================== */

const KEY = 'bids';

/* Low enough that a small community can get on the board at all — the board is
   worthless if only whales are on it, because nobody else checks it. */
export const FLOOR_SOL = 0.05;

/* What it costs to take a rank: the bid below it plus this. Small, because the
   ratchet should be driven by people wanting the rank, not by our step size. */
export const INCREMENT_SOL = 0.05;

export const BOARD_SIZE = 20;

const round = n => Math.round((Number(n) || 0) * 1e6) / 1e6;

export async function listBids(store) {
  return (await store.get(KEY)) || {};
}

/* The board: every bid, sorted, with rank derived from the amounts. */
export async function board(store, limit = BOARD_SIZE) {
  const all = await listBids(store);
  return Object.values(all)
    .filter(b => b.sol > 0)
    .sort((a, b) => b.sol - a.sol || a.since - b.since)   /* ties: whoever got there first */
    .slice(0, limit)
    .map((b, i) => ({ ...b, rank: i + 1 }));
}

/* What somebody must pay to take a given rank right now.

   Paying less is still allowed and still lands you on the board — wherever the
   amount sorts. Refusing a small bid would just turn away money and thin out
   the board, and a thin board is one nobody returns to. */
export async function priceFor(store, rank = 1) {
  const rows = await board(store, BOARD_SIZE);
  const target = rows[rank - 1];
  const toTake = target ? round(target.sol + INCREMENT_SOL) : FLOOR_SOL;
  return {
    rank,
    currentSol: target ? target.sol : 0,
    currentHolder: target ? { sym: target.sym, mint: target.mint } : null,
    takeSol: Math.max(toTake, FLOOR_SOL),
    floorSol: FLOOR_SOL,
  };
}

/* What this token already has on the board, and what the next rank up costs. */
export async function standing(store, mint) {
  const rows = await board(store, 1000);
  const mine = rows.find(r => r.mint === mint) || null;
  const above = mine && mine.rank > 1 ? rows[mine.rank - 2] : null;
  return {
    current: mine,
    /* topping up only needs to beat the one directly above */
    toBeatAboveSol: above ? round(above.sol - (mine ? mine.sol : 0) + INCREMENT_SOL) : 0,
    nextRank: above ? above.rank : (mine ? mine.rank : null),
  };
}

/* Quote a bid. Same order shape as a boost, so it signs, polls, verifies and
   sweeps through the identical machinery — `kind` is the only thing that tells
   them apart at activation. The amount is chosen by the bidder rather than
   taken from a price list, which is the whole difference between renting a
   boost and buying a rank. */
export function bidOrderFields(solAmount, taken = []) {
  const wanted = round(solAmount);
  if (!(wanted >= FLOOR_SOL)) throw new Error(`the smallest bid is ${FLOOR_SOL} SOL`);
  if (wanted > 10000) throw new Error('that bid is implausibly large — contact us instead');

  /* Same trick as a boost, and the same six-decimal limit for the same reason:
     Phantom strips the Solana Pay reference, so the amount is the only
     identifier — and anyone paying by hand has to type it. A nine-decimal
     figure gets truncated, which is how a real payment went unmatched once
     already. Round to 0.001 SOL and put the nonce in whole microSOL. */
  const baseLamports = Math.floor(wanted * 1e3) * 1e6;
  const used = new Set(taken);
  let lamports = 0;
  for (let i = 0; i < 200 && !lamports; i++) {
    const nonce = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 999);
    const candidate = baseLamports + nonce * 1000;
    if (!used.has(candidate)) lamports = candidate;
  }
  if (!lamports) throw new Error('too many bids being paid for right now — try again in a minute');
  return { lamports, amountSol: lamports / 1e9, usd: 0 };
}

/* Credit a confirmed payment to a token's bid. Idempotent on the transaction
   signature, exactly like a boost: one payment can never count twice however
   many times the sweep or a poll re-runs. */
export async function applyBid(store, { mint, sym, name, img, mcap, sol, sig, payer }) {
  if (!mint) throw new Error('missing mint');
  const amount = round(sol);
  if (!(amount > 0)) throw new Error('bid must be positive');

  const all = await listBids(store);
  const now = Date.now();
  const cur = all[mint];

  /* the same signature must never be counted twice */
  if (cur && Array.isArray(cur.sigs) && cur.sigs.includes(sig)) return cur;

  all[mint] = {
    mint,
    sym: sym || cur?.sym || mint.slice(0, 4),
    name: name || cur?.name || '',
    img: img || cur?.img || '',
    mcap: mcap || cur?.mcap || 0,
    sol: round((cur?.sol || 0) + amount),
    since: cur?.since || now,          /* when it first joined, for tie-breaks */
    updated: now,
    payers: [...new Set([...(cur?.payers || []), payer].filter(Boolean))].slice(-20),
    sigs: [...(cur?.sigs || []), sig].filter(Boolean).slice(-50),
    clicks: cur?.clicks || 0,
  };
  await store.put(KEY, all);
  return all[mint];
}

/* Click-through counts, which are what convince the next bidder the rank is
   worth anything. Counted server-side so the number is ours, not the page's. */
export async function countClick(store, mint) {
  const all = await listBids(store);
  if (!all[mint]) return null;
  all[mint].clicks = (all[mint].clicks || 0) + 1;
  await store.put(KEY, all);
  return all[mint].clicks;
}

/* Bids feed the map as boost-equivalents so a #1 bid draws as the biggest gold
   bubble without the renderer needing to know bids exist. Converting through
   spend keeps one definition of "paid size" rather than two that drift. */
export function bidsAsBoostSpend(rows, solPriceUsd) {
  const out = new Map();
  for (const b of rows) {
    out.set(b.mint, {
      mint: b.mint,
      sym: b.sym,
      name: b.name,
      img: b.img,
      mcap: b.mcap,
      liveUsd: (Number(b.sol) || 0) * (Number(solPriceUsd) || 0),
      spentUsd: (Number(b.sol) || 0) * (Number(solPriceUsd) || 0),
      count: 1,
      until: Number.MAX_SAFE_INTEGER,   /* a bid does not expire; it gets outbid */
      rank: b.rank,
      bid: true,
    });
  }
  return out;
}
