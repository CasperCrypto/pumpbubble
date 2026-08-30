# pumpbubble.fun — project context

Read this before changing anything. It carries the decisions that aren't obvious from the code.

## What this is

A live "bubble screener" for pump.fun tokens: every token is a liquid bubble, size = market cap
(or gain / volume), colour = price change, gold = someone paid to boost it.
Stock-market equivalent: a bubble screener. Crypto equivalent: cryptobubbles.net, but for
Solana memecoins and with a paid gamified boost layer instead of static ads.

Business model, in priority order:

1. **Boosts / golden bubbles** — DexScreener-style boosts, but gamified: a boosted bubble's size
   comes from what the community paid, NOT from market cap, and the boost **decays over time**, so
   communities have to keep pumping to stay biggest. Micro-boosts ($1–5 from individual holders)
   are expected to out-earn big team packages. *Built: self-serve, on-chain, no processor.*
2. **Ad slots** — the rail above the map. Sold slots come from KV so a slot can be filled without
   a deploy. Empty slots stay visible on purpose: they are the sales pitch. *Built, sold manually.*
3. **Trade referrals** — a Buy button on each bubble routed through Jupiter or a trading-bot
   referral (Axiom / Photon / BullX / Trojan). Expected to out-earn ads at volume, zero sales
   effort. *Built — `src/refs.mjs`. Dormant until `REF_PROVIDER` and `REF_CODE` are set; the
   button does not render without a code, because one that earns nothing still spends the click.*
4. **Pro subscription** — alerts, more bubbles, saved filters, no ads. *Not built.*

## Current state

Front end is still a single self-contained `public/index.html`: no build step, no framework,
canvas 2D, hand-rolled physics and soft-body rendering.

There is now a backend, because there had to be (see Data). It is dependency-free and shared:

```
src/core.mjs     pump.fun fetch, normalise, DexScreener enrichment, history, image signing
src/boosts.mjs   tiers, Solana Pay orders, on-chain verification, decay
src/api.mjs      every HTTP route, written against web-standard Request/Response
worker/index.js  Cloudflare adapter — KV, edge image cache, cron
server/dev.mjs   Node adapter — in-memory, serves public/ too. `npm run dev`
scripts/check.mjs smoke test against any deployment. `node scripts/check.mjs <url>`
```

`src/*` runs unmodified in both runtimes: Node 22 and Workers both provide `fetch`,
`Request`/`Response` and WebCrypto. There is exactly one implementation of every route.

## Non-negotiable product rules

These exist because breaking them kills the product, not because of taste:

- **Boosted bubbles must be unmistakable.** Gold shell, pulsing rim, `★ ×N` label, legend line
  saying "boosted = paid, not mcap". If a paid bubble can be mistaken for a real large-cap, the map
  is lying and traffic dies.
- **Cap total gold at ~20–25% of on-screen bubble area.** Ad inventory is worth what the traffic is
  worth; over-selling destroys the thing being sold. This is *enforced*: `/api/boost/order` refuses
  a sale that would breach 25%, `/api/tokens` reports `goldShare`, and `scripts/check.mjs` fails
  above the cap.
  `goldShare()` **must mirror `sizes()`** — log-compress into the 0.30–1.00 band, *then* apply the
  boost. Measuring raw `sqrt(mcap)` instead makes big caps look far more dominant than they are on
  screen and refuses a single top-tier boost on exactly the tokens most likely to buy one.
  Measured against the live distribution: one ×4.0 whale ≈ 21% (sells), two ≈ 34% (refused),
  ~13–19 concurrent ×2.4 boosts fit. Decay reopens inventory continuously.
- **The % inside a gold bubble still shows real direction** (green/red text), even though its size
  is paid. Size is the ad; the data stays honest.
- **Never invent a number.** Live data is never nudged, smoothed or extrapolated — `tick()` only
  animates demo data. A screener that makes up movement is worthless the day someone checks.
- **Timeframe matters more than on a stock screener.** A 24h change is meaningless for a token that
  is 40 minutes old. Always expose 5m/1h/6h/24h, never hardcode 24h.

## Architecture decisions worth knowing

### Data — why there is a backend at all

**pump.fun's API returns 403 to any request carrying an `Origin` header**, i.e. to every browser
`fetch()`. Verified directly: identical request, 200 without `Origin`, 403 with it. There is no
client-side workaround, so all token data is read server-side. This is the single fact that shapes
the whole architecture.

- **pump.fun** `frontend-api-v3.pump.fun/coins` — the spine: mint, **ticker**, **image**,
  **market cap**, graduation state, ATH, creation and last-trade time. 6 pages × 50 = 300 tokens,
  ~2s cold. Deep pagination works; no rate limiting observed at this volume.
- **DexScreener** `/tokens/v1/solana/{mints}` (30 per call) — price change and volume *only*.
  pump.fun exposes no change field and colour is the whole point of the map. Coverage of graduated
  pump.fun mints measured at ~98%.
- **Own history** — market-cap snapshots, tiered retention (everything under 10min, thinning with
  age: ~120 samples covers 24h instead of 8640). Fills change for anything DexScreener misses.
  Persisted to KV every 5 minutes; it is an optimisation, losing it only dulls the colours.

Snapshots are cached 10s per isolate with in-flight de-duplication, so a traffic burst cannot
become a burst of pump.fun calls. Stale data is served for up to 2 minutes rather than failing —
the front end shows the age.

**A build is also capped at 6 seconds.** Each upstream call has its own 9s timeout, but a pump.fun
snapshot makes six paged requests plus ten DexScreener ones in sequence, so one slow upstream can
stall the build for a minute — and because callers share the in-flight promise, every visitor waits
that long. Measured in production: one request hung 60s while the next returned in 1.2s, and the
page sat on "loading pump.fun…" forever. Past the deadline whatever is cached is served however old
it is, and the build finishes in the background.

### Images
Two thirds of pump.fun token art is IPFS-hosted. Hotlinking it tanks framerate, so everything goes
through `/api/img`, cached at the edge (immutable, 1 week) — one fetch per image per colo.

The proxy is **HMAC-signed**: `buildSnapshot` signs each URL, `/api/img` verifies it. Without that
it is an open relay for anyone on the internet. `scripts/check.mjs` asserts an unsigned URL is
refused; treat a failure there as a live incident.

Note: `cf-ipfs.com` and `cloudflare-ipfs.com` are **dead** — Cloudflare shut its public gateway
down, and pump.fun still serves those URLs for a slice of older tokens. Those are rewritten to
`ipfs.io`, which measured ~0.3s. Nothing else is rewritten; second-guessing a token's own gateway
only adds ways to fail.

### Payments
Solana Pay, no processor and no KYC. Full detail and failure modes in `docs/payments.md`; read it
before touching `src/boosts.mjs`. Three things that look like mistakes and are not:

- **The amount carries a random nonce in its final lamports.** Solana Pay puts a reference key in
  the transaction, but a trader who copies the address out of the modal sends a transaction with no
  reference in it — the unique amount is what matches that payment. Do not tidy it by rounding.
  The nonce space is ~1e6, not a few hundred: at 900 values the birthday collision across ~20
  concurrent orders is about 20%, and a collision pays the wrong person's bubble.
- **Orders are stateless and HMAC-signed, never stored.** Storing quotes would let anyone burn the
  1000 KV writes/day free tier by opening the modal in a loop. A write now happens once per sale.
- **The treasury scan is shared and cached, not per-order.** Verifying each pending order
  separately is hundreds of RPC calls a minute and burns a free Helius tier in days.

Money is compared in **integer lamports**, never floats.

### Security
`docs/security.md` carries the threat model. The one thing to internalise: this page renders
**attacker-controlled strings next to a payment address**. Anyone can mint a token called
`<img src=x onerror=…>`, and the top mover is printed into the header with no interaction at all —
so an unescaped write is payment theft, not defacement. Three locks: `esc()` on write, `clean()` on
the server, CSP in `public/_headers`. Keep all three.

Editing the page to fake a boost is expected and harmless: bubble sizes come from `/api/tokens` on
every refresh, and `merge()` deliberately does not carry a client-side boost across a refresh.

### Sizing (`sizes()`)
Market caps span 4+ orders of magnitude. A pure `sqrt(value)` radius scale makes everything except
the top 3 an invisible dot. So: **log-compress the domain into a 0.30 → 1.00 radius band**, then
scale the whole set so total bubble *area* hits a target fill of the canvas.
`fill` is tuned per bubble-count; it is deliberately high (~0.8) because the liquid look depends on
bubbles actually touching. Measured 78–80% at both test viewports.

**Boost is applied to the radius AFTER log compression** (`* (1 + boost*0.6)`), not to the metric
before it — otherwise log compression would swallow the boost and a ×2.4 would be invisible.

**Boosted tokens are excluded from the log domain, and floored at the 40th percentile.** Both
follow from the same rule — paid size comes from what was paid, not from market cap — and both were
learned the hard way:

- *Excluded from the domain:* a paid bubble's market cap must not define the scale for everyone
  else. One $9 boost on a $3,215 token stretched the domain down from $7.7M and squeezed a real 22×
  spread of market caps into a **1.21×** spread of radii. Fartcoin at $168M looked the same size as
  a $7.7M token. With boosted tokens out of the domain it is 3.33× radius / 11× area again.
- *Floored at the 40th percentile:* multiplying a bottom-of-scale radius delivers nothing — ×1.3 of
  invisible is still invisible, and the buyer sees no bubble. The floor is not higher because radii
  span only ~1.4× after compression, so a higher one puts a $9 Spark at the top of the map and
  leaves a $149 Whale nothing to buy.

`shape()` clamps its normalised input to 0..1 for this reason: a boosted cap can now fall outside
the domain, and a negative base to a fractional power is NaN, which would silently unsize the map.

### Liquid bubbles (`blob()`)
Not circles. Each bubble is a 64-vertex outline:
1. per-vertex radius = jelly wobble (two sine harmonics) minus neighbour squash
2. squash uses a **smoothstep** angular falloff, capped at 40% of R so a bubble never collapses
3. two passes of circular blur over the radius array — this is what melts facets into curves
4. drawn with **quadratic midpoint curves**, not `lineTo` — gives continuous tangents, no corners

Physics allows slight overlap (`md = touch - min(r)*0.20`) so surfaces visibly merge.
Neighbour lists are built once per frame in the last collision pass and capped at 7.

If you make deformation stronger, re-check step 3 — without enough smoothing it goes polygonal fast.

### Canvas sizing
`#stage` is a flex child, so its box is still 0 when the script first runs — sizing off it at boot
leaves a 0×0 canvas and an empty map. Three paths keep it correct: the `resize` event, a
`ResizeObserver`, and a check every 30 frames in `loop()`. The last one is not redundant:
ResizeObserver callbacks are only delivered with a rendering frame.

## Conventions

- No dependencies, front end or back. If a library is genuinely needed, argue for it first.
- Mobile-first. Every layout rule starts mobile and widens at `min-width: 820px`.
- Rendering is canvas at 60fps; anything added to the per-frame loop needs to justify its cost.
  100 bubbles × 64 verts × ≤7 neighbours is the current budget. `step()` measures ~0.4ms;
  `draw()` is the expensive half and is the first place to look if frames drop.
- Test both viewports before calling something done: 1440×900 and 390×844.
- `node scripts/check.mjs <url>` before and after a deploy.

## Roadmap (suggested order)

1. Buy button with referral routing — revenue, no sales effort, doesn't touch map integrity
2. Daily boost leaderboard + "boost war" view — the shareable screenshot, i.e. free marketing
3. PumpPortal WebSocket for per-trade bubble flashes — nobody does this well, and the ingest
   already lives server-side where the socket belongs
4. Helius webhook instead of polling `/api/boost/status`, so boosts activate without a poll
5. Pre-graduation "bonding" mode via Bitquery (bonding-curve market cap), as a separate toggle

## Data quality — why bubbles get hidden

A market cap is price × supply, and price is whatever the last trade said. With a thin pool that
number is paper. Measured on a live snapshot: **fourteen separate mints shared the ticker UOTF**,
the largest showing $250M of market cap against $1.2M of liquidity, eight hours old, with a
706,399% "24h change". Ranked by market cap they owned the top of the map, which is what a first
visitor saw.

`scoreQuality()` in `src/core.mjs` scores every token on whether its cap is backed by anything:

- **mcap / liquidity** — calibrated, not guessed. Median token ~14×, established names reach 99×
  while trading millions a day, copycats 100–385×. Bar sits at 120×.
- **24h volume** — but see below.
- **copies** — how many mints in the snapshot share this ticker. This carries most of the weight.

`solid` means all three pass. The front end's "Real only" chip filters on it, defaults **on**,
**says how many it hid**, and turns off in one click.

**Never delete a token over this.** A screener that silently drops real trades is lying in the
other direction. Filter the view, disclose the count, keep the numbers visible, and never print the
word "scam" — intent is unknowable, backing is measurable. Boosted bubbles are never filtered: they
were paid for.

**Volume is absent, not zero, for bonding-curve tokens.** DexScreener only indexes graduated mints,
so a briskly trading curve reports $0. `last_trade_timestamp` from pump.fun stands in. If you ever
tighten the volume rule, re-check bonding mode first — an earlier version hid 285 of 300.

## Sources

`pumpfun` (default), `majors`, `stocks`. Each is an adapter in `src/sources.mjs` declaring its own
cache TTL and whether it is boostable.

- **majors** is CoinPaprika, not CoinGecko. CoinGecko's free tier rate-limits by IP and
  Cloudflare's egress is shared platform-wide, so it returned 429 from the Worker while working
  from a laptop; the documented fix is a demo key we do not have. CoinPaprika needs none and
  returns 2,000 coins in one request.
- **stocks** is Nasdaq's own screener: every listed company in one keyless request, with sector and
  industry on each row. One company can list several share classes and *each reports the whole
  company's market cap*, so listings are grouped by company and only the largest is kept —
  Alphabet otherwise appears four times and the map shows $9.6T of a $4.2T company.

**Timeframes are 1H / 24H / 1W / 1M / 1Y, and which ones carry data varies by source.** A window
with no data is **null, not zero**, and renders grey — zero is a claim the asset did not move,
which is a statement about the asset rather than about our data.

| source | 1H | 24H | 1W | 1M | 1Y |
|---|---|---|---|---|---|
| pumpfun | yes | yes | — | — | — |
| majors | yes | yes | yes | yes | yes |
| stocks | — | yes | — | yes | yes |

CoinPaprika returns zero for 30d and 1y on the free tier, so those two windows come from elsewhere
for both asset classes, by two different shapes of the same idea.

Stocks use `src/stockwin.mjs` — Yahoo's chart endpoint, keyless and accurate, but one symbol per
request, so it fills in ~30 symbols per cron tick and caches in KV for a day. Majors use
`src/cryptowin.mjs` — DefiLlama, which takes ~60 coins per request, so the whole map rebuilds in
twelve requests once a day and needs no warm-up at all. Neither ever blocks the map; an unenriched
symbol reports null.

**A green API check is not a working feature.** The client mapper copied only `m5/h1/h6/h24` out
of `pc`, so `d7`, `d30` and `y1` were dropped before they ever reached a bubble. Every long window
read `+0.00%` on every asset while `/api/tokens` returned correct numbers for all of them — and the
windows were signed off on the strength of that API response. Long windows are now carried as null
and never coerced to zero, because `||0` turns "we don't know" into "it didn't move".

Related: `scripts/page-refs.test.mjs` exists because removing the caption strip left a write to a
deleted `#cnt`, which threw inside `rebuild()` and hung every tab on "loading…" forever, while all
three feeds still answered 200 with full token counts in under three seconds. Server-side health
says nothing about whether the page draws.

**Test an upstream from the Worker, never from a laptop.** Binance answers a laptop and 403s
Cloudflare's egress; so do its `.vision`, `api1` and `.us` hosts. CryptoCompare wants a key, OKX
429s the shared egress. Kraken, Bybit and DefiLlama answer. This has now bitten twice — CoinGecko
was the first — and a candidate that has not been probed from a deployed Worker has not been tested.

DefiLlama is keyed by CoinGecko id, which the feed does not carry, so `src/cgmap.mjs` is a committed
ticker→id map built by `scripts/cgmap.mjs` (CoinGecko's list endpoint rate-limits Cloudflare, hence
offline). **Every entry is verified against a live price before it is written.** That check rejected
eleven ticker collisions on the first run: `TON` matched a tokenized AT&T stock quoting 1854% off,
and a second coin named Jupiter shadowed the real `JUP`. Ticker matching alone silently returns a
real price for the wrong asset, which on a map of coloured circles is undetectable. Regenerate with
`node scripts/cgmap.mjs --write` when the top 250 turns over.

Two traps in that file, both of which produced numbers that looked plausible. Yahoo returns **two
bars for the month in progress**, both equal to the current price, so picking "the previous monthly
close" by index compared today against today and reported every stock flat — anchors are dates, not
indices. And `fiftyDayAverageChangePercent` is price against a moving average, *not* a one-month
return; using it would have been a fabricated number wearing the right label.

**Bonding was removed.** Its screening problem was real and fixable — `real_sol_reserves` is the
honest denominator, and it correctly rejects a token claiming $141M against an empty curve — but
what survived filtering was still mostly $5–12k tokens. Deep links to `?source=bonding` still
resolve so nothing already shared breaks.

## Modes

`?mode=graduated` (default) and `?mode=bonding`, cached separately, never mixed — a 24h axis means
nothing to a token forty minutes old.

**Bonding is sorted by `last_trade_timestamp`, not market cap.** Ranking live curves by size
surfaces abandoned ones: by mcap the median age was 104 days with almost nothing trading; by last
trade it is ~12 minutes with everything on screen traded inside the last minute. pump.fun's
`complete=false` parameter is what splits the two feeds.
