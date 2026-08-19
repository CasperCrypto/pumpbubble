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
   effort. *Not built yet — highest-value next thing.*
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
Solana Pay, unique reference pubkey per order, no processor and no KYC. Full detail and the
failure modes are in `docs/payments.md` — read it before touching `src/boosts.mjs`.

The one thing to keep in mind: **the amount's last three decimals are a per-order nonce**. Solana
Pay puts the reference key in the transaction, but a trader who copies the address out of the modal
sends a transaction with no reference in it. The unique amount is what lets that payment be matched
anyway. Do not "tidy" the amount by rounding it.

### Sizing (`sizes()`)
Market caps span 4+ orders of magnitude. A pure `sqrt(value)` radius scale makes everything except
the top 3 an invisible dot. So: **log-compress the domain into a 0.30 → 1.00 radius band**, then
scale the whole set so total bubble *area* hits a target fill of the canvas.
`fill` is tuned per bubble-count; it is deliberately high (~0.8) because the liquid look depends on
bubbles actually touching. Measured 78–80% at both test viewports.

**Boost is applied to the radius AFTER log compression** (`* (1 + boost*0.6)`), not to the metric
before it — otherwise log compression would swallow the boost and a ×2.4 would be invisible.

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
