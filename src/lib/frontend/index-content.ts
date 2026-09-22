/** Curated public-facing copy supplied with the 20-index content pack. */
export type IndexContent = {
  cardHook: string;
  heroProof: string;
  portfolioIntro: string;
  coverageCopy?: string;
};

export const INDEX_CONTENT: Record<string, IndexContent> = {
  "idx-theme-beta-caucus": {
    cardHook: "The surprisingly boring one.",
    heroProof: "15 ETF positions recurring across disclosed books.",
    portfolioIntro: "A research view of the broad-market and sector ETFs that show up repeatedly in congressional disclosures.",
  },
  "idx-theme-bipartisan-handshake": {
    cardHook: "Five names that crossed the aisle.",
    heroProof: "5 equal-weight names with disclosed buys from both major parties.",
    portfolioIntro: "A deliberately thin research basket: only catalog-tradable names with disclosed buys from both Democratic and Republican members make the cut.",
  },
  "idx-theme-capitol-arsenal": {
    cardHook: "Aerospace and defense names from disclosed books.",
    heroProof: "6 aerospace and defense names found across latest annual disclosures.",
    portfolioIntro: "A sparse, rules-based research view led by Boeing and Lockheed Martin. Thin by design when the data is thin.",
  },
  "idx-theme-capitol-cluster": {
    cardHook: "When the same ticker keeps showing up on multiple buy disclosures.",
    heroProof: "25 names selected by repeated disclosed buys since 2024.",
    portfolioIntro: "The filter is recurrence across members, not purchase size. Equal weights keep one large disclosed range from dominating the research view.",
  },
  "idx-theme-dual-lock": {
    cardHook: "Held in the annual book — and bought again recently.",
    heroProof: "20 equal-weight names that pass two disclosure checks.",
    portfolioIntro: "A ticker must appear in the latest annual disclosed holdings and in a 2024+ buy disclosure to qualify.",
  },
  "idx-theme-fresh-ink": {
    cardHook: "The latest filings, while the ink is still fresh.",
    heroProof: "20 recent buy-disclosure names, weighted by disclosed size bands.",
    portfolioIntro: "Fresh Ink turns the recent purchase tape into a single research view, ranking tradable names by the midpoints of reported disclosure ranges.",
  },
  "idx-theme-house-heat": {
    cardHook: "The names that keep reappearing on the buy tape.",
    heroProof: "15 equal-weight names ranked by disclosed purchase count.",
    portfolioIntro: "House Heat ignores dollar-range size and focuses only on frequency: which tradable tickers repeatedly appear in buy disclosures.",
  },
  "idx-theme-mag7-caucus": {
    cardHook: "The mega-caps that keep showing up in disclosed books.",
    heroProof: "8 mega-cap tech names across multiple disclosed books.",
    portfolioIntro: "A research view of recurring Magnificent Seven exposure across Congress, weighted from disclosure values with per-person caps.",
  },
  "idx-theme-silicon-hill": {
    cardHook: "The Hill’s collective tech stack.",
    heroProof: "19 tradable tech names appearing across multiple disclosed books.",
    portfolioIntro: "Instead of following one famous person, Silicon Hill aggregates recurring tech holdings across members and caps each person’s influence.",
  },
  "idx-theme-whips-desk": {
    cardHook: "Cards, banks and brokers through the filing lens.",
    heroProof: "6 finance names from finance-heavy disclosed books.",
    portfolioIntro: "A concentrated research view of catalog-tradable financial companies appearing in selected disclosed books. Visa dominates the current model weight.",
  },
  "insiderindex-josh-gottheimer": {
    cardHook: "A 25-name book. Microsoft is still the main character.",
    heroProof: "25 mapped holdings. 91.1% of disclosed weight represented.",
    portfolioIntro: "The book is broad by name count, but Microsoft carries most of the mapped weight, with Meta, QQQ and Amazon behind it.",
    coverageCopy: "Tracks 91.1% of the disclosed book by weight; 8.9% is not represented because no supported Solana-tradable token is available.",
  },
  "insiderindex-julia-letlow": {
    cardHook: "53 mapped names. Diversification has entered the chat.",
    heroProof: "The widest mapped person index in the set.",
    portfolioIntro: "Apple and Microsoft are the largest positions, but the defining feature is breadth: dozens of smaller disclosed holdings survive the mapping instead of being trimmed away.",
    coverageCopy: "Tracks 89.4% of the disclosed book by weight; 10.6% is not represented because no supported Solana-tradable token is available.",
  },
  "insiderindex-kevin-hern": {
    cardHook: "Eight names. One very loud O’Reilly position.",
    heroProof: "8 mapped holdings. 89.3% of disclosed weight represented.",
    portfolioIntro: "This is a compact, highly concentrated mapped book: O’Reilly Automotive is the majority weight, with Apple a distant second.",
    coverageCopy: "Tracks 89.3% of the disclosed book by weight; 10.7% is not represented because no supported Solana-tradable token is available.",
  },
  "insiderindex-lisa-mcclain": {
    cardHook: "Index funds, Nvidia, Palantir — with a big coverage caveat.",
    heroProof: "45 mapped holdings, representing 58.8% of disclosed weight.",
    portfolioIntro: "IVV leads the mapped slice, followed by Nvidia and Palantir. More than 40% of the disclosed book has no mapped Solana token and is not represented.",
    coverageCopy: "Tracks 58.8% of the disclosed book by weight; 41.2% is not represented because no supported Solana-tradable token is available.",
  },
  "insiderindex-marjorie-taylor-greene": {
    cardHook: "52 mapped names. Almost nothing gets to dominate.",
    heroProof: "52 mapped holdings. 59.7% of disclosed weight represented.",
    portfolioIntro: "The mapped allocation is unusually spread out: the largest visible positions are only around five percent each. Roughly 40% of disclosed weight is not represented.",
    coverageCopy: "Tracks 59.7% of the disclosed book by weight; 40.3% is not represented because no supported Solana-tradable token is available.",
  },
  "insiderindex-nancy-pelosi": {
    cardHook: "The book everyone watches — rebuilt from the filing.",
    heroProof: "18 mapped holdings. 96.9% of disclosed weight represented.",
    portfolioIntro: "A concentrated mega-cap book led by Apple, with Nvidia, Salesforce, Alphabet and Amazon making up much of the rest.",
    coverageCopy: "Tracks 96.9% of the disclosed book by weight; 3.1% is not represented because no supported Solana-tradable token is available.",
  },
  "insiderindex-patrick-fallon": {
    cardHook: "Big filing. Smaller on-chain window.",
    heroProof: "21 mapped holdings, but only 33.7% of disclosed weight.",
    portfolioIntro: "FedEx and Southwest are the largest mapped positions, but the defining fact is coverage: about two-thirds of disclosed weight is outside the index.",
    coverageCopy: "Tracks 33.7% of the disclosed book by weight; 66.3% is not represented because no supported Solana-tradable token is available.",
  },
  "insiderindex-shri-thanedar": {
    cardHook: "Bitcoin ETF first. Mega-cap tech second.",
    heroProof: "9 mapped holdings. 85.1% of disclosed weight represented.",
    portfolioIntro: "IBIT is the majority weight, with Apple, Alphabet, Microsoft and Amazon making up most of the rest of the mapped book.",
    coverageCopy: "Tracks 85.1% of the disclosed book by weight; 14.9% is not represented because no supported Solana-tradable token is available.",
  },
  "insiderindex-susie-lee": {
    cardHook: "Broad filing. Narrow on-chain window.",
    heroProof: "18 mapped holdings, representing 24.2% of disclosed weight.",
    portfolioIntro: "IVV and Starbucks lead the mapped slice. The bigger story is what is not represented: about three-quarters of the disclosed book by weight has no mapped Solana token.",
    coverageCopy: "Tracks 24.2% of the disclosed book by weight; 75.8% is not represented because no supported Solana-tradable token is available.",
  },
  "insiderindex-vern-buchanan": {
    cardHook: "VOO, then a few satellites.",
    heroProof: "5 mapped holdings. 92.3% of disclosed weight represented.",
    portfolioIntro: "VOO dominates the mapped allocation, with mid-cap, infrastructure, small-cap and Japan exposure around it.",
    coverageCopy: "Tracks 92.3% of the disclosed book by weight; 7.7% is not represented because no supported Solana-tradable token is available.",
  },
};

export function indexContentFor(indexId: string): IndexContent | null {
  return INDEX_CONTENT[indexId] ?? null;
}

export function shareImageForIndex(indexId: string): string | null {
  return INDEX_CONTENT[indexId] ? `/index-assets/share/${indexId}-share.png` : null;
}
