/* ==========================================================================
   pumpbubble.fun — Insiders: what politicians and CEOs buy and sell

   Three free public sources, one table (the Insiders tab):

   | who                              | source                                   | how fresh                   | amounts          |
   |----------------------------------|------------------------------------------|-----------------------------|------------------|
   | Congress, House and Senate       | CongressInvests' free API over the STOCK | filed up to 45 days after   | ranges           |
   |                                  | Act filings (House Clerk, Senate eFD)    | the trade, by law           |                  |
   | Trump and ~40 cabinet officials  | Open Cabinet's parse of the OGE 278-T    | weeks late, in batches      | ranges           |
   |                                  | reports (github.com/tbrown034/open-      | (73% of Trump's are filed   |                  |
   |                                  | cabinet, MIT; the filings are public     | late)                       |                  |
   |                                  | domain, 17 U.S.C. 105)                   |                             |                  |
   | CEOs, directors and 10% owners   | SEC Form 4, from EDGAR                   | within two business days    | exact, and what  |
   | of the companies in ISSUERS      |                                          |                             | they hold after  |

   The rules that come with the data, each one checked on 2026-10-03:
   - **CongressInvests**: 100 calls a day keyless, no attribution asked;
     "for informational and research purposes", and no use of the records
     for commercial solicitation or advertising — the table informs, and
     nothing is sold off it. Bargo was the first Congress source and was
     dropped on 2026-10-03: its free terms require a visible credit link on
     the page, the operator wants the page clean, and from the Worker it
     answered 429 on the first call anyway. Sources are listed in
     docs/sources.md, not on the page.
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
/* CongressInvests: the House Clerk's and the Senate eFD's trade reports,
   parsed, refreshed every six hours; up to 500 rows a call. */
export const CONGRESS = 'https://congressinfor-production.up.railway.app/trades?limit=500';
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
  { t: 'BRK', cik: 1067983, co: 'Berkshire Hathaway', yh: '' },
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
  { t: 'MARA', cik: 1507605, co: 'MARA' },
  { t: 'RIOT', cik: 1167419, co: 'Riot Platforms' },
  { t: 'CRWV', cik: 1769628, co: 'CoreWeave' },
  { t: 'SOFI', cik: 1818874, co: 'SoFi' },
  { t: 'HIMS', cik: 1773751, co: 'Hims & Hers' },
  { t: 'RDDT', cik: 1713445, co: 'Reddit' },
  { t: 'RBLX', cik: 1315098, co: 'Roblox' },
  { t: 'UBER', cik: 1543151, co: 'Uber' },
  { t: 'ABNB', cik: 1559720, co: 'Airbnb' },
  { t: 'RIVN', cik: 1874178, co: 'Rivian' },
  { t: 'SNOW', cik: 1640147, co: 'Snowflake' },
  { t: 'CRWD', cik: 1535527, co: 'CrowdStrike' },
  { t: 'PANW', cik: 1327567, co: 'Palo Alto Networks' },
  { t: 'NOW', cik: 1373715, co: 'ServiceNow' },
  { t: 'ADBE', cik: 796343, co: 'Adobe' },
  { t: 'MU', cik: 723125, co: 'Micron' },
  { t: 'SMCI', cik: 1375365, co: 'Super Micro' },
  { t: 'INTC', cik: 50863, co: 'Intel' },
  { t: 'QCOM', cik: 804328, co: 'Qualcomm' },
  { t: 'IBM', cik: 51143, co: 'IBM' },
  { t: 'WMT', cik: 104169, co: 'Walmart' },
  { t: 'COST', cik: 909832, co: 'Costco' },
  { t: 'DIS', cik: 1744489, co: 'Disney' },
  { t: 'NKE', cik: 320187, co: 'Nike' },
  { t: 'SBUX', cik: 829224, co: 'Starbucks' },
  { t: 'KO', cik: 21344, co: 'Coca-Cola' },
  { t: 'BA', cik: 12927, co: 'Boeing' },
  { t: 'LLY', cik: 59478, co: 'Eli Lilly' },
  { t: 'UNH', cik: 731766, co: 'UnitedHealth' },
  { t: 'JNJ', cik: 200406, co: 'Johnson & Johnson' },
  { t: 'XOM', cik: 2115436, co: 'ExxonMobil' },
  { t: 'V', cik: 1403161, co: 'Visa' },
  { t: 'MA', cik: 1141391, co: 'Mastercard' },
  { t: 'GS', cik: 886982, co: 'Goldman Sachs' },
  { t: 'MS', cik: 895421, co: 'Morgan Stanley' },
  { t: 'BAC', cik: 70858, co: 'Bank of America' },
  { t: 'WFC', cik: 72971, co: 'Wells Fargo' },
  { t: 'BLK', cik: 2012383, co: 'BlackRock' },
  /* the themes asked for on 2026-10-04 — defense, magnets and rare earths,
     robotics, energy and nuclear, AI (ARM and TSMC file 20-Fs, so no Form 4s:
     they are tagged by ticker below, not followed here) */
  { t: 'LMT', cik: 936468, co: 'Lockheed Martin' },
  { t: 'RTX', cik: 101829, co: 'RTX' },
  { t: 'NOC', cik: 1133421, co: 'Northrop Grumman' },
  { t: 'GD', cik: 40533, co: 'General Dynamics' },
  { t: 'KTOS', cik: 1069258, co: 'Kratos' },
  { t: 'AVAV', cik: 1368622, co: 'AeroVironment' },
  { t: 'HII', cik: 1501585, co: 'Huntington Ingalls' },
  { t: 'RCAT', cik: 748268, co: 'Red Cat' },
  { t: 'MP', cik: 1801368, co: 'MP Materials' },
  { t: 'USAR', cik: 1970622, co: 'USA Rare Earth' },
  { t: 'UUUU', cik: 1385849, co: 'Energy Fuels' },
  { t: 'ISRG', cik: 1035267, co: 'Intuitive Surgical' },
  { t: 'SYM', cik: 1837240, co: 'Symbotic' },
  { t: 'TER', cik: 97210, co: 'Teradyne' },
  { t: 'SERV', cik: 1832483, co: 'Serve Robotics' },
  { t: 'OKLO', cik: 1849056, co: 'Oklo' },
  { t: 'SMR', cik: 1822966, co: 'NuScale' },
  { t: 'NNE', cik: 1923891, co: 'Nano Nuclear' },
  { t: 'LEU', cik: 1065059, co: 'Centrus Energy' },
  { t: 'CEG', cik: 1868275, co: 'Constellation Energy' },
  { t: 'VST', cik: 1692819, co: 'Vistra' },
  { t: 'GEV', cik: 1996810, co: 'GE Vernova' },
  { t: 'BE', cik: 1664703, co: 'Bloom Energy' },
  { t: 'FSLR', cik: 1274494, co: 'First Solar' },
  { t: 'SOUN', cik: 1840856, co: 'SoundHound AI' },
  { t: 'AI', cik: 1577526, co: 'C3.ai' },
  { t: 'BBAI', cik: 1836981, co: 'BigBear.ai' },
];

/* Themes, for the tab's theme filter: by ticker where a row has one, by the
   company's name where it does not (the White House's reports name companies
   without tickers — "LOCKHEED MARTIN CORP"). A row can sit in two (Palantir is
   AI and defense). Lists, not a classifier: a theme is a claim on the page,
   and a list can be read and argued with. */
export const THEMES = {
  ai: { label: 'AI', t: 'NVDA AMD AVGO PLTR MSFT GOOGL GOOG META ORCL SMCI CRWV MU ARM TSM SNOW NOW CRM AI SOUN BBAI INTC QCOM DELL IBM ADBE ANET MRVL AMZN',
    kw: /nvidia|advanced micro|broadcom|palantir|microsoft|alphabet|google|meta platforms|oracle|super micro|coreweave|micron|arm holdings|taiwan semiconductor|snowflake|servicenow|salesforce|c3\.ai|soundhound|bigbear|marvell|arista|artificial intelligence/i },
  robotics: { label: 'Robotics', t: 'TSLA ISRG SYM TER SERV RR ROK ZBRA PATH',
    kw: /tesla|intuitive surgical|symbotic|teradyne|serve robotics|richtech|rockwell automation|zebra tech|uipath|robot/i },
  magnets: { label: 'Magnets & rare earths', t: 'MP USAR UUUU ALB NB CRML TMC LAC',
    kw: /mp materials|usa rare earth|rare earth|energy fuels|albemarle|niocorp|critical metals|lithium|magnet/i },
  defense: { label: 'Defense', t: 'LMT RTX NOC GD KTOS AVAV HII LDOS PLTR BA RCAT ONDS BWXT KRMN LHX TXT AXON',
    kw: /lockheed|raytheon|\brtx\b|northrop|general dynamics|kratos|aerovironment|huntington ingalls|leidos|boeing|red cat|l3harris|textron|axon enterprise|bwx|defen[cs]e/i },
  energy: { label: 'Energy', t: 'XOM CVX COP OXY CEG VST OKLO SMR NNE LEU TLN BE GEV FSLR ENPH NEE CCJ SLB EOG DUK SO EXC ET KMI WMB MPC PSX VLO HAL BKR DVN FANG',
    kw: /exxon|chevron|conocophillips|occidental|constellation energy|vistra|oklo|nuscale|nano nuclear|centrus|talen|bloom energy|ge vernova|first solar|enphase|nextera|cameco|schlumberger|duke energy|southern co|exelon|energy transfer|kinder morgan|williams cos|marathon petroleum|phillips 66|valero|halliburton|baker hughes|devon energy|diamondback|nuclear|uranium|petroleum|natural gas|\boil\b|solar|\benergy\b/i },
  crypto: { label: 'Crypto', t: 'COIN HOOD MSTR XYZ SQ CRCL GLXY BMNR SBET MARA RIOT CLSK HUT IREN CIFR BITF IBIT FBTC ETHA GBTC BITO',
    kw: /coinbase|robinhood|microstrategy|strategy inc|circle internet|galaxy digital|bitmine|sharplink|mara holdings|riot platforms|cleanspark|bitcoin|ethereum|crypto|blockchain/i },
};
const THEME_T = Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, new Set(v.t.split(' '))]));

export function themesOf(r) {
  const out = [];
  const t = String((r && r.ticker) || '').toUpperCase().replace(/[.\-].*$/, '');
  const name = String((r && r.asset) || '');
  for (const [k, v] of Object.entries(THEMES)) if ((t && THEME_T[k].has(t)) || v.kw.test(name)) out.push(k);
  return out;
}
/* The rows with their themes, read at serve time — a list edited here tags
   every row already held, without reading anything again. */
export const withThemes = rows => rows.map(r => ({ ...r, themes: themesOf(r) }));

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

/* An asset name the way a PTR prints it, without the PTR's furniture: the
   parser that read the PDF sometimes runs the next columns into the name
   ("Sony Group Corporation American P 12/26/2026 01/21/2026 $1,001 - …"),
   and the House adds an asset-type tag ("[ST]") and the ticker in brackets. */
export function cleanAsset(s, ticker = '') {
  let v = text(s, 160);
  v = v.replace(/\s+(?:SP|JT|DC)?\s*[PSE](?:\s*\(partial\))?\s+\d{2}\/\d{2}\/\d{4}[\s\S]*$/i, '');
  v = v.replace(/\s+\d{2}\/\d{2}\/\d{4}[\s\S]*$/, '').replace(/\s*\$[\d,]+[\s\S]*$/, '');
  v = v.replace(/^(?:SP|JT|DC)\s+/, '').replace(/\s*\[[A-Z]{2}\]\s*/g, ' ');
  if (ticker) v = v.replace(new RegExp('\\s*\\(' + ticker.replace(/[.\-]/g, '\\$&') + '\\)\\s*', 'i'), ' ');
  return v.replace(/\s+/g, ' ').replace(/[\s\-–]+$/, '').trim().slice(0, 80);
}

/* The trade date must come before the filing. The PTR reader sometimes
   takes the year from the wrong cell (a trade "on 2026-12-26" disclosed
   2026-02-09): one year back is tried, and a date that still makes no sense
   is dropped rather than shown. */
export function tradeDate(traded, filed) {
  const t = day(traded), f = day(filed);
  if (!t || !f) return t;
  if (t <= f) return t;
  const back = String(+t.slice(0, 4) - 1) + t.slice(4);
  return back <= f && Date.parse(f) - Date.parse(back) <= 120 * 864e5 ? back : '';
}

/* One CongressInvests row: member, chamber, buy or sell, the band, the trade
   and disclosure dates, the asset, its ticker, and the official PDF. */
export function fromCongress(t, i = 0) {
  if (!t || !t.member) return null;
  const ty = String(t.trade_type || t.type || '').toLowerCase();
  const side = /^(buy|purchase)/.test(ty) ? 'buy' : /^(sell|sale)/.test(ty) ? 'sell' : '';
  if (!side) return null;
  const [lo, hi] = amountRange(t.amount);
  const ticker = tick(t.ticker);
  const filed = day(t.disclosed);
  const traded = tradeDate(t.tx_date, filed);
  const who = text(t.member, 60);
  return {
    id: 'c:' + fp([who, ticker, traded, t.amount, side, t.link, i].join('|')),
    src: 'congress', who, role: /senate/i.test(t.chamber || '') ? 'Senate' : 'House',
    side, ticker, asset: cleanAsset(t.asset, ticker) || ticker,
    lo, hi, usd: 0, traded, filed, perf: null,
    link: okUrl(t.link),
  };
}

/* The feed lists some trades twice — the same member, asset, day, band and
   report, sometimes on two of its pages. One row each. */
export const congressKey = r => [r.who, r.ticker || r.asset, r.traded, r.lo, r.hi, r.side, r.link].join('|');
export function dedupe(rows, key = congressKey) {
  const seen = new Set(), out = [];
  for (const r of rows || []) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
export function congressRows(list, offset = 0) {
  const all = Array.isArray(list) ? list : (list && (list.trades || list.data)) || [];
  return dedupe(all.map((t, i) => fromCongress(t, offset + i)).filter(Boolean));
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
   (the file repeats its latest batch) counts once. Every trade opens with
   its "description"; matching only objects that do is what keeps the file's
   own top-level object from matching as one giant "trade" — which it did in
   every file whose trades carry no nested object (all but Trump's), and the
   lot was thrown away. */
export function recentTrades(src, { since = '', max = 60 } = {}) {
  const out = [], seen = new Set();
  const re = /\{\s*"description"\s*:(?:[^{}]|\{[^{}]*\})*\}/g;
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
/* One pass over an official's file: the newest `max` trades for the table,
   and a summary of every periodic trade since `since` for their portfolio.
   Trump reported 10,096 such trades; the newest few dozen are not his year,
   and a portfolio built from them said he bought $1.7M–$3.9M. */
export function officialTrades(src, { since = '', max = 40 } = {}) {
  const all = recentTrades(src, { since, max: Infinity });
  let n = 0, buys = 0, sells = 0, bLo = 0, bHi = 0, sLo = 0, sHi = 0;
  const vol = {};
  for (const t of all) {
    const side = /purchase|buy/i.test(t.type || '') ? 'buy' : /sale|sell/i.test(t.type || '') ? 'sell' : '';
    if (!side) continue;
    const [lo, hi0] = amountRange(t.amount), hi = hi0 || lo;
    n++;
    if (side === 'buy') { buys++; bLo += lo; bHi += hi; } else { sells++; sLo += lo; sHi += hi; }
    const name = tick(t.ticker) || text(t.description, 60);
    if (name) vol[name] = (vol[name] || 0) + (lo + hi) / 2;
  }
  return {
    recent: all.slice(0, max),
    sum: { n, buys, sells, bought: [Math.round(bLo), Math.round(bHi)], sold: [Math.round(sLo), Math.round(sHi)],
      top: Object.entries(vol).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]) },
  };
}

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
    issuerCik: +val(doc, 'issuerCik') || 0,
    owner: val(owner, 'rptOwnerName'),
    director: flag(val(rel, 'isDirector')), officer: flag(val(rel, 'isOfficer')),
    tenPct: flag(val(rel, 'isTenPercentOwner')), title: text(val(rel, 'officerTitle'), 60),
    plan: flag(val(doc, 'aff10b5One')),
    lines,
  };
}

const roleOf = (f, co) => ((f.title || (f.director ? 'Director' : f.tenPct ? '10% owner' : 'Insider')) + ', ' + co).slice(0, 90);
/* The company a Form 4 is about. A company's feed also lists the filings it
   makes as somebody else's big holder — Berkshire buying Lennar arrived in
   Berkshire's feed — so the short name in ISSUERS is used only when the
   filing's issuer is that company. */
const companyOf = (f, issuer = {}) => (issuer.cik && f.issuerCik && f.issuerCik !== issuer.cik) || !issuer.co
  ? shortCo(f.issuer) : issuer.co;
const shortCo = s => text(String(s || '').replace(/[,.]?\s+(inc|corp|corporation|co|company|ltd|plc|holdings|group|n\.?v|s\.?a)\.?$/i, '').replace(/[,.]?\s+(inc|corp|corporation)\.?$/i, ''), 60);

/* A Form 4 as table rows: open-market purchases (code P) and sales (S) only —
   grants, option exercises, tax withholding and gifts are paperwork, not a
   view on the stock. One row per side per filing, the lines summed: a CEO's
   planned sale is often forty fills at forty prices. `after` is what the
   owner holds directly once the last of them settled, and `afterUsd` that at
   the average price. `plan` marks a pre-scheduled (10b5-1) sale, which says
   less than one somebody chose to make. */
export function fromForm4(f, filing, issuer = {}) {
  if (!f || !filing) return [];
  const co = companyOf(f, issuer);
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

/* ============================================================ portfolios */

/* Today's price, from Yahoo's chart endpoint — keyless, one symbol a call,
   and it answers the Worker (src/stockwin.mjs reads it the same way). An
   issuer whose shares Yahoo names differently says so in `yh`; '' means it
   is not priced (Berkshire's insiders hold A and B shares, and a Form 4 does
   not say which in a way worth guessing at). */
export const yahooSym = iss => (iss && iss.yh !== undefined ? iss.yh : (iss && iss.t) || '');
export const priceUrl = sym => 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1d&interval=1d';
export const chartUrl = sym => 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1y&interval=1d';

/* The close on each of `dates` (or the last trading day before it) from a
   year of Yahoo's daily bars, and the price now. */
export function closesOn(j, dates) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const ts = (r && r.timestamp) || [];
  const cl = (r && r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
  const days = ts.map(x => new Date(x * 1000).toISOString().slice(0, 10));
  const out = {};
  for (const d of dates || []) {
    let v = 0;
    for (let i = 0; i < days.length; i++) {
      if (days[i] > d) break;
      if (cl[i] > 0) v = cl[i];
    }
    if (v > 0) out[d] = +v.toFixed(4);
  }
  return { now: priceFrom(j), on: out };
}
export function priceFrom(j) {
  const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  const p = m ? +m.regularMarketPrice : 0;
  return Number.isFinite(p) && p > 0 ? p : 0;
}

/* What one Form 4 says its owner holds directly once it settled. Every
   filing counts here — a grant or an option exercise changes a holding as
   much as a sale — and the last line on the latest date is the position. */
export function holdingFrom(f, filing, issuer = {}) {
  if (!f || !f.lines || !f.lines.length) return null;
  const direct = f.lines.filter(l => l.direct);
  const pool = (direct.length ? direct : f.lines).slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = pool[pool.length - 1];
  const t = f.ticker || tick(issuer.t);
  if (!t || !(last.after >= 0)) return null;
  return { who: personName(f.owner), role: roleOf(f, companyOf(f, issuer)), t, shares: Math.round(last.after), date: last.date || (filing && filing.date) || '' };
}

/* Company insiders' rows with today's price: what the holding is worth now,
   and how the stock has moved since the trade. Other rows pass through —
   Congress rows already carry the move since, and the White House reports
   names, not tickers. */
export function withPrices(rows, px = {}, pxAt = {}) {
  return rows.map(r => {
    const p = r && r.ticker && px[r.ticker] ? +px[r.ticker].p : 0;
    if (!(p > 0)) return r;
    if (r.src === 'ceo') {
      return { ...r, now: +p.toFixed(2), afterNow: Math.round((r.after || 0) * p),
        perf: r.price > 0 ? +(((p - r.price) / r.price) * 100).toFixed(2) : null };
    }
    const p0 = r.traded ? +pxAt[r.ticker + '|' + r.traded] || 0 : 0;
    if (r.src === 'congress' && p0 > 0) return { ...r, now: +p.toFixed(2), perf: +(((p - p0) / p0) * 100).toFixed(2) };
    return r;
  });
}

/* One row per person. From their trades: how many, how much bought and how
   much sold (exact for a Form 4, the sum of the bands otherwise), what they
   traded most, how those trades have done since, and the latest filing.
   From their holdings (company insiders only — Congress and the White House
   report trades, not positions): every stake, at today's price where there
   is one, and the total. People who hold but did not trade in the window
   are listed too: a CEO's stake is the point even in a quiet month. */
export function peopleFrom(rows, holdings = [], px = {}, sums = {}) {
  const by = new Map();
  const get = (src, who, role) => {
    const key = src + ':' + who;
    let p = by.get(key);
    if (!p) by.set(key, p = { key, src, who, role, n: 0, buys: 0, sells: 0, bLo: 0, bHi: 0, sLo: 0, sHi: 0, last: '', vol: {}, perfSum: 0, perfN: 0, hold: [], holdUsd: 0, gain: 0, gainN: 0, themes: new Set() });
    return p;
  };
  for (const r of rows || []) {
    if (!r || !r.who) continue;
    const p = get(r.src, r.who, r.role);
    const lo = r.usd || r.lo || 0, hi = r.usd || r.hi || r.lo || 0;
    p.n++;
    if (r.side === 'buy') { p.buys++; p.bLo += lo; p.bHi += hi; } else { p.sells++; p.sLo += lo; p.sHi += hi; }
    if ((r.filed || '') > p.last) p.last = r.filed;
    const name = r.ticker || r.asset || '';
    if (name) p.vol[name] = (p.vol[name] || 0) + (lo + hi) / 2;
    if (r.perf !== null && r.perf !== undefined && Number.isFinite(+r.perf)) {
      p.perfSum += +r.perf; p.perfN++;
      /* what a buy has made since, at the middle of its band (exact for a
         Form 4): an estimate, and the page says so */
      if (r.side === 'buy') { p.gain += ((lo + hi) / 2) * (+r.perf / 100); p.gainN++; }
    }
    for (const th of (r.themes || themesOf(r))) p.themes.add(th);
  }
  for (const h of holdings || []) {
    if (!h || !h.who || !h.t) continue;
    const p = get('ceo', h.who, h.role);
    const price = px[h.t] ? +px[h.t].p || 0 : 0;
    const usd = price > 0 ? Math.round(h.shares * price) : 0;
    p.hold.push({ t: h.t, shares: h.shares, usd, date: h.date });
    p.holdUsd += usd;
    if ((h.date || '') > p.last && !p.n) p.last = h.date;
  }
  /* a whole year's summary, where the source gave one, over the rows we keep */
  return [...by.values()].map(p => ({ p, s: sums[p.key] })).map(({ p, s }) => ({
    key: p.key, src: p.src, who: p.who, role: p.role, n: s ? s.n : p.n, buys: s ? s.buys : p.buys, sells: s ? s.sells : p.sells,
    bought: s ? s.bought : [Math.round(p.bLo), Math.round(p.bHi)], sold: s ? s.sold : [Math.round(p.sLo), Math.round(p.sHi)], last: p.last,
    top: s && s.top.length ? s.top : Object.entries(p.vol).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]),
    perf: p.perfN ? +(p.perfSum / p.perfN).toFixed(2) : null,
    hold: p.hold.sort((a, b) => b.usd - a.usd).slice(0, 6), holdUsd: p.holdUsd,
    gain: p.gainN ? Math.round(p.gain) : null, gainN: p.gainN, themes: [...p.themes],
  })).sort((a, b) => (b.holdUsd - a.holdUsd) || ((b.bought[1] + b.sold[1]) - (a.bought[1] + a.sold[1])));
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
