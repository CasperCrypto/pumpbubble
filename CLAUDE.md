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
3. **Trade referrals and our own swap** — a Buy button on each Solana bubble, the bot's Buy and
   ⚡ Copy buy. A trading-bot referral (Axiom / Photon / BullX / Trojan) wins when `REF_PROVIDER`
   and `REF_CODE` are set; otherwise Buy opens **our `/swap` page** (Jupiter's widget, our fee on
   every quote once `JUP_REFERRAL` is set). Expected to out-earn ads at volume, zero sales effort.
   *Built — `src/refs.mjs`, `public/swap.html`; see "The swap page".*
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
  **One coin by mint is `/coins-v2/<mint>`** (`pumpCoin()`, v3 as the spare). pump.fun retired
  `GET /coins/<mint>` — 404 "Cannot GET" — and it was found on 2026-09-30 only because the swap
  page could not name UDR, a token on the map: every single-token lookup (the boost box, a boost
  for a token off the map, the bot's `/setup` and alert market cap, Tap wars adds) had been
  answering "no token found" for anything not already in a warm feed, which is why nothing looked
  broken from the map. `scripts/check.mjs` now resolves wrapped SOL, which is on no tab, so the
  cold path is exercised after every deploy.
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

## Pushing deploys

**Every push to `main` deploys**, through Cloudflare's Git integration (Workers Builds); the GitHub
Action in `.github/workflows/deploy.yml` has its push trigger switched off. So a local
`npx wrangler deploy` of uncommitted work is overwritten a minute or two later by the build of
whatever was last pushed — which is exactly how the Smart money table went live at 19:26 and
vanished at 19:28, replaced by the previous commit's page. Commit and push first; deploy manually
after that only to skip the wait, since both then ship the same code. A second deploy landing a
minute after the first also restarts every isolate again, which is the likeliest cause of the
smoke test's post-deploy 502s.

## The request budget

**On the free plan every Worker invocation counts against 100,000 a day, per account**: every API
call, every `/api/img`, every Telegram and Helius webhook delivery, every cron tick. Static files
(the page, CSS, `public/*`) are free and unlimited — which is why the map's shell still loaded while
every route answered Cloudflare **error 1027** on 2026-09-30, and "Smart money could not refresh"
was the first symptom anyone saw. The count resets at 00:00 UTC.

**Measured from the account's analytics** (GraphQL `workersInvocationsAdaptive` and the zone's
`httpRequestsAdaptiveGroups`): ~7,700 requests a day before the bot; 187,000 on its launch day;
56,000–80,000 a day after, with pump.fun's top hundred traders on the Helius webhook; 356,000 on
2026-09-30, a frenzy day, when **`/tg/trade` took 371,067 requests in six hours** against 763 for
`/api/img` and 257 for `/api/tokens`. Durable Objects have their own allowance and were far inside
it (AudienceDO ~8,000–20,000 a day, the rest in the hundreds). The same flood also spent the free
KV reads, so the KV API answered 429 for the rest of the day.

What spends it, in the order to suspect: Helius deliveries (every transaction of every watched
address is one request, so `SMART_WATCH` is now 10, down from 100; every buy of every token a
group tracks is one too, which is the part that grows with the bot and the reason a busy bot needs
Workers Paid — one hot token can trade 20,000–30,000 times a day); each delivery logs one
`{ev:'tg-trade'}` line so the Logs split group buys from wallet swaps;
a map open in a tab (a refresh every 15 s — now paused while the tab is hidden); the image proxy
(one request per bubble's art on a first visit; the browser caches it after). `[observability]` is
on at a tenth of requests, so the dashboard's Logs name the route that is spending it.

**A second Cloudflare account for the bot is not the fix**: the bot shares KV and Durable Objects
with the site, its shop calls the site's own routes (those would land on the site's account anyway),
and a second free account opened to get round a limit risks both. Workers Paid ($5/month, ten
million requests a month) is, and it also lifts the CPU and KV-write limits described below.

## Conventions

- No dependencies, front end or back. If a library is genuinely needed, argue for it first.
- Mobile-first. Every layout rule starts mobile and widens at `min-width: 820px`.
- Rendering is canvas at 60fps; anything added to the per-frame loop needs to justify its cost.
  100 bubbles × 64 verts × ≤7 neighbours is the current budget. `step()` measures ~0.4ms;
  `draw()` is the expensive half and is the first place to look if frames drop.
- Test both viewports before calling something done: 1440×900 and 390×844.
- **Icons, not emoji, in the site's UI.** One hand-drawn line-icon sprite sits at the top of
  `public/index.html`'s body (`<symbol id="i-…">`), used through `ic(name, cls)`; the canvas draws
  the same shapes from the same path data (`icon2d`, `faceLabel`), so a bubble's face and a button
  never disagree. Emoji render differently on every phone and cannot take the page's colours. They
  stay where they belong: Telegram messages and the ready-made X post text. `swap.html` carries the
  few icons it uses.
- `node scripts/check.mjs <url>` before and after a deploy.

## Roadmap (suggested order)

1. Buy button with referral routing — revenue, no sales effort, doesn't touch map integrity
2. Daily boost leaderboard + "boost war" view — the shareable screenshot, i.e. free marketing
3. PumpPortal WebSocket for per-trade bubble flashes — nobody does this well, and the ingest
   already lives server-side where the socket belongs
4. Helius webhook instead of polling `/api/boost/status`, so boosts activate without a poll —
   the webhook plumbing now exists in `src/helius.mjs` for the buybot and can carry this too
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
- **robinhood** is Robinhood Chain, whose launchpad is Pons — its pump.fun. See
  `src/rhchain.mjs`, which exists because **nothing ranks this chain**. Pons publishes no REST API
  and its docs say to index the factory yourself; the chain's public RPC 429s after two calls;
  GeckoTerminal ranks it properly and 429s Cloudflare on every request, exactly as CoinGecko does.
  Blockscout 403s a request carrying no User-Agent at all, which is why Node's bare `fetch` fails
  against it and the project's own UA is fine.

  **Ranking by Blockscout's market cap was the first version and it was wrong.** Blockscout only
  prices what its own feed covers, so the map filled with bridged assets — LINK on top at $9bn with
  thirty-three holders — while ROBINCAT, thirteen thousand holders and trading hard, returned
  `circulating_market_cap: null` and was dropped entirely. Its other sorts are worse: by holders the
  top is airdrop spam, one token with 1.6M holders and no market at all. So Blockscout is used to
  *find* tokens and DexScreener to *judge* them — a market cap for a token with no pool is a number
  with nothing behind it.

  **Discovery is accumulated, not fetched.** Every query on this chain returns one ticker's clones —
  forty-four tokens call themselves ROBINCAT, thirty call themselves ROBIN — and both engines cap
  (DexScreener 30 cross-chain, Blockscout 50 chain-scoped). So each cron tick pages one term further
  through Blockscout's search and adds what it finds to a KV registry, and the terms are
  bootstrapped: every ticker already discovered becomes a later search term. Two traps, both of
  which silently froze it at a fixed number: a failed request left the cursor where it was while
  still reporting "more pages", and **Blockscout's cursor stops advancing after about five pages** —
  it keeps returning the same fifty rows next to a `next_page_params` that never terminates. The
  usable signal is whether a tick actually learned anything, not what the server claims.

  `scripts/rh-seed.mjs --sym ROBINCAT --go` pins a token immediately, for when discovery has not
  reached it yet. Pinned addresses are never pruned; everything else that turns out to have no pool
  is dropped when the registry nears its cap.

  **One survivor per ticker, chosen by pool depth.** Keeping the clones and letting the copy-count
  heuristic sort them out hid the real ones: PONS, with $6.7M of liquidity, was flagged as a copycat
  swarm and vanished off its own chain's map. The market-cap-to-liquidity test still runs over the
  survivors, which is what catches bridged LINK — $54.7bn of claimed market cap against **$243** of
  liquidity. Under the `major` quality tier that passed untouched, because that tier only asks
  whether a market cap exists; this source uses `memecoin`.

  It is **the whole chain, not Pons alone**. Separating a Pons launch from a bridged LINK means
  reading the factory, which is the door the RPC closes — and a tab labelled "Pons" while showing
  bridged majors would be worse than one that says what it is.
- **base** is Base, and it is the one chain here with a **canonical list**. Its own Blockscout
  instance answers 503 (eth.blockscout.com is fine from the same code, so it is theirs, not us),
  GeckoTerminal 429s Cloudflare as always, and sixteen DexScreener searches turned up twenty-seven
  unique Base tokens because every query returns one ticker's clones. CoinGecko publishes a token
  list per platform as a *static file* — `tokens.coingecko.com/base/all.json`, 2,677 addresses, not
  the rate-limited API — and that is the universe. DexScreener still supplies the ranking.

  That ordering is the point, and it is what Robinhood Chain could not have. Discovery by search
  returns whatever shares a name with a search term, which on a memecoin chain is a swarm of clones
  of whatever is hot. Starting from a list somebody maintains means a token has to have been listed
  before it can appear at all — the cheapest scam filter available. Pricing 2,677 addresses is
  ninety requests, so `src/basechain.mjs` sweeps: a slice per cron tick, tokens with a pool
  refreshed often and the rest re-checked slowly, and the map reads the cache so it never waits.

  **A pinned token is never ranked off the map.** $MAC prices correctly at $256k and sat outside
  the top 220 by market cap, so pinning it put it in the cache and still not on screen — which is
  not what pinning means.
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
| robinhood | yes | yes | — | — | — |
| base | yes | yes | — | — | — |

CoinPaprika returns zero for 30d and 1y on the free tier, so those two windows come from elsewhere
for both asset classes, by two different shapes of the same idea.

Stocks use `src/stockwin.mjs` — Yahoo's chart endpoint, keyless and accurate, but one symbol per
request, so it fills in ~30 symbols per cron tick and caches in KV for a day. Majors use
`src/cryptowin.mjs` — DefiLlama, which takes ~60 coins per request, so the whole map rebuilds in
twelve requests once a day and needs no warm-up at all. Neither ever blocks the map; an unenriched
symbol reports null.

## When DexScreener refuses the Worker

**Measured:** DexScreener answered **429 to every request from the Worker** (`/api/health` → `dex`)
while answering a laptop fine — its ~300/min limit is per IP and Cloudflare's egress IPs are shared
with every Worker on the platform. The pump.fun tab then showed **five bubbles with 295 hidden**:
no liquidity for anyone, so the quality filter called every token unbacked, and the old collapse
guard compared against the same isolate's previous build — which a fresh isolate (every isolate,
after a deploy) does not have. Robinhood showed zero rows for the same reason.

Four layers now, each answering one part:

1. **Answers are remembered** (`DEX_MEM` in core.mjs): reused for 60s instead of re-asked every
   10s build (roughly a sixth of the traffic), and a failed request falls back to the last good
   answer for 15 minutes. "No pair" is remembered too. It is DexScreener's own answer reused,
   never a number made up in its place.
2. **pump.fun's own market activity fills what DexScreener would not** (`src/activity.mjs`, moved
   out of pumptrend so core can use it without a cycle): price change, volume and buys/sells for
   Solana mints, marked `liqUnknown`. Without a pool, **turnover decides** whether a cap is backed
   (`UNKNOWN_LIQ_TURNOVER`, mcap / 24h volume): Fartcoin at $168M trading $12M passes; the $4B
   copycat swarms at the top of pump.fun's own ranking, trading $40k, do not.
3. **An absolute guard**: `minEnrich` on a source says what coverage is normal (pump.fun: 25%), so a
   build under it counts as broken on a fresh isolate too; the page gets `degraded` and **fails
   open** — every bubble, "prices refreshing" — instead of filtering on quality it could not measure.
4. **A shared feed that builds empty serves its KV copy however old**; the page shows its age.

`/api/health` carries `dex: { lastError, lastErrorAt, lastOkAt, memSize }` so the next refusal
names itself instead of looking like a grey map.

## Trending

`src/trending.mjs`. **"Trending" had to be defined before it could be a tab**, or it becomes
whatever number happened to be sortable. Everything that publishes a ready-made list is shut to us:
GeckoTerminal's `/trending_pools` ranks every chain properly and 429s Cloudflare on every request,
and DexScreener's boost endpoints rank *paid promotion* — an advertising slot wearing the word
trending.

So it is computed from two numbers the map already measures:

- **turnover** — 24h volume over market cap. How much of the thing actually changed hands. This is
  what stops the tab being the largest caps again.
- **movement** — the 24h change. Turnover alone puts stablecoins and wrappers on top: RLUSD turns
  over 1.0× a day and never moves, and WETH on Robinhood Chain turns over 5× while tracking ETH.

Multiplied, so both must be true. Gates: backed, ≥$100k cap, ≥$50k volume, 3%–1000% move, ≥$25k
liquidity **where liquidity is measured**, and none of the `copycat`/`thin`/`new` flags.

The upper move bound is the scam gate. baton reached the top of the tab at **+7340% on a token
thirteen hours old** — a real figure, and the shape of a mint pumping rather than a market moving.
The X poster refuses the same thing for the same reason; a tab labelled Trending is making a claim,
and the claim has to survive somebody clicking through.

The liquidity floor applies only where liquidity is *known*: CoinPaprika publishes none, so a blanket
rule would delete the whole majors category for missing data rather than bad data. A pump.fun token
whose liquidity is unknown is already caught by the `thin` flag.

**Unknown age is null, not zero** (`scoreQuality`). `t.created ? … : 0` made a missing creation
timestamp read as "0 hours old", which flagged the token `new` and declared its 24h figures
meaningless — METAc, a tokenised Meta with $1.2M of liquidity, was called a fresh mint purely
because the feed it comes from carries no creation date.

It is composed in `snapshot()` rather than fetched, because it ranks the other feeds against each
other and has no upstream of its own. Spanning pump.fun, Base, Robinhood Chain and the wider market
on one scale is the part nobody else can copy — and it surfaces the tokenised-stock crossover by
itself: METAc, AAPLc, NVDAc on Base, SPCX and GME on Robinhood, STONKS and Nasduck on pump.fun.

**pump.fun's own Trending list leads the tab now.** Its screener column called Trending is fed by
`frontend-api-v3.pump.fun/coins/great-coins?topK=50`. That was read out of the bundle — the
screener's fetcher is `GET /coins/great-coins` with `topK = offset + limit`, paged to fifty — after
a wrong turn worth recording: watching the Explore page's network traffic found
`advanced-indexer.pump.fun/boards/movers`, which *is* a pump.fun ranking but a different one
(🌟 Movers), and drawing it under the word Trending put OnlyFees and GIGAJEAN where pump.fun's own
list showed Backpack and STONK. The user caught it against a screenshot. And `great-coins` called
without `topK` returns **five** — the five rows pump.fun badges HOT — which is why the first look at
the right endpoint also read as the wrong one. `src/pumptrend.mjs`.

The list is about thirty-five rows, Solana-first with a few Pons and BSC entries, and it carries no
volume, no price change, no holders. Two more calls fill those. `swap-api.pump.fun/v1/coins/
market-activity/batch` (POST, ≤50 addresses, windows 5m/1h/6h/24h) gives volume, buys, sells,
**distinct buyers and sellers** and price change — the distinct-buyer count this project could not
get after pump.fun removed `/trades`, now on every trending card: *28,419 buyers / 23,751 sellers
24h*. The movers board is fetched too, as extras only: holders, top-ten share, deployer holding,
transactions in the last five minutes, KOLs, for whichever trending coins also sit on it (most of
the top do; a miss leaves those fields null). All three hosts answer from the Worker.

Rules, three carried over and two learned:

- **Nothing from the list goes through `scoreQuality()`.** It carries no liquidity, and unknown
  liquidity there is `thin`, which would mark every row unbacked for want of a field. Flags are
  computed in `shapeCoin()` from what *is* measured — buys against sells (the same one-way rule),
  tickers shared across the list, age, deployer holding ≥10%, top-ten ≥50%, pump.fun's own ban
  flag. A trending coin that our pump.fun feed also carries borrows that feed's liquidity and art.
- **A window the activity endpoint did not answer is null.** The board's lifetime buy/sell counts
  and volume stand in for the sums when the board has the coin; nothing stands in for a percentage.
- **One-way still takes a token off the tab.** WSOS sat at #6 on the movers board at $44M market
  cap with 14 holders, 19 buyers and 2 sells. pump.fun's rankings do not look at that; ours does.
- **Rank-heat is divided, not subtracted.** Rows carry `heat = 1e6 / rank` so the client's heat
  sort keeps pump.fun's order and its heat sizing means something: `1e6 − rank×1000` was a 10%
  spread that drew a hundred identical bubbles once log-compressed. Computed heat never reaches a
  thousand, so every computed row (Base, the wider market) sits below the list. Fire bubbles print
  `#N pump.fun`; the card says HOT for pump.fun's first five and ✓ for its verified badge.
- **Size on this tab is rank, so the market-cap floor is only for dust** ($1K). pump.fun's list
  goes down to $4K rows and they are on the tab where pump.fun puts them.

**The trending tab ranks by heat, not market cap.** Ranking by cap put WBNB and ARB on screen and
cut the tokens the tab exists for — the signal is turnover against size, so what it finds is small
by construction and was being dropped before it could be drawn. Size follows heat too unless a size
mode was picked explicitly, or the hottest bubble is a dot beside a bridged major.

**A trending bubble's outline *is* the flame.** Two attempts failed before that, and both failed the
same way — treating fire as something drawn *near* a bubble rather than as the bubble's shape:

1. Flame tongues behind the bodies. Invisible: the map packs bubbles to ~80% of the canvas, so
   every neighbour painted straight over the tongues of the one before it.
2. Tongues in front, on an orange shell. Still read as "an orange circle with wisps beside it",
   because the silhouette is what the eye names a shape by, and the silhouette was a circle.

So `blobInto()` deforms the outline for `t.hot`: canvas y grows downward, so `-sin(a)` is 1 at the
top and 0 at the sides; cubed, the stretch concentrates into a tongue instead of inflating the upper
half, and the ripples travel round the rim over time. The bottom is untouched — fire sits on
something. Frequencies stay low because the two smoothing passes eat anything finer, which is the
warning already in the Liquid bubbles section.

The fill is a **vertical** gradient — white-hot tip, orange body, deep red base. A radial gradient
makes an evenly lit ball whatever colour it is, which was most of why attempt 2 looked like a
marble.

Fire follows gold's rule: the shell stops encoding direction, so the percentage carries it in
dark-green or dark-red, and the turnover that put it there is printed on the face. Paid outranks
hot — a gold bubble stays gold.

## Tap wars

`src/taps.mjs`, the `TapArena` Durable Object in `worker/index.js`, the `taps` source, and the bar
at the bottom of the tab. Asked for as *"a new tab where they can add any bubble token, 1000 taps
gets a free ad spot, 5k taps a mini golden bubble, if another token outbids them in taps it takes
their place"*. That is what it is, with the mechanics pinned down:

| what | value | why |
|---|---|---|
| size on the tab | taps held | the tab has one measure; colour stays the real price change |
| rail slot | ≥1,000 taps, next 2 by rank after gold | sold ads always come first; a free slot is what is left |
| mini gold | ≥5,000 taps, top 3 by rank | `GOLD_USD = 12` of paid size — a Spark and a half, through the same curve and the same 25% gold-share guard as money |
| decay | halves every 24h | same reason boosts decay: staying on top costs effort now |
| keep | a won slot holds to 90% of its floor | without it a community at exactly 1,000 lost the slot to decay two minutes later and the event feed stuttered |
| per address | 100 taps / 10s, 1,500 / day, 5 adds / day | a script cannot tap faster than a thumb, and one address cannot outweigh a crowd |
| batch | ≤50 taps a request, every ~700ms from the page | a thumb never waits on the network |
| arena | 150 tokens; idle two days and under 25 taps → pruned when full | slots are for the living |

**Thresholds are floors, ranks decide.** Passing a floor makes a token eligible; whoever holds more
taps holds the slot. Being out-tapped takes it away at any count, and every flip is an event
(`gold` / `ad` / `lost`, with who took it from whom) — the bar shows the latest and the buybot will
post them later.

**Why a Durable Object, the one architectural fact here.** A tap is a counter increment and KV is
the wrong tool for a counter twice over: writes are last-wins across isolates, so two people tapping
at once lose taps, and the free tier's thousand writes a day are gone in a minute of a tap war. The
DO is one process with one memory — every tap lands exactly once — and it persists from an alarm,
at most one storage write every five seconds while anyone is tapping and none while nobody is.
**No tap ever touches KV.** The class in `src/taps.mjs` is the whole logic, plain and portable; the
DO is the box it lives in, and `server/dev.mjs` holds one in memory. Tested at 58 assertions
without a DO in sight. `new_sqlite_classes` in the migration is deliberate: SQLite-backed is the
kind the free plan allows.

The Worker reads the arena through a five-second per-isolate cache (`arenaState`), busted by that
isolate's own taps so a tapper's next poll shows their count. The tab's snapshot is also composed
in `snapshot()`, like trending, with a 5s TTL, and **the collapse guard does not apply to it** —
an empty arena is a state, not an outage, and so is a shrink after pruning. The client tolerates an
empty token list on this tab for the same reason; every other feed empty still means the feed is down.

**Identity comes from the chain, never from the form.** Adding a token goes through
`resolveAnyToken()` exactly as a boost order does, so the arena cannot be told a mint is a token it
is not, and it takes any chain the boost box takes. Price change and volume for the tab come from
DexScreener, cached a minute per token; the tap counts are never cached past five seconds.

**Gold won by taps joins the paid-size pool** in `/api/tokens` the way bids do — as
`GOLD_USD` of live spend on the token's `byMint` entry — so it draws through `bonusFromSpend`, counts
toward `goldShare`, and re-adds through the existing path when the token is not in the feed being
viewed. The token carries `tapGold` so the face prints `👆 ×1.6` rather than `★` and the card says
*golden by taps, not paid for*. The rail merges the two tap winners after whatever is sold, server
side, so the client's `rail()` did not change.

`/api/tap` refuses a request whose `sec-fetch-site` says cross-site, and — when that header is
absent — one whose `Origin` is not ours. **Requiring the header to equal `same-origin` was wrong
and would have been invisible:** Safari did not send Sec-Fetch-* before 16.4, an iPhone is the most
likely device at a tap game, and every tap from one would have returned 403 with the page saying
only "taps did not land". A POST carries `Origin` whether or not Sec-Fetch exists, so that is the
fallback. A cheap first door, not a lock; the per-address caps are the control,
and the honest statement is that a tap game cannot keep a determined botter out — it can only make
winning by bot cost proxies, which cost money, which is roughly the price of the ad. Verified live:
one address reached 1,000 in 100 seconds, took the rail slot, and decayed out of it minutes later.

The client: a click on this tab is a tap (`tapHit`), the card is one button away in the bar, taps
kick the bubble for a few frames (`t.kick`, decayed in `draw()`), and a poll never eats what
somebody is typing into the add box. `?source=taps|tap|tapwars|arena`.

## Traders

`src/traders.mjs`, sources `traders-daily|weekly|monthly`, the 💰 Traders tab. pump.fun's own PnL
leaderboard, **re-ranked by realized profit** — what was actually sold for more than it cost.

The endpoint is `frontend-api-v3.pump.fun/pnl-leaderboard?period=<daily|weekly|monthly>&sort=
<combined|realized|unrealized>&limit=100`, found by hooking the leaderboard page's `fetch` and
switching its 1W tab (a cold load server-renders the first period, so nothing shows in the network
log until the period changes). Rows carry realized, unrealized and total PnL in USD and SOL,
positions count, top three positions, username, avatar, X handle and verified badge. Everyone on it
is a pump.fun profile that opted in by making a callout, so nothing is published here that pump.fun
does not publish itself; there is no losers ordering and none is built.

**Why realized, the whole reason the tab exists.** pump.fun sorts by `combined`. The day this was
built its daily #1 showed +$1.1M with **$0 realized** and its weekly #1 +$1.31M with **−$31,848
realized** — the top of pump.fun's board is paper. Here, **size is realized profit** (it goes in
`mcap`, the field that sizes every bubble) and a row with nothing realized is not on the map at all.
**Colour is the total** in the tab's window: green if the trader is up overall, red if the open
bags outweigh what was banked. The face says why — `+$58.7K` banked, `open −$95.8K` — because a red
bubble with a plus sign on it reads as a contradiction until the third line explains it. The card
shows realized / open / total / positions and where pump.fun's own board puts the same wallet
(joined from a second, optional `combined` call): cooker was #1 by realized and **not in pump.fun's
top 100 at all**.

Details that are decisions:

- **The timeframe pill is the query.** 24H → daily, 1W → weekly, 1M → monthly; 1H and 1Y fall back
  to 24H in `fixTf()`, and on this tab a pill change refetches instead of re-sorting.
- **A trader is not a token**: no `mint`, no `addr`, so the card's Boost and Buy buttons stay
  hidden by the rules they already follow; the button says **Profile** and goes to
  `pump.fun/profile/<wallet>`; Share opens the top-10 card rather than a ticker card.
- **The X handle is `xh`, never `x`** — `x` is a bubble's position on the canvas.
- **`@` only in front of a real X handle.** The first card put one in front of every pump.fun
  username, and "@MadToast" on X may be somebody else.
- **`history: false`** on these sources. `buildSnapshot` pushes every row's `mcap` into the price
  history and back-fills short windows from it, which here would have printed how a trader's profit
  moved under a price-change label. The flag is generic for any source whose `mcap` is not a cap.
- **Not `shared`.** Three feeds refreshed through KV would spend ~860 of the 1,000 free writes a
  day on a list pump.fun refreshes every few minutes; per-isolate caching at 2–5 minutes is plenty.

**Node's fetch is blocked, the Worker's is not.** From a laptop, `pnl-leaderboard` answered curl 200
and Node's built-in `fetch` 403 with Cloudflare `rule_id 0.07` — identical headers, so it is the TLS
fingerprint, not anything a header can fix. From the deployed Worker all three periods answered 200.
The project rule held again: an upstream is tested from the Worker or it has not been tested.

**Avatars go through pump.fun's own image optimizer.** pump.fun serves profile pictures as WebP,
which resvg cannot decode, and wsrv.nl answers **400** to that host — so the first share card had
two avatars out of ten. `pump.fun/_next/image?url=…&w=256&q=75`, asked with an Accept that does not
list WebP, returns the same picture as JPEG: first-party, and now the first conversion step for any
pump.fun-hosted art in `logoDataUri` (token cards benefit too). **`q=75` exactly** — current Next.js
answers 400 to any quality it was not configured for, which is what `q=80` did. Ten of ten after.

**Ready posts.** The Share top 10 popup writes the post too: an editable box with the text, an X
character count (links weigh 23, emoji 2), Copy post, and Post on X pre-filled with exactly what is
in the box — link included, which is what makes the card unfurl under it. It was asked for after
the operator started hand-typing these lists, and the generated monthly post matched the
hand-typed one name for name. `tenRows()` is the server's `pickTen()` on the client: the tab's own
order, measured rows only, so the post and the picture name the same ten in the same order.
Traders get `@handle` only when pump.fun's X field is a legal handle, else the pump.fun username;
tokens get a cashtag only when X would link it (a CJK ticker is printed bare).

**`+null` is 0, and 0 is finite** — the null-as-zero trap once more, on both sides this time.
`pickTen()` and `tenRows()` filtered on `Number.isFinite(+pc[tf])`, so after leaving Traders on 1M
the Trending post printed **+0.0% for all ten** and the share page's description said "+0%" for a
window nobody measured. Both check `!= null` first now; under three measured rows the popup says
there is nothing measured for that window instead of a card that never draws. And leaving Traders
resets the timeframe to 24H, because its 1W and 1M are its own boards and most tabs have neither.

**Cards live on the free plan's burst allowance, and sometimes lose.** Measured from `wrangler tail`:
a cold bubble card costs **~1,065 ms of CPU**; the free plan's limit is 10 ms per request, tolerated
in bursts, so a cold render is occasionally killed with *"Worker exceeded CPU time limit"* (503) and
succeeds on the next try, after which the edge serves it. This is true of every share card, not
this one. Workers Paid ($5/month) removes it; until then, open a link once before posting it.

## Smart money

`src/smartmoney.mjs`, source `smart`, the 🧠 tab. Every bubble is a token, sized by **how many of
pump.fun's top traders by realized profit hold it now** — the daily, weekly and monthly realized
boards together, each wallet once, up to 300 traders — from the `topPositions` pump.fun lists on
every leaderboard row. Coin records come from `POST frontend-api-v3.pump.fun/coins-v2/mints`
(`{"mints":[…]}`, full coin objects, 100 a call); price change and volume from market activity.
Nothing is predicted: it shows where people with a measured record of banking profit have money.

**The claim was checked before it was built.** "Top positions" could have meant what a trader made
money on and already sold — the opposite signal. Against pump.fun's per-wallet PnL
(`profile-api.pump.fun/v2/pnl/token/<wallet>/<mint>`, `amount_held`) 15 of 18 sampled were still
held; the other three were Robinhood Chain tokens that endpoint does not cover.

- **All three boards, not the pill's period.** Price change is available to 24h only; letting 1W
  choose the weekly board would have coloured bubbles by a week's move nobody measured. One day's
  board alone was 255 positions across 228 tokens; three boards make overlap happen.
- **Size is holders, tie-broken by what they banked** (`scoreOf`: count × 10 + log10 of combined
  realized), carried in `heat` so the page sizes and ranks it the way it does Trending. The face
  prints `🧠 N`; the card names the holders, richest first, `@` only on a legal X handle.
- **Dust and wrapped majors are dropped.** Top positions include tokens called `test` and `4` with
  nothing traded (`MIN_VOL`, `MIN_MCAP`); and **wrapped ETH on Solana carried Ethereum's whole
  $324B market cap**, which put the header's tracked cap at $348B. The cap-to-volume bar the pump.fun
  tab uses without liquidity (`MAX_CAP_TO_VOL`, 2000) removes them: ETH turned over 1/29,831 of its
  "cap" a day, real coins on the tab 1/50 to 1/300.
- It is a token view: Boost, Buy and Chart all work. Share top 10 reads "N TRADERS" on each bubble.

**One tab, two views, four boards — and the holdings are a table.** Traders and Smart money share
the strip's 🧠 Smart money tab; `#subbar` switches between *What they hold* (`S.mode='smart'`) and
*Top traders* (`'traders'`), and under *What they hold* the board tabs pick whose holdings count —
All, Today's, This week's, This month's (sources `smart`, `smart-daily|weekly|monthly`,
`smartMoney(periods)`). The board is its own control now, so the 1H/24H pills keep meaning the price
move. The boards tell different stories on the same afternoon: all boards ZCAT ×16, today's traders
goon ×7, this month's ZCAT ×12. `feedId()` is the one place tab state becomes a source id;
`lightMode()` lights Smart money for either view; `?source=traders`, `traders-weekly`,
`smart-monthly` and the rest land on the right view and board.

*What they hold* is drawn as a **table, not bubbles** — asked for directly, and right: "who holds
what" is names and numbers, and a circle can carry one of them. `renderSmartTable()` takes the
rebuild's full ranked list (not the bubble limit), sorts by holders, market cap, 1H or 24H from its
headers, and a row opens the ordinary card with Chart, Buy and Boost. While it shows, the canvas is
hidden and `loop()` skips the physics and the draw — ninety bubbles animating under a table was
CPU spent on nothing.

*Top traders* is a table too now — asked for the day the holdings table shipped ("i want top
traders in tables too"). `renderTraderTable()` inside the same `#smTable`: rank, avatar, name with
✓ and the legal `@handle`, Banked (the default sort — it is the ranking), Open, Total, Positions,
what they hold, and pump.fun's own rank for the same wallet. On a phone it is rank, trader, banked,
total. The 24H / 1W / 1M pills still pick the board.

**The share card for both views is a leaderboard, not bubbles** (`src/tablecard.mjs`,
`/api/card?kind=table&source=smart*|traders-*`). A picture of ten people and their amounts is what
the people on it repost; ten circles could carry one number each. Rows are the same `pickTen()` as
every top-ten card; smart money ranks by `heat` so the card and the table agree. Traders read
BANKED / OPEN / TOTAL with a dash, not a zero, where pump.fun gave nothing; holdings read HELD BY /
the pill's window / MCAP. The window label sits on the tag line, not beside the title: Archivo Black
capitals average ~0.7em, not the 0.62 the mixed-case estimate uses, and the first render ran the
title into it. `/s/top10` and the popup switch to `kind=table` for these sources on their own.

**On a phone both tables are lists** (≤700px): rank, picture, name with its second line at full
width, and one right-hand column with the two numbers that matter stacked — market cap over the 24h
move, banked over total — whose header halves each sort. `table-layout:fixed` gives the name every
pixel the numbers do not need; the first phone cut kept four number columns and squeezed names to
70px. Desktop-only cells carry `c-dt`, phone-only `c-ph`. The sub-bar goes full-width with short
board labels (All / Today / Week / Month) below 820px. **The map and the main toolbar were not
touched on purpose**: a two-row phone toolbar was built and reverted the same hour — the operator
was clear the bubble view on mobile was already right and only the tables needed work.

**Card art goes through the map's image proxy first** (`logoDataUri(t, via)`, `via` =
`ctx.fetchImage`). The first live table card had six letter discs in ten: all ipfs.io art, which
ipfs.io answered 429 to the card's direct fetch while `/api/img` served every one in ~0.1s from the
edge cache the map had already filled. The proxy is a cache hit with no upstream call, and on a miss
it walks the same gateways; the old direct path stays as the fallback. Every card kind passes it.

## Callers

`src/callers.mjs`, the `CallersDO` watcher in `worker/index.js`, sources `calls` and
`callers-daily|weekly|monthly`, the Calls tab. Asked for as "callouts on pump.fun — maybe a
leaderboard of traders by callouts; value, dopamine, flex". A pump.fun callout is a public call on
a coin the caller holds, pushed to their followers; pump.fun ranks callers behind a login (its
`/callout/leaderboard` answers 401). This ranks them in the open.

**What is public, measured 2026-09-30:**

| endpoint | what | how it behaved |
|---|---|---|
| `GET /home-feed` | ~150 live calls, pump.fun's own ranking, each with the caller's position in the coin (held, value, realized and total PnL) | fine polled every 3 s |
| `GET /home-feed/new` | the 25 newest calls — about forty a minute | fine polled every 2 s |
| `GET /users/<wallet>/callout-stats` | per day/week/month: calls, share reaching 1.2×/1.5×/2×, average and median peak multiple, time to peak, distribution | a burst of 40 in 2.4 s, no complaint |
| `GET /callout/list/<wallet>` | every call of one caller | **429, `Retry-After: 584`** after a burst of 40, locked out for minutes |

So per-caller polling is off the table: the two feeds are the stream and the stats endpoint the
record. Every call carries `multiple` (now, against the call's price) and `maxMultiplier` (the peak
since) — checked against live prices: SI at 24.2× by Jupiter's price, pump.fun said 24.7×.

**Measured, not believed:**

- **Peak and now, never only the peak.** TIGRINO peaked 19.7× after its call and sat at 0.31× —
  whoever followed and held lost 69%. The table and the card show both.
- **The ranking is the 2× hit rate at the lower edge of its 95% Wilson interval**, with a minimum
  of calls per window (2 a day, 5 a week, 10 a month). Five for five (0.57) does edge out 28 for 40
  (0.55) — that is the interval doing its job, and the test fixture says so — while 3 for 3 cannot
  beat 20 for 30. An average is one moonshot: a trader that week averaged 3.0× on a median of 1.76×.
- **Whether the caller still holds** is their own position in the feed, as of when it was read —
  "sold", "took profit", "still holding" are measurements, not verdicts.
- **The live table is calls worth reading**: from a caller with a record (5+ calls this week, a
  quarter reaching 2×) or a call 1,000+ people have looked at. The raw stream is forty a minute,
  most from accounts with generated names — the first four on the first run were ArrowWellServer,
  TideMintPapyrus, ShrubCampAction and a fourth like them.

**Why a Durable Object, again:** one process polls pump.fun once however many people are looking,
on its own 20-second alarm, and keeps the book (calls, callers, records) in memory, saved every two
minutes as one storage write. The clock schedules everything — the ranked feed every minute, the
PnL boards every half hour (their callers are fetched first: they have a record of banking), coin
market caps every three minutes — so a restart does not refetch everything on every tick. A cold
book (a fresh deploy) fetches 15 records a tick until 150 callers have one, then 6. A tick is at
most ~21 requests, inside the 50 a Worker invocation may make. The cron's `tick` restarts the
alarm if a deploy ever lost it. Verified under `wrangler dev`: 144 calls from 337 callers within
seconds of the first read, the weekly board filling as records arrive.

**On the page** both views are tables in the Smart money tables' container (`TABLE_MODES`), rows
as the feed pipeline expects: a call is a token row (`kind: 'call'`, one per call — two callers on
one coin are two rows), so the card's Chart, Buy and Boost work; a caller is a people row like a
trader (`kind: 'caller'`, Profile opens pump.fun). Table feeds skip the paid-bubble re-add
(`TABLE_FEED`) — a gold token has no place in a table of people — and may be empty (`EMPTY_OK`,
`EMPTY_MODES`) without reading as an outage. The share card is a leaderboard (`/api/card?kind=table
&source=callers-weekly`: HIT 2× / MEDIAN PEAK / CALLS).

**In the bot**: /callers shows the week's top ten and a switch; "Follow top callers" (AudienceDO
`cf:<user>`) sends each new call from the week's top 20 the moment the watcher sees it, through the
same paced fan-out queue the wallet tracker uses, with Buy (our swap), Chart and a way out. An alert
is considered once per call and only while under 15 minutes old — a restart does not replay the
past hour.

## The generative card

`src/bubblecard.mjs`, `/api/card?kind=bubbles`, the page at `/s/top10`, and the **Share top 10**
button on the tabs whose top ten is a claim (trending, pump.fun, majors, stocks, robinhood, base —
not the flow views, whose venues have no ticker and no logo).

The five-row card answers "who moved". This one answers "what does the site look like": the top ten
drawn the way the map draws them — packed bubbles, sized by rank, coloured by direction, logo above
the ticker above the percentage. A post then carries a picture of the product.

The background is the bubbles' own light: three translucent rings behind each one, emitted before
any body so a neighbour's halo never washes over a bubble already drawn. Free-floating glow blobs
were tried first and read as wallpaper the bubbles happened to sit on.

**Generative, not random.** `seedFor()` is the tickers plus the *hour*. The same ten in the same
hour is always the same picture — which is what lets the edge cache it, and what stops one link
showing two pictures of one fact — and the next hour, or one change in the ten, recomposes the
whole field: positions, radii jitter and the glow blobs behind them. The cache key is the seed, so
cache and composition cannot disagree.

Packing is a seeded relaxation (push apart, pull to the middle, clamp), then **a spread pass**,
because relaxation leaves the cluster compact in the middle of a 1.9:1 letterbox with a third of
the card empty. The spread scales *positions only, never radii, and never below 1*, on each axis
independently: every pair of centres moves further apart, so it can separate bubbles but can never
push one through another. One factor for both axes fills the tight axis and leaves the wide one
short, which is the axis the eye reads.

Two things had to be solved that the row card never faced:

- **Text has to fit inside a circle.** There is no way to measure a string in the Worker, so
  `fitSize()` solves the size from Archivo Black's ~0.62em average advance against the chord at the
  height each line sits on. Without it `$SCHRÖDINGER` ran a hundred pixels past its rim and across
  its neighbours at the size that suits `$SOL`.
- **Art is harder than it looks, and three separate things were breaking it.** resvg-wasm 2.6.2
  decodes PNG, JPEG and GIF — not WebP or AVIF — and it fails the way an image library fails inside
  an SVG: no error, no logo, just the committed space. On a live top ten **five of ten served
  `image/webp`**. This was never a new-card bug: the single-token and five-row cards had it too.

  The pipeline in `logoDataUri` now answers each cause once. **The bytes are the truth, not the
  header** (`sniffType`): an IPFS gateway returns `text/plain` on a 429 with a sentence in the body
  and plenty of real PNGs with no type at all, so sniffing both rescues the mislabelled and refuses
  the error pages. **Ask nicely first** (`preferReadable`): DexScreener's CMS takes `format=auto`,
  which means "whatever the caller accepts" and answers WebP to anything modern — `format=png` is
  the same image, free, no third party. **A CID is on every gateway** (`altGateways`, in core.mjs
  so the image proxy shares it). **And WebP is rented out**: wsrv.nl re-encodes a public image to
  PNG, for share cards only, never the map, and a failure is the same outcome as before, no logo.
  A bubble with no art draws no ring at all, moving its two lines up into the space instead.

- **A cached failure is worse than no cache, and this one lasted a week.** The image proxy fetched
  with `cf: { cacheEverything: true }`, which caches by status as well as body, so a single 429 from
  a rate-limited IPFS gateway was stored under that image's URL — and `cache.match` returns before
  any fallback can run, so every later request served the 429 for the whole `IMG_TTL`. $JEANPHIL and
  $Replicate wore letter avatars **on the map** for days while their art sat one gateway away
  answering in 300ms. Now only an actual image counts as a hit, and the outbound fetch uses
  `cacheTtlByStatus` so an error is never what the edge remembers. Measured after: 12 of 12 tokens'
  art served, none missing.

A row whose window was never measured is not drawn, the same rule as everywhere else; under three
measured rows and the route 404s and the page redirects to the map rather than publishing a top ten
we could not fill.

## The rail moves

The ad rail is a slow continuous belt (`#rail.marquee`, the items twice, `translateX(-50%)`,
speed set from the belt's own width, paused under the pointer, off under
`prefers-reduced-motion`). Order: **sold slots, tap-won slots, the pitch, then the top fourteen of
the Trending tab.** The trending items exist because an empty rail is an empty rail; the pitch stays
because an empty *slot* is the sales pitch.

**A moving strip of tokens must never let a paid one pass as a ranked one**, so every item wears
what it is: `AD` on a sold slot, `👆 won` on a tap-won one, `#N trending` on a filler with its 24h
move in green or red, and the pitch is dashed gold. The old `AD` badge on the rail itself is gone —
it would have labelled the trending items as ads. Filler comes through `/api/ads` as `fill`, read
from the trending snapshot behind a 1.5s race so a cold isolate never holds the rail for a feed;
a trending item opens its card on the map, switching to the Trending tab and pinning it when the
current tab does not carry it. The client refetches the rail every minute.

**The belt must not restart when the rail refreshes.** Writing `innerHTML` destroys the animated
element, so every minute's refresh sent it back to the start — and one lap is longer than a minute,
so it never finished one. `rail()` rebuilds only when the *set* of items changes and otherwise
writes the new percentages into the elements already on screen, both copies of them. A rail-set pin
is also dropped the moment the visitor picks a tab themselves (`S.pinFromRail`), or clicking a
trending coin drags it onto the stocks map and every map after that; a deep link's pin is the
partner's and stays.

**The fill must never wait on a build, and the first version did.** It raced `snapshot()` against
1.5 seconds and lost four times in five — measured live: `fill: 0` at ~1.7s on four of five
requests, so most visitors got the empty `SLOT OPEN` placeholders the fill exists to replace. Every
`/api/ads` lands on whatever isolate Cloudflare picks, a cold one has no trending in memory, and
composing that tab is four feeds plus three pump.fun calls. `railFill()` reads what is already
warm instead — this isolate's snapshot, else the shared KV copy the cron refreshes — and caches the
derived rows a minute. 14 of 14 afterwards, at 0.15–0.37s. **Stale by a few minutes is the right
trade for a strip of logos; empty is not.**

Pausing is a pointer idea, so touch gets its own: a press adds `.hold` (released 1.2s after the
finger lifts, so a tap-to-open is never fighting the belt), and a hidden tab pauses too. Under
`prefers-reduced-motion` the rail is not a belt at all — it keeps every item and goes back to being
scrollable, because the trending fill is information, not decoration.

## Chains and launchpads

`src/flows.mjs`. Two views that are not about individual tokens: where trading is happening across
chains, and which launchpad is actually busy.

**Size is what the thing does, not what it holds.** TVL is the obvious measure and it is the wrong
one — money parked rather than money moving. For a launchpad it is not merely imperfect: a launchpad
holds nothing, and DefiLlama duly reports pump.fun and Pons at **$0 TVL**. What a launchpad does is
take fees, and those are published. Pons V2 at $5.2M in 24h against pump.fun's $1.4M is the answer
to which one is busy; TVL would have said neither exists.

| view | size | colour | 1W |
|---|---|---|---|
| Chains | 24h DEX volume | volume-weighted `change_1d` of the venues on it | volume-weighted `change_7d` |
| Launchpads | 24h fees | `change_1d`, or the day against the trailing weekly average | `change_7d` |
| Prediction | 24h volume wagered | `change_1d` | `change_7d` |
| Casinos | hot-wallet balance (off-chain casinos) / bankroll TVL (on-chain) | own history / `change_1d` | own history / `change_7d` |

**These bubbles print the money on their own faces.** Relative area says which is
bigger; it does not say whether that is two billion dollars or two million, and
that is the question the two tabs exist to answer. So a chain and a launchpad do
not get the token face at all — `flowFace()` draws name, dollar figure, change,
with the money as the hero. The token layout could not have carried it: it spends
the top of the bubble on a logo and leaves `r*.31` between the ticker and the
percentage. Every line is measured with `measureText` and shrunk to fit inside
the rim rather than trusted to a radius ratio, because "$2.97B" and "$412" are
the same font size and very different widths.

**Names are a harder problem than numbers here.** A ticker is four characters; a
launchpad is "Meteora Dynamic Bonding", 23 of them, on a bubble 54 pixels across.
Shrinking the font until that fits is unreadable *and* it still spilled past the
rim onto the neighbours — on a 375px phone the tab was overlapping soup with the
fourth-biggest launchpad on the map lost inside it. `fitLabel()` tries the whole
name, then its first word (a launchpad brand is its first word: "Graphite" beats
"Graphi…"), then clips. Splitting is on whitespace only — pump.fun and BONK.fun
are one word each and cutting them at the dot would rename them.

The card is relabelled to match — "24h DEX volume" and "DEX volume share" for a
chain, "24h fees" and "7d fees" for a launchpad — and its button says **Open**
rather than Chart, because `chartUrl()` sends these to DefiLlama, which is where
the number came from. A chain has no market cap and no five-minute candle;
printing its volume under a label reading "Market cap" beside two boxes of
dashes was four wrong answers to questions nobody asked about a chain.

A chain gets no 7d *volume*: the overview breaks down by chain for 24h and 30d
only, and slicing a protocol's global weekly total across the chains it happens
to list would be arithmetic we invented. Its share of all DEX volume on the map
is free, measured, and a more direct answer to "where is the money flowing" than
another absolute figure.

**Launchpad fees are floored at $1,000 a day.** The tail there is not data: fees
span $6.75 to $5.2M across DefiLlama's sixty, with twenty-six under a thousand
dollars, and a contract that took $6.75 yesterday costs twice — it spends a
bubble slot, and it stretches the log domain so every launchpad anyone is asking
about comes out the same size. Above the floor it is thirty-four venues over 3.7
decades, the same visual range the chains map has and the one already verified to
read well. Chains need no floor: fifty-five of sixty are above $1M.

**Prediction** and **Casinos** are the third and fourth flow views, and they are separate on
purpose — they answer different questions and are sized in different units.

*Prediction* is prediction markets by 24h volume wagered: Kalshi ~$420M/day, Polymarket ~$150M,
27 venues over the $1,000 floor. Volume, because that is how a betting venue's size is stated
anywhere (handle, not revenue). The house take is joined from the fees overview by slug and shown
in the card — Polymarket keeps ~2% of what is wagered — and is a dash where DefiLlama has no
adapter. Kalshi is a CFTC-regulated US exchange and not crypto at all; DefiLlama files it in the
same category and the card says *Off Chain* out loud. It stays because leaving it out would hide
the largest fact on the tab.

**Kalshi above Polymarket was challenged as false data, and checked rather than defended.**
DefiLlama measures both the same way — Kalshi as `price × contracts` from Kalshi's own published
trade reports, Polymarket as USDC filled on-chain halved for the maker/taker double-count — so the
unit is the same. Then independently: Kalshi's public trade tape runs ~8,000 trades a minute, and
extrapolating one minute of it gives ≈$428M a day against DefiLlama's $423M. The 2.9× gap holds
over 7d (2.75×) and 30d (2.96×); it is not a spike. Polymarket won 2024, Kalshi is winning 2026 on
volume, and the tab says so.

What *was* wrong was ours: DefiLlama lists Polymarket as three protocols (International on Polygon,
the CFTC-regulated US exchange, Combos) and the map drew three bubbles, each a fifth of Kalshi
when the brand is a third. `BRANDS` in `predictionFrom()` sums a brand's listings into one bubble —
change volume-weighted, take and week summed — and the card shows the split. Merging is a
judgment, so the list is explicit and short.

*Casinos* was asked for as *"Stake, Shuffle, BC.Game"*. None of those publish anything: not in
DefiLlama under any name (the one "Stake" hit is Binance's staked ETH), no volume, no fees. A map of
casino *tokens* would omit Stake, which has none and is the largest, so that version was not built.

**They are on it now — measured from their hot wallets.** `src/casinowallets.mjs` is a registry
of 31 addresses for 15 off-chain casinos (Stake on Tron, Ethereum, Solana and Polygon; Roobet,
Rainbet, Shuffle, BC.Game, Duel…), and `src/casinos.mjs` reads their balances from public RPCs
every cron tick, in slices of eight. The number on the bubble is dollars sitting in the wallets
that pay withdrawals, priced with the majors feed. Stake reads ~$134M.

How the registry was built, because it is the part worth protecting. Public trackers (circus.fyi,
fairgambling.com) publish *biggest deposits and withdrawals* lists with full transaction hashes and
a casino name on each. **A hash is a public fact; the casino's side of that transaction is read
from the chain** — recipient of a deposit, sender of a withdrawal — so every address in the
registry came from a transaction, not from anyone's label, and carries the hash that established
it. 291 seed hashes gave 271 resolved transactions and 31 distinct addresses. Nothing the trackers
compute is stored or shown; they are a seed source, used offline by `scripts/casino-wallets.mjs`,
never called at runtime.

Verified before it was written, the cgmap way. An address with code is a contract, not a wallet —
the **USDC token contract** arrived via a malformed transaction and was rejected on `eth_getCode`.
Then per-casino sums were compared to circus.fyi's own (larger) wallet sets: Stake 76%, Duel 75%,
Roobet 72%, Rainbet 52%, 1win 55% — **every one under, none over.** A mislabelled wallet would have
blown past the reference. The gap is coverage (wallets and chains we have no hash for yet), not
error, and it closes as more hashes are fed in.

So the card says *hot wallets, on-chain*, prints how many wallets that is, and carries a line saying
it is a floor — cold storage and chains without a known address are not counted. 24h and 7d change
come from our own history points and are **null until a point that old exists**; a tab that has
run for an hour does not get to claim a daily move. One KV write per tick; a wallet that fails to
read keeps its last value with the error attached, so a bad RPC minute cannot zero a casino.

Both kinds share the map because both are *what the house holds where we can see it*:

What DefiLlama does list is 38 on-chain casinos ("Luck Games"), and **this is the one flow view
sized by what a venue holds rather than what it does.** Deliberately: a volume adapter exists for
five of the 38, so sizing by volume draws five bubbles and calls it a market, while every one of
them publishes its **bankroll** — and bankroll is how the casino industry itself states size,
because it is what the house can pay out. Wagered and house take ride along in the card where an
adapter exists and are a dash where not. Yield lotteries (PoolTogether, Ample) are excluded: a
no-loss lottery is not a casino and would have taken the top three slots. 17 venues over $1,000;
the third DefiLlama fetch (`/protocols`, the full list) rides the same twenty-minute tick.

`?source=gamble`, `casino`, `gambling` resolve to Casinos; `bets` resolves to Prediction.

Chain volume comes from each DEX's `breakdown24h`, which is `{chain: {protocol: volume}}` — the
exact split. Dividing a multi-chain protocol's total by how many chains it lists would credit Solana
and a testnet equally.

The two responses are 1.8MB and 4.1MB, so a cron tick aggregates them to a few KB in KV and the map
reads that. A side that comes back empty never overwrites a side we already had.

**`fmtPct(null)` threw, and the symptom was a bubble that would not open.**
`null >= 0` is true in JavaScript, so the sign guard passed and `null.toFixed`
did not exist. It threw inside `openCard`, between the market-cap box and the
line that reveals the card — no visual glitch, no failing route, one uncaught
error in a console nobody had open. Every source publishing a window it does not
have was affected, so **the stocks card was dead too** (no 5m, no 1h), not only
the two new tabs. `fmtPct` returns a dash for null now, and
`scripts/page-refs.test.mjs` lifts it and `fmtUsd` out of the page and *runs*
them, because reading a formatter is not the same as calling it with null.

That test also pins `fmtUsd(5.39e12) === '$5.39T'`. The map had no trillion rung
while the stocks tab had six of them, so NVDA read `$5390.45B` — technically
correct and not how anybody says it. The share card has had the rung since it
was written.

**The short windows were still coercing null to zero.** `pc:{m5:+t.pc.m5||0,…}` in the client mapper
was left alone when the long windows were fixed, because pump.fun always reports them. Chains and
launchpads publish a 24h figure and nothing else, so the 1H tab rendered sixty confident green
`+0.00%` bubbles for a number nobody had measured. Every window is null-preserving now.

`fixTf()` keeps the timeframe on a window the source actually has. It first lived in the tab click
handler alone, so a deep link to `?source=chains` skipped it and landed on exactly the empty tab it
existed to prevent — the same shape of bug as `?source=` only working inside `initEmbed()`. It
permits `d7` as well as `h24` now that both are measured.

**A deep link has to light its own pills.** `applyDeepLink()` set `S.mode` and
stopped, so `?source=chains` drew the chains map under a highlighted "pump.fun"
tab: the state was right and the page said otherwise, which is worse than either
being wrong alone — and the links this site generates for itself are what land
there.

## The swap page

`public/swap.html` at `/swap?mint=<mint>` (`&side=sell`, `&amount=0.5` optional),
`swapConfig()` / `buyOrSwap()` / `SWAP_CSP` in `src/refs.mjs`, `/api/swap-config`,
`scripts/swap-page.test.mjs`. **Our own swap, drawn like the map**: the token as a lit bubble
with price, 24h move, market cap, liquidity, holders and traders, measured chips (mint and freeze
authority, top-holder share, dev share, "53 traders made 29.3K trades", organic activity — never a
verdict), Buy/Sell tabs, presets (0.1–1 SOL, 25–100%), the quote's rate, impact, minimum,
fee, network cost and route, and the map's green button. After a buy: Solscan, and a gold
**"Make $X gold on the map"** — the people who just bought a token are the people who boost it.

**It is where Buy goes when no trading bot is configured** — the map card's Buy (shown on every
Solana token), the bot's Buy and ⚡ Copy buy. The old rule was "no code, no button", because a link
out to someone else's terminal with no referral spends the click and earns nothing. This keeps the
visitor on pumpbubble, and it starts earning the day the fee account exists, without a deploy: set
`JUP_REFERRAL` (the public key of a referral account under **Jupiter Ultra**'s referral project,
`DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc`, made at referral.jup.ag with the operator's own
wallet) and `JUP_FEE_BPS` (50–255; **100, i.e. 1%, since 2026-10-01**, the operator's call —
Jupiter keeps a fifth, so 0.8% lands; Ultra's own base fee is then not charged on top). Jupiter
picks the mint each order's fee is taken in (`feeMint`: SOL first, then stablecoins), and **if the
referral token account for that mint does not exist, the trade executes without the fee** — so the
account needs SOL and USDC token accounts at least. Integrator fees also route through Metis only
(JupiterZ's RFQ quotes do not take them). A trading-bot referral still wins when both are set.
**Live since 2026-10-01**: the operator's account `CHub77…PbjBq` (SOL, USDC and PUMP token
accounts), checked against live orders — a buy, a sell, a pump.fun coin and a USDC trade all came
back `feeBps: 100` with the fee in SOL (USDC for the USDC trade); Jupiter's own rate without it is
10 bps. The quote's Fee line says "pumpbubble" only when Jupiter applied exactly our bps.

**Why our own and not Jupiter's widget.** The first version embedded Jupiter's Plugin; it worked,
and it looked like Jupiter — a fixed 360×550 black box, their lime button — which is what was asked
to change. Jupiter's Ultra API does the part that is hard (routing, slippage, priority fees,
landing the transaction) and answers the browser directly: keyless on `lite-api.jup.ag`, with
CORS for our origin on `/order`, `/execute`, `/holdings` and `/search` (checked before building).
So the page is ours and the plumbing is theirs:

- **Wallets are the Wallet Standard, not a library** — `wallet-standard:app-ready` announced,
  `wallet-standard:register-wallet` listened for; Phantom, Solflare and Backpack answer both. Only
  a wallet with `standard:connect` and a Solana signing feature on a `solana:` chain is listed;
  icons only as `data:image`. The last wallet reconnects silently. A phone with no wallet gets
  "Open in Phantom / Solflare" (their browse links, this same URL inside the wallet's browser) —
  that is the path from a Telegram Buy button.
- **Amounts are integers in base units end to end** (`toUnits`/`fromUnits`, BigInt); a float only
  reaches the screen.
- **A transaction from Jupiter is checked before any wallet sees it** (`orderOk`): same mints,
  same amount in, built for this wallet, with a request id. The wallet's preview is the last check,
  this is the one before it. A quote older than 20s is re-asked before signing; quotes refresh
  every 12s while on screen.
- **A fee account Jupiter refuses fails the whole quote** ("referralAccount is initialized under
  REFER4Zgmy… for project DkiqsTrw…" for a bad one), so the page drops the fee, keeps quoting, and
  warns in the console — the trade matters more than our cut of it.
- **The price and its 24h move come from one source.** Jupiter's price is the one traded against,
  so its change leads; ours is the fallback. Mixing them printed our +1,060,591% (a token hours
  old, measured from launch) beside Jupiter's $0.53.
- Sign-and-send-only wallets are handled (the wallet lands it; base58 of the signature for Solscan).

**The door and the picker** (2026-10-01, asked as "where is the swap button?" and "it can't be
just paste a CA — it must be the whole swap UI with pick / paste"). The map's top bar has **SWAP**
beside BOOST in the map's mint (on a phone a round icon like X and Telegram; the phone bar was
tightened — one 8px gap, 32px circles, the wordmark giving ground last — so it fits from 320px with
BOOST at the edge; it already overflowed at 360px before), and the toolbar has Swap too. `/swap`
with no token opens on the swap itself: the token side says **Select token** and opens a picker —
search by name or paste an address (Jupiter's `/ultra/v1/search` straight from the browser, so it
costs the site no request; an address Jupiter has not indexed yet is still offered, since a coin
minutes old can trade), a one-tap popular row, **the map's own Trending** (the rail's warm list
from `/api/ads`, named and priced by one multi-mint Jupiter search — 100 mints answered 100), and
**the wallet's own tokens** once connected (holdings priced by the same search, sorted by value;
tokens Jupiter does not know and dust under a cent are left out — a public test wallet held 4,045
tokens, nearly all airdropped junk). While nothing is picked, the trending list sits under the
swap too.

**Token art is the token's own URL here, so `img-src` allows `https:` on this page** — our signed
proxy only covers tokens the map has already seen. A third of that art is IPFS, and the gateway is
what fails, not the picture: WIF's icon on `nftstorage.link` redirects to `dweb.link`, which
answered 429 like ipfs.io (one operator, one limiter), while filebase and pinata served it. So dead
or limited gateways are read from filebase, a failed IPFS picture is asked of the next gateway
(`nextSrc`, the server's `altGateways` order), and only then becomes a letter.

**Base, Ethereum and Robinhood Chain go through Relay** (2026-10-01, asked as "it's possible to add
other chains?" and "we need a good tool"). Chosen on measurement: the same trades quoted on all three
candidates — Jupiter best on 3 of 3 Solana trades (a pump.fun AMM coin included, which LI.FI could
not route at all), **Relay best on 4 of 4 EVM trades**, LI.FI 0.07–0.10% behind, which was mostly its
fixed 0.25% fee. Relay is keyless with CORS `*`, and keeps none of the integrator's fee: an
`appFees` entry on each quote (1%, `RELAY_FEE_RECIPIENT`, the operator's own address, never a
request parameter), accruing in USDC, claimed at relay.link/claim-app-fees. A chain row sits at the
top of the panel; links are `/swap?chain=base&token=0x…`.

- **The check before the wallet is stricter on EVM** (`relayOk`), because an EVM transaction can do
  more than a Solana swap: quote for this wallet, these two tokens, this amount, this chain; every
  transaction from this wallet on this chain; an approval only of the token being sold, to Relay's
  own spender, for **no more than this trade** (Relay approves the exact amount; an unlimited one is
  refused); the swap only to **Relay's router, pinned** — `0xb92f…ff4f` for ETH in, `0xccc8…15be`
  for an approved token, read off live quotes and the same on all three chains — carrying exactly
  the ETH being sold. 16 refusal cases in `scripts/swap-page.test.mjs`. If Relay ever moves
  contracts, swaps fail closed with "the price moved", which is the right way to fail.
- **A price before a wallet is quoted for the burn address** (`NOBODY`): Relay simulates the trade
  against its sender, and an empty placeholder fails that simulation; the burn address holds enough
  on Base and Robinhood. Every trade is re-quoted for the signing wallet.
- **On Ethereum, a small trade with our fee attached fails Relay's simulation** (0.01 ETH → PEPE:
  "Final transaction simulation failed" with the fee, fine without; 0.1 ETH fine with it) — the
  fee's own extra step costs more gas than it is worth. So a quote that fails with the fee is asked
  again without it, as the Solana side does when Jupiter refuses the referral account.
- **Wallets are EIP-6963** (MetaMask, Rabby, Coinbase Wallet, Phantom's EVM side announce
  themselves; a lone `window.ethereum` is the fallback), silently reconnected by `eth_accounts`.
  Connecting on another network asks to switch; a wallet that does not know Robinhood Chain is
  offered it through `wallet_addEthereumChain` (its public RPC and Blockscout). Balances and
  decimals come through the wallet's own provider, so the page needs no RPC of ours; decimals for a
  token nobody named come from Relay's index, else from a tiny priced buy whose quote names them.
- **The picker ranks the map's own tokens first on these chains** (`/api/swap/tokens?chain=`, the
  warm Base or Robinhood snapshot, never a build, most traded first, the chain's own money left out):
  Relay's search for PONS on Robinhood Chain listed five clones before the real one, and its index
  does not carry the real one at all — the map's one-survivor-per-ticker rule is exactly the part a
  token search cannot do.
- Verified in a browser with a mock EIP-6963 wallet on a funded public Robinhood address (quotes
  only; the mock recorded transactions instead of sending them): reconnect, switch from Base, add
  Robinhood Chain, quote with the 1% fee, one transaction to the router for exactly 0.005 ETH on
  chain 4663, the Blockscout link; and a sale as approve-exactly-100 then swap, with the button
  walking "Approve (1 of 2) → waiting → Confirm the swap (2 of 2) → Swapping".

**The map and the bot send EVM tokens here too.** The map card's Buy now shows on a contract on
Base, Ethereum or Robinhood Chain (`evmSwap()`), and the bot's EVM buy alerts and pasted-token
replies say Buy to `swapPath()` instead of Uniswap — which earned nothing and had no Robinhood
Chain at all, so a Robinhood group's Buy button used to open a chart.

**Trust and safety on the page itself**: three plain statements under the swap (your keys stay
yours, every transaction checked before you sign, fees up front); the token's address on the
header with one-tap copy, for checking against the project's own; measured chips (Solana's
authorities and holder concentration, a thin pool, a ticker other tokens share, under a day old);
and a **price-impact guard** — at 5% the button turns gold and takes a second, deliberate press,
at 25% it refuses.

**No third-party code runs on the page**, so its policy is the map's plus `connect-src` to
Jupiter's two API hosts and Relay's, and `https:` images (`SWAP_CSP`, served by the Worker like `/embed`'s so
`_headers` merge order never matters). `docs/security.md` has the reasoning. The page has a global
`[hidden]` rule — a display rule beat the attribute twice on the map and once on the first version
of this page.

Verified in a browser with a mock Wallet Standard wallet (the real handshake, a live Jupiter
transaction for a funded public address, execute intercepted so nothing was sent): connect,
balance, quote, sign (624-byte v0 transaction, right account, `solana:mainnet`), success screen,
Jupiter's failure, the wallet's refusal, sell with percentage presets, silent reconnect, and the
phone's no-wallet sheet. **The first real trade has not been made** — a live swap needs a real
wallet and real SOL, which is the operator's to do (0.01 SOL is enough).

## Where the Chart button goes

`chartUrl(t)` routes by the **token**, never by the tab being viewed. Keying off `S.mode` was wrong
twice over:

- On the Trending tab the mode is `trending`, so *every* token on it fell through to the last
  branch — Base and Robinhood contracts included, which have perfectly good DexScreener pages.
- The last branch was a CoinGecko **search**. A search page is not a chart; it is a list of every
  coin sharing three letters, which for a memecoin ticker is reliably the wrong asset.

| token | destination |
|---|---|
| has a Solana mint | `pump.fun/coin/<mint>` |
| has a contract | `dexscreener.com/<chain>/<address>` |
| `stock:` id | `finance.yahoo.com/quote/<sym>` |
| `cg:` id (majors) | `coinpaprika.com/coin/<paprika-id>/` |

Majors go to CoinPaprika because that is the feed they come from, so every one of the 250 has an id
already — more than `src/cgmap.mjs` covers — and CoinGecko answers 403 to anything that is not a
browser. DexScreener accepts a **token** address and redirects to its deepest pair; verified in a
real browser, since it 403s a plain fetch. The remaining fallback is a DexScreener search rather
than a coin directory: it resolves by contract or ticker.

## Ads and boosts are not Solana-only

**The ad rail and the Boost button are never hidden.** Both used to be gated on the source's
`boostable` flag, which is false everywhere except pump.fun — so sold ad inventory was invisible on
four tabs out of five, and the Boost button was missing from exactly the tabs where somebody is
looking at a token they might buy one for. An advertiser paid for a rail most visitors never saw.

**A boost is paid in SOL to a Solana treasury, and nothing about that requires the token to be on
Solana.** The payment rail and the advertised token are independent, so the box takes any contract
address — Solana mint, Base, Ethereum, Robinhood Chain. `resolveAnyToken()` in core.mjs turns one
into a named, priced token: pump.fun first for a Solana mint (it knows graduation state and the
original art), otherwise DexScreener's `/latest/dex/tokens/<address>`, which is chain-agnostic and
says which chain each pair is on. Deepest pool wins. Verified live: POK/solana, MAC/base,
PEPE/ethereum and PONS/robinhood all quote to the same treasury.

What stays per-token is the *boost this bubble* button inside the card, which needs an identifier —
a stock has no contract, so there it is hidden.

**The chain is stamped on the token, never inferred from the address.** Reading it off the address
format guessed "base" for anything EVM, which filed a Robinhood Chain token as Base inside a payment
record. Feeds now set `chain` themselves, and a feed hit that cannot name its own chain is resolved
rather than guessed.

**Two order routes exist and they are not interchangeable.** `/api/bid/order` and
`/api/boost/order` both begin by validating `body.mint`, so a patch aimed at one landed in the
other: the boost route kept the Solana-only check *and* referenced a variable defined in the bid
route, which took boost quotes down entirely. Bids stay Solana-only on purpose — the board ranks
pump.fun tokens and nothing there has been taught to price anything else.

## The console

`src/admin.mjs`. There is no link to it anywhere and **no default path**: it lives at whatever
`ADMIN_PATH` says, and with that or `ADMIN_PASS` unset the whole block does not exist and the URL
404s like any other unknown one. A panel that answers 401 has told an attacker it is there.

The secret path is convenience; the password is the control. It is compared as a SHA-256 digest so
the comparison is fixed-cost whatever the input, arrives as a Bearer header rather than a query
parameter (those reach logs, referrers and history), and is never echoed in a response.

Failed logins are capped at **eight per ten minutes** per IP, counted **in KV**, and only a
*failure* costs an attempt. Both halves of that were wrong on the first pass and both were wrong in
the same direction — punishing the operator and not the attacker:

- Counting *every* request locked the operator out of their own console in seconds, because the
  panel refetches the overview on load and after every change. Eight requests is a few clicks.
- Counting in memory counted **per isolate**, and Cloudflare spreads requests across many: eleven
  wrong passwords in a row all returned 401 and not one was throttled. Meanwhile one person
  clicking from a single browser reliably landed on the same isolate and got locked out.

So the check is: locked-out callers are rejected on a KV read before the password is even examined,
a failure writes a counter, and a success clears it so a typo or two never strands anyone. KV is
eventually consistent, so a fast burst may land a couple of extra guesses; against a budget of
eight that is noise. Verified live — guesses 1-8 return 401 and 9 onward return 429.

Both values are Cloudflare secrets rather than `[vars]`. The repo is private, so committing them
would not publish them to the world — but git history is forever and repos change visibility,
whereas a secret can be rotated in one command without touching a commit.

It shows revenue, traffic, per-feed health, and manages the ad rail, house boosts and pinned
tokens.

**What the operator can do from it now** (asked for as "edit ads, add remove tokens, bubbles, control
size and how long"): ads are edited in place (renaming names the old title in `prevTitle`) and carry
a **show-for** time — `until`, 0 for always — after which `/api/ads` simply stops serving them. Gold
bubbles take any contract (the chain comes from `resolveAnyToken`, not a dropdown), a **size** as
the face will print it (×1.5–×6, turned into spend by `spendForBonus`, the inverse of the one sizing
curve) and a **duration**; `activeBoosts` honours `until` on house bubbles now, and old ones carry
`until` a century out. A **hide list** (KV `hidden`, 30s isolate cache) takes a token off every tab,
the rail and the share cards. **Tap wars** can be reset or pruned per token, and the arena removes a
token nobody tapped for `cfg.idleHours` (default 24, set in the console) — taps halve daily but a
halving never reaches zero, so a 5,000-tap token sat on the tab for a week after its community left.

**What the operator sees about the bot** (2026-10-01, asked as "I should see the list of users we
can mass DM, the mass DM tool there, and which groups added our bot"). The Telegram card lists
**every group that added the bot** — tracking a token, *not set up* (added by an admin who never
ran /setup: the follow-ups worth making), or removed — with Telegram's own title, @username and
member count read live for the first twenty (two calls each, inside the 50 subrequests a free-plan
invocation may make), cached five minutes. Groups that never ran /setup used to leave no trace at
all: the bot said thanks and forgot them; `my_chat_member` now records each join and leave in the
AudienceDO (`g:<id>`, who added it and when). The Mass DM card lists **who is on the list** — the
newest 300 in join order (a `recent` ring kept on each new Start) or everyone by id, 200 a page,
with a filter — and **sends a test to one id** before the list gets it, Unsubscribe button
included. Names and @usernames are kept from 2026-10-01 (people who started earlier gain theirs on
their next message); control and direction-override characters are stripped, a username is kept
only if it is a legal handle, and nothing else about a person is stored.

**Measured 2026-10-01 from the account's KV analytics**: 933 writes on 2026-09-29, 1,661 on
2026-09-30 (and 194,000 reads, past the 100,000 free — the Helius flood). Background jobs alone
spent most of the 1,000: history saved every five minutes by the cron *and* by every isolate, and
every shared feed's snapshot copied to KV on every rebuild. Both are cut — the snapshot copy at
most every fifteen minutes per feed (`KV_SNAP_EVERY`, keyed on the copy's own `ts`, so isolates
coordinate), history on the quarter hours — because the same budget records a paid boost.
Workers Paid is still the real fix.

**KV writes are over the free tier, and have been for a while.** Measured when the console's first
save returned *"KV put() limit exceeded for the day"*: every `shared` source writes its snapshot on
every rebuild (trending ≈1,440/day at a 60s lifetime, base ≈720, majors and robinhood ≈480, the four
flow views ≈288 each), plus history, sweeps and stats — well over 5,000 a day against 1,000. Every
one of those writes is wrapped in "next tick retries", so once the cap hits each day the site stops
saving *silently* — including the `boosts` write that activates a paid boost. Workers Paid ($5/month)
includes a million writes a month; until then, decouple the KV write interval from the TTL. **House boosts are excluded from the revenue figure** — they are the operator's own slot and
counting them would be inventing income. And the rule this project already learned about sweeps
holds here: *where money goes is never a request parameter*, so nothing in the console accepts a
destination address.

**Boosts attach by `addr || mint`, not by `mint`.** A Solana token is its mint; an ERC-20 on Base or
Robinhood Chain has no mint and is its contract address. Indexing on `mint` alone meant a house
boost on an EVM token silently did nothing — and the re-add path, which builds its "already here"
set the same way, saw `{''}` for an EVM feed, judged the boosted token absent, and added a second
copy of it: two gold $MAC bubbles, one of them carrying no data.

## Share cards and the X poster

`/s/<mint>` or `/s/<TICKER>` is a share link. Crawlers get Open Graph tags pointing at
`/api/card`, which returns a PNG built from `src/card.mjs` and rasterised by `src/png.mjs`.
People get a small page with the card and a way through to the map, because an image alone is a
dead end for a visitor.

**PNG, not SVG.** X, Telegram and Discord all decline SVG in link previews. That forces a
rasteriser into the Worker: `@resvg/resvg-wasm`, ~2.4MB, the only real dependency this project has.
It is instantiated lazily, on the first card rather than at startup, and the homepage was measured
before and after at 0.22s to confirm nothing else pays for it. **A Worker has no system fonts** —
Archivo Black is compiled in as bytes via a `[[rules]] type = "Data"` entry. Without it every
string rasterises to nothing at all, silently, and the card still returns 200.

**A window with no measured value gets no card.** `/api/card` 404s and `/s/` redirects to the map.
`pctLabel(null)` returned `+0.00%` on the first pass, because `Number(null)` is 0 — the same
coercion that had just been fixed on the map. Here it would have minted a shareable image asserting
a flat market we never measured, with our domain printed on it.

The poster (`src/xbot.mjs`) is off unless `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN` and
`X_ACCESS_SECRET` are all set; `/api/xbot/status` reports whether it is live without revealing
anything. It posts a link, never an uploaded image, so the card lands in the timeline *and* the
click comes back. OAuth 1.0a signing is split into `baseString()` and `hmacSha1B64()` so each half
is checked against something authoritative — the published example and RFC 2202 — because a wrong
signature returns a bare 401 that names none of the six steps that could be at fault.

Its filters exist for credibility, not data quality: the map still shows everything. pump.fun's top
mover is routinely a token minted minutes ago showing +1452986%, which is a real number that reads
as a scam. Posting those teaches people to scroll past us.

**The band is per asset class**, because "a move worth posting about" is not one number: a memecoin
doing +25% in a day is a Tuesday, a listed company doing +25% is a takeover. The first version
judged everything by the memecoin band and the stocks card 404'd for want of movers — the right
answer to the wrong question.

| class | min mcap | min vol | gain band |
|---|---|---|---|
| pumpfun | $50k | $10k | 25% – 1500% |
| majors | $10M | — | 10% – 500% |
| stocks | $1B | — | 3% – 100% |

Rate: once a day by default (`XBOT_PER_DAY`, max 5), at 15:00 UTC (`XBOT_HOUR`), one week's
cooldown per token. The hour is fixed so the account has a rhythm instead of firing at whatever
minute the first cron after midnight happens to run.

Four post types rotate on the day number, weighted towards the single-coin post because that is the
one a community reposts: `mover` (one token), `board` (top five), `market` (green/red across the
top 250), `stocks`. A thin feed falls through to the next type rather than skipping the day.
`/api/xbot/preview` renders what it would post right now without posting it, so the copy can be
judged before anyone hands it credentials.

**Cashtags by default; @mentions are opt-in and filtered.** pump.fun's `twitter` field is typed in
by whoever minted the coin, so it is an attacker-controlled string — a scam token can name
`@elonmusk` and we would tag him from our own account, next to a price, which reads as vouching for
it. Mentions need `XBOT_MENTIONS=1` *and* a handle that resembles the ticker or the name.
`$FONE` as a cashtag is clickable on X and is how these communities already find posts about
themselves, so the reach is there without the risk. `scripts/xbot.test.mjs` covers this specifically.

The ranked card (`/api/card?kind=board&source=…`, page at `/s/top`) exists because a leaderboard
gives five projects a reason to repost instead of one. It draws through the same `topMovers()` the
poster uses, so what a project sees on the card is what the account would say about it.

**A boosted token that is not in the feed still needs real numbers.** A boost is bought for a small
token, and small is what does not reach pump.fun's top-cap pages, so the paid bubble is re-added
from the boost record. That record holds what was *paid*, not what the token is *doing*, and it
carried a hardcoded `pc: {m5:0,h1:0,h6:0,h24:0}` and `vol: 0` — so the one token the site most wants
people to look at rendered a confident `+0.00%`. DexScreener had it at +1.22% on $27k of volume the
whole time; it was simply never asked. Re-added tokens now go through `enrich()` (cached a minute,
since the re-add happens per request rather than inside the snapshot), and start as null rather than
zero so an upstream miss greys out instead of asserting a flat market.

The bubble label draws `—` for a window with no data. Grey alone did not carry it: a grey bubble
reading `+0.00%` still says the market was flat, and nobody reads a percentage by its colour.

**A bad build must never become the cached answer.** Every upstream here fails by returning
*nothing* rather than by throwing — a 429, a timeout, a shape that moved — so `buildSnapshot`
cannot tell "the feed is down" from "the market is empty", and it caches the result either way.
Two shapes of this reached production within an hour of each other:

- An empty snapshot went into KV during a deploy. Because `shared` sources read KV back as
  authoritative, every isolate then served `tokens: []` for the whole TTL and kept re-serving it —
  the Robinhood map showed one bubble for minutes after the upstream had recovered.
- A pump.fun build returned all 301 tokens with the DexScreener pass failed. Liquidity is what
  decides whether a market cap is backed, so with none of it every bubble scored unbacked, the
  map's own filter hid 291 of them, and a healthy-looking snapshot rendered as **eight bubbles**.

So `snapshot()` now refuses to cache a build that collapsed: zero tokens, under a quarter of the
previous count, or — for sources that enrich — under a quarter of the previous `enriched`. It keeps
the last good data and retries in 20 seconds instead of the full TTL. The KV read is guarded the
same way, since a namespace may still hold an empty snapshot written by an older build.

The lesson generalises past caching: **the count of rows is not a health check.** A feed can be the
right length and still be missing the field the rest of the pipeline depends on.

**`?source=` only worked on `/embed`.** The deep-link handling lived inside `initEmbed()`, so every
share page linking back with `?source=stocks` or `?source=robinhood` quietly landed on pump.fun —
including the ones this project generates itself.

**`enrich()` turned a missing window into zero for as long as it has existed.** DexScreener omits a
window entirely when nothing traded in it — LINK on Robinhood Chain comes back as `{h24:-1.38}`
with no `h1` key at all — and `num(undefined)` is 0, so the map asserted a flat hour on a price
nothing had measured. Invisible on pump.fun, where everything trades every minute; obvious on a
chain full of quiet pairs. Absent is null now, and our own market-cap history still fills what it
legitimately can.

**A test suite that never imports a module cannot tell you the module is broken.** Moving one helper
dropped `export` from `clean` in core.mjs, so `sources.mjs` could not import it — every feed on the
site — and the whole suite passed, because nothing in it imported sources.mjs. `node --check` misses
it too: a missing export is valid syntax and only fails when the graph is linked.
`scripts/imports.test.mjs` now loads every module; `png.mjs` and `api.mjs` are skipped there because
they reach the font and the WASM through wrangler's `[[rules]]`, and `npx wrangler deploy --dry-run`
is what link-checks those.

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

## The Telegram buybot

`src/tgbot.mjs`, `src/solbuy.mjs`, `src/helius.mjs`. A token community adds the bot to its
group, an admin runs `/setup <contract address>`, and every buy is posted into the group in the
format the communities already know from Bobby, Cherry and Major — with the group's own picture
on it, and four buttons: Chart · Bubble · Buy · **Boost**. The bot is distribution: every alert is
seen by every member, carries the site's name, and puts the Boost button one tap from the people
who buy boosts. `?boost=<address>` on the map opens the boost box with the address resolved, so a
group tapping the button is not asked to paste what it already has.

**Off until `TG_BOT_TOKEN` is set, and then on with nothing else.** Without the token the two
webhook routes do not exist (404, like the console). With it, the next cron tick registers the
Telegram webhook itself. The Helius key is read out of `SOLANA_RPC` when that is a Helius URL, so
turning the bot on adds one secret, not two — and rotating the RPC key rotates this as well.

**Nobody is messaged who did not ask.** This is the rule, and it is the product, not a nicety:

- A **group** is stored only after one of *its admins* ran `/setup`. Admin status is checked
  against `getChatMember`, cached five minutes.
- A **user** is stored only after they pressed /start *and* picked something on the opt-in
  keyboard. There is no list of "everyone the bot has seen". A captcha flow that harvests every
  verified member into a DM list was proposed and refused, because Telegram tracks a bot's block
  rate: blast 50k people who signed up to pass a captcha, 20–40% block it in the first hour, the
  bot is restricted, and the buy feed dies in every group at once. The opt-in list is smaller and
  it survives. The console's broadcast tool sends to that list only, counts recipients before it
  will enable Send, and forgets anyone who has blocked the bot.

**A buy is read off balances, not off a parser's label.** `parseBuys()` takes the raw
transaction — Helius `webhookType: raw`, which is `getTransaction`'s shape — and finds the
**signer whose token balance rose while their SOL balance fell.** That one definition covers the
pump.fun curve, PumpSwap, Raydium, Meteora and Jupiter routes without decoding any of them. The
three things it must *not* call a buy, each with a test:

- a **transfer** — tokens moved, only the fee left the receiver;
- an **airdrop** — tokens arrived, the receiver paid nothing;
- the pool side of a **sell** — tokens up, SOL down, *exactly* a buyer's balance signature,
  because the pool did buy them from the seller. The first version reported it. **A pool never
  signs**; requiring the buyer to be a signer is what tells a buy from the other side of a sell.

`newHolder` is read from the pre-balance, not from whether we had seen the wallet before. SOL
spent is net of the network fee when the buyer paid it — the fee is the chain's, not the token's.
Buys under 0.0005 SOL are rent and wrap round-trips, not purchases.

**Zero KV writes per buy.** The free tier allows a thousand writes a day; a busy token does that
many buys before lunch. Config is written at setup, read through a 60s memory cache at alert
time, and a buy touches nothing. Market cap at alert time comes from `resolveAnyToken()` cached
20s per mint. Per group, alerts are capped at 18 a minute (Telegram allows ~20) and the overflow is
**dropped, not queued** — an alert about a buy from three minutes ago is noise, and a queue that
never drains is a memory leak with a delay. Helius retries deliveries it thinks failed, so a
signature is posted once per isolate.

**One Helius webhook, many addresses.** Every tracked token adds its mint *and its deepest pool*
to a single address list, rewritten on each `/setup` and `/stop`. The pool matters: some routers
list only the pool in a swap's accounts, so watching the mint alone misses them. A bonding-curve
token has no pool yet and its mint is in every one of its trades. The webhook id is kept in KV so a
redeploy updates it rather than creating a second one, and an empty list deletes it — Helius
rejects a webhook watching nothing.

**Every string a token controls is escaped before it reaches a caption** — ticker, name, the
group's chosen emoji, every social link. The caption is HTML and it is posted into somebody
else's group. `clean()` strips the brackets server-side and `tgEsc()` escapes what is left; links
are kept only when they are `http(s)`, because a minter's "website" field has been `javascript:`.
`scripts/tgbot.test.mjs` covers all of it, and runs the caption end to end so the shape can be
read in the test output.

**What the first real group taught (2026-09-25).** `/setup` on Shurikane answered *"MCap $4,902 ·
bonding curve ⚠️ helius 530 error code: 1016"*, and was wrong in two of three ways:

- **The Helius host was wrong.** `api.helius-rpc.com` does not resolve (Cloudflare 1016 is origin
  DNS); the webhooks API is `api.helius.xyz`. The RPC is on helius-rpc.com, the REST API is not.
  `ensureWebhook()` now also registers the Helius webhook on the cron when mints are tracked and
  none exists, so a group whose setup failed heals without running `/setup` again.
- **"Bonding curve" on a graduated token.** The pool came from DexScreener only, DexScreener 429s
  the Worker, so no pool — and the label keyed off the pool. The pool now comes from pump.fun's own
  record (`pump_swap_pool`), socials too, DexScreener only fills gaps; the label reads pump.fun's
  `complete` flag.
- **The market cap was right, and DexScreener's was not.** The operator expected DexScreener's
  $354K. The PumpSwap pool held **13 SOL against 745M tokens** — about $2K by its own reserves, so
  selling 1% of supply returns ~$20 — while DexScreener priced it from a stream of dust-sized trades
  at 176× the reserve ratio (its "$3M volume" is the same trades). Checked the method on healthy
  pools before trusting it: reserves, DexScreener and pump.fun agree within ~4% on neet, TripleT,
  JEANPHIL and PAID. pump.fun's `usd_market_cap` stays the bot's figure.

**The bot sets up its own Telegram profile** (`BOT_PROFILE`, `ensureProfile`, run from the cron's
`ensureWebhook`): the "/" command lists for private chats, group members and group admins (Telegram
shows only the most specific scope, so every member command is repeated in the admins' list), the
text of an empty chat ("What can this bot do?", ≤512), the profile line (≤120), the Menu button,
and the admin rights it asks for in groups (what the guard needs) and channels (posting). Applied
once per hash of that object, kept in KV `tg:profile`; edit any text and the next tick re-applies.
Its profile photo (`public/bot-avatar.jpg`, the P bubble) goes up **only on a bot with none** —
Bot API 10.3's `setMyProfilePhoto`, a multipart upload — so a picture set in BotFather is never
overwritten. Nothing has to be done in BotFather. Asked for as "when I enter the bot everything
must be clear": the private chat is now a four-line menu with buttons, Help is one tap down and
edits in place, a pasted token offers Buy and Chart before the shop, and anything typed that is not
a command or an address gets a pointer back instead of silence. `scripts/botux.test.mjs` drives
all of it against a fake Telegram, including that every command in the menu gets an answer.

**Settings are buttons.** `/settings`, the `/setup` reply and `/status` carry a ⚙️ panel —
media, emoji, minimum buy, dollars per emoji, test alert, links, stop — one message edited in place
(`settingsView`, `onSettings`), admins only, callback data `cfg:<what>[:<index>]` with choices as
indexes into fixed lists, never free text. Media is set by replying to the bot's upload prompt
(`MEDIA_PROMPT`, `force_reply` with `selective` and a mention of whoever tapped, so the reply box
does not open for the whole group); the `/media` caption still works. Links stay typed commands —
a button cannot collect a URL.

**The guard: join captcha, welcome, clean joins** (`src/guard.mjs`, the `GroupGuard` Durable
Object, ⚙️ Settings → 🛡 Guard). Asked for so a group running the buybot does not also need
Safeguard. It is Safeguard's *join captcha*, not its portal — their own docs call that mode "not
as secure as a portal, however it can stop spam", and that is the claim here too: a new member is
muted on arrival (`restrictChatMember`, all false) and unmuted by tapping the emoji the message
names, out of eight; two wrong taps or the clock (2 / 5 / 10 min) remove them with a 60-second ban
that lifts itself, so a real person can rejoin. The answer index never travels in a button.
Passing lifts the mute with all permissions true, which Telegram defines as "back to the group's
defaults", not more. The welcome replaces the previous one (the DO returns the id to delete), and
clean joins deletes the "joined"/"left" lines. Joins arrive twice — the service message and a
`chat_member` update, the only signal in groups that hide join messages — so the DO ignores a
repeat inside 90 seconds; `ensureWebhook` re-registers the webhook when `chat_member` is missing
from its `allowed_updates`, because Telegram only delivers it when asked for by name.

**Why a Durable Object, again:** a pending captcha needs a clock (the alarm removes whoever let it
expire) and a raid is a hundred joins a minute, which KV's free writes cannot take. One DO per group
(`idFromName(chatId)`), SQLite-backed like the arena, migration `v2-guard`. **Nobody is stored who
did not stay**: a pending entry lives until it is answered or expires; there is no member list.
Switching the captcha or the cleaner on checks the bot's own rights first (`missingRights`) and
says what is missing — a captcha the bot cannot enforce mutes nobody.

**Latency is measured, not claimed.** Each posted buy logs `{ev:'buy-alert', latencyS}` — block
time to message sent — and `/status` in the console carries the median and p90 of the isolate's
last hundred. Read it with `wrangler tail` before comparing the bot to Bobby.

**Base, Ethereum and Robinhood Chain** (`src/evmbuy.mjs`, the `EvmWatch` Durable Object, one per
chain). `/setup 0x…` finds the chain where the token trades deepest (or the one named after the
address), takes up to four pools priced in ETH/WETH or a dollar stablecoin from DexScreener *once*,
reads `decimals()` and `totalSupply()`, and from then on the chain's watcher polls those pools'
Swap events every 4s (Base, Robinhood) or 12s (Ethereum, one block) with one batched `eth_getLogs`
— no DexScreener at alert time, which matters because DexScreener refuses the Worker. Market cap is
the trade's own price × supply; measured against DexScreener on live buys: $97.95M vs $97.67M,
$28.81M vs $28.78M. The buyer is the transaction's signer (`eth_getTransactionByHash`), because
routers and v4's PoolManager sit between the pool and the wallet. EVM alerts do not claim
"New Holder" — nothing here knows whether the wallet held before.

Five Swap formats, every topic read off a real transaction first: Uniswap v2, Solidly (Aerodrome
classic), Uniswap v3 (also Aerodrome CL, Ramses, "up"), Pancake v3 (also "giga"), and Uniswap v4 —
the PoolManager singleton, pool id in topic 1, Robinhood's at `0x8366…0951` read off the chain.
**The signs differ and that is the trap**: v3 reports the pool's delta, v4 the swapper's (checked
on a real Robinhood swap — −0.0026 ETH equal to the tx value, +114M tokens equal to the transfer),
v2 and Solidly carry In and Out. A transaction that buys and sells the same token is a route
through it and is not posted. Robinhood Chain trades mostly on v4 (14 of 30 sampled pairs), in
native ETH or USDG (6 decimals).

**Robinhood makes a block every 0.1 s**, measured (1,000 blocks in 101 s) — the first guess of
0.25 s made the latency estimate read 45–50 s when delivery was ~5 s. Its public RPC is fresh
(head 1–2 s old) but answers 429 to bursts; the watcher backs off, and `ALCHEMY_KEY` (one key
serves all three chains, as a secret) replaces the public endpoints. The watcher keeps its last
block in memory and saves once a minute, skips ahead rather than posting history after a restart,
and drops any chat whose group no longer follows the token. `/api/tg/status` shows each watcher's
token count, last read and last error.

**Boosts and ads are sold inside the bot too, through the same system.** A private chat with the
bot (`/start`, `/boost`, `/ads`, a pasted contract address, or the ⚡ Boost button on any alert,
which now deep-links to `t.me/<bot>?start=boost_<address>`) shows the three boost tiers and two ad
slots; a tap calls `/api/boost/order` through `ctx.self` — the site's own route, so one order
system, one gold-share cap, one unique-amount match, one sweep — and replies with the exact SOL and
the treasury to copy, and a *Check* button that runs the sweep. Buyers are told when the cron's
sweep finds their payment (`notify` on the order; only a bot-originated order may carry one, or a
web caller could point paid-notices at anyone). Rate limits key on the Telegram user.

Two ad products, `AD_TIERS` in boosts.mjs, prices the operator's to change: **Map ad** (a rail slot,
four at a time, lands in the same `ads` list the console writes) and **Buy-alert ad** (one line
under every buy alert in every group, one at a time, list `alertads`). Full inventory **queues**
rather than refusing (`adSchedule`, up to seven days out), so tomorrow's slot sells today. **The ad
is always the token itself** — ticker, name, and its own page (our `/s/` for Solana, DexScreener for
EVM) — never free text or a typed link, so nobody can buy a phishing line under every alert. While
the alert slot is unsold the line sells itself ("Your token here, under every buy").

Adding ads exposed a real bug: the pending record dropped the order's `kind`, so a bid paid after
its tab closed was swept in as a zero-hour boost and the bid never landed. `addPending` keeps
`kind` now.

**The mass DM — built on the second ask, with the conditions that protect the bot**
(`src/audience.mjs`, the `AudienceDO`, console → Mass DM). The first answer was no (harvesting
group members through a disguised verify, and selling DMs to that list); the operator asked again,
citing Major and similar bots, and it is his product. What was built:

- **Everyone who presses Start is on the list**, and is told so at that Start (`DISCLOSURE`:
  "adds you to pumpbubble updates — new launches, trending tokens and sponsored drops. /stop or 🔕
  any time"). `/stop`, 🔕 on the menu, and the **Unsubscribe button on every mass DM** remove them;
  a blocked or deleted account is forgotten on the next send.
- **Growth comes from 🛡 Guard → Verify in private chat**: a new member's captcha opens in a chat
  with the bot (`t.me/<bot>?start=v_<chat>`), the options are the same pending challenge
  (`peek`), and that Start is what makes them reachable. Telegram gives a bot no other way to DM
  a group member. The group's settings page says what the mode does.
- **The send lives in the Durable Object**, paced at 25 messages per 1.1 s tick by its alarm —
  under Telegram's ~30/s — so it runs to the end with the console closed, resumes by key cursor, and
  never sends one person the same job twice. One send at a time; Stop cancels it.
- **Paid DM blasts ($199, `AD_TIERS.dm`) wait for the operator.** They are bought in the bot's
  shop like any ad, land in KV `dmads` as `review`, and go out only on *Approve & send* in the
  console; *Decline* leaves a refund to the operator. The message is the token and nothing it
  typed, marked "Sponsored", with its chart and bubble buttons.

The risk that remains is the one that was the reason for the first no: a bot whose DMs get reported
is restricted by Telegram, and a restricted bot stops posting buys in every group at once. The
disclosure and the one-tap way out are what keep the block rate down — do not remove them to
"grow faster".

**Smart Buy, the Tap wars head start, and the wallet tracker — the answer to "why us, when there
are many buy bots".** Three things nobody else's bot can do, because they come from the map's own
data (asked for as "we need to give value — help people earn, find big traders to track and copy;
they can't copy them inside the pump.fun app"):

- **🧠 SMART BUY** on a group's alert when the buyer is one of pump.fun's top traders by realized
  profit (`src/smartset.mjs`: the Smart money tab's three boards as a wallet lookup, each wallet at
  its best rank, ten-minute cache): *"@CookerFlips, #3 on pump.fun this week by profit banked"*.
- **📣 TOP CALLER BUY** when the buyer is one of the week's top fifty callers — the KOLs, by the
  Calls tab's own ranking (`topCallers()`, the CallersDO's weekly board, ten-minute cache): *"@Bean,
  #2 caller on pump.fun this week — 63% of their 16 calls hit 2×"*. Asked for as "show if a top
  trader or KOL bought this token". A wallet that is both gets both lines.
- **Tap wars head start**: every token set up with the bot enters the arena with 500 taps, once per
  token ever (`Arena.grant`, server-side, no address limits, decays like any tap) — half of a free
  rail slot, a reason for a project to install this bot rather than another.
- **Wallet tracker** (private chat: 👛 Wallet tracker, 🧠 Follow top traders, `/track WALLET name`,
  `/untrack`, `/wallets`; a pasted address that is no token is offered as a wallet). Followed
  wallets ride the buybot's Helius webhook (`watchAddresses` with the audience); pump.fun's top 300
  join it only while somebody follows them or a channel posts them, re-synced hourly as the boards
  turn over. A swap is read off balances from the wallet's side (`parseWalletSwaps`: it signed, SOL
  native-or-wrapped one way, exactly one token the other; token-for-token routes are left out
  rather than guessed). Buys and sells arrive with **⚡ Copy buy**. Follows live in the AudienceDO
  (`w:<user>`, `f:<wallet>`, `sm:<user>`), ten per person; unsubscribing from the mass DM does not
  touch them, `/stop` or blocking the bot does. Twenty alerts a minute per person at most.
- **The public Smart money channel** (console → Smart money channel): top traders' buys of 0.5 SOL
  or more, posted with Copy buy — the free alpha feed that brings people to the bot. The console
  checks the bot is an admin there before saving.

**What the full-code review of 2026-09-25 fixed** (ten findings, each with a test):
the captcha let a removed member back in unmuted if they rejoined between the 60 s ban and the 90 s
dedupe window (a removal now clears the window); the EVM watcher re-posted up to a minute of buys
after every deploy (it saves its block whenever a poll posted buys); top-trader follows looped over
every follower inside the Helius request and would have sent every add and trim — now entries and
full exits of ≥1 SOL only (`smartSignal`), through the AudienceDO's paced queue (`enqueue`/`drain`),
and only the best 100 (`SMART_WATCH`) ride the webhook, because every one of their transactions is a
billed delivery on the same webhook as every group's buy alerts; the public `/api/tg/status` is
throttled and cached (it asked Telegram and Helius and woke three watchers per hit); the boost quote
looked up existing EVM boosts by the raw pasted address, not the lowercased one; `adSchedule`
counted the console's "until removed" ads as over (a paid Map ad became a fifth slot); the welcome
text used `String.replace` with user text as the replacement (`$'` expanded); removing the bot left
an EVM watcher polling for nobody; the console's four-slot check counted ended and queued paid ads.

**The welcome gift** (`welcomeGold` in boosts.mjs): the first `/setup` for a token turns it gold on
the map for an hour, once per token ever (KV `welcomed`), as a house boost (never revenue), never
over a token already gold, at most five at a time. It is the outreach pitch in one line — "add the
bot and your token is gold on the map for an hour" — built the night the numbers came in: 22 site
views in a week, one group, $0. Distribution, not features, is the bottleneck.

**Our own links, everywhere a user is** (2026-09-26, X added 2026-09-30): X (`X_PROFILE`,
x.com/pumpbubblefun) and the Telegram group (`TG_COMMUNITY`, t.me/pumpbubble) as round buttons
beside BOOST on every screen (on a phone the live pill gives way so BOOST never leaves the edge),
on the bot's Start menu and in the setup reply, and in the footer of every other page and every
share page; share links carry `via=pumpbubblefun` and the pages `twitter:site`, so each post
credits the account; the bot (t.me/pumpbubblebot, Telegram's add-to-group screen asking for the
guard's admin rights) as "🤖 Free buy bot" in the toolbar and "🤖 Free buy alerts for $X in your
Telegram group" on every token's card; the operator's pump.fun invite (`PUMP_JOIN`) on Solana
cards and the Start menu. **The page has no global `[hidden]` rule** — `#card .join{display:block}`
beat the attribute and put the invite on every card, stocks included, until
`#card .join[hidden]{display:none}`. And `scripts/page-refs.test.mjs` now parses every inline
script: a second `const cb` in `openCard` was a SyntaxError that killed the whole page, and the
text-level checks passed it.

**Copy trading and sniping are deep links, not custody — decided, not deferred.** ⚡ Copy buy opens
the same swap as the Buy button (the referral trading bot when `REF_PROVIDER`/`REF_CODE` are set,
our `/swap` page otherwise). Executing trades for users means holding their keys and money in a Worker; one
bug or breach empties every user at once, and the liability is the operator's. The trading bots
that already do sniping and auto-copy are the execution layer, and they pay referral for the flow.

**The alert has two styles, and Bubble is the default** (2026-10-01, asked as "make the buybot
cooler — instead of emojis show something else"). *Bubble*: the size of the buy by name — 🦐
SHRIMP under $100, 🐟 FISH, 🐬 DOLPHIN from $500, 🦈 SHARK from $2,500, 🐋 WHALE from $10,000 — and
a ten-step meter on a log scale (`buyMeter`: $10 fills 2, $1,000 fills 6, $100,000 all 10), the
numbers in a Telegram quote block, and the token's place on the Trending tab when it has one
("#4 trending on the bubble map", `ctx.mapRank`, from what the isolate already holds — Solana
alerts only, since EVM alerts are posted from the chain watchers). A row of one emoji per $20 runs
off the screen on a whale and says nothing on a shrimp, and every buy bot prints it. *Classic* is
that format, kept one tap away in ⚙️ Settings → 🎨 Style for groups that want what they know.
Both carry the same facts, the same escaped strings and the same buttons.

**Standard format first; bubble posts later.** The buy alert's facts are deliberately the ones the
communities compare against, because that is what they judge a buybot by. What is *ours* — rank
changes, milestones, a daily map with their token lit, the Bubble Index — goes out as separate
posts so the buy feed stays clean and the bubble posts read as events. Not built yet.

Solana, Base, Ethereum and Robinhood Chain — see above for how the EVM chains are read.

## Modes

`?mode=graduated` (default) and `?mode=bonding`, cached separately, never mixed — a 24h axis means
nothing to a token forty minutes old.

**Bonding is sorted by `last_trade_timestamp`, not market cap.** Ranking live curves by size
surfaces abandoned ones: by mcap the median age was 104 days with almost nothing trading; by last
trade it is ~12 minutes with everything on screen traded inside the last minute. pump.fun's
`complete=false` parameter is what splits the two feeds.
