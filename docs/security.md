# Security — what can be attacked, and what stops it

This site shows attacker-controlled content next to a payment address. That combination is what
makes it worth attacking, so the threat model is written down rather than assumed.

Run the checks in `scripts/check.mjs` after every deploy. The two that matter most are the image
proxy refusing an unsigned URL and gold share staying under the cap.

## 1. Hostile token names — the big one

**The attack.** Anyone can mint a pump.fun token for a few cents and name it
`<img src=x onerror="...">`. That name is fetched by us and rendered on the page. It needs no
interaction at all to land: the **top mover is printed into the header**, so an attacker only has
to pump their token to the top of the movers list and every visitor executes their JavaScript.

**Why it matters more here than on a normal site.** Injected script on this page can rewrite the
treasury address in the boost modal. Buyers would copy the attacker's wallet and pay them instead.
It is a payment-theft vector, not a defacement.

**What stops it — three independent locks:**

1. **Escaped on write.** Every token-derived string that goes near `innerHTML` runs through `esc()`.
2. **Stripped at the source.** `clean()` in `src/core.mjs` removes angle brackets, control
   characters, zero-width joiners and bidi marks before the data ever leaves the server. So a
   forgotten escape in some future template is not automatically an incident.
3. **Content-Security-Policy** (`public/_headers`). `connect-src 'self'` and `img-src 'self'` mean
   injected script could not phone home or beacon out even if it did run.

**`/swap` talks to one more host: Jupiter's API.** The swap page is our own code — no widget, no
wallet library — so its policy (`SWAP_CSP` in `src/refs.mjs`, set by `worker/index.js`) is the
map's with `connect-src` extended to `lite-api.jup.ag` and `api.jup.ag` (Solana) and
`api.relay.link` (Base, Ethereum, Robinhood Chain), where quotes, token search and signed trades
go. On EVM the page refuses any transaction that is not to Relay's two pinned contracts, any
approval that is not of the token being sold for at most the trade's amount, and any quote whose
recipient is not the signing wallet (`relayOk`). Scripts and styles stay `'self'`. **Images are the one loosening: `https:`**,
because the token picker shows each token's art wherever its creator put it (arweave, IPFS
gateways, GitHub), and our signed proxy only covers tokens the map has already seen — proxying
arbitrary search results would mean signing URLs on request, which is the open relay the signature
exists to prevent. The cost is a beacon channel: an injected script could leak through an image
URL. On this page that channel was never the lock — its script policy already carries
`'unsafe-inline'` (the known weakness below) — so `esc()` on every token string stays the defence,
and `scripts/swap-page.test.mjs` runs a token named `<img src=x onerror=…>` through a picker row.
`iconSrc()` draws only `https:` (never `http:`, `javascript:` or `data:` — data URIs are for wallet
icons alone) and refuses quotes and angle brackets. The page shows no payment address of ours and holds no keys:
the visitor's own wallet signs a transaction Jupiter built, after the page has checked it is for
the mints, amount and wallet that were asked for. If the page ever grows a treasury address or a
boost box, it inherits the map's threat model in full. `scripts/check.mjs` checks both policies
after every deploy — the map's must still say `connect-src 'self';` and never mention `jup.ag`.

**Known weakness.** The CSP still needs `script-src 'unsafe-inline'`, because the whole front end
is deliberately one self-contained file. Moving the script into its own file and dropping
`unsafe-inline` is the single strongest hardening step still available, at the cost of that
convention. Worth doing if the site ever holds anything more sensitive than it does today.

## 2. Editing the page to fake a boost

**The attack.** Open devtools, set `t.boost = 10`, or edit the HTML.

**What happens.** Nothing that matters. It changes what *that one person* sees on *their* screen
until they refresh. Bubble sizes are recomputed from `/api/tokens` on every refresh, and boosts in
that response come from the server, which only writes one after a confirmed on-chain payment.
`merge()` deliberately does **not** carry a client-side boost value across a refresh.

There is no way to make a bubble gold for anyone else without paying.

## 3. Tampering with a payment

Orders are **stateless and HMAC-signed**. The client gets the order plus a signature and hands it
back when polling. Every field is covered by that signature, so all of these are rejected outright:

| Attempt | Result |
|---|---|
| Change tier from `spark` ($9) to `whale` ($149) after quoting | rejected — signature fails |
| Lower `amountSol` to 0.000001 | rejected |
| Swap `treasury` to the attacker's wallet | rejected |
| Invent an order from scratch | rejected |
| Replay a paid order to get a second boost | ignored — activation is idempotent on the transaction signature |

The server also never trusts client-supplied display data: the token symbol on an order comes from
our own pump.fun snapshot, not from the request body.

**What counts as paid** is decided only by the chain: the treasury's balance delta across a
confirmed transaction, in integer lamports, matched to the order's unique amount. Float arithmetic
is never used on money.

## 4. Denial of service and cost exhaustion

Attacks that cost you money rather than data:

- **KV write exhaustion.** The free tier allows 1000 writes/day. Storing every quote would let
  anyone burn that by opening the modal in a loop. Solved by design: quotes are stateless, so a
  write happens only on an actual sale.
- **RPC bill.** Verifying each pending order separately would mean hundreds of RPC calls a minute.
  The treasury scan is done **once for everybody** and cached for 10s, so the cost is constant no
  matter how many people are paying at once. Old history is skipped by `blockTime` without fetching
  it, and cold-start decoding is capped.
- **Request floods.** Per-IP limits on `/api/tokens`, `/api/boost/order` and `/api/boost/status`.
  These are per-isolate and in memory — deliberately not KV, since a limiter that writes to KV can
  be used to exhaust the quota it protects.

**Do this after deploying:** add a Cloudflare **Rate Limiting rule** in the dashboard. The
in-process limiter only sees one isolate; only the edge rule is global.

## 5. The image proxy

`/api/img` fetches arbitrary URLs, which is exactly what an attacker wants to abuse — to reach
internal addresses (`169.254.169.254` and friends) or to use your worker as an anonymising relay.

Every proxied URL is **HMAC-signed** when the snapshot is built and verified before fetching, so
only URLs that came from pump.fun through us are ever requested. Unsigned and edited URLs get a
403. `scripts/check.mjs` asserts this; treat a failure there as a live incident.

## 6. Being seen to be honest

Boosts are advertising. If people think the gold is fake, the map is worthless — so the ledger is
public: `/api/boost/history` lists every boost ever sold with its Solana transaction signature and
a Solscan link. Anyone can verify that gold on this map was paid for.

Two rules exist for the same reason, and both are enforced in code rather than trusted:

- Paid size is capped at **25% of on-screen bubble area** — `/api/boost/order` refuses a sale that
  would breach it.
- A boosted bubble still shows its **real** price direction. Size is the ad; the data stays honest.

## What is still open

- `script-src 'unsafe-inline'` in the CSP (see §1).
- No admin authentication anywhere, because there is no admin surface — ad slots are edited with
  `wrangler kv key put`. **If an admin endpoint is ever added, it needs real auth.**
- Boost activation depends on the buyer's tab staying open to poll. A Helius webhook, or a cron
  sweep, would remove that dependency — see `docs/payments.md`.
- The treasury is a hot wallet. Move funds out of it periodically; nothing in this system needs a
  balance to sit there.
