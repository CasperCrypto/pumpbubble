# Payments — how boosts settle themselves

No processor, no KYC, no chargebacks, nobody watching a dashboard. A trader pays on-chain and the
bubble turns gold on its own. This is the whole revenue mechanism, so it is worth understanding
before changing `src/boosts.mjs`.

## Why direct SOL, and not MoonPay or Coinbase

DexScreener offers card payments because it sells to *companies* — marketing budgets, expense
claims, people who need an invoice. Boosts here sell to **traders who already hold SOL**, which is
a different customer with different plumbing:

| | Direct SOL (what we do) | MoonPay / Coinbase Commerce |
|---|---|---|
| Fee | network only, ~$0.0001 | 1–5% (card on-ramps often more) |
| Payout | instant, into your wallet | settlement delay, sometimes custody |
| KYC | none for you or the buyer | required, and they can decline a buyer |
| Chargebacks | impossible | possible on card rails |
| Integration | one HMAC + an RPC read | accounts, API keys, webhooks, compliance |
| Buyer needs | a Solana wallet with SOL | a card |

Every pump.fun trader already has a funded Solana wallet — that is the entire prerequisite for
being on pump.fun at all. A card on-ramp would add a percentage fee and a KYC wall to reach people
who mostly are not your buyers.

**Where a card rail would earn its keep:** selling the *ad rail* to real companies, which is a
manual, invoiced sale anyway. Add it when someone asks for an invoice — not before.

## The flow

1. **Quote.** Trader taps a bubble → ⚡ Boost → picks a tier. `POST /api/boost/order` prices it in
   USD, converts at the current SOL rate, and locks that rate into the order so the amount cannot
   drift between quote and payment. Quotes stop being offered after 30 minutes.
2. **Pay.** The modal shows a Solana Pay URL (`solana:<treasury>?amount=…&reference=…`). On mobile
   that opens Phantom / Solflare directly. On desktop the amount and address are click-to-copy.
3. **Detect.** The browser polls `GET /api/boost/status?t=…`. That endpoint is what looks at the
   chain — the client cannot grant itself a boost, it only displays what the backend confirmed.
4. **Activate.** On a confirmed payment the boost is written to KV with a start time and expiry.
   The next `/api/tokens` returns it and the bubble goes gold for everyone.

## Why the amount looks strange

An order for $9 quotes something like `0.105561211 SOL`. The trailing digits are deliberate.

Solana Pay works by putting a **reference pubkey** — a random address that is never a signer — into
the transaction, so the payment can be looked up. That only works if the buyer actually uses the
pay link. Plenty will not: they will copy the address out of the modal and send from their wallet,
producing a transaction with **no reference in it at all**. Left alone that payment strands — money
received, no boost, angry customer.

So every quote carries a random nonce in its final lamports, drawn from about a million values.
That makes the amount itself the identifier, and a plain wallet send matches just as well as a
Solana Pay one.

The nonce is large on purpose. An earlier version used only 900 values; across ~20 concurrent
orders the birthday collision probability is roughly 20%, and a collision means one buyer's payment
activates another buyer's bubble.

**Do not round the amount.** It looks untidy and it is load-bearing.

## What counts as paid

- The **treasury's balance delta** across a confirmed transaction, in **integer lamports**. Balance
  delta survives any instruction shape, including a transfer wrapped in a CPI. No float arithmetic
  is used on money anywhere.
- The payment must not predate the quote (two minutes of clock-skew allowance).
- Failed transactions are skipped.
- Activation is keyed on the **transaction signature**, so one payment can never buy two boosts no
  matter how often the status endpoint is polled.
- A single RPC failure never aborts a scan — public RPCs 429 constantly, and giving up on the first
  error would strand a payment that already landed.

## Cost control

The naive design verifies each pending order separately, which at a 6s poll is hundreds of RPC
calls a minute and burns a free Helius tier in days. Instead:

- the treasury is scanned **once for everybody**, cached for 10 seconds
- transactions older than 25h are skipped using `blockTime`, without fetching them
- already-decoded transactions are reused; only new ones cost a call
- cold-start decoding is capped

Measured against a real treasury on the public RPC: 7s cold, 16ms warm.

## Setting up Helius

The public endpoint (`api.mainnet-beta.solana.com`) returns 429 under real load — measured, not
assumed — and payments would silently fail to verify. Any of Helius, QuickNode or Triton works;
Helius is the easiest.

1. Sign up at **helius.dev** — the free tier is far more than this needs.
2. Create an API key. You get a URL like
   `https://mainnet.helius-rpc.com/?api-key=xxxxxxxx-xxxx-xxxx`.
3. Store it as a secret — **not** in `wrangler.toml`, since the key is in the URL:
   ```bash
   npx wrangler secret put SOLANA_RPC
   ```
4. Confirm it took effect:
   ```bash
   node scripts/check.mjs https://pumpbubble.fun     # "solana rpc configured"
   curl https://pumpbubble.fun/api/health
   ```

For local development the public RPC is fine — it is slow, not broken.

## The public ledger

`GET /api/boost/history` lists every boost ever sold: token, tier, amount paid, and the Solana
transaction signature with a Solscan link.

Publish it. Boosts are advertising, and if people suspect the gold is handed out to friends the map
loses the credibility it is selling. Being auditable is cheap; being trusted is not.

## Known limits

- **Polling, not push.** Activation waits on a 6s client poll. A Helius webhook pointed at the
  worker would make it instant and cut RPC usage to near zero.
- **A closed tab stops the polling.** The payment still lands and the order stays valid for 24h,
  but nothing activates it until someone re-opens that order. A webhook, or a cron sweep, fixes
  this properly — it is the one failure mode that will generate support messages.
- **SOL only.** USDC would need the SPL-token branch of Solana Pay and a token-account balance
  check rather than a lamport delta.
- **Refunds are manual.** By design there is no refund path, which also means an overpayment or a
  wrong-token send has to be sorted out by hand.
- **The treasury is a hot wallet.** Move funds out periodically; nothing needs a balance to sit
  there.

## Ad slots

Ads are not automated. Sold slots live in the `ads` key in KV:

```bash
npx wrangler kv key put --binding=BUBBLE_KV ads '[{"id":"acme","title":"ACME","sub":"sponsored","url":"https://example.com","img":""}]'
```

Empty slots render as "SLOT OPEN" and link to `AD_CONTACT` (currently the Telegram in
`wrangler.toml`). That is deliberate: empty inventory is the sales pitch.

## Underpayment, overpayment, and why the matching is asymmetric

Covered by `scripts/payment-abuse.test.mjs`, which stands a fake RPC in front of the real matching
code so the cases you cannot produce on demand are still tested.

**Short payments never activate anything**, however they are dressed up: one lamport short, half
the price, the $9 amount against a $149 quote, dust, or three part-payments that add up to the
price. Amounts are matched per transaction, never accumulated.

**Overpayment is accepted only when the transaction carries the order's reference key**, i.e. when
it came through Solana Pay. There the reference says which order it belongs to, so paying too much
is generous rather than ambiguous. A payment with no reference must match to the lamport, because
the amount is the only thing identifying it — a larger payment is indistinguishable from some other
order's payment.

The asymmetry is deliberate: a shortfall is never accepted, and an overpayment is accepted only
when something other than the amount proves which order it belongs to.

Also enforced: payments to a different wallet are ignored, failed transactions are ignored,
transactions that predate the quote are ignored, and one transaction signature can only ever
activate one boost.

## Affiliates

Most of the reach comes from people telling other communities to boost. That is unpaid sales work,
and it should not stay unpaid: an affiliate gets a cut of every boost bought through their link.

    https://pumpbubble.fun/?ref=alice        their link
    https://pumpbubble.fun/affiliate.html?code=alice   their statement

Default commission is **20%**, overridable per affiliate up to 50%.

### How a sale gets credited

1. The link sets `?ref=alice`. The front end stores it for 30 days. **First touch wins** — whoever
   introduced the buyer earns it, not whoever happened to be last, because the person who made the
   case in the group did the selling.
2. The code is sent with the quote and **signed into the order**, so it cannot be swapped after the
   buyer has seen the price.
3. Whether it is worth anything is decided **at confirmation**, server-side, from the affiliate list
   and the wallet that actually paid. Never from the client, never recomputed later.
4. The commission is recorded on the boost, in the same ledger anyone can audit.

An unknown or malformed code is dropped rather than rejected: a bad referral must never stop
somebody buying.

### Self-referral is voided

The payer's wallet is in the transaction we already fetch, so an affiliate paying through their own
link is detected and the commission zeroed — that is a 20% discount, not a referral. The boost still
activates; only the commission is void, and the statement shows it as such rather than hiding it.

### Payouts are manual

Accruing and settling by hand is the right shape while the list is small, and it keeps a spend key
away from the worker entirely. `owedUsd` is what to send.

```bash
node scripts/affiliate.mjs list                       # who has earned what
node scripts/affiliate.mjs stats  --code alice        # one statement
node scripts/affiliate.mjs payout --code alice --usd 24.50 --sig <tx>
```

Statements are built from the **boost ledger**, not a separate tally, so what an affiliate sees and
what anyone can audit cannot drift apart. That is the only reason to trust a commission number you
did not compute yourself.

The arithmetic and the fraud checks are pinned in `scripts/affiliate.test.mjs` — commission is money
owed to real people, and payout day is the wrong time to discover a rounding rule.
