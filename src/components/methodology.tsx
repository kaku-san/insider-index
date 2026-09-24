import Link from 'next/link';
import {Breadcrumb} from './social/shared';
import styles from './methodology.module.css';

const topics = [
  {
    id: 'full-book',
    label: 'The complete book',
    title: 'Every reported asset stays visible',
    takeaway: 'The disclosed book is bigger than the investable basket.',
    points: [
      'Holdings are loaded independently of token coverage; a mint catalog adds context, never filters the original book.',
      'Transactions, holdings, options and missing values remain distinct—not interchangeable evidence of what someone owns today.',
      'Excluded holdings stay in Allocation, even when the vault cannot buy them.',
    ],
  },
  {
    id: 'dollar-ranges',
    label: 'Reading dollar ranges',
    title: 'Dollar ranges are not share counts',
    takeaway: 'A reported trade band describes dollars, not a precise position.',
    points: [
      'A transaction disclosure does not establish how many shares are still held, and its dollar range is not multiplied by a share price.',
      'Reported share ownership can be valued using a sourced, timestamped price; different owners and instruments stay separate.',
      'Repeated Form 4 “shares owned after” values are snapshots, not amounts to add together.',
    ],
    example: '$15,000–$50,000 is a disclosed dollar range—not 15,000–50,000 shares.',
  },
  {
    id: 'asset-value',
    label: 'Value, not net worth',
    title: 'Asset value is not personal net worth',
    takeaway: 'A partial disclosure cannot tell you someone’s total wealth.',
    points: [
      'Reconstructing current holdings needs an opening balance, subsequent transactions, ownership identities, amendments and corporate actions.',
      'Private assets, debts and unreported accounts may be absent from the source.',
      'Read disclosed asset ranges alongside their coverage and missing-data labels; unknown does not mean $0.',
    ],
  },
  {
    id: 'index-weights',
    label: 'Building the weights',
    title: 'How a person index gets its weights',
    takeaway: 'Saved holdings—not the trade feed—supply the allocation.',
    points: [
      'A published annual-holdings person index starts with the latest saved annual snapshot and groups eligible mapped stock and ETF rows by verified Solana mint.',
      'If every mapped holding has a usable positive closed value band, their midpoints are summed by mint and normalized to 100%.',
      'If any mapped holding lacks that band, the mapped basket uses clearly labelled equal weights instead; missing values are not filled with trade dollars.',
      'Unmapped holdings and partial-book warnings stay visible, and publishing research does not mean a vault is ready for deposits.',
    ],
  },
  {
    id: 'mint-verification',
    label: 'Identity vs. liquidity',
    title: 'Mint verification is not execution approval',
    takeaway: 'The right token address is only the first check.',
    points: [
      'The catalog prefers issuer-listed xStocks, with verified Backpack on-chain .US tokens as fallback for the same underlying.',
      'Brokerage-only symbols, random DEX lookalikes, Ondo, Superstate and PreStocks are not buy-catalog substitutes; options are not silently copied as shares.',
      'Quotes can fail because of liquidity, market hours, jurisdiction or transfer restrictions, without removing the disclosed holding.',
      'Current on-chain vault readiness and safety checks—not catalog membership or historical route evidence—govern investing.',
    ],
  },
  {
    id: 'sources',
    label: 'Sources & completeness',
    title: 'Sources and completeness',
    takeaway: 'Every source has a date, a scope and gaps.',
    points: [
      'Profiles prefer the complete saved FMP annual book, falling back to dated PelosiTracker holdings when no annual book is available.',
      'The public disclosure feed uses committed PelosiTracker/FMP data; live EDGAR and AInvest feed lanes are off, not silently presented as current.',
      'Tracker slices and constructed multi-member themes keep their own provenance; they are not added to annual books or presented as one person’s complete holdings.',
      'Disclosures can be delayed or incomplete, and missing values or performance series remain unavailable—not invented balances or returns.',
    ],
  },
];

const investingSteps = [
  {
    title: 'Choose the tradable slice',
    text: 'Review the complete book and its exclusions. The vault holds only the verified, route-supported slice, with retained stock weights renormalized; an index without a ready vault remains research.',
  },
  {
    title: 'Sign a USDC deposit',
    text: 'One user signature deposits USDC into our Solana NAV vault. The entry fee is deducted and proportional Token-2022 shares are minted atomically at vault value.',
  },
  {
    title: 'The keeper buys the stocks',
    text: 'A separate keeper invests and rebalances through Jupiter, with Raydium fallback, while maintaining a USDC buffer. New shares may initially represent cash awaiting investment.',
  },
  {
    title: 'Shares track stocks + cash',
    text: 'Net asset value (NAV) is free USDC plus stock inventory valued at keeper-posted prices, excluding assets reserved for withdrawals. These marks come from Raydium/Jupiter, not an independent oracle.',
  },
  {
    title: 'Start a cash-out with one signature',
    text: 'With fresh prices and enough free USDC, shares burn for immediate USDC. Otherwise, a request reserves your pro-rata assets for keeper conversion and settlement; untradable stock can be delivered in kind, and later or large claims may need extra signatures.',
  },
];

export function Methodology() {
  return (
    <article className={styles.page}>
      <Breadcrumb label="Methodology" />
      <header className={styles.hero}>
        <p className={styles.eyebrow}>SHOW THE WORK. KEEP THE UNCERTAINTY.</p>
        <h1>What’s in a<br />disclosed book?</h1>
        <p className={styles.intro}>Public filings are a starting point, not a live portfolio. Here’s how we read the evidence, build an index and keep what’s disclosed separate from what you can invest in.</p>
        <ol className={styles.overview} aria-label="From research to investment">
          <li><span className={styles.overviewLabel}>01 / RESEARCH</span><strong>Disclosed book</strong><span>Keep the whole picture.</span></li>
          <li><span className={styles.overviewLabel}>02 / SELECTION</span><strong>Tradable slice*</strong><span>Label what’s left out.</span></li>
          <li><span className={styles.overviewLabel}>03 / INVESTMENT</span><strong>NAV vault shares</strong><span>Own a share of stocks + cash.</span></li>
        </ol>
        <p className={styles.overviewNote}>*Excluded holdings stay visible in the full book; they are not held by the vault.</p>
      </header>

      <div className={styles.layout}>
        <nav className={styles.contents} aria-label="On this page">
          <p className={styles.eyebrow}>ON THIS PAGE</p>
          <ol>
            {topics.map((topic, index) => <li key={topic.id}><a href={`#${topic.id}`}><span aria-hidden="true">0{index + 1}</span>{topic.label}</a></li>)}
            <li><a href="#how-investing-works" className={styles.investingLink}><span aria-hidden="true">07</span>How investing works</a></li>
          </ol>
        </nav>

        <div className={styles.sections}>
          {topics.map((topic, index) => (
            <section key={topic.id} id={topic.id} className={styles.card} aria-labelledby={`${topic.id}-title`}>
              <div className={styles.sectionHeading}>
                <span className={styles.sectionNumber} aria-hidden="true">0{index + 1}</span>
                <h2 id={`${topic.id}-title`}>{topic.title}</h2>
              </div>
              <p className={styles.takeaway}><strong>{topic.takeaway}</strong></p>
              <ul className={styles.points}>{topic.points.map(point => <li key={point}>{point}</li>)}</ul>
              {topic.example && <aside className={styles.example}><span className={styles.eyebrow}>FOR EXAMPLE</span><p>{topic.example}</p></aside>}
            </section>
          ))}

          <section id="how-investing-works" className={`${styles.card} ${styles.investing}`} aria-labelledby="investing-title">
            <div className={styles.sectionHeading}>
              <span className={styles.sectionNumber} aria-hidden="true">07</span>
              <h2 id="investing-title">How investing works</h2>
            </div>
            <p className={styles.takeaway}><strong>USDC in. Shares in a vault of stocks and cash.</strong></p>
            <p className={styles.sectionIntro}>You invest through our NAV vault on Solana—not directly into a politician’s account. Here’s the path from deposit to exit.</p>
            <ol className={styles.steps}>
              {investingSteps.map((step, index) => (
                <li key={step.title}>
                  <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>
                  <div><h3>{step.title}</h3><p>{step.text}</p></div>
                </li>
              ))}
            </ol>
            <aside className={styles.sliceNote}>
              <span className={styles.asterisk} aria-hidden="true">*</span>
              <p><strong>The asterisk matters.</strong> Asterisked holdings are excluded from the tradable slice, not erased from the disclosed book. The remaining stock weights are scaled to the slice; the cash buffer means your vault allocation can differ from those stock targets.</p>
            </aside>
            <dl className={styles.terms}>
              <div><dt>0.25% <span>entry fee</span></dt><dd>Deducted from deposited USDC to fund keeper trade costs. Network and trading costs also apply.</dd></div>
              <div><dt>5% <span>USDC buffer</span></dt><dd>A configured cash floor for buys, not a promise of instant liquidity or a fixed cash balance.</dd></div>
              <div><dt>60 seconds <span>price freshness</span></dt><dd>Mainnet marks expire after this window. Stale prices block deposits and instant USDC withdrawals.</dd></div>
            </dl>
            <aside className={styles.risk} aria-labelledby="risk-title">
              <p className={styles.eyebrow}>KNOW THE LIMITS</p>
              <h3 id="risk-title">Unaudited. Upgradeable. Not risk-free.</h3>
              <p>Keeper-posted prices, token issuers, liquidity and program bugs all carry risk. Admins have privileged pause, price-override and holder-only in-kind refund powers. Neither principal nor a timely, USDC-only exit is guaranteed.</p>
            </aside>
          </section>
          <footer className={styles.endnote}>
            <p>Research first. Not investment advice.</p>
            <Link href="/">Explore the indexes <span aria-hidden="true">→</span></Link>
          </footer>
        </div>
      </div>
    </article>
  );
}
