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
| Bets | 24h volume wagered | `change_1d` | `change_7d` |

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

**Bets** is the third flow view: prediction markets and on-chain casinos, sized by 24h volume
wagered, from the same two responses. It was asked for as *"casinos — Stake, Shuffle, BC.Game"*,
and **none of those can be on it**: they are off-chain companies that accept crypto and publish
nothing. Not in DefiLlama under any name (the one "Stake" hit is Binance's staked ETH), no
volume, no fees; the only proxies are paid (labelled hot-wallet flows, web traffic), and a map of
casino *tokens* would omit Stake, which has none and is the largest. A map missing its biggest
player by construction is lying by omission, so that version was not built. What is published is
where the betting money actually is — Kalshi ~$420M/day and Polymarket ~$150M against $80K for the
biggest on-chain casino — and that is the tab. Sized by **volume** because that is how a venue's
size is stated anywhere (handle, not revenue); the house take rides along in the card, joined from
the fees overview by slug, and is a dash where DefiLlama has no adapter. Same $1,000 floor as
launchpads. `?source=gamble` and `?source=casinos` resolve to it.

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
tokens. **House boosts are excluded from the revenue figure** — they are the operator's own slot and
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

**Standard format first; bubble posts later.** The buy alert is deliberately the format the
communities compare against, because that is what they judge a buybot by. What is *ours* — rank
changes, milestones, a daily map with their token lit, the Bubble Index — goes out as separate
posts so the buy feed stays clean and the bubble posts read as events. Not built yet.

Solana only. The address box accepts any chain (`isCA`) and says so plainly when it is not Solana;
Base and Robinhood Chain need an EVM event source, which is either a provider's webhook or a
Durable Object holding a websocket.

## Modes

`?mode=graduated` (default) and `?mode=bonding`, cached separately, never mixed — a 24h axis means
nothing to a token forty minutes old.

**Bonding is sorted by `last_trade_timestamp`, not market cap.** Ranking live curves by size
surfaces abandoned ones: by mcap the median age was 104 days with almost nothing trading; by last
trade it is ~12 minutes with everything on screen traded inside the last minute. pump.fun's
`complete=false` parameter is what splits the two feeds.
