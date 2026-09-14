import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildTickerCikMap,
  describeOwner,
  edgarDocumentUrl,
  form4ToTransactions,
  padCik,
  parseForm4Xml,
  rawPrimaryDocument,
  selectRecentForm4Filings,
} from "../src/lib/disclosures/edgar-parse.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");

test("padCik pads to 10 digits and strips junk", () => {
  assert.equal(padCik(320193), "0000320193");
  assert.equal(padCik("CIK0001045810"), "0001045810");
});

test("rawPrimaryDocument strips the xsl render prefix", () => {
  assert.equal(rawPrimaryDocument("xslF345X06/wk-form4_1789160684.xml"), "wk-form4_1789160684.xml");
  assert.equal(rawPrimaryDocument("form4.xml"), "form4.xml");
});

test("edgarDocumentUrl points at the raw archive document", () => {
  assert.equal(
    edgarDocumentUrl({
      cik: "0001045810",
      accessionNumber: "0002152188-26-000005",
      primaryDocument: "xslF345X06/wk-form4_1789160684.xml",
    }),
    "https://www.sec.gov/Archives/edgar/data/1045810/000215218826000005/wk-form4_1789160684.xml",
  );
});

test("selectRecentForm4Filings keeps only Form 4 XML, newest first, bounded", () => {
  const refs = selectRecentForm4Filings(
    {
      cik: 1045810,
      filings: {
        recent: {
          accessionNumber: ["a", "b", "c", "d", "e"],
          filingDate: ["2026-09-11", "2026-09-10", "2026-09-09", "2026-09-08", "2026-09-07"],
          acceptanceDateTime: ["2026-09-11T21:04:47.000Z", "", "", "", ""],
          form: ["4", "8-K", "4/A", "4", "4"],
          primaryDocument: ["xslF345X06/x.xml", "8k.htm", "xslF345X06/amend.xml", "old.htm", "xslF345X06/y.xml"],
        },
      },
    },
    2,
  );
  assert.deepEqual(
    refs.map((ref) => ref.accessionNumber),
    ["a", "e"],
  );
  assert.equal(refs[0].cik, "0001045810");
  assert.equal(refs[0].acceptanceDateTime, "2026-09-11T21:04:47.000Z");
});

test("parseForm4Xml reads a real AAPL 10b5-1 sale", () => {
  const parsed = parseForm4Xml(fixture("edgar-form4-aapl-sale.xml"));
  assert.equal(parsed.issuerTicker, "AAPL");
  assert.equal(parsed.issuerName, "Apple Inc.");
  assert.equal(parsed.issuerCik, "0000320193");
  assert.equal(parsed.aff10b5One, true);
  assert.equal(parsed.owners.length, 1);
  assert.equal(parsed.owners[0].name, "Newstead Jennifer");
  assert.equal(parsed.owners[0].cik, "0001780525");
  assert.equal(parsed.owners[0].isOfficer, true);
  assert.equal(parsed.owners[0].title, "SVP, GC and Government Affairs");
  assert.equal(parsed.transactions.length, 1);
  const [tx] = parsed.transactions;
  assert.equal(tx.transactionCode, "S");
  assert.equal(tx.shares, 1438);
  assert.equal(tx.pricePerShare, 317.23);
  assert.equal(tx.sharesOwnedAfter, 34352);
  assert.equal(tx.acquiredDisposed, "D");
  assert.equal(tx.direct, true);
  assert.equal(tx.derivative, false);
});

test("form4ToTransactions keeps only non-derivative P/S rows and computes value", () => {
  const parsed = parseForm4Xml(fixture("edgar-form4-nvda-mixed.xml"));
  assert.equal(parsed.transactions.length, 3);
  assert.equal(parsed.transactions[2].derivative, true);

  const rows = form4ToTransactions(parsed, {
    accessionNumber: "0002152188-26-000005",
    acceptanceDateTime: "2026-09-11T21:04:47.000Z",
    filingDate: "2026-09-11",
  });
  assert.equal(rows.length, 1, "RSU grant (A) and derivative sale are excluded");
  const [row] = rows;
  assert.equal(row.id, "edgar-0002152188-26-000005-1");
  assert.equal(row.ticker, "NVDA");
  assert.equal(row.transactionCode, "P");
  assert.equal(row.sharesAmount, 1250, "comma-formatted share counts parse");
  assert.equal(row.pricePerShare, 180.5);
  assert.equal(row.transactionValue, 225625);
  assert.equal(row.sharesOwnedAfter, 173757);
  assert.equal(row.insiderName, "Parker Nicholas P.");
  assert.equal(row.insiderCik, "0002152188");
  assert.equal(row.insiderTitle, "EVP, Worldwide Field Ops");
  assert.equal(row.filedAt, "2026-09-11T21:04:47.000Z");
  assert.equal(row.is10b51, false);
});

test("form4ToTransactions never emits 0 shares or 0 price", () => {
  const xml = fixture("edgar-form4-nvda-mixed.xml").replace(
    "<transactionCode>A</transactionCode>",
    "<transactionCode>P</transactionCode>",
  );
  const rows = form4ToTransactions(parseForm4Xml(xml), {
    accessionNumber: "x",
    acceptanceDateTime: "",
    filingDate: "2026-09-11",
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pricePerShare, null, "zero price becomes null");
  assert.equal(rows[0].transactionValue, null);
  assert.equal(rows[0].filedAt, "2026-09-11T00:00:00.000Z", "falls back to filingDate");
});

test("form4ToTransactions honours a caller-supplied ticker and code filter", () => {
  const parsed = parseForm4Xml(fixture("edgar-form4-aapl-sale.xml"));
  assert.equal(form4ToTransactions(parsed, { accessionNumber: "a", acceptanceDateTime: "", filingDate: "" }, { codes: ["P"] }).length, 0);
  const rows = form4ToTransactions(parsed, { accessionNumber: "a", acceptanceDateTime: "", filingDate: "" }, { ticker: "aapl" });
  assert.equal(rows[0].ticker, "AAPL");
  assert.equal(rows[0].is10b51, true);
});

test("describeOwner combines title and director/10% flags", () => {
  assert.equal(
    describeOwner({ cik: "1", name: "x", title: "CEO", isDirector: true, isOfficer: true, isTenPercentOwner: true }),
    "CEO · Director · 10% Owner",
  );
  assert.equal(describeOwner({ cik: "1", name: "x", title: null, isDirector: false, isOfficer: true, isTenPercentOwner: false }), "Officer");
  assert.equal(describeOwner({ cik: "1", name: "x", title: null, isDirector: false, isOfficer: false, isTenPercentOwner: false }), null);
});

test("buildTickerCikMap handles the keyed-object company_tickers.json shape", () => {
  const map = buildTickerCikMap({
    "0": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" },
    "1": { cik_str: 320193, ticker: "aapl", title: "Apple Inc." },
  });
  assert.equal(map.get("NVDA")?.cik, "0001045810");
  assert.equal(map.get("AAPL")?.cik, "0000320193");
});

test("form4ToTransactions aggregates lots of one filing into a VWAP print", () => {
  const base = fixture("edgar-form4-aapl-sale.xml");
  const lot = /<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/.exec(base)![0];
  const secondLot = lot
    .replace("<value>1438</value>", "<value>562</value>")
    .replace("<value>317.23</value>", "<value>320</value>")
    .replace("<value>34352</value>", "<value>33790</value>");
  const thirdLotOtherDay = lot
    .replace("<value>2026-09-08</value>", "<value>2026-09-09</value>")
    .replace("<value>1438</value>", "<value>100</value>");
  const xml = base.replace(lot, `${lot}${secondLot}${thirdLotOtherDay}`);
  const ref = { accessionNumber: "0001140361-26-036226", acceptanceDateTime: "2026-09-10T22:30:31.000Z", filingDate: "2026-09-10" };

  const rows = form4ToTransactions(parseForm4Xml(xml), ref);
  assert.equal(rows.length, 2, "same code+date lots merge; a different day stays separate");
  const [merged, other] = rows;
  assert.equal(merged.id, "edgar-0001140361-26-036226-0");
  assert.equal(merged.sharesAmount, 2000);
  assert.equal(merged.transactionValue, 636016.74);
  assert.equal(merged.pricePerShare, 318.0084);
  assert.equal(merged.sharesOwnedAfter, 33790, "post-transaction holding comes from the last lot");
  assert.equal(other.transactionDate, "2026-09-09");
  assert.equal(other.sharesAmount, 100);

  const raw = form4ToTransactions(parseForm4Xml(xml), ref, { aggregate: false });
  assert.equal(raw.length, 3);
});
