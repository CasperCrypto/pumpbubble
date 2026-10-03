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
