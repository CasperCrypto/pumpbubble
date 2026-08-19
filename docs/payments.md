# Payments — how boosts settle themselves

No processor, no KYC, no chargebacks, nobody watching a dashboard. A trader pays on-chain and the
bubble turns gold on its own. This is the whole revenue mechanism, so it is worth understanding
before changing `src/boosts.mjs`.

## The flow

1. **Quote.** Trader taps a bubble → ⚡ Boost → picks a tier. `POST /api/boost/order` creates the
   order server-side. Price is set in USD, settled in SOL, and the SOL rate is **locked into the
   order** so the amount cannot drift between quote and payment. Quotes expire after 30 minutes.
2. **Pay.** The modal shows a Solana Pay URL (`solana:<treasury>?amount=…&reference=…`). On mobile
   that opens Phantom / Solflare directly. On desktop the trader copies the address and amount.
3. **Detect.** The browser polls `GET /api/boost/status?id=…`. That endpoint is what actually looks
   at the chain — the client cannot grant itself a boost, it only displays what the backend
   confirmed.
4. **Activate.** On a confirmed payment the boost is written to KV with a start time and an expiry.
   The next `/api/tokens` returns it, and the bubble goes gold for everyone.

## Why the amount has a weird nonce

An order for $49 quotes something like `0.575693 SOL`, not `0.5756`.

Solana Pay works by putting a **reference pubkey** — a random address that is never a signer — into
the transaction's account list, so we can look the payment up with `getSignaturesForAddress`. That
only works if the payment goes through the Solana Pay link.

Plenty of traders will not do that. They will copy the treasury address out of the modal and send
from their wallet, producing a transaction with **no reference in it at all**. Left alone, that
payment strands: money received, no boost, angry customer.

So the last three decimals of every quote are a random nonce (worth about $0.0001). It makes each
open order's amount unique, which lets the backend match a plain wallet transfer to the right order
by amount alone. Both routes are checked, reference first.

**Do not round the amount.** It looks untidy and it is load-bearing.

## What counts as paid

- Verification uses the **treasury's balance delta** across the transaction, not instruction
  parsing. That survives any instruction shape, including a transfer wrapped in a CPI.
- Reference route allows 1.5% under (some wallets round down). Amount route requires a near-exact
  match, with a tolerance far below the nonce step so two orders can never collide.
- Failed transactions are skipped.
- Activation is keyed on the **transaction signature**, so the same payment can never buy two
  boosts, no matter how often the status endpoint is polled.
- A single RPC failure never aborts a scan — public RPCs 429 constantly, and giving up on the first
  error would strand a payment that already landed.

## What you must configure

| Setting | Why | How |
|---|---|---|
| `TREASURY_WALLET` | Where the money lands. Until it is set, checkout returns 503 and the modal says boosts aren't live. | `npx wrangler secret put TREASURY_WALLET` |
| `SOLANA_RPC` | Payment verification. **The public endpoint is not usable** — `api.mainnet-beta.solana.com` returns 429 under any real load, measured. | Helius / QuickNode / Triton free tier, then `npx wrangler secret put SOLANA_RPC` |

Use a **dedicated wallet** as the treasury, not a personal one. Its full transaction history gets
scanned on every pending-order check, so a busy wallet makes verification slower and noisier.

## Known limits

- **Polling, not push.** Activation waits on a 6s client poll. A Helius webhook pointed at the
  worker would make it instant and cut RPC usage to near zero. This is the natural next step.
- **A closed tab stops the polling.** The payment still lands, but nothing activates it until
  someone re-opens that order. A webhook, or a cron sweep over pending orders, fixes this properly.
- **SOL only.** USDC would need the SPL-token branch of Solana Pay and a token-account balance
  check rather than a lamport delta.
- **Refunds are manual.** There is no refund path, by design — but that means an overpayment or a
  wrong-token send has to be sorted out by hand.

## Ad slots

Ads are not automated. Sold slots live in the `ads` key in KV:

```json
[{ "id": "acme", "title": "ACME", "sub": "sponsored", "url": "https://…", "img": "https://…" }]
```

```bash
npx wrangler kv key put --binding=BUBBLE_KV ads '[{"id":"acme","title":"ACME","sub":"sponsored","url":"https://example.com","img":""}]'
```

Empty slots render as "SLOT OPEN" and link to `AD_CONTACT`. That is deliberate: the empty inventory
is the sales pitch.
