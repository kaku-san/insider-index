import { HUNDRED_PERCENT_BPS } from "@symmetry-hq/sdk/dist/constants.js";
import { address } from "./amounts.ts";

/** Hermes-free local copy of the SDK AND rule. Never call the SDK helper that always hits Hermes. */
export interface RebalanceTokenInput {
  mint: string;
  weight: number;
  amountRaw: bigint;
  /** Quote units per 1 raw token, already scaled. Null = this token could not be priced. */
  priceQuote: bigint | null;
  validated: boolean;
}
export interface RebalanceGateInput {
  allowAutomation: number;
  activeRebalance: bigint;
  bountyBalance: bigint;
  nowSeconds: number;
  cycleStartTime: bigint;
  cycleDuration: bigint;
  automationStart: bigint;
  automationEnd: bigint;
  lastAutomationExecutionTimestamp: bigint;
  rebalanceActivationCooldown: bigint;
  rebalanceActivationThresholdRelBps: number;
  rebalanceActivationThresholdAbsBps: number;
  bountyMint: string;
  tokens: RebalanceTokenInput[];
  /** `null` = prices were not loaded (eligibility unknown). An array, even empty, is an attempt. */
  quotesLoaded: boolean;
}
export type RebalanceDecision = { required: boolean | null; reason: string };

function asBigInt(value: { toString(): string } | string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Unsafe rebalance integer");
    return BigInt(value);
  }
  const text = typeof value === "string" ? value : value.toString();
  if (!/^-?(0|[1-9][0-9]*)$/.test(text)) throw new Error("Non-integer rebalance field");
  return BigInt(text);
}

export function evaluateRebalanceRequired(input: RebalanceGateInput): RebalanceDecision {
  if (input.allowAutomation !== 1) return { required: false, reason: "automation-disabled" };
  if (input.activeRebalance > 0n) return { required: false, reason: "active-rebalance" };
  if (input.bountyBalance === 0n) return { required: false, reason: "no-bounty" };
  if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds < 1) throw new Error("Invalid eligibility timestamp");
  const now = BigInt(input.nowSeconds);
  if (input.cycleStartTime > now) return { required: false, reason: "cycle-not-started" };
  let cycleTimestamp = now - input.cycleStartTime;
  if (input.cycleDuration !== 0n) cycleTimestamp %= input.cycleDuration;
  if (!(cycleTimestamp >= input.automationStart && cycleTimestamp < input.automationEnd)) return { required: false, reason: "outside-automation-window" };
  if (input.lastAutomationExecutionTimestamp + input.rebalanceActivationCooldown >= now) return { required: false, reason: "cooldown" };
  if (!input.quotesLoaded) return { required: null, reason: "prices-unavailable-hermes-forbidden" };

  return evaluateRebalanceDrift(input);
}

/** Shared price/weight drift check without changing or fabricating automation eligibility.
 * Settlement may audit its proposed post-mint book using the same thresholds. */
export function evaluateRebalanceDrift(input: Pick<RebalanceGateInput, "bountyMint" | "tokens" | "rebalanceActivationThresholdRelBps" | "rebalanceActivationThresholdAbsBps">, options: { nativeThresholdInflation?: boolean } = {}): RebalanceDecision {
  const bounty = address(input.bountyMint);
  for (const token of input.tokens) {
    address(token.mint);
    const mustPrice = token.weight > 0 || token.amountRaw !== 0n;
    if (!mustPrice || token.mint === bounty) continue;
    if (!token.validated || token.priceQuote === null || token.priceQuote <= 0n) return { required: false, reason: `unpriceable:${token.mint}` };
  }

  let tvl = 0n, weightSum = 0;
  const values: { token: RebalanceTokenInput; value: bigint }[] = [];
  for (const token of input.tokens) {
    weightSum += token.weight;
    const value = token.amountRaw === 0n || token.priceQuote === null ? 0n : token.amountRaw * token.priceQuote;
    values.push({ token, value });
    tvl += value;
  }
  if (tvl === 0n || weightSum <= 0) return { required: false, reason: "zero-tvl" };

  const relThresh = BigInt(input.rebalanceActivationThresholdRelBps);
  const absThresh = BigInt(input.rebalanceActivationThresholdAbsBps);
  const bps = BigInt(HUNDRED_PERCENT_BPS), inflation = options.nativeThresholdInflation === false ? 100n : 101n;
  for (const { token, value } of values) {
    if (token.mint === bounty) continue;
    const target = tvl * BigInt(token.weight) / BigInt(weightSum);
    const diff = value < target ? target - value : value - target;
    if (diff === 0n) continue;
    const maxValue = value < target ? target : value;
    // SDK inflates thresholds by 1.01. Exact form: diff/max * 10000 >= thresh * 101/100
    const relHits = diff * bps * 100n >= relThresh * inflation * maxValue;
    const absHits = diff * bps * 100n >= absThresh * inflation * tvl;
    if (relHits && absHits) return { required: true, reason: `drift:${token.mint}` };
  }
  return { required: false, reason: "on-target" };
}

type Bn = { toString(): string };
export interface VaultRebalanceView {
  numTokens: number;
  settings: {
    bountyMint: { toBase58(): string };
    automation: {
      allowAutomation: number;
      rebalanceActivationCooldown: Bn;
      rebalanceActivationThresholdRelBps: number;
      rebalanceActivationThresholdAbsBps: number;
    };
    activeRebalance: Bn;
    bountyBalance: Bn;
    schedule: { cycleStartTime: Bn; cycleDuration: Bn; automationStart: Bn; automationEnd: Bn };
    lastAutomationExecutionTimestamp: Bn;
  };
  composition: { mint: { toBase58(): string }; weight: number; amount: Bn }[];
}

/** On-chain settings only. Pass `quotesLoaded: false` so this never contacts Hermes. */
export function rebalanceInputFromVault(vault: VaultRebalanceView, nowSeconds: number, priced: Map<string, { priceQuote: bigint; validated: boolean }> | null): RebalanceGateInput {
  const { automation, schedule } = vault.settings;
  const tokens = vault.composition.slice(0, vault.numTokens).map(asset => {
    const mint = asset.mint.toBase58();
    const quote = priced?.get(mint);
    return { mint, weight: asset.weight, amountRaw: asBigInt(asset.amount), priceQuote: quote?.priceQuote ?? null, validated: quote?.validated === true };
  });
  return {
    allowAutomation: automation.allowAutomation,
    activeRebalance: asBigInt(vault.settings.activeRebalance),
    bountyBalance: asBigInt(vault.settings.bountyBalance),
    nowSeconds,
    cycleStartTime: asBigInt(schedule.cycleStartTime),
    cycleDuration: asBigInt(schedule.cycleDuration),
    automationStart: asBigInt(schedule.automationStart),
    automationEnd: asBigInt(schedule.automationEnd),
    lastAutomationExecutionTimestamp: asBigInt(vault.settings.lastAutomationExecutionTimestamp),
    rebalanceActivationCooldown: asBigInt(automation.rebalanceActivationCooldown),
    rebalanceActivationThresholdRelBps: automation.rebalanceActivationThresholdRelBps,
    rebalanceActivationThresholdAbsBps: automation.rebalanceActivationThresholdAbsBps,
    bountyMint: vault.settings.bountyMint.toBase58(),
    tokens,
    quotesLoaded: priced !== null,
  };
}
