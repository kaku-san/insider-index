import Image from "next/image";
import styles from "./ecosystem-logos.module.css";
const integrations = [
  {
    "id": "solana",
    "name": "Solana",
    "role": "Network",
    "href": "https://solana.com"
  },
  {
    "id": "raydium",
    "name": "Raydium",
    "role": "Pool execution",
    "href": "https://raydium.io"
  },
  {
    "id": "jupiter",
    "name": "Jupiter",
    "role": "Swap routing",
    "href": "https://jup.ag"
  },
  {
    "id": "privy",
    "name": "Privy",
    "role": "Wallet connection",
    "href": "https://privy.io"
  },
  {
    "id": "xstocks",
    "name": "xStocks",
    "role": "Stock tokens",
    "href": "https://xstocks.fi"
  },
  {
    "id": "backpack",
    "name": "Backpack",
    "role": "Stock-token catalog",
    "href": "https://backpack.exchange"
  },
  {
    "id": "symmetry",
    "name": "Symmetry",
    "role": "Vault infrastructure",
    "href": "https://symmetry.fi"
  },
  {
    "id": "fmp",
    "name": "FMP",
    "role": "Disclosure data",
    "href": "https://site.financialmodelingprep.com"
  }
] as const;
/** Technology attribution, not a partner/sponsor strip. All files are served locally. */
export function EcosystemLogos() {
  return <section className={styles.section} aria-labelledby="ecosystem-title">
    <div className={styles.heading}><h2 id="ecosystem-title">Built on Solana.</h2><p>The infrastructure behind the indexes.</p></div>
    <div className={styles.logos}>{integrations.map(item => <a key={item.id} href={item.href} target="_blank" rel="noreferrer noopener" aria-label={`${item.name}: ${item.role}`}>
      <span className={`${styles.mark} ${styles[item.id] ?? ""} ${item.id === "xstocks" ? styles.darkMark : ""}`}><Image src={`/brand/integrations/${item.id}.svg`} alt="" width={36} height={36} unoptimized /></span>
      <span className={styles.labels}><strong>{item.name}</strong><small>{item.role}</small></span>
    </a>)}</div>
    <p className={styles.note}>Technology references only. No affiliation or endorsement is implied.</p>
  </section>;
}
