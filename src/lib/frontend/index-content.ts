/** Consumer copy. Counts, weights, dates and availability always come from API data. */
export type IndexContent = {
  cardHook: string;
  heroProof: string;
  portfolioIntro: string;
  coverageCopy?: string;
};

export const INDEX_CONTENT: Record<string, IndexContent> = {
  "idx-theme-mag7-caucus": {
    cardHook: "The big-tech group chat.",
    heroProof: "Mega-cap tech, through the disclosure lens.",
    portfolioIntro: "A rules-based basket of Magnificent Seven companies appearing in the source disclosures. Check the published weights below; this is an index, not any one person's portfolio.",
  },
  "idx-theme-silicon-hill": {
    cardHook: "Tech, beyond the usual suspects.",
    heroProof: "A broader look at technology holdings.",
    portfolioIntro: "A technology basket drawn from multiple disclosed books. The model caps each filer's contribution rather than letting one large disclosure determine the entire mix.",
  },
  "idx-theme-capitol-cluster": {
    cardHook: "Same ticker. Different filings.",
    heroProof: "Repeated purchase disclosures, brought together.",
    portfolioIntro: "This model looks for tickers recurring in purchase disclosures across multiple filers. Equal target weights keep a single large reported dollar range from dominating the basket.",
  },
  "idx-theme-bipartisan-handshake": {
    cardHook: "The crossover episode.",
    heroProof: "Company overlap across the source disclosures.",
    portfolioIntro: "A rules-based, equal-weight basket selected from purchase disclosures by members of both major parties. Inclusion describes disclosure overlap, not political agreement or an investment endorsement.",
  },
  "idx-theme-fresh-ink": {
    cardHook: "Fresh filings. Fewer paper cuts.",
    heroProof: "The most recent purchase disclosures in the source.",
    portfolioIntro: "A model built from recent purchase disclosures in the saved source, weighted using the midpoints of reported size ranges. A newly filed transaction can still describe an older trade.",
  },
  "idx-theme-beta-caucus": {
    cardHook: "The ETF group project.",
    heroProof: "Funds that appear in the source disclosures.",
    portfolioIntro: "A basket of broad-market and sector ETFs appearing across the source books. Funds can overlap and remain exposed to market losses; more funds does not automatically mean more diversification.",
  },
  "idx-theme-whips-desk": {
    cardHook: "Your wallet’s supporting cast.",
    heroProof: "Cards, banks and financial businesses.",
    portfolioIntro: "A financial-sector model assembled from selected disclosed books. Published weights show the actual concentration; the theme name is an editorial label, not a claim about access or influence.",
  },
  "idx-theme-capitol-arsenal": {
    cardHook: "Aerospace. On the record.",
    heroProof: "Aerospace and defense in the source books.",
    portfolioIntro: "A sector basket of aerospace and defense companies appearing in the source disclosures. Inclusion does not imply advance knowledge of contracts, policy decisions or future returns.",
  },
  "idx-theme-dual-lock": {
    cardHook: "On the list. Back on the buy tape.",
    heroProof: "A holdings record and a purchase disclosure.",
    portfolioIntro: "To qualify, a ticker must appear in both the annual holdings source and the qualifying purchase-disclosure window. Two records do not establish a current position or guarantee a future return.",
  },
  "idx-theme-house-heat": {
    cardHook: "Déjà vu, but make it tickers.",
    heroProof: "Purchase frequency, not a performance ranking.",
    portfolioIntro: "An equal-weight model selected by how often tickers occur in qualifying purchase disclosures. Heat means disclosure frequency, not live order flow or expected performance.",
  },
  "insiderindex-nancy-pelosi": { cardHook: "No group chat. Just the filing.", heroProof: "An annual-disclosure index.", portfolioIntro: "Explore the supported holdings mapped from the source annual disclosure. The index weights are estimates from disclosed value ranges, not a live view of a personal brokerage account." },
  "insiderindex-josh-gottheimer": { cardHook: "Big filing. Smaller learning curve.", heroProof: "An annual-disclosure index.", portfolioIntro: "The mapped slice of the source annual disclosure, with every published holding and weight available to inspect. Review coverage to see what the index leaves out." },
  "insiderindex-julia-letlow": { cardHook: "Long filing. Shorter scroll.", heroProof: "An annual-disclosure index.", portfolioIntro: "Explore the holdings included in this disclosure-based model without searching through the filing. Holding count describes breadth, not a promise of diversification or reduced risk." },
  "insiderindex-kevin-hern": { cardHook: "See the mix, not just the headline.", heroProof: "An annual-disclosure index.", portfolioIntro: "This index maps the supported holdings in the source annual disclosure. The allocation view makes large positions visible without implying that they reflect investment skill or conviction." },
  "insiderindex-lisa-mcclain": { cardHook: "The source book, with the gaps in view.", heroProof: "An annual-disclosure index.", portfolioIntro: "A mapped slice of the source annual disclosure. Coverage matters: unsupported holdings remain outside this index and are explained in About." },
  "insiderindex-marjorie-taylor-greene": { cardHook: "Public receipts. One readable basket.", heroProof: "An annual-disclosure index.", portfolioIntro: "A disclosure-based model of the supported holdings in the saved annual filing. The source date and coverage matter more than a name or headline; this is not a current personal account." },
  "insiderindex-patrick-fallon": { cardHook: "One filing. A closer look.", heroProof: "An annual-disclosure index.", portfolioIntro: "Explore the mapped portion of the source annual disclosure. Unsupported holdings are not tracked by this index, so the basket must not be mistaken for the complete source book." },
  "insiderindex-shri-thanedar": { cardHook: "The mix behind the name.", heroProof: "An annual-disclosure index.", portfolioIntro: "See the supported holdings and published target weights drawn from the source annual disclosure. The index is an estimated model, not a copy of a live personal account." },
  "insiderindex-susie-lee": { cardHook: "Read the basket. Check the coverage.", heroProof: "An annual-disclosure index.", portfolioIntro: "This model covers only the supported part of the annual disclosure. The coverage figure and excluded holdings explain how the index differs from the full source." },
  "insiderindex-vern-buchanan": { cardHook: "Open the filing. See the funds.", heroProof: "An annual-disclosure index.", portfolioIntro: "A model built from supported annual-disclosure holdings. Funds may overlap with each other and with individual stocks; the published mix is not the same as underlying-company diversification." },
};

export type IndexProofContext = { holdingCount: number; memberCount?: number | null; coverageBps?: number | null };
/** No fallback to stale counts or percentages from the content pack. */
export function indexProofFor({ holdingCount, memberCount, coverageBps }: IndexProofContext): string {
  const count = Number.isFinite(holdingCount) ? Math.max(0, Math.trunc(holdingCount)) : 0;
  const parts = [`${count} holding${count === 1 ? "" : "s"}`];
  if (typeof memberCount === "number" && Number.isInteger(memberCount) && memberCount > 0) parts.push(`${memberCount} source filer${memberCount === 1 ? "" : "s"}`);
  if (typeof coverageBps === "number" && Number.isFinite(coverageBps) && coverageBps >= 0 && coverageBps <= 10_000) parts.push(`${(coverageBps / 100).toFixed(1)}% of disclosed weight mapped`);
  return parts.join(" · ");
}

export function indexContentFor(indexId: string): IndexContent | null { return INDEX_CONTENT[indexId] ?? null; }
export function shareImageForIndex(indexId: string): string | null {
  return INDEX_CONTENT[indexId] ? `/index-assets/share/${indexId}-share.png` : null;
}
