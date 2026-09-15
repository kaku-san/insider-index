import type { CandidateAsset, Network } from "./adapter-contract.ts";
import { address, rawAmount } from "./amounts.ts";

export type ReadinessStatus = "READY" | "MARKET_HOURS_ONLY" | "NO_SUPPORTED_ORACLE" | "NO_BUY_ROUTE" | "NO_SELL_ROUTE" | "TRANSFER_BLOCKED" | "EXTENSION_UNSUPPORTED" | "PRICE_BASIS_UNKNOWN" | "UNTESTED";
export interface MintReadinessEvidence {
  network: Network; mint: string; tokenProgram: string; decimals: number;
  catalogVerified: boolean; extensions: string[]; testedExtensions: string[];
  freezeAuthority: string | null; permanentDelegate: string | null; paused: boolean;
  oracleAccount: string; oracleSupported: boolean; priceBasis: CandidateAsset["priceBasis"];
  denomination: "USD" | "USDC"; priceTimestamp: number; confidenceBps: number;
  multiplier: string | null; multiplierTimestamp: number | null; proxyDivergenceTested: boolean;
  vaultTokenSupported: boolean; depositTransferSimulation: boolean; claimTransferSimulation: boolean;
  usdcToTokenRoute: boolean; tokenToUsdcRoute: boolean; buyAmountRaw: string; sellAmountRaw: string;
  observedSlot: number; observedAt: number; marketOpen: boolean;
}
export function assessReadiness(candidate: CandidateAsset, evidence: MintReadinessEvidence | undefined, policy: { network: Network; now: number; maxAgeMs: number; maxConfidenceBps: number; buyAmountRaw: string; sellAmountRaw: string }): { status: ReadinessStatus; reasons: string[] } {
  if (![policy.now, policy.maxAgeMs, policy.maxConfidenceBps].every(Number.isFinite) || policy.maxAgeMs <= 0 || policy.maxConfidenceBps < 0 || policy.maxConfidenceBps > 10_000) throw new Error("Invalid readiness policy bounds");
  const reasons: string[] = [];
  if (!evidence) return { status: "UNTESTED", reasons: ["No mint-specific native evidence"] };
  const e = evidence;
  let status: ReadinessStatus = "READY";
  const block = (s: ReadinessStatus, reason: string) => { if (status === "READY") status = s; reasons.push(reason); };
  address(candidate.mint); address(candidate.tokenProgram); address(candidate.oracle.account);
  if (e.network !== policy.network || e.mint !== candidate.mint || e.tokenProgram !== candidate.tokenProgram || e.decimals !== candidate.decimals || e.oracleAccount !== candidate.oracle.account || e.denomination !== candidate.oracle.denomination || e.priceBasis !== candidate.priceBasis || !e.catalogVerified) block("UNTESTED", "Exact network/catalog/mint/program/decimals/oracle identity mismatch");
  if (!Number.isSafeInteger(e.observedSlot) || e.observedSlot < 1 || !Number.isFinite(e.observedAt) || policy.now - e.observedAt > policy.maxAgeMs || e.observedAt > policy.now) block("UNTESTED", "Readiness observation stale or invalid");
  if (e.extensions.some(x => !e.testedExtensions.includes(x))) block("EXTENSION_UNSUPPORTED", "Untested mint extension");
  if (e.paused || !e.vaultTokenSupported || !e.depositTransferSimulation || !e.claimTransferSimulation) block("TRANSFER_BLOCKED", "Native deposit and second-wallet claim transfers must both succeed");
  if (e.priceBasis === "unknown" || (e.priceBasis === "underlying-proxy" && !e.proxyDivergenceTested) || (e.priceBasis === "scaled-ui-token" && (!e.multiplier || !Number.isFinite(Number(e.multiplier)) || Number(e.multiplier) <= 0 || !e.multiplierTimestamp || e.multiplierTimestamp > policy.now || policy.now - e.multiplierTimestamp > policy.maxAgeMs))) block("PRICE_BASIS_UNKNOWN", "Price/multiplier or proxy divergence basis unproved");
  if (!e.oracleSupported) block("NO_SUPPORTED_ORACLE", "No supported native oracle");
  if (!Number.isFinite(e.priceTimestamp) || e.priceTimestamp > policy.now || policy.now - e.priceTimestamp > policy.maxAgeMs || !Number.isFinite(e.confidenceBps) || e.confidenceBps < 0 || e.confidenceBps > policy.maxConfidenceBps) block("NO_SUPPORTED_ORACLE", "Stale or unconfident native price");
  if (e.priceBasis === "underlying-proxy" && !e.marketOpen) block("MARKET_HOURS_ONLY", "Underlying proxy outside verified market session");
  if (!e.usdcToTokenRoute || rawAmount(e.buyAmountRaw) < rawAmount(policy.buyAmountRaw, true)) block("NO_BUY_ROUTE", "Buy route not verified at intended size");
  if (!e.tokenToUsdcRoute || rawAmount(e.sellAmountRaw) < rawAmount(policy.sellAmountRaw, true)) block("NO_SELL_ROUTE", "Sell route not verified at intended size");
  return { status, reasons };
}
