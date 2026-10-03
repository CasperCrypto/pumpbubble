/* ==========================================================================
   pumpbubble.fun — Insiders: what politicians and CEOs buy and sell

   Three free public sources, one table (the Insiders tab):

   | who                              | source                                   | how fresh                   | amounts          |
   |----------------------------------|------------------------------------------|-----------------------------|------------------|
   | Congress, House and Senate       | Bargo's free API over the STOCK Act      | filed up to 45 days after   | ranges           |
   |                                  | filings (House Clerk, Senate eFD)        | the trade, by law           |                  |
   | Trump and ~40 cabinet officials  | Open Cabinet's parse of the OGE 278-T    | weeks late, in batches      | ranges           |
   |                                  | reports (github.com/tbrown034/open-      | (73% of Trump's are filed   |                  |
   |                                  | cabinet, MIT; the filings are public     | late)                       |                  |
   |                                  | domain, 17 U.S.C. 105)                   |                             |                  |
   | CEOs, directors and 10% owners   | SEC Form 4, from EDGAR                   | within two business days    | exact, and what  |
   | of the companies in ISSUERS      |                                          |                             | they hold after  |

   The rules that come with the data, each one checked on 2026-10-03:
   - **Bargo**: free with "a visible, above-the-fold credit linking back" to
     bargo.ai wherever the data is shown, and "redistributing the raw records
     is not allowed" — the tab carries the credit and offers no download.
     Keyless is 30 calls a day per IP, 100 rows a call; BARGO_KEY (a free key,
     sent as a Bearer token) raises it to 100.
   - **SEC**: a declared User-Agent and no more than ten requests a second.
     This asks a few a minute.
   - **Congress reports**: federal law bars using them for a commercial
     purpose other than news media publishing to the public (5 U.S.C. 13107),
     so the table is free to view and nothing paid hangs off it.

   One Durable Object (InsidersDO, worker/index.js) reads all of it on its own
   clock, a little each minute: the free plan's limits are per invocation, and
   a Durable Object's 30 s of CPU is what lets it read Trump's 15 MB file at
   all. Pure functions here; every fetch is passed in, so the test
   (scripts/insiders.test.mjs) runs without a network.
   ========================================================================== */

export const SEC_UA = 'pumpbubble.fun insiders table (+https://pumpbubble.fun)';
export const BARGO = 'https://www.bargo.ai/free-apis/congress/v1';
export const OC = 'https://raw.githubusercontent.com/tbrown034/open-cabinet/main';

/* Companies whose insiders are followed, by SEC CIK — every one read off the
   SEC's own company_tickers.json on 2026-10-03, none typed from memory. The
   household names, then the crypto-adjacent ones this site's visitors own. */
export const ISSUERS = [
  { t: 'TSLA', cik: 1318605, co: 'Tesla' },
  { t: 'SPCX', cik: 1181412, co: 'SpaceX' },
  { t: 'NVDA', cik: 1045810, co: 'Nvidia' },
  { t: 'META', cik: 1326801, co: 'Meta' },
  { t: 'AMZN', cik: 1018724, co: 'Amazon' },
  { t: 'AAPL', cik: 320193, co: 'Apple' },
  { t: 'MSFT', cik: 789019, co: 'Microsoft' },
  { t: 'GOOGL', cik: 1652044, co: 'Alphabet' },
  { t: 'ORCL', cik: 1341439, co: 'Oracle' },
  { t: 'AVGO', cik: 1730168, co: 'Broadcom' },
  { t: 'AMD', cik: 2488, co: 'AMD' },
  { t: 'PLTR', cik: 1321655, co: 'Palantir' },
  { t: 'NFLX', cik: 1065280, co: 'Netflix' },
  { t: 'CRM', cik: 1108524, co: 'Salesforce' },
  { t: 'DELL', cik: 1571996, co: 'Dell' },
  { t: 'JPM', cik: 19617, co: 'JPMorgan' },
  { t: 'BRK', cik: 1067983, co: 'Berkshire Hathaway' },
  { t: 'MSTR', cik: 1050446, co: 'Strategy' },
  { t: 'COIN', cik: 1679788, co: 'Coinbase' },
  { t: 'HOOD', cik: 1783879, co: 'Robinhood' },
  { t: 'XYZ', cik: 1512673, co: 'Block' },
  { t: 'CRCL', cik: 1876042, co: 'Circle' },
  { t: 'GLXY', cik: 1859392, co: 'Galaxy' },
  { t: 'BMNR', cik: 1829311, co: 'BitMine' },
  { t: 'SBET', cik: 1981535, co: 'SharpLink' },
  { t: 'DJT', cik: 1849635, co: 'Trump Media' },
  { t: 'GME', cik: 1326380, co: 'GameStop' },
];

const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const day = s => { const m = String(s || '').match(/\d{4}-\d{2}-\d{2}/); return m ? m[0] : ''; };
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const unent = s => String(s || '').replace(/&(amp|lt|gt|quot|apos|#39);/g, (m, k) => ENT[k]);
/* Text that reaches the page: no markup, no control characters, bounded. The
   page escapes everything again; this is so a hostile filing cannot even try. */
const text = (s, n = 80) => unent(s).replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const okUrl = u => /^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? String(u) : '';
const tick = s => { const v = String(s || '').trim().toUpperCase(); return /^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(v) ? v : ''; };

/* Days from the trade to the filing — the number that says how stale a
   "politician bought" headline really is. */
export function daysLate(traded, filed) {
  if (!traded || !filed) return null;
  const d = Math.round((Date.parse(filed) - Date.parse(traded)) / 864e5);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/* "$1,001 - $15,000", "$1,001-$15,000", "Over $50,000,000" → [low, high];
   high is 0 when the band is open-ended. */
export function amountRange(s) {
  const v = (String(s || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
  if (v.length === 1 && /over|more than|\+/i.test(s)) return [v[0], 0];
  if (v.length >= 2) return [v[0], v[1]];
  if (v.length === 1) return [v[0], v[0]];
  return [0, 0];
}

const caps = s => s.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;
const ENTITY = /\b(inc|llc|l\.?p\.?|lp|ltd|trust|corp|corporation|co|company|fund|funds|holdings?|capital|partners|group|foundation|bank|n\.?a\.?|plc|s\.?a\.?|ag|gmbh|management|advisors?|investments?)\b\.?/i;
/* The SEC writes a person "Last First Middle", often in capitals: MUSK ELON
   is Elon Musk, HUANG JEN HSUN is Jen Hsun Huang, SMITH JOHN A JR is John A
   Smith Jr. Companies, trusts and funds are left in their own order. */
export function personName(raw) {
  const s = text(raw, 120);
  if (!s) return '';
  const nice = s === s.toUpperCase() ? caps(s) : s;
  if (ENTITY.test(s)) return nice;
  const parts = nice.split(' ');
  if (parts.length < 2) return nice;
  const [last, ...rest] = parts;
  const suf = rest.length > 1 && SUFFIX.test(rest[rest.length - 1]) ? ' ' + rest.pop() : '';
  return rest.join(' ') + ' ' + last + suf;
}

/* "Trump, Donald J." → "Donald J. Trump" (Open Cabinet's spelling). */
export function commaName(s) {
  const v = text(s, 120);
  const m = v.match(/^([^,]+),\s*(.+)$/);
  return m ? m[2].trim() + ' ' + m[1].trim() : v;
}

/* ============================================================== Congress */

/* One Bargo row. Its types are purchase, sale, sale_partial, sale_full and
   exchange; an exchange is neither side and is left out. */
export function fromBargo(t, i = 0) {
  if (!t || !t.member) return null;
  const ty = String(t.type || '').toLowerCase();
  const side = /^(purchase|buy)/.test(ty) ? 'buy' : /^(sale|sell)/.test(ty) ? 'sell' : '';
  if (!side) return null;
  const perf = t.perf_pct === null || t.perf_pct === undefined || !Number.isFinite(+t.perf_pct) ? null : +(+t.perf_pct).toFixed(2);
  return {
    id: 'c:' + i + ':' + text(t.member_slug || t.member, 40) + ':' + tick(t.ticker) + ':' + day(t.transaction_date),
    src: 'congress', who: text(t.member, 60),
    role: (String(t.chamber || '').toLowerCase() === 'senate' ? 'Senate' : 'House') + (t.state ? ' · ' + text(t.state, 6) : ''),
    side, ticker: tick(t.ticker), asset: text(t.asset, 80),
    lo: num(t.amount_low), hi: num(t.amount_high), usd: 0,
    traded: day(t.transaction_date), filed: day(t.disclosure_date), perf,
    link: okUrl(t.filing_portal),
  };
}

/* ============================================================ White House */

/* A small CSV reader: quoted fields, doubled quotes, CRLF. Enough for Open
   Cabinet's officials-summary.csv, which is the only CSV read here. */
export function parseCsv(src) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = String(src || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head = [], ...body] = rows;
  return body.filter(r => r.length >= head.length - 1 && r.some(Boolean))
    .map(r => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] === undefined ? '' : r[i]])));
}

/* Who is in Open Cabinet's index, and when each last filed — the change in
   that date is what says an official's file is worth reading again. People
   who have left office stay listed with `departed`. */
export function officialsFrom(csv) {
  return parseCsv(csv).map(r => ({
    slug: /^[a-z0-9-]{2,60}$/.test(r.slug || '') ? r.slug : '',
    name: commaName(r.name), title: text(r.title, 60), agency: text(r.agency, 60),
    last: day(r.most_recent_oge_filing_date), departed: day(r.departed_date),
    n: num(r.transaction_count), est: num(r.estimated_total_value),
  })).filter(o => o.slug && o.name);
}

/* The newest trades in one official's file without parsing all of it: the
   file is up to 15 MB of pretty-printed JSON, and every trade is an object
   at most one level deep (the newer ones carry a `read` object naming the
   parser that read them — the first version of this matched flat objects
   only and silently dropped every trade after June 2026). A cheap look at
   its date skips the old ones before any JSON.parse; annual-report rows are
   a year of history rather than news and are left out; a trade listed twice
   (the file repeats its latest batch) counts once. */
export function recentTrades(src, { since = '', max = 60 } = {}) {
  const out = [], seen = new Set();
  const re = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[0];
    if (!/"type"\s*:/.test(raw)) continue;
    const d = (raw.match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/) || [])[1];
    if (!d || (since && d < since) || /annual/i.test((raw.match(/"sourceKind"\s*:\s*"([^"]*)"/) || [])[1] || '')) continue;
    let t;
    try { t = JSON.parse(raw); } catch { continue; }
    const key = [t.description, t.type, t.date, t.amount, t.sourcePage, t.sourceRow].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, max);
}

/* A short, stable fingerprint for a row id. */
export function fp(s) {
  let h = 0x811c9dc5;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/* One Open Cabinet trade as a row. The id is built from what the trade says,
   plus its place in the list: newer rows carry no page or row number, and
   one account can buy the same bond twice on the same day. */
export function fromCabinet(t, off, i = 0) {
  if (!t || !off) return null;
  const side = /purchase|buy/i.test(t.type || '') ? 'buy' : /sale|sell/i.test(t.type || '') ? 'sell' : '';
  if (!side) return null;
  const [lo, hi] = amountRange(t.amount);
  return {
    id: 'w:' + off.slug + ':' + day(t.date) + ':' + side + ':' + fp([t.description, t.amount, t.sourceUrl, t.sourcePage, t.sourceRow, i].join('|')),
    src: 'whitehouse', who: off.name, role: off.title, side,
    ticker: tick(t.ticker), asset: text(t.description, 80),
    lo, hi, usd: 0, traded: day(t.date), filed: off.last || '',
    late: t.lateFilingFlag === true, link: okUrl(t.sourceUrl),
  };
}

/* =================================================================== SEC */

/* An issuer's latest insider filings, from EDGAR's company feed with
   owner=only. Without it, `type=4` is a prefix match: JPMorgan's newest
   "type 4" filings on 2026-10-02 were all 424B2 prospectuses. */
export const form4Feed = cik => 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK='
  + String(cik).padStart(10, '0') + '&type=4&dateb=&owner=only&count=20&output=atom';

export function form4Entries(atom) {
  const out = [];
  for (const m of String(atom || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const pick = k => ((e.match(new RegExp('<' + k + '>([^<]*)<')) || [])[1] || '').trim();
    const type = pick('filing-type'), acc = pick('accession-number');
    if (!/^4(\/A)?$/.test(type) || !/^\d{10}-\d{2}-\d{6}$/.test(acc)) continue;
    out.push({ acc, date: day(pick('filing-date')), href: okUrl(unent(pick('filing-href'))), amended: type === '4/A' });
  }
  return out;
}

/* The filing's full text sits beside its index page; the ownership XML is
   inside it. One request per filing instead of an index and a document. */
export const form4Text = href => {
  const m = String(href || '').match(/^(https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/)(\d{10}-\d{2}-\d{6})-index\.html?$/);
  return m ? m[1] + m[2] + '.txt' : '';
};

const val = (block, name) => {
  const m = String(block || '').match(new RegExp('<' + name + '>\\s*(?:<value>)?\\s*([^<]*)', 'i'));
  return m ? unent(m[1]).trim() : '';
};
const flag = v => /^(1|true)$/i.test(String(v || '').trim());

/* A Form 4, read with patterns rather than an XML parser (a Worker has none,
   and the schema is fixed): the issuer, the first reporting owner, and every
   non-derivative line — date, code, shares, price, acquired or disposed, and
   what the owner holds after it. Derivative lines (options) are not trades
   anyone would call buying or selling and are left out. */
export function parseForm4(src) {
  const doc = (String(src || '').match(/<ownershipDocument>[\s\S]*?<\/ownershipDocument>/i) || [''])[0];
  if (!doc) return null;
  const owner = (doc.match(/<reportingOwner>[\s\S]*?<\/reportingOwner>/i) || [''])[0];
  const rel = (owner.match(/<reportingOwnerRelationship>[\s\S]*?<\/reportingOwnerRelationship>/i) || [''])[0];
  const lines = [];
  for (const m of doc.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)) {
    const b = m[1];
    lines.push({
      date: day(val(b, 'transactionDate')), code: val(b, 'transactionCode').toUpperCase(),
      shares: num(val(b, 'transactionShares')), price: num(val(b, 'transactionPricePerShare')),
      ad: val(b, 'transactionAcquiredDisposedCode').toUpperCase(),
      after: num(val(b, 'sharesOwnedFollowingTransaction')),
      direct: val(b, 'directOrIndirectOwnership').toUpperCase() !== 'I',
    });
  }
  return {
    issuer: text(val(doc, 'issuerName'), 80), ticker: tick(val(doc, 'issuerTradingSymbol')),
    owner: val(owner, 'rptOwnerName'),
    director: flag(val(rel, 'isDirector')), officer: flag(val(rel, 'isOfficer')),
    tenPct: flag(val(rel, 'isTenPercentOwner')), title: text(val(rel, 'officerTitle'), 60),
    plan: flag(val(doc, 'aff10b5One')),
    lines,
  };
}

const roleOf = (f, co) => ((f.title || (f.director ? 'Director' : f.tenPct ? '10% owner' : 'Insider')) + ', ' + co).slice(0, 90);

/* A Form 4 as table rows: open-market purchases (code P) and sales (S) only —
   grants, option exercises, tax withholding and gifts are paperwork, not a
   view on the stock. One row per side per filing, the lines summed: a CEO's
   planned sale is often forty fills at forty prices. `after` is what the
   owner holds directly once the last of them settled, and `afterUsd` that at
   the average price. `plan` marks a pre-scheduled (10b5-1) sale, which says
   less than one somebody chose to make. */
export function fromForm4(f, filing, issuer = {}) {
  if (!f || !filing) return [];
  const co = issuer.co || f.issuer;
  const out = [];
  for (const [side, code] of [['buy', 'P'], ['sell', 'S']]) {
    const ls = f.lines.filter(l => l.code === code && l.shares > 0);
    if (!ls.length) continue;
    const shares = ls.reduce((s, l) => s + l.shares, 0);
    const usd = ls.reduce((s, l) => s + l.shares * l.price, 0);
    const price = shares ? usd / shares : 0;
    const last = [...ls].reverse().find(l => l.direct) || ls[ls.length - 1];
    out.push({
      id: 'f:' + filing.acc + ':' + side, src: 'ceo',
      who: personName(f.owner), role: roleOf(f, co), side,
      ticker: f.ticker || tick(issuer.t), asset: text(co, 80),
      lo: 0, hi: 0, usd: Math.round(usd), shares: Math.round(shares), price: +price.toFixed(2),
      after: Math.round(last.after), afterUsd: Math.round(last.after * price),
      traded: ls.map(l => l.date).filter(Boolean).sort().pop() || '', filed: filing.date,
      plan: !!f.plan, link: filing.href,
    });
  }
  return out;
}

/* ================================================================= table */

/* Every source's rows as one list: newest filing first, then newest trade.
   The filing date leads because that is when anyone could have known. */
export function mergeRows(...lists) {
  const seen = new Set(), out = [];
  for (const r of lists.flat()) {
    if (!r || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out.sort((a, b) => (b.filed || '').localeCompare(a.filed || '') || (b.traded || '').localeCompare(a.traded || ''));
}
