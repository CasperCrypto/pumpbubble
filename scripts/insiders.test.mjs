/* ==========================================================================
   Insiders — Congress, the White House and CEOs, read off public filings.

       node scripts/insiders.test.mjs

   Every fixture below is shaped like the real thing as it was read on
   2026-10-03: a Bargo row, a line of Open Cabinet's officials index, a slice
   of an official's file (with the nested `read` object the newer trades
   carry — the first parser skipped all of them), an EDGAR company feed with
   a prospectus mixed in, and a Form 4 cut down from Tesla's CFO's filing of
   2026-09-09. The failures that matter: a sale read as a buy, a grant or an
   option exercise shown as a trade, one person's name in the wrong order,
   and markup from a filing reaching the page.
   ========================================================================== */

import {
  amountRange, personName, commaName, daysLate, fromBargo, parseCsv, officialsFrom, recentTrades, fromCabinet,
  form4Feed, form4Entries, form4Text, parseForm4, fromForm4, mergeRows, ISSUERS, fp,
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

console.log('\nCongress (Bargo)');
{
  const t = { member: 'David J. Taylor', member_slug: 'david-j-taylor', chamber: 'house', state: 'OH02', ticker: 'MPC',
    asset: 'Marathon Petroleum Corporation Common Stock', type: 'sale', amount_low: 1001, amount_high: 15000,
    transaction_date: '2026-09-22', disclosure_date: '2026-10-01', perf_pct: 8.38, filing_portal: 'https://disclosures-clerk.house.gov/FinancialDisclosure' };
  const r = fromBargo(t, 0);
  is('a sale is a sale', [r.side, r.who, r.role, r.ticker], ['sell', 'David J. Taylor', 'House · OH02', 'MPC']);
  is('the range and the dates', [r.lo, r.hi, r.traded, r.filed, r.perf], [1001, 15000, '2026-09-22', '2026-10-01', 8.38]);
  is('a purchase is a buy', fromBargo({ ...t, type: 'purchase' }).side, 'buy');
  is('a partial sale is a sale', fromBargo({ ...t, type: 'sale_partial' }).side, 'sell');
  is('an exchange is neither, and left out', fromBargo({ ...t, type: 'exchange' }), null);
  is('a senator says Senate', fromBargo({ ...t, chamber: 'senate', state: 'MA' }).role, 'Senate · MA');
  is('no performance is null, not zero', fromBargo({ ...t, perf_pct: null }).perf, null);
  is('markup in a name never survives', fromBargo({ ...t, member: '<img src=x onerror=alert(1)>Bob' }).who.includes('<'), false);
  is('a javascript: link is dropped', fromBargo({ ...t, filing_portal: 'javascript:alert(1)' }).link, '');
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
  is('a price given only as a footnote is zero, not a crash', parseForm4(doc([line('2026-09-08', 'S', 10, null, 'D', 5)])).lines[0].price, 0);
  is('markup in an owner name never survives', fromForm4(parseForm4(doc([line('2026-09-08', 'P', 1, '1', 'A', 1)], 0, '&lt;script&gt;Evil Bob')), ents[0], tesla)[0].who.includes('<'), false);
  is('no ownership document, nothing', parseForm4('<html>not here</html>'), null);
  is('the companies all have a CIK and a ticker', ISSUERS.every(x => x.cik > 0 && /^[A-Z.]{1,6}$/.test(x.t)), true);
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
