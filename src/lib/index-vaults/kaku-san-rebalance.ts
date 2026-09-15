import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { isRebalanceRequired } from "@symmetry-hq/sdk";
import type { Vault } from "@symmetry-hq/sdk";
import { MAX_SUPPORTED_TOKENS_PER_VAULT } from "@symmetry-hq/sdk/dist/constants.js";
import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { loadVaultPrice } from "@symmetry-hq/sdk/dist/states/basket.js";
import Decimal from "decimal.js";
import { address } from "./amounts.ts";
import { feeSnapshot, HOST_ENTRY_FEE_BPS, HOST_EXIT_FEE_BPS } from "./fees.ts";
import type { VaultIdentity } from "./adapter-contract.ts";
import { KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEPLOYER, KAKU_SAN_INDEX_ID, KAKU_SAN_RAYDIUM_POOLS, assertKakuSanDeployer } from "./kaku-san.ts";
import {
  KAKU_SAN_HEADERS, PREPARE_TIMEOUT_MS, parseKakuSanPrepareRequest, payloadTransactions, simulateUnsigned,
  withKakuSanTimeout, type KakuSanPrepared,
} from "./kaku-san-create.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyVault } from "./raydium-oracles.ts";
import { NativeVaultBuilders, SYMMETRY_PROGRAM_ID } from "./symmetry-adapter.ts";
import { keeperConfigurationHash, planKeeperObservation } from "../../../workers/stocklana-keeper.ts";
import type { KeeperIntentObservation, KeeperObservation } from "../../../workers/stocklana-keeper.ts";

export const KAKU_SAN_NATIVE_TOKEN_CAP = MAX_SUPPORTED_TOKENS_PER_VAULT;
const HUNDRED_PERCENT_BPS = 10_000;
const headers = KAKU_SAN_HEADERS;

export interface KakuSanDriftRow {
  ticker: string | null;
  mint: string;
  targetWeightBps: number;
  onchainWeightBps: number | null;
  amountRaw: string;
  driftBps: number | null;
}
export interface KakuSanEligibility {
  required: boolean | null;
  reason: string;
}
export interface KakuSanStatus {
  network: typeof KAKU_SAN.network;
  name: typeof KAKU_SAN.name;
  symbol: typeof KAKU_SAN.symbol;
  label: typeof KAKU_SAN.label;
  deployer: typeof KAKU_SAN.deployer;
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  nativeTokenCap: number;
  vault: string;
  shareMint: string;
  shareSupplyRaw: string;
  drift: KakuSanDriftRow[];
  eligibility: KakuSanEligibility;
  keeper: KeeperObservation;
  estimatedOnly: true;
}

export function assertNativeTokenCap(count: number, label = "tokens"): void {
  if (!Number.isInteger(count) || count < 0) throw new Error("NATIVE_TOKEN_CAP: count is invalid");
  if (count > KAKU_SAN_NATIVE_TOKEN_CAP) throw new Error(`NATIVE_TOKEN_CAP: ${count} ${label} exceeds the native vault cap of ${KAKU_SAN_NATIVE_TOKEN_CAP}`);
}

export function kakuSanDrift(
  vault: { composition: { mint: { toBase58(): string }; weight: number; amount: { toString(): string } }[]; numTokens: number },
  targets: readonly { ticker: string; mint: string; targetWeightBps: number }[] = KAKU_SAN_ASSETS,
): KakuSanDriftRow[] {
  const allocated = vault.composition.slice(0, vault.numTokens);
  const byMint = new Map(allocated.map(asset => [asset.mint.toBase58(), asset]));
  const rows: KakuSanDriftRow[] = targets.map(target => {
    const onchain = byMint.get(target.mint);
    const onchainWeightBps = onchain === undefined ? null : Number(onchain.weight);
    return {
      ticker: target.ticker, mint: target.mint, targetWeightBps: target.targetWeightBps, onchainWeightBps,
      amountRaw: onchain ? onchain.amount.toString() : "0",
      driftBps: onchainWeightBps === null ? null : onchainWeightBps - target.targetWeightBps,
    };
  });
  for (const asset of allocated) {
    const mint = asset.mint.toBase58();
    if (targets.some(target => target.mint === mint)) continue;
    rows.push({
      ticker: null, mint, targetWeightBps: 0, onchainWeightBps: Number(asset.weight),
      amountRaw: asset.amount.toString(), driftBps: Number(asset.weight),
    });
  }
  return rows;
}

function asInt(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toString" in value) {
    const text = String((value as { toString(): string }).toString());
    if (!/^-?\d+$/.test(text)) throw new Error(`NATIVE_ELIGIBILITY_UNAVAILABLE: malformed ${field}`);
    const n = Number(text);
    if (!Number.isSafeInteger(n)) throw new Error(`NATIVE_ELIGIBILITY_UNAVAILABLE: ${field} exceeds integer range`);
    return n;
  }
  throw new Error(`NATIVE_ELIGIBILITY_UNAVAILABLE: missing ${field}`);
}

/** Same early gates as SDK `isRebalanceRequired`, without Hermes/Pyth HTTP. */
export function nativeRebalanceGates(vault: Vault, nowSeconds = Math.floor(Date.now() / 1000)): KakuSanEligibility {
  const settings = vault.settings;
  if (asInt(settings.automation.allowAutomation, "allowAutomation") !== 1) {
    return { required: false, reason: "Automation is disabled on this vault" };
  }
  if (asInt(settings.activeRebalance, "activeRebalance") > 0) {
    return { required: false, reason: "An active rebalance is already in progress" };
  }
  if (asInt(settings.bountyBalance, "bountyBalance") === 0) {
    return { required: false, reason: "Vault bounty balance is zero" };
  }
  const cycleStart = asInt(settings.schedule.cycleStartTime, "cycleStartTime");
  if (cycleStart > nowSeconds) return { required: false, reason: "Automation cycle has not started" };
  const duration = asInt(settings.schedule.cycleDuration, "cycleDuration");
  const elapsed = nowSeconds - cycleStart;
  const cycleTimestamp = duration === 0 ? 0 : elapsed % duration;
  const windowStart = asInt(settings.schedule.automationStart, "automationStart");
  const windowEnd = asInt(settings.schedule.automationEnd, "automationEnd");
  if (!(cycleTimestamp >= windowStart && cycleTimestamp < windowEnd)) {
    return { required: false, reason: "Outside the automation window" };
  }
  const last = asInt(settings.lastAutomationExecutionTimestamp, "lastAutomationExecutionTimestamp");
  const cooldown = asInt(settings.automation.rebalanceActivationCooldown, "rebalanceActivationCooldown");
  if (last + cooldown >= nowSeconds) return { required: false, reason: "Rebalance cooldown has not elapsed" };
  return { required: null, reason: "Native gates passed; price-drift still required" };
}

async function raydiumValueRebalanceRequired(vault: Vault, connection: NativeVaultBuilders["connection"]): Promise<KakuSanEligibility> {
  const priced = await loadVaultPrice(vault, connection);
  for (let i = 0; i < priced.numTokens; i++) {
    const token = priced.composition[i];
    const mustPrice = token.weight > 0 || !token.amount.isZero();
    if (!mustPrice) continue;
    if (token.mint.equals(priced.settings.bountyMint)) continue;
    if (!token.price || token.price.validated !== true || !token.price.price.gt(new Decimal(0))) {
      return { required: false, reason: "A required token cannot be priced from Raydium" };
    }
  }
  let vaultTvl = new Decimal(0);
  let weightSum = 0;
  for (let i = 0; i < priced.numTokens; i++) {
    const token = priced.composition[i];
    weightSum += token.weight;
    if (token.amount.isZero()) continue;
    if (!token.price || !token.value) return { required: false, reason: "Token value unavailable after Raydium price load" };
    vaultTvl = vaultTvl.add(token.value);
  }
  if (vaultTvl.isZero() || weightSum === 0) return { required: false, reason: "Vault TVL is zero; nothing to rebalance" };
  const relThreshold = new Decimal(priced.settings.automation.rebalanceActivationThresholdRelBps).mul(1.01);
  const absThreshold = new Decimal(priced.settings.automation.rebalanceActivationThresholdAbsBps).mul(1.01);
  for (let i = 0; i < priced.numTokens; i++) {
    const token = priced.composition[i];
    if (token.mint.equals(priced.settings.bountyMint)) continue;
    if (!token.price || !token.value) return { required: false, reason: "Token value unavailable after Raydium price load" };
    const targetValue = vaultTvl.mul(token.weight).div(weightSum);
    const [valueDiff, maxValue] = token.value.lt(targetValue)
      ? [targetValue.sub(token.value), targetValue]
      : [token.value.sub(targetValue), token.value];
    if (valueDiff.isZero()) continue;
    const relBps = valueDiff.div(maxValue).mul(HUNDRED_PERCENT_BPS);
    const absBps = valueDiff.div(vaultTvl).mul(HUNDRED_PERCENT_BPS);
    if (relBps.gte(relThreshold) && absBps.gte(absThreshold)) {
      return { required: true, reason: "Native eligibility: value drift exceeds rebalance thresholds" };
    }
  }
  return { required: false, reason: "Value drift is within rebalance thresholds" };
}

export async function forbidPythNetwork<T>(work: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/hermes|pythnetwork|pyth\.network/i.test(url)) return Promise.reject(new Error("PYTH_NETWORK_FORBIDDEN"));
    return original(input as Parameters<typeof original>[0], init);
  }) as typeof fetch;
  try { return await work(); }
  finally { globalThis.fetch = original; }
}

/** Keeper eligibility: SDK early gates, then Raydium `loadVaultPrice` — never Hermes. */
export async function kakuSanRebalanceEligibility(vault: Vault, connection: NativeVaultBuilders["connection"]): Promise<KakuSanEligibility> {
  const gates = nativeRebalanceGates(vault);
  if (gates.required === false) {
    if (await isRebalanceRequired(vault, connection)) throw new Error("Keeper eligibility mismatch: SDK required a rebalance after a failed native gate");
    return gates;
  }
  return forbidPythNetwork(() => raydiumValueRebalanceRequired(vault, connection));
}

export async function kakuSanIdentity(native: NativeVaultBuilders, vault: string, shareMint: string): Promise<VaultIdentity> {
  await native.assertNetwork();
  const mintKey = new PublicKey(address(shareMint));
  const mintAccount = await native.connection.getAccountInfo(mintKey, "confirmed");
  if (!mintAccount) throw new Error("Missing native share mint");
  if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(program => mintAccount.owner.equals(program))) throw new Error("Wrong share mint program");
  const mint = await getMint(native.connection, mintKey, "confirmed", mintAccount.owner);
  return {
    network: "mainnet-beta", programId: SYMMETRY_PROGRAM_ID, vaultAccount: address(vault), shareMint: address(shareMint),
    shareDecimals: mint.decimals, hostTreasury: KAKU_SAN_DEPLOYER, initialDeployer: KAKU_SAN_DEPLOYER,
    indexId: KAKU_SAN_INDEX_ID, deploymentGeneration: 1, metadataHash: "unverified:execution-test-kaku-san",
  };
}

function intentSummaries(native: NativeVaultBuilders, identity: VaultIdentity, intents: Awaited<ReturnType<NativeVaultBuilders["sdk"]["fetchVaultRebalanceIntents"]>>): KeeperIntentObservation[] {
  return intents.map(intent => {
    const chain = intent.chain_data;
    if (!chain.ownAddress || chain.vault.toBase58() !== identity.vaultAccount) throw new Error("Native intent address/vault mismatch");
    return {
      address: chain.ownAddress.toBase58(), owner: chain.owner.toBase58(), type: intent.formatted_data.rebalance_type,
      action: intent.formatted_data.current_action, bountyLeftRaw: chain.bounty.bountyLeft.toString(10),
    };
  });
}

export async function observeKakuSanVault(input: { creator: string; vault: string; shareMint: string }, native: NativeVaultBuilders): Promise<KakuSanStatus> {
  assertNoPythEnvironment();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet builder required");
  const creator = assertKakuSanDeployer(input.creator);
  assertNativeTokenCap(KAKU_SAN_ASSETS.length, "basket names");
  const identity = await kakuSanIdentity(native, input.vault, input.shareMint);
  const { vault, mint } = await native.read(identity);
  if (vault.settings.creator.toBase58() !== creator) throw new Error("Vault creator is not the approved deployer");
  assertNativeTokenCap(vault.numTokens);
  assertRaydiumOnlyVault(vault, KAKU_SAN_RAYDIUM_POOLS);
  const intents = intentSummaries(native, identity, await native.sdk.fetchVaultRebalanceIntents(identity.vaultAccount));
  const eligibility = intents.length
    ? { required: null, reason: "Existing intents take priority over a new rebalance" } satisfies KakuSanEligibility
    : await kakuSanRebalanceEligibility(vault, native.connection);
  let configHash = "unverified";
  try { configHash = keeperConfigurationHash(vault, feeSnapshot(vault, await native.sdk.fetchGlobalConfig())); }
  catch { /* observation still returns drift; config hash is diagnostic */ }
  const keeper = planKeeperObservation({
    vault: identity.vaultAccount, configHash, shareSupplyRaw: mint.supply.toString(), intents, retired: false,
    normalRebalanceRequired: intents.length ? null : eligibility.required,
  });
  return {
    network: KAKU_SAN.network, name: KAKU_SAN.name, symbol: KAKU_SAN.symbol, label: KAKU_SAN.label,
    deployer: KAKU_SAN.deployer, hostEntryFeeBps: HOST_ENTRY_FEE_BPS, hostExitFeeBps: HOST_EXIT_FEE_BPS,
    nativeTokenCap: KAKU_SAN_NATIVE_TOKEN_CAP, vault: identity.vaultAccount, shareMint: identity.shareMint,
    shareSupplyRaw: mint.supply.toString(), drift: kakuSanDrift(vault), eligibility, keeper, estimatedOnly: true,
  };
}

function preparedKeeper(step: "prices" | "rebalance", status: KakuSanStatus, transactions: KakuSanPrepared["transactions"], extra: Pick<KakuSanPrepared, "eligible" | "reason" | "keeperNext">): KakuSanPrepared {
  return {
    step, network: status.network, name: status.name, symbol: status.symbol, label: status.label, deployer: status.deployer,
    hostEntryFeeBps: status.hostEntryFeeBps, hostExitFeeBps: status.hostExitFeeBps, basket: KAKU_SAN_ASSETS,
    vault: status.vault, shareMint: status.shareMint, transactions, ...extra,
  };
}

export async function prepareKakuSanKeeperStep(
  input: ReturnType<typeof parseKakuSanPrepareRequest>,
  native: NativeVaultBuilders,
  simulate = true,
): Promise<KakuSanPrepared> {
  if (input.step !== "prices" && input.step !== "rebalance") throw new Error("Unknown keeper step");
  if (!input.vault || !input.shareMint) throw new Error("Existing vault and share mint required");
  const creator = assertKakuSanDeployer(input.creator);
  const status = await observeKakuSanVault({ creator, vault: input.vault, shareMint: input.shareMint }, native);
  const identity = await kakuSanIdentity(native, input.vault, input.shareMint);
  const { vault } = await native.read(identity);
  if (input.step === "prices") {
    const intent = status.keeper.intents[0]?.address ?? getRebalanceIntentPda(new PublicKey(identity.vaultAccount), new PublicKey(identity.vaultAccount)).toBase58();
    const { payload } = await native.priceUpdateFromVault(vault, creator, intent, KAKU_SAN_RAYDIUM_POOLS);
    const transactions = payloadTransactions(payload, creator);
    if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
    return preparedKeeper("prices", status, transactions, {
      eligible: true, reason: status.keeper.intents.length ? `Updating prices for existing intent ${intent}` : "Updating Raydium prices",
      keeperNext: status.keeper.next,
    });
  }
  if (status.keeper.intents.length) {
    return preparedKeeper("rebalance", status, [], {
      eligible: false, reason: "Existing intents take priority; sign update_prices if that is the current action. Do not force a new rebalance.",
      keeperNext: status.keeper.next,
    });
  }
  if (status.eligibility.required !== true) {
    return preparedKeeper("rebalance", status, [], {
      eligible: false, reason: status.eligibility.reason, keeperNext: status.keeper.next,
    });
  }
  const payload = await native.sdk.rebalanceVaultTx({
    keeper: creator, vault_mint: identity.shareMint, rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50,
  });
  const transactions = payloadTransactions(payload, creator);
  if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
  return preparedKeeper("rebalance", status, transactions, {
    eligible: true, reason: status.eligibility.reason, keeperNext: status.keeper.next,
  });
}

export function parseKakuSanStatusRequest(body: unknown): { creator: string; vault: string; shareMint: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Status request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "vault", "shareMint"].includes(key))) throw new Error("Unexpected status field");
  if (typeof input.creator !== "string" || typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Creator, vault and share mint required");
  return { creator: assertKakuSanDeployer(address(input.creator)), vault: address(input.vault), shareMint: address(input.shareMint) };
}

export function parseKakuSanKeeperArgs(argv: string[]): { mode: "dry-run" | "execute"; vault: string; shareMint: string; keypath?: string } {
  let mode: "dry-run" | "execute" = "dry-run";
  let vault: string | undefined;
  let shareMint: string | undefined;
  let keypath: string | undefined;
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--dry-run") { sawDryRun = true; mode = "dry-run"; }
    else if (flag === "--execute") mode = "execute";
    else if (flag === "--vault") vault = address(value());
    else if (flag === "--share-mint") shareMint = address(value());
    else if (flag === "--keypath") keypath = value();
    else if (flag === "--force-rebalance" || flag === "--force") throw new Error("Force-rebalance is not permitted");
    else throw new Error(`Unsupported argument ${flag}`);
  }
  if (sawDryRun && mode === "execute") throw new Error("Pass --dry-run or --execute, not both");
  if (!vault || !shareMint) throw new Error("Usage: --dry-run --vault <addr> --share-mint <addr>  |  --execute --keypath <file> --vault <addr> --share-mint <addr>");
  if (mode === "execute" && !keypath) throw new Error("--execute requires --keypath; the web app never holds a keeper keypair");
  if (mode === "dry-run" && keypath) throw new Error("--keypath is only valid with --execute");
  return { mode, vault, shareMint, ...(keypath ? { keypath } : {}) };
}

export async function handleKakuSanStatus(
  request: Request,
  nativeBuilder: () => NativeVaultBuilders,
  timeoutMs = PREPARE_TIMEOUT_MS,
): Promise<Response> {
  let input: ReturnType<typeof parseKakuSanStatusRequest>;
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseKakuSanStatusRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid Kaku San status request" }, { status: 400, headers });
  }
  try {
    const status = await withKakuSanTimeout(() => observeKakuSanVault(input, nativeBuilder()), timeoutMs);
    return Response.json(status, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Kaku San status unavailable" }, { status: 503, headers });
  }
}
