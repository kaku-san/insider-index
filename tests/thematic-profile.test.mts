import assert from "node:assert/strict";
import test from "node:test";
import { getThematicView, listThematicViews, thematicDirectory } from "../src/lib/thematic/views.ts";
import {
  NO_INDEX_PEOPLE,
  noIndexExplanation,
  noIndexReason,
  personIndexUnavailable,
} from "../src/lib/frontend/no-index-people.ts";

test("thematic profile views carry the data a person-quality profile page needs", () => {
  const views = listThematicViews();
  assert.equal(views.length, 10);
  for (const view of views) {
    // Research-model state, never fundable.
    assert.equal(view.status, "RESEARCH_MODEL");
    assert.equal(view.fundable, false);
    // Constituents with weight + venue.
    assert.ok(view.constituents.length >= 3);
    for (const leg of view.constituents) {
      assert.ok(leg.ticker);
      assert.ok(leg.issuer === "xstock" || leg.issuer === "backpack");
      assert.ok(leg.weight_bps > 0);
    }
    assert.equal(view.constituents.reduce((sum, c) => sum + c.weight_bps, 0), 10_000);
    // Member roster the page can link to /p/[id].
    assert.ok(view.members.length >= 3);
    for (const member of view.members) {
      assert.match(member.bioguideId ?? "", /^[A-Z][0-9]{6}$/);
    }
    // Source + as-of date.
    assert.ok(view.sourceGeneratedAt);
    assert.ok(!Number.isNaN(new Date(view.sourceGeneratedAt).getTime()));
    assert.ok(view.sources.websiteFooterBlock.length >= 1);
  }
});

test("thematic directory advertises the research-only, non-fundable distinction", () => {
  const dir = thematicDirectory();
  assert.equal(dir.count, 10);
  assert.equal(dir.status, "RESEARCH_MODEL");
  assert.equal(dir.fundable, false);
  for (const entry of dir.indexes) {
    assert.equal(entry.status, "RESEARCH_MODEL");
    assert.equal(entry.fundable, false);
    assert.match(entry.href, /^\/indexes\/idx-theme-/);
  }
});

test("thematic detail resolves by slug and by full id", () => {
  const bySlug = getThematicView("mag7-caucus");
  const byId = getThematicView("idx-theme-mag7-caucus");
  assert.ok(bySlug);
  assert.ok(byId);
  assert.equal(bySlug.id, byId.id);
  assert.equal(getThematicView("not-a-real-theme"), null);
});

test("a research thematic index never reads as a fundable person index", () => {
  // Person indexes are the fundable/vault-candidate family; thematic are research-only.
  for (const view of listThematicViews()) {
    assert.equal(view.fundable, false);
    assert.equal(view.basis, "insiderindex-thematic");
    assert.notEqual(view.status, "Published");
  }
});

test("the ten no-position-book politicians are handled deliberately, not as dead ends", () => {
  assert.equal(NO_INDEX_PEOPLE.length, 10);
  const ids = new Set(NO_INDEX_PEOPLE.map((p) => p.id));
  assert.equal(ids.size, 10, "bioguide ids are unique");
  for (const person of NO_INDEX_PEOPLE) {
    assert.match(person.id, /^[A-Z][0-9]{6}$/);
    assert.ok(person.reason === "no-holdings-book" || person.reason === "trades-only");
    assert.ok(personIndexUnavailable(person.id));
    const explanation = noIndexExplanation(person);
    // Honest copy: names the person, never claims an investable index or a return.
    assert.ok(explanation.includes(person.name.split(",")[0]));
    assert.doesNotMatch(explanation, /invest|return|NAV|deposit/i);
  }
  // The six no-holdings-book vs four trades-only split from the disclosure record.
  assert.equal(NO_INDEX_PEOPLE.filter((p) => p.reason === "no-holdings-book").length, 6);
  assert.equal(NO_INDEX_PEOPLE.filter((p) => p.reason === "trades-only").length, 4);
});

test("people with a published book are not flagged as no-index", () => {
  // Pelosi (P000197) has a mappable book; she must never be in the no-index set.
  assert.equal(personIndexUnavailable("P000197"), false);
  assert.equal(noIndexReason("P000197"), null);
});
