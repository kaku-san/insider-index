# InsiderIndex Consumer Design System

## Direction

Final direction: **consumer social finance with Public.com-inspired investing ergonomics**.

Public is the UI/UX reference for asset identity, portfolio breakdown, allocation rows, and investment review. We borrow the information architecture and interaction clarity — **not Public's branding or visual identity**.

- Market Social owns discovery, people, following, sharing and interaction.
- Editorial owns typography, composition, restraint and storytelling.
- Consumer Wealth owns investment review, risk language and trust states.

The product should be identifiable with the logo removed.

## Brand primitives

- Canvas: warm off-white / warm near-black in dark mode.
- Ink: near black.
- Brand accent: **signal orange / vermilion**. It must not be confused with green/red market semantics.
- Asset identity: every company row uses a recognizable company mark where available, with a ticker fallback rather than a blank square.
- Positive/negative: green/red **semantic only**.
- Typography: consumer sans, tight display spacing, tabular numbers where values are comparable.
- Containers: use borders and hierarchy before shadows. Do not put every section in a card.
- Radius vocabulary: small controls, medium cards, large sheets only.

## Signature UI

1. **Large people** — editorial portraits instead of tiny avatars.
2. **Person-index identity** — the person is the hook; the published target is the financial object.
3. **Asset-first finance** — company marks, ticker, company name and weight scan before secondary metadata.
4. **Event-aware finance** — transaction/filed/source clocks are visible instead of collapsed.
5. **Share-ready compositions** — person pages and share surfaces should survive a screenshot.

## Motion

Motion explains change; it does not decorate the page.

- button press: subtle scale response
- popovers/sheets originate spatially from the trigger
- chart range changes may transition once a real series exists
- expand/collapse rows may animate height/content
- no page-wide fade-up choreography
- no animation for routine data rows
- respect `prefers-reduced-motion`

## Anti-slop rules

Never default to:

- gradient blob hero backgrounds
- glassmorphism everywhere
- purple crypto palettes
- green as the brand color simply because the product is finance
- cards around every metric
- pill badges for every noun
- fake sparklines
- icon-in-colored-square section headings
- giant empty whitespace presented as “premium”
- glow borders
- animated viewport entrances on every section
- invented performance, NAV or follower counts

## Page hierarchy

### Home

1. Explain the premise in one glance.
2. Show people/indexes.
3. Show the public paper trail.
4. Expose the full directory.
5. Explain the mission once, briefly.

Home is **research/discovery**. It must not imply model indexes are buyable in the current wave.

### Person

1. Who is this / what is this index?
2. What verified data exists?
3. Performance if and only if supportable.
4. What is mapped into the target?
5. What did they disclose recently?
6. Full source book.
7. Methodology / four clocks.
8. Disabled investment rail until a real vault exists.

### Feed

A social transaction tape, not another dashboard. Copy only appears on genuinely eligible disclosure rows.

### Positions

Keep signed copy-fill receipts and vault-share balances visually and conceptually separate.

## Review questions

- With the logo hidden, does this still look like InsiderIndex?
- Would someone screenshot/share this?
- Would someone trust it with money?
- Can a non-finance user understand the object?
- Is the UI making a claim the data cannot support?
- Does every animation explain something?

## Public-inspired component rules

- Performance and allocation are separate jobs: line charts answer **how it moved**; the segmented allocation strip answers **what it contains**.
- Use a compact **Breakdown by asset** visualization before the full allocation list.
- Full allocation rows use company mark → ticker/company → weight visualization → exact weight.
- Order flows should feel like a consumer brokerage ticket: clear side, amount, review, fees, explicit approval.
- Do not copy Public colors, typography, logos, or marketing copy.
