import { MINTS } from "@symmetry-hq/sdk/dist/constants.js";
import { HOST_ENTRY_FEE_BPS, HOST_EXIT_FEE_BPS } from "./fees.ts";
import { WSOL_MINT } from "./raydium-oracles.ts";

/** Approved deployer / host. Anyone else is refused. Server never holds this key. */
export const KAKU_SAN_DEPLOYER = "H6pLh8nFv1teY9G6JAVQuZQxeUvGfwYf1aPXHkDPDRph";
export const KAKU_SAN_NETWORK = "mainnet-beta" as const;
export const KAKU_SAN_NAME = "Kaku San Index";
export const KAKU_SAN_SYMBOL = "KAKU";
export const KAKU_SAN_INDEX_ID = "execution-test-kaku-san";
/** SDK start_price is divided by 10^6; "1000000" → $1 bootstrap. Unverified basis. */
export const KAKU_SAN_START_PRICE = "1000000";
export const KAKU_SAN_METADATA_URI = "";
export const KAKU_SAN_LABEL = "Execution Test — not politician holdings";
/** Creation-time Symmetry defaults. Must be deactivated after create; never left on Pyth. */
export const KAKU_SAN_WSOL_MINT = WSOL_MINT;
export const KAKU_SAN_USDC_MINT = MINTS.mainnet.USDC.toBase58();
export const KAKU_SAN_DEFAULT_SLOTS = Object.freeze([
  { ticker: "WSOL" as const, mint: KAKU_SAN_WSOL_MINT },
  { ticker: "USDC" as const, mint: KAKU_SAN_USDC_MINT },
]);

export interface KakuSanAsset {
  ticker: "AAPLx" | "NVDAx" | "MSFTx" | "AMZNx" | "GOOGLx";
  mint: string;
  pool: string;
  kind: "raydium_clmm";
  targetWeightBps: 2000;
  decimals: 8;
}

/** Fixed equal 2000 bps basket. Raydium CLMM pools only; never invent a pool. */
export const KAKU_SAN_ASSETS: readonly KakuSanAsset[] = Object.freeze([
  { ticker: "AAPLx", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", pool: "CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y", kind: "raydium_clmm", targetWeightBps: 2000, decimals: 8 },
  { ticker: "NVDAx", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", pool: "49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6", kind: "raydium_clmm", targetWeightBps: 2000, decimals: 8 },
  { ticker: "MSFTx", mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", pool: "CLu4kFM4nb67xrdN7vJnMxXXir8Z5hA4HJUzPFccXjsL", kind: "raydium_clmm", targetWeightBps: 2000, decimals: 8 },
  { ticker: "AMZNx", mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", pool: "6m5aXAve4uh6Kt4ytKyCLWNMjd8PYP5vujwNCtycrUiD", kind: "raydium_clmm", targetWeightBps: 2000, decimals: 8 },
  { ticker: "GOOGLx", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", pool: "B8YAwjGYk6qidWzGBXMAxP7nYfG8g74EZ3Y4gFSsobRw", kind: "raydium_clmm", targetWeightBps: 2000, decimals: 8 },
]);

export const KAKU_SAN_RAYDIUM_POOLS = Object.freeze(
  KAKU_SAN_ASSETS.map(asset => ({ mint: asset.mint, pool: asset.pool, kind: asset.kind })),
);

export const KAKU_SAN = Object.freeze({
  deployer: KAKU_SAN_DEPLOYER,
  network: KAKU_SAN_NETWORK,
  name: KAKU_SAN_NAME,
  symbol: KAKU_SAN_SYMBOL,
  indexId: KAKU_SAN_INDEX_ID,
  startPrice: KAKU_SAN_START_PRICE,
  metadataUri: KAKU_SAN_METADATA_URI,
  label: KAKU_SAN_LABEL,
  hostEntryFeeBps: HOST_ENTRY_FEE_BPS,
  hostExitFeeBps: HOST_EXIT_FEE_BPS,
  assets: KAKU_SAN_ASSETS,
});

export function assertKakuSanDeployer(pubkey: string): string {
  if (pubkey !== KAKU_SAN_DEPLOYER) throw new Error("Only the approved deployer wallet may create this execution-test vault");
  return pubkey;
}

/** Rebalance keeper is a dedicated hot wallet. The deployer Phantom does not sign ticks. */
export function assertKakuSanKeeper(pubkey: string): string {
  if (pubkey === KAKU_SAN_DEPLOYER) throw new Error("Keeper must be a dedicated hot wallet, not the deployer");
  return pubkey;
}
