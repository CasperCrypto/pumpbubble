# Data sources

Where the site's data comes from, and the terms that come with each source. Credits live here
rather than on the pages: the operator wants the main UI clean (2026-10-03), so a source whose
free terms require an on-page credit is not used.

## Insiders tab (`src/insiders.mjs`)

| Data | Source | Terms, as read on 2026-10-03 |
|---|---|---|
| Congress trades (House and Senate) | [CongressInvests API](https://congressinvests.com/), built from the [House Clerk](https://disclosures-clerk.house.gov/FinancialDisclosure) and [Senate eFD](https://efdsearch.senate.gov/) Periodic Transaction Reports | 100 calls a day keyless, no attribution asked; "for informational and research purposes"; no use of the records for commercial solicitation or advertising |
| Trump and ~40 cabinet officials' trades | [Open Cabinet](https://open-cabinet.org/) ([GitHub](https://github.com/tbrown034/open-cabinet), MIT), parsed from the [Office of Government Ethics](https://www.oge.gov/)' OGE 278-T reports | the filings are US government works, no copyright (17 U.S.C. 105); the code is MIT |
| Company insiders' trades and stakes | [SEC EDGAR](https://www.sec.gov/edgar/search/), Form 4 | public domain; a declared User-Agent and at most 10 requests a second ([fair access](https://www.sec.gov/os/accessing-edgar-data)) |
| Company CIK numbers | the SEC's [company_tickers.json](https://www.sec.gov/files/company_tickers.json) | public domain |
| Stock prices (stakes now, moves since a trade) | Yahoo Finance's chart endpoint, as `src/stockwin.mjs` already uses | keyless |

**The law on Congress reports**: financial disclosure reports may not be used for a commercial
purpose other than by news and communications media for dissemination to the general public
(5 U.S.C. 13107(c)). The Insiders tab is free to view and nothing paid is attached to it — keep it
that way.

**Not used, and why**: Bargo's free Congress API (its terms require a visible, above-the-fold credit
link wherever the data is shown, and it answered the Worker 429 on its first call); Quiver Quant and
Unusual Whales (they sell this data, and copying their pages breaks their terms); OpenInsider and
SECForm4 (front-ends over the same SEC filings, read here directly); the House Clerk's PTR PDFs
directly (they are encrypted PDFs with CID fonts — possible later, not needed while the API works).

## Calls tab: KOLs (`src/kols.mjs`)

| Data | Source | Notes, as read on 2026-10-11 |
|---|---|---|
| Callout rewards per caller (USDC paid, payouts, last paid) | pump.fun's public payout board, `frontend-api-v3.pump.fun/payouts/leaderboard` (top 500, `period` 1d / 1w / 1m or all-time) | keyless, what pump.fun shows on its own rewards page; 30 requests a minute |
| Followers, X handle | pump.fun's public profile, `…/users/<wallet>` | keyless; the same profile pump.fun.com/profile shows |
| A caller's last 100 calls (market cap at the call, peak, now) | `…/callout/list/<wallet>?limit=100` | keyless; 60 requests a minute; read at most every six hours per KOL |

Nothing is stored that pump.fun does not publish itself; the medians, averages and "hold now" are
computed here from those calls.

## Cards tab (`src/cards.mjs`) — switched off

| Data | Source | Terms, as read on 2026-10-22 |
|---|---|---|
| Gacha machines: price, odds, stock, expected value, instant-buyback share | [Collector Crypt](https://docs.collectorcrypt.com/gacha/api) `gacha.collectorcrypt.com/api/machines` | see below |
| Pulls (card, insured value, machine, buyer, storefront) and top-tier pulls | Collector Crypt `…/api/getAllWinners?count=200` (and `&epic=true`) | see below |
| Machine art | Collector Crypt's own images (gacha site and its Vercel blob store), through our image proxy | Collector Crypt's |
| Card photos | the resized copy on Helius's image CDN (`cdn.helius-rpc.com/cdn-cgi/image/width=160,…`) that Collector Crypt's API carries as `cdn_uri`; full size from Collector Crypt's CloudFront as the fallback | the photos are Collector Crypt's |

**Why it is off (`CARDS_TAB = "off"`)**: Collector Crypt's [Terms of Service](https://collectorcrypt.com/terms-of-service)
(revised 2026-06-09) cover its "application programming interfaces" and grant a licence to the
content "solely for User's personal use" unless the company expressly authorises use "for User's own
commercial purposes". They also bar using "any robot, spider, or other automatic device … including
monitoring or copying" and commercially exploiting content displayed on the service. The endpoints
are documented publicly, and the company posts "Our APIs are open. Come chat with our team about
hosting our Gachas on your site". That reads as willing, but it is not written permission.
**Turn it on only after Collector Crypt says yes in writing**: being asked 2026-10-22, alongside the
partner API key. Card art is of third-party trading cards (Pokémon, One Piece, sports). The tab is
called "Cards" and uses no franchise logos.

## Compute tab (`src/compute.mjs`)

| Data | Source | Terms, as read on 2026-10-07 |
|---|---|---|
| GPU rental price per hour | [Akash](https://akash.network/pricing/gpus/) console API, `console-api.akash.network/v1/gpu-prices` — providers' own bids on the Akash chain, weighted by GPUs on offer | keyless; the console is open source; no reuse restriction found |
| Compute tokens | CoinPaprika, as the Crypto tab | keyless free tier |
| Compute companies | Nasdaq's screener, as the Stocks tab | keyless |
| Token logos | the projects' own logos, from CoinGecko's image host, through our image proxy | the marks are the projects' |

**Not used, and why**: Vast.ai (its terms forbid its prices in "any index, benchmark, pricing index,
price-comparison database"); RunPod (its terms forbid access "through automated or non-human
means"); Ornn's index, OCPI (its free tier may not be displayed publicly without a signed agreement
— ask them); gpurentalprices.com, FastGPU and gpu.ai (CC BY 4.0 — a visible credit, which the main
UI does not carry); Silicon Data and CME settlement prices (licensed); Kalshi's GPU markets (no
trading to read a price from).

## Launch Kit (`src/launch.mjs`)

| Data / service | Source | Terms, as read on 2026-10-24 |
|---|---|---|
| pump.fun create transactions | [PumpPortal Local Transaction API](https://pumpportal.fun/creation) (`/api/trade-local`) | keyless; creation free, 0.5% on the dev buy (their fee page) |
| Simulation, sending, confirmation | Solana JSON-RPC (Alchemy when `ALCHEMY_KEY` is set) | the RPC provider's terms |
| Metadata and images | stored by us at `/m/<id>`, or [Pinata](https://pinata.cloud) when `PINATA_JWT` is set | ours / Pinata's free plan |

## Compute tab → Map (`src/computemap.mjs`, `public/compute-map.js`)

The map carries one small line of sources at the bottom of its panel — the operator approved that on
2026-10-18 ("small source text at bottom"), which is what lets the CC BY sources below be used.

| Data | Source | Terms, as read on 2026-10-19 |
|---|---|---|
| GPU providers, positions, GPUs, models | [Akash](https://akash.network/) console API, `console-api.akash.network/v1/providers` (positions are its IP geolocation) | keyless; no reuse restriction found |
| Industrial electricity, Europe | [Eurostat nrg_pc_205](https://ec.europa.eu/eurostat/databrowser/view/nrg_pc_205/default/table), 70–150 GWh/year, excl. VAT | reuse with the source acknowledged |
| Industrial electricity, US states | [U.S. EIA, Electric Power Monthly, table 5.6.B](https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_b) | US government work, public domain |
| Euro → dollar | [ECB reference rates](https://data.ecb.europa.eu/) (monthly averages) | free reuse with the source acknowledged |
| Wholesale power, JP KR IN AU BR SG CH | [Global Day-Ahead Electricity Price Dataset](https://zenodo.org/records/16284828) (Zenodo, 2025) | CC BY 4.0 |
| Grid carbon intensity, low-carbon share | [Ember](https://ember-energy.org/) via [Our World in Data](https://ourworldindata.org/electricity-mix) | CC BY 4.0 |
| Published tariffs: China (30 provinces), South Korea, Québec, Ethiopia, Paraguay | each utility's or regulator's own figure, read where `scripts/tariffs.mjs` links it (China Briefing's compilation of the provincial schedules; KEPCO's SEC filing; Hydro-Québec's 2026 filing as reported; Ethiopian Electric Power's miner tariff as reported; ANDE's 220 kV tariff as reported) | facts, each with its source |
| GPU utilization by model | Akash console API, `/v1/gpu-breakdown` | keyless |
| Bitcoin reward, price, hashrate | [mempool.space](https://mempool.space/docs/api) public API | free, keyless |
| Miner specs (TH/s, J/TH) | Bitmain's published specifications for the Antminer S21 family | facts |
| Country outlines | [Natural Earth](https://www.naturalearthdata.com/) 1:110m via world-atlas 2.0.2 | public domain (world-atlas: ISC) |
| Country codes (build time only) | [i18n-iso-countries](https://www.npmjs.com/package/i18n-iso-countries) code table | MIT |
| Cloud regions | AWS, Google Cloud and Azure's own region lists | facts, compiled by hand |
| AI megaprojects | company announcements and trackers, linked per project in `src/datacenters.mjs` | facts, each with its source |

**Not used, and why**: the IEA's End-Use Prices (~150 countries — the only global industrial price
set, and sold under licence); GlobalPetrolPrices (its data is reported as CC BY-NC-ND — not for a site
that sells ads); Climatescope (it says "open data" and "All Rights Reserved" on the same page);
World Bank Doing Business electricity prices (CC BY, but 2019 — before the energy crisis, so wrong
today); from the Zenodo set, Chile (unit not confirmed), Ontario (HOEP leaves out the Global
Adjustment) and Great Britain (stops in 2020).
