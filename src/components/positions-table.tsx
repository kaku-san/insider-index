"use client";
import { usePrivySolana } from "./providers/privy-provider";
import { useResource } from "@/lib/frontend/use-resource";
import { DEVNET_TEST_VAULT } from "@/lib/index-vaults/devnet-contract";
import { formatVaultShares } from "@/lib/index-vaults/positions-contract";
import type { DevnetVaultPosition } from "@/lib/index-vaults/positions-contract";
import { Icon } from "./social/icon";
import { PageError, Skeleton } from "./social/shared";
import { WalletButton } from "./wallet-button";
import { shortenAddress } from "@/lib/format";
import styles from "./disclosure-workspace.module.css";

export function PositionsTable() {
  const wallet = usePrivySolana();
  const connected = wallet.mode === "live" && wallet.authenticated && wallet.solanaAddress;
  return <div className={styles.workspace}>
    <header className={styles.indexHero}><span className={styles.kicker}>Devnet · On-chain shares</span><h1>My positions</h1><p>Your wallet’s shares in the existing devnet test vault. Not trade receipts.</p></header>
    {connected ? <WalletPositions key={connected} address={connected} /> : <section className={styles.empty}>
      <Icon name="wallet" size={38} /><h2 className={styles.connectTitle}>Connect to read your shares.</h2>
      <p>{wallet.mode === "unavailable" ? "Wallet connection is unavailable. Retry to reload Privy. We won’t substitute a demo wallet." : "Connect a live Solana wallet through Privy to read its devnet vault share balance. Preview wallets are not used for positions."}</p>
      <WalletButton /><p className={styles.finePrint}>Connecting doesn’t move funds or approve a trade.</p>
    </section>}
    <p className={styles.finePrint}>Devnet test assets only. Share balances are not a dollar valuation. NAV, portfolio value and profit-and-loss are unavailable. Pending deposits and Jupiter fills are not counted as shares. Deposits and withdrawals remain disabled.</p>
  </div>;
}

function WalletPositions({ address }: { address: string }) {
  const resource = useResource<{ position: DevnetVaultPosition }>(`/api/positions?wallet=${encodeURIComponent(address)}`);
  // Never present a previous observation as a successful refresh after an RPC failure.
  const position = !resource.loading && !resource.error ? resource.data?.position : null;
  const identityMatches = position?.owner === address && position.identity.network === "devnet" &&
    position.identity.vaultAccount === DEVNET_TEST_VAULT.vaultAccount && position.identity.shareMint === DEVNET_TEST_VAULT.shareMint;
  return <>
    <div className={styles.sourceStrip}><span><Icon name="wallet" size={16} />{shortenAddress(address, 6)}</span><button className={styles.refreshButton} onClick={resource.reload} disabled={resource.loading}>Refresh shares <Icon name="refresh" size={15} /></button></div>
    {resource.error && <PageError error={resource.error} retry={resource.reload} />}
    {resource.loading && <Skeleton cards={2} />}
    {position && !identityMatches && <PageError error="Vault observation identity mismatch. No balance is shown." retry={resource.reload} />}
    {position && identityMatches && <>
      <dl className={styles.positionMetrics}><div><dt>Vault shares</dt><dd>{formatVaultShares(position.shareBalanceRaw, position.shareDecimals)}</dd><small>Confirmed devnet token accounts</small></div><div><dt>NAV / share</dt><dd>Unavailable</dd><small>No verified dollar valuation</small></div><div><dt>Portfolio value</dt><dd>Unavailable</dd><small>Not inferred from fills</small></div></dl>
      {position.shareBalanceRaw === "0" && <section className={styles.empty}><h2>No vault shares held.</h2><p>This wallet holds zero shares of this test vault at the observed slot. This does not describe other wallet assets or pending claims.</p></section>}
      <section className={styles.section}>
        <div className={styles.sectionHead}><h2>{position.identity.name}</h2></div>
        <p className={styles.finePrint}>Observed at {position.observedAt} · Confirmed slot {position.observedSlot}</p>
        <p>Vault: <a href={`https://explorer.solana.com/address/${position.identity.vaultAccount}?cluster=devnet`} target="_blank" rel="noreferrer"><code className={styles.mint}>{position.identity.vaultAccount}</code></a></p>
        <p>Share mint: <a href={`https://explorer.solana.com/address/${position.identity.shareMint}?cluster=devnet`} target="_blank" rel="noreferrer"><code className={styles.mint}>{position.identity.shareMint}</code></a></p>
        {position.nativeIntent && <p role="status">A native operation is pending reconciliation. Its deposits or claims are not added to your share balance. Recovery is not enabled in the app.</p>}
      </section>
    </>}
  </>;
}
