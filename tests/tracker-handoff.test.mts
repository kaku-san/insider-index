import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeTrackerHandoff, trackerAmountBand, trackerSummary, TRACKER_AS_OF } from "../src/lib/tracker/tracker-parse.ts";

const BUCKET = new URL("../data/insiderindex-source-buckets/pelositracker-top20-handoff/", import.meta.url);
const bucketPath = (name: string) => new URL(name, BUCKET).pathname;
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const brief = JSON.parse(readFileSync(bucketPath("top20-agent-brief.json"), "utf8"));

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, `${prefix}${name}/`) : [`${prefix}${name}`];
  });
}

test("the source bucket is itemized: MANIFEST.json matches every extracted handoff file byte for byte", () => {
  const manifest = JSON.parse(readFileSync(bucketPath("MANIFEST.json"), "utf8"));
  const files = walk(BUCKET.pathname).filter((name) => name !== "MANIFEST.json");
  assert.equal(files.length, 24, "24 files came out of the zip: README, brief, directory, Pelosi JSON and 20 photos");
  assert.deepEqual(manifest.files.map((f: { path: string }) => f.path).sort(), files);
  for (const entry of manifest.files) {
    assert.equal(sha256(bucketPath(entry.path)), entry.sha256, `${entry.path} changed since the handoff`);
    assert.equal(statSync(bucketPath(entry.path)).size, entry.bytes);
  }
  assert.equal(manifest.count, 20);
  assert.equal(manifest.photos, 20);
  assert.equal(manifest.scrapedAt, brief.scrapedAt);
});

test("all 20 profiles normalize with photos mirrored into public/, unique bioguide IDs and full slices", () => {
  const handoff = normalizeTrackerHandoff(brief);
  assert.equal(handoff.count, 20);
  assert.deepEqual(handoff.issues, []);
  assert.equal(handoff.asOf, TRACKER_AS_OF);
  assert.equal(handoff.asOf, "2026-09-15");
  assert.ok(handoff.scrapedAt.startsWith("2026-09-15"));
  assert.deepEqual(handoff.partyMix, { Democrat: 6, Republican: 13, Independent: 1 });
  assert.equal(new Set(handoff.profiles.map((p) => p.id)).size, 20);
  assert.deepEqual(handoff.profiles.map((p) => p.rank), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(handoff.profiles[0].id, "P000197");
  assert.equal(handoff.profiles[0].name, "Nancy Pelosi");
  for (const profile of handoff.profiles) {
    const publicPhoto = new URL(`../public${profile.photo.local}`, import.meta.url).pathname;
    assert.equal(sha256(publicPhoto), sha256(bucketPath(`photos/${profile.slug}.jpg`)), `${profile.slug} photo mirrored verbatim`);
    assert.equal(profile.topHoldings.length, 5);
    assert.equal(profile.recentTrades.length, 10);
    assert.ok(profile.sectors.length >= 1);
    assert.ok(profile.performance.points.length > 300);
    assert.equal(profile.sourceLabel, "PelosiTracker");
    assert.match(profile.portfolio.label, /not net worth · not vault NAV/);
    assert.ok(profile.portfolio.valueUsd! > 0);
    // Tracker $ values are not summed into any total by the parser.
    assert.equal(Object.keys(profile.portfolio).sort().join(","), "cashUsd,label,monthlyChangePercent,valueUsd");
  }
  // Senate rows carry zero/null filing stats from the tracker → "not tracked", never "0 filings".
  const scott = handoff.profiles.find((p) => p.id === "S001217")!;
  assert.equal(scott.chamber, "senate");
  assert.equal(scott.filingStats.tracked, false);
  const pelosi = handoff.profiles[0];
  assert.equal(pelosi.filingStats.tracked, true);
  assert.equal(pelosi.filingStats.totalFilings, 65);
  assert.equal(pelosi.performance.leadingZeroPoints, 125);
  assert.equal(pelosi.performance.points.length, 2550);
  const greene = handoff.profiles.find((p) => p.id === "G000596")!;
  assert.equal(greene.currentMember, false);
  const summary = trackerSummary(pelosi);
  assert.deepEqual(summary.topTickers, ["NVDA", "AMZN", "MSFT", "AVGO", "GOOG"]);
  assert.equal(summary.portfolioValueUsd, 314903941);
  assert.match(summary.portfolioValueLabel, /PelosiTracker/);
});

test("trade amounts decode to disclosure bands; anomalies are flagged, kept and never repaired", () => {
  assert.deepEqual(trackerAmountBand(8000.5), { low: 1001, high: 15000 });
  assert.deepEqual(trackerAmountBand(3000000.5), { low: 1000001, high: 5000000 });
  assert.equal(trackerAmountBand(1750.5), null);
  assert.equal(trackerAmountBand(0), null);
  assert.equal(trackerAmountBand("8000.5"), null);
  const handoff = normalizeTrackerHandoff(brief);
  const hern = handoff.profiles.find((p) => p.id === "H001082")!;
  const labelled = hern.recentTrades.filter((t) => t.date === null);
  assert.equal(labelled.length, 8);
  assert.ok(labelled.every((t) => t.flags.includes("non-date-label") && /semi-annually|monthly|Quarterly/.test(t.dateLabel)));
  const letlow = handoff.profiles.find((p) => p.id === "L000595")!;
  const future = letlow.recentTrades.find((t) => t.date === "2026-10-31")!;
  assert.ok(future.flags.includes("after-scrape-date"));
  assert.ok(future.flags.includes("unknown-band"));
  assert.equal(future.amountEstimateUsd, 1750.5);
  assert.equal(future.amountBand, null);
  const pelosiBuy = handoff.profiles[0].recentTrades[0];
  assert.equal(pelosiBuy.side, "buy");
  assert.equal(pelosiBuy.ticker, "BE");
  assert.deepEqual(pelosiBuy.amountBand, { low: 500001, high: 1000000 });
  const mcclain = handoff.profiles.find((p) => p.id === "M001136")!;
  assert.ok(mcclain.recentTrades.some((t) => t.filingStatus === null && t.flags.includes("filing-status-missing")));
});

test("malformed input is reported as issues, not invented rows", () => {
  const handoff = normalizeTrackerHandoff({ source: "elsewhere", scrapedAt: "2020-01-01T00:00:00Z", count: 2, top20: [{ slug: "x", rank: 1, bioguideId: "X000001" }, { rank: 2 }], profiles: { x: { slug: "x", bioguideId: "bad", name: "X" } } });
  assert.equal(handoff.count, 0);
  assert.ok(handoff.issues.some((issue) => /source is elsewhere/.test(issue)));
  assert.ok(handoff.issues.some((issue) => /not 2026-09-15/.test(issue)));
  assert.ok(handoff.issues.some((issue) => /profile missing or invalid for x/.test(issue)));
  assert.ok(handoff.issues.some((issue) => /without slug/.test(issue)));
});
