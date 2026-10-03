/* ==========================================================================
   Insiders — Congress, the White House and CEOs, read off public filings.

       node scripts/insiders.test.mjs

   Every fixture below is shaped like the real thing as it was read on
   2026-10-03: CongressInvests rows (one with the PDF reader's columns run
   into the asset name, one with the year in the wrong cell — both real), a
   line of Open Cabinet's officials index, a slice
   of an official's file (with the nested `read` object the newer trades
   carry — the first parser skipped all of them), an EDGAR company feed with
   a prospectus mixed in, and a Form 4 cut down from Tesla's CFO's filing of
   2026-09-09. The failures that matter: a sale read as a buy, a grant or an
   option exercise shown as a trade, one person's name in the wrong order,
   and markup from a filing reaching the page.
   ========================================================================== */

import {
  amountRange, personName, commaName, daysLate, fromCongress, congressRows, cleanAsset, tradeDate, parseCsv, officialsFrom,
  recentTrades, officialTrades, fromCabinet, form4Feed, form4Entries, form4Text, parseForm4, fromForm4, mergeRows, ISSUERS, fp,
  holdingFrom, withPrices, peopleFrom, closesOn, priceFrom, yahooSym,
} from '../src/insiders.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

console.log('\nsmall readers');
{
  is('a range with spaces', amountRange('$1,001 - $15,000'), [1001, 15000]);
  is('a range without', amountRange('$100,001-$250,000'), [100001, 250000]);
  is('an open band', amountRange('Over $50,000,000'), [50000000, 0]);
  is('nothing', amountRange(''), [0, 0]);
  is('SEC order, capitals', personName('MUSK ELON'), 'Elon Musk');
  is('SEC order, mixed case', personName('Taneja Vaibhav'), 'Vaibhav Taneja');
  is('two given names', personName('HUANG JEN HSUN'), 'Jen Hsun Huang');
  is('a suffix stays last', personName('SMITH JOHN A JR'), 'John A Smith Jr');
  is('a company keeps its order', personName('BERKSHIRE HATHAWAY INC'), 'Berkshire Hathaway Inc');
  is('a trust keeps its order', personName('Musk Elon Revocable Trust'), 'Musk Elon Revocable Trust');
  is('OGE order', commaName('Trump, Donald J.'), 'Donald J. Trump');
  is('days from trade to filing', daysLate('2026-09-22', '2026-10-01'), 9);
  is('no dates, no number', daysLate('', '2026-10-01'), null);
  is('a fingerprint is stable', fp('a|b'), fp('a|b'));
}

console.log('\nCongress (CongressInvests)');
{
  const pelosi = { member: 'Nancy Pelosi', chamber: 'House', trade_type: 'buy', amount: '$500,001 - $1,000,000', tx_date: '2026-07-24',
    disclosed: '2026-08-21', asset: 'Intel Corporation - Common Stock (INTC) [ST]', ticker: 'INTC',
    link: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035143.pdf' };
  const r = fromCongress(pelosi, 0);
  is('a buy, the member, the chamber, the ticker', [r.side, r.who, r.role, r.ticker], ['buy', 'Nancy Pelosi', 'House', 'INTC']);
  is('the band and the dates', [r.lo, r.hi, r.traded, r.filed], [500001, 1000000, '2026-07-24', '2026-08-21']);
  is('the asset without the ticker and the [ST] tag', r.asset, 'Intel Corporation - Common Stock');
  is('the official PDF', r.link, 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035143.pdf');
  is('a sale is a sale', fromCongress({ ...pelosi, trade_type: 'sell' }).side, 'sell');
  is('an exchange is neither, and left out', fromCongress({ ...pelosi, trade_type: 'exchange' }), null);
  is('a senator says Senate', fromCongress({ ...pelosi, chamber: 'Senate' }).role, 'Senate');
  is('markup in a name never survives', fromCongress({ ...pelosi, member: '<img src=x onerror=alert(1)>Bob' }).who.includes('<'), false);
  is('a javascript: link is dropped', fromCongress({ ...pelosi, link: 'javascript:alert(1)' }).link, '');

  is('columns run into the name are cut', cleanAsset('Sony Group Corporation American P 12/26/2026 01/21/2026 $1,001 - $15,000', 'SONY'), 'Sony Group Corporation American');
  is('a spouse prefix and the date tail are cut', cleanAsset('SP Bloom Energy Corporation Class A P 07/28/2026 07/28/2026 $500,001 -', 'BE'), 'Bloom Energy Corporation Class A');
  is('a trade dated after its own filing: a year back', tradeDate('2026-12-26', '2026-02-09'), '2025-12-26');
  is('…and one that still makes no sense is dropped', tradeDate('2026-12-26', '2026-06-30'), '');
  is('a normal date is kept', tradeDate('2026-07-24', '2026-08-21'), '2026-07-24');

  const page = { total: 3, has_more: false, trades: [pelosi, { ...pelosi }, { ...pelosi, ticker: 'BE', asset: 'Bloom Energy' }] };
  is('a trade listed twice is one row; the wrapper is read', congressRows(page).map(x => x.ticker), ['INTC', 'BE']);
}

console.log('\nWhite House (Open Cabinet)');
{
  const csv = 'name,slug,title,agency,level,confirmed_date,departed_date,transaction_count,sales_count,purchases_count,late_filing_count,estimated_total_value,most_recent_oge_filing_date\n'
    + '"Trump, Donald J.",trump-donald-j,President of the United States,Executive Office of the President,Cabinet,2025-01-20,,31211,9638,21573,7398,3243377000,2026-09-22\n'
    + '"Bessent, Scott",bessent-scott,Secretary of the Treasury,Department of the Treasury,Cabinet,2025-01-27,,26,26,0,0,3276500,2025-12-31\n'
    + '"Bad, Row",../etc/passwd,x,y,z,,,1,1,0,0,1,2026-01-01\n';
  is('quoted fields with commas', parseCsv(csv)[0].name, 'Trump, Donald J.');
  const offs = officialsFrom(csv);
  is('officials, names in reading order', offs.map(o => o.name), ['Donald J. Trump', 'Scott Bessent']);
  is('a slug that could walk a path is refused', offs.some(o => o.slug.includes('/')), false);
  is('the last filing date', offs[0].last, '2026-09-22');

  /* a slice of the 15 MB file: an annual-report row, an old one, two new ones
     with the nested `read`, and the latest batch repeating one of them */
  const trade = (d, type, desc, amount, extra = '') => `{
      "description": "${desc}",
      "ticker": null,
      "type": "${type}",
      "date": "${d}",
      "amount": "${amount}",
      "lateFilingFlag": false,
      "sourceUrl": "https://extapps2.oge.gov/x.pdf"${extra}
    }`;
  const read = `,
      "read": {
        "parser": "2026-09-05.2",
        "model": "claude-sonnet-4-6"
      }`;
  const file = `{
  "name": "Trump, Donald J.",
  "transactions": [
    ${trade('2026-07-31', 'Purchase', 'ABBOTT LABS', '$100,001-$250,000', read)},
    ${trade('2026-07-30', 'Sale', 'APPLE INC', '$1,000,001-$5,000,000', read)},
    ${trade('2025-02-01', 'Purchase', 'OLD BOND', '$15,001-$50,000')},
    ${trade('2026-07-15', 'Purchase', 'ANNUAL ROW', '$1,001-$15,000', ',\n      "sourceKind": "annual-278e"')}
  ],
  "sourceFilings": [{ "date": "2026-09-22", "url": "https://extapps2.oge.gov/y.pdf", "label": "x" }],
  "lastIngestedTrades": [
    ${trade('2026-07-31', 'Purchase', 'ABBOTT LABS', '$100,001-$250,000', read)}
  ]
}`;
  const got = recentTrades(file, { since: '2026-01-01' });
  const whole = officialTrades(file, { since: '2026-01-01', max: 1 });
  is('a year summed, while the table keeps the newest', [whole.recent.length, whole.sum.n, whole.sum.buys, whole.sum.sells, whole.sum.bought, whole.sum.sold],
    [1, 2, 1, 1, [100001, 250000], [1000001, 5000000]]);
  is('newest first, nested objects read, old and annual rows out, repeats once', got.map(t => t.description), ['ABBOTT LABS', 'APPLE INC']);
  const rows = got.map((t, i) => fromCabinet(t, offs[0], i));
  is('as rows', rows.map(r => [r.side, r.who, r.asset, r.lo, r.hi, r.traded, r.filed]),
    [['buy', 'Donald J. Trump', 'ABBOTT LABS', 100001, 250000, '2026-07-31', '2026-09-22'], ['sell', 'Donald J. Trump', 'APPLE INC', 1000001, 5000000, '2026-07-30', '2026-09-22']]);
  is('two identical trades on one day stay two rows', fromCabinet(got[0], offs[0], 0).id === fromCabinet(got[0], offs[0], 1).id, false);
}

console.log('\nCEOs (SEC Form 4)');
{
  is('the feed asks for ownership filings only', /owner=only/.test(form4Feed(1318605)) && /CIK=0001318605/.test(form4Feed(1318605)), true);
  const atom = `<feed>
<entry><content type="text/xml"><accession-number>0001104659-26-106432</accession-number><filing-date>2026-09-09</filing-date>
<filing-href>https://www.sec.gov/Archives/edgar/data/1318605/000110465926106432/0001104659-26-106432-index.htm</filing-href><filing-type>4</filing-type></content></entry>
<entry><content type="text/xml"><accession-number>0001104659-26-106000</accession-number><filing-date>2026-09-08</filing-date>
<filing-href>https://www.sec.gov/Archives/edgar/data/1318605/000110465926106000/0001104659-26-106000-index.htm</filing-href><filing-type>424B2</filing-type></content></entry>
</feed>`;
  const ents = form4Entries(atom);
  is('a prospectus in the feed is not a Form 4', ents.map(e => e.acc), ['0001104659-26-106432']);
  is('the full text sits beside the index', form4Text(ents[0].href), 'https://www.sec.gov/Archives/edgar/data/1318605/000110465926106432/0001104659-26-106432.txt');
  is('only sec.gov paths become requests', form4Text('https://evil.example/Archives/edgar/data/1/2/0001104659-26-106432-index.htm'), '');

  const line = (date, code, shares, price, ad, after, direct = 'D') => `
        <nonDerivativeTransaction>
            <securityTitle><value>Common Stock</value></securityTitle>
            <transactionDate><value>${date}</value></transactionDate>
            <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode><footnoteId id="F1"/></transactionCoding>
            <transactionAmounts>
                <transactionShares><value>${shares}</value></transactionShares>
                <transactionPricePerShare>${price === null ? '<footnoteId id="F2"/>' : '<value>' + price + '</value>'}</transactionPricePerShare>
                <transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode>
            </transactionAmounts>
            <postTransactionAmounts><sharesOwnedFollowingTransaction><value>${after}</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
            <ownershipNature><directOrIndirectOwnership><value>${direct}</value></directOrIndirectOwnership></ownershipNature>
        </nonDerivativeTransaction>`;
  const doc = (lines, plan = 0, owner = 'Taneja Vaibhav') => `<SEC-DOCUMENT>junk<TEXT><XML>
<ownershipDocument>
    <issuer><issuerCik>0001318605</issuerCik><issuerName>Tesla, Inc.</issuerName><issuerTradingSymbol>TSLA</issuerTradingSymbol></issuer>
    <reportingOwner>
        <reportingOwnerId><rptOwnerCik>0001771340</rptOwnerCik><rptOwnerName>${owner}</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer><isTenPercentOwner>0</isTenPercentOwner><officerTitle>Chief Financial Officer</officerTitle></reportingOwnerRelationship>
    </reportingOwner>
    <aff10b5One>${plan}</aff10b5One>
    <nonDerivativeTable>${lines.join('')}
    </nonDerivativeTable>
</ownershipDocument></XML></TEXT></SEC-DOCUMENT>`;
  const tesla = ISSUERS.find(x => x.t === 'TSLA');
  const real = parseForm4(doc([line('2026-09-05', 'M', 6539, '0.0', 'A', 28578), line('2026-09-08', 'S', 2605.75, '360.134', 'D', 25972.25), line('2026-09-08', 'F', 1, '360', 'D', 25971)]));
  is('the owner, the title, the company', [real.owner, real.title, real.ticker, real.officer], ['Taneja Vaibhav', 'Chief Financial Officer', 'TSLA', true]);
  const rows = fromForm4(real, ents[0], tesla);
  is('an exercise and a tax withholding are not trades; the sale is', rows.map(r => r.side), ['sell']);
  is('the sale, summed and priced', [rows[0].who, rows[0].shares, rows[0].price, rows[0].usd, rows[0].after], ['Vaibhav Taneja', 2606, 360.13, 938419, 25972]);
  is('what they hold after, in dollars', rows[0].afterUsd, Math.round(25972.25 * 360.134));
  is('the role names the company', rows[0].role, 'Chief Financial Officer, Tesla');

  const fills = parseForm4(doc([line('2026-09-08', 'S', 100, '10', 'D', 900), line('2026-09-09', 'S', 300, '20', 'D', 600), line('2026-09-09', 'S', 50, '20', 'D', 400, 'I')], 1));
  const one = fromForm4(fills, ents[0], tesla);
  is('forty fills are one row', one.length, 1);
  is('…averaged by shares, dated by the last fill', [one[0].shares, one[0].usd, one[0].price, one[0].traded], [450, 8000, 17.78, '2026-09-09']);
  is('…holding read off the last direct line', one[0].after, 600);
  is('a planned (10b5-1) sale says so', one[0].plan, true);

  const both = parseForm4(doc([line('2026-09-08', 'P', 1000, '50', 'A', 1000), line('2026-09-09', 'S', 10, '55', 'D', 990)]));
  is('a buy and a sale in one filing are two rows', fromForm4(both, ents[0], tesla).map(r => r.side), ['buy', 'sell']);
  /* a company's own feed lists the filings it makes as another company's big holder */
  const brk = ISSUERS.find(x => x.t === 'BRK');
  const len = parseForm4(doc([line('2026-09-30', 'P', 660000, '81.59', 'A', 553000)])
    .replace('<issuerCik>0001318605</issuerCik><issuerName>Tesla, Inc.</issuerName><issuerTradingSymbol>TSLA</issuerTradingSymbol>',
      '<issuerCik>0000920760</issuerCik><issuerName>LENNAR CORP /NEW/</issuerName><issuerTradingSymbol>LEN</issuerTradingSymbol>'));
  const lr = fromForm4(len, ents[0], brk)[0];
  is('Berkshire buying Lennar is a Lennar trade, not a Berkshire one', [lr.ticker, lr.asset.toUpperCase().startsWith('LENNAR'), lr.role.includes('Berkshire')], ['LEN', true, false]);
  is('…and a Tesla filing keeps the short name', fromForm4(both, ents[0], tesla)[0].asset, 'Tesla');
  is('a price given only as a footnote is zero, not a crash', parseForm4(doc([line('2026-09-08', 'S', 10, null, 'D', 5)])).lines[0].price, 0);
  is('markup in an owner name never survives', fromForm4(parseForm4(doc([line('2026-09-08', 'P', 1, '1', 'A', 1)], 0, '&lt;script&gt;Evil Bob')), ents[0], tesla)[0].who.includes('<'), false);
  is('no ownership document, nothing', parseForm4('<html>not here</html>'), null);
  is('the companies all have a CIK and a ticker', ISSUERS.every(x => x.cik > 0 && /^[A-Z.]{1,6}$/.test(x.t)), true);
}

console.log('\nportfolios and prices');
{
  const tesla = ISSUERS.find(x => x.t === 'TSLA');
  const f = { owner: 'MUSK ELON', ticker: 'TSLA', issuer: 'Tesla, Inc.', title: 'CEO', director: true, officer: true, tenPct: true,
    lines: [{ date: '2026-09-01', code: 'A', shares: 10, price: 0, ad: 'A', after: 410, direct: true },
            { date: '2026-09-02', code: 'M', shares: 5, price: 0, ad: 'A', after: 415, direct: true },
            { date: '2026-09-02', code: 'S', shares: 1, price: 0, ad: 'D', after: 99, direct: false }] };
  const h = holdingFrom(f, { date: '2026-09-03' }, tesla);
  is('a stake is the last direct line on the latest date — grants count', [h.who, h.t, h.shares, h.date], ['Elon Musk', 'TSLA', 415, '2026-09-02']);

  const chart = { chart: { result: [{ meta: { regularMarketPrice: 120 },
    timestamp: [Date.parse('2026-07-23T13:30:00Z') / 1000, Date.parse('2026-07-24T13:30:00Z') / 1000, Date.parse('2026-07-27T13:30:00Z') / 1000],
    indicators: { quote: [{ close: [95, 100, 104] }] } }] } };
  is('the close on the day, the last trading day before a weekend, and now', closesOn(chart, ['2026-07-24', '2026-07-26']), { now: 120, on: { '2026-07-24': 100, '2026-07-26': 100 } });
  is('a price', priceFrom(chart), 120);
  is('Berkshire is not priced', yahooSym(ISSUERS.find(x => x.t === 'BRK')), '');

  const cong = fromCongress({ member: 'Nancy Pelosi', chamber: 'House', trade_type: 'buy', amount: '$500,001 - $1,000,000', tx_date: '2026-07-24',
    disclosed: '2026-08-21', asset: 'Intel', ticker: 'INTC', link: 'https://disclosures-clerk.house.gov/x.pdf' });
  const ceo = { id: 'f:1:sell', src: 'ceo', who: 'Elon Musk', role: 'CEO, Tesla', side: 'sell', ticker: 'TSLA', usd: 1000, shares: 10, price: 100, after: 415, filed: '2026-09-03' };
  const px = { INTC: { p: 120 }, TSLA: { p: 150 } }, pxAt = { 'INTC|2026-07-24': 100 };
  const [c2, e2] = withPrices([cong, ceo], px, pxAt);
  is('a Congress trade, up since the close on its day', [c2.now, c2.perf], [120, 20]);
  is('an insider: the stake now and the move since the sale', [e2.afterNow, e2.perf], [62250, 50]);

  const ppl = peopleFrom([c2, e2, { ...cong, id: 'c:2', side: 'sell', lo: 1001, hi: 15000, ticker: 'NVDA' }], [h], px);
  const elon = ppl.find(p => p.who === 'Elon Musk'), nancy = ppl.find(p => p.who === 'Nancy Pelosi');
  is('a CEO: trades, and the stake at today\'s price', [elon.n, elon.sells, elon.holdUsd, elon.hold[0].t], [1, 1, 62250, 'TSLA']);
  is('a member: bought and sold, summed bands', [nancy.n, nancy.bought, nancy.sold], [2, [500001, 1000000], [1001, 15000]]);
  is('…what they traded most', nancy.top[0], 'INTC');
  is('…and the move since, where known', nancy.perf, 20);
  is('a stake first, then the biggest trader', ppl[0].who, 'Elon Musk');
  const sums = { 'whitehouse:Donald J. Trump': { n: 10096, buys: 6212, sells: 3884, bought: [1e9, 2e9], sold: [5e8, 1e9], top: ['BROADCOM INC'] } };
  const tr = peopleFrom([{ id: 'w:1', src: 'whitehouse', who: 'Donald J. Trump', role: 'President', side: 'buy', lo: 1001, hi: 15000, filed: '2026-09-22' }], [], {}, sums)[0];
  is('an official\'s portfolio is their year, not the rows kept', [tr.n, tr.buys, tr.bought[1], tr.top[0]], [10096, 6212, 2e9, 'BROADCOM INC']);
}

console.log('\nthe table');
{
  const a = { id: 'a', filed: '2026-10-01', traded: '2026-09-22' };
  const b = { id: 'b', filed: '2026-09-22', traded: '2026-07-31' };
  const c = { id: 'c', filed: '2026-10-01', traded: '2026-09-30' };
  is('newest filing first, then newest trade, each once', mergeRows([b, a], [c, a]).map(r => r.id), ['c', 'a', 'b']);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
