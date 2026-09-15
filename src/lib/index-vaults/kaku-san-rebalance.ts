import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import { isRebalanceRequired } from "@symmetry-hq/sdk";
import type { Vault } from "@symmetry-hq/sdk";
import { MAX_SUPPORTED_TOKENS_PER_VAULT } from "@symmetry-hq/sdk/dist/constants.js";
import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { loadVaultPrice } from "@symmetry-hq/sdk/dist/states/basket.js";
import Decimal from "decimal.js";
import { address } from "./amounts.ts";
import { feeSnapshot, HOST_ENTRY_FEE_BPS, HOST_EXIT_FEE_BPS } from "./fees.ts";
import type { VaultIdentity } from "./adapter-contract.ts";
import { KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEPLOYER, KAKU_SAN_INDEX_ID, KAKU_SAN_RAYDIUM_POOLS, assertKakuSanDeployer, assertKakuSanKeeper } from "./kaku-san.ts";
import {
  KAKU_SAN_HEADERS, PREPARE_TIMEOUT_MS, assertSignedBy, payloadTransactions, simulateUnsigned,
  withKakuSanTimeout, type KakuSanPrepared,
} from "./kaku-san-create.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyVault } from "./raydium-oracles.ts";
import { evaluateRebalanceRequired, rebalanceInputFromVault } from "./rebalance-eligibility.ts";
import type { RebalanceDecision } from "./rebalance-eligibility.ts";
import { GENESIS, NativeVaultBuilders, SYMMETRY_PROGRAM_ID } from "./symmetry-adapter.ts";
import { keeperConfigurationHash, planKeeperObservation } from "../../../workers/stocklana-keeper.ts";
import type { KeeperIntentObservation, KeeperObservation } from "../../../workers/stocklana-keeper.ts";

export const KAKU_SAN_NATIVE_TOKEN_CAP = MAX_SUPPORTED_TOKENS_PER_VAULT;
const headers = KAKU_SAN_HEADERS;
/** Scale for converting an SDK Decimal price into the shared module's bigint "quote units per 1 raw token". */
const PRICE_QUOTE_SCALE = 10n ** 18n;
const ELIGIBILITY_REASONS: Record<string, string> = {
  "automation-disabled": "Automation is disabled on this vault",
  "active-rebalance": "An active rebalance is already in progress",
  "no-bounty": "Vault bounty balance is zero",
  "cycle-not-started": "Automation cycle has not started",
  "outside-automation-window": "Outside the automation window",
  "cooldown": "Rebalance cooldown has not elapsed",
  "prices-unavailable-hermes-forbidden": "Native gates passed; price-drift still required",
  "zero-tvl": "Vault TVL is zero; nothing to rebalance",
  "on-target": "Value drift is within rebalance thresholds",
};

function describeEligibility(decision: RebalanceDecision): KakuSanEligibility {
  if (decision.reason.startsWith("unpriceable:")) return { required: decision.required, reason: "A required token cannot be priced from Raydium" };
  if (decision.reason.startsWith("drift:")) return { required: decision.required, reason: "Native eligibility: value drift exceeds rebalance thresholds" };
  return { required: decision.required, reason: ELIGIBILITY_REASONS[decision.reason] ?? decision.reason };
}

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

/** Same early gates as SDK `isRebalanceRequired`, delegated to the shared Hermes-free AND rule. */
export function nativeRebalanceGates(vault: Vault, nowSeconds = Math.floor(Date.now() / 1000)): KakuSanEligibility {
  return describeEligibility(evaluateRebalanceRequired(rebalanceInputFromVault(vault, nowSeconds, null)));
}

function decimalPriceQuote(price: Decimal): bigint {
  return BigInt(price.mul(PRICE_QUOTE_SCALE.toString()).toFixed(0));
}

/** Loads Raydium prices, then defers to the shared AND rule for the drift math (never a second copy of it). */
async function raydiumValueRebalanceRequired(vault: Vault, connection: NativeVaultBuilders["connection"], nowSeconds: number): Promise<KakuSanEligibility> {
  const priced = await loadVaultPrice(vault, connection);
  const quotes = new Map<string, { priceQuote: bigint; validated: boolean }>();
  for (let i = 0; i < priced.numTokens; i++) {
    const token = priced.composition[i];
    if (!token.price) continue;
    quotes.set(token.mint.toBase58(), { priceQuote: decimalPriceQuote(token.price.price), validated: token.price.validated === true });
  }
  return describeEligibility(evaluateRebalanceRequired(rebalanceInputFromVault(priced, nowSeconds, quotes)));
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
  const nowSeconds = Math.floor(Date.now() / 1000);
  const gates = nativeRebalanceGates(vault, nowSeconds);
  if (gates.required === false) {
    if (await isRebalanceRequired(vault, connection)) throw new Error("Keeper eligibility mismatch: SDK required a rebalance after a failed native gate");
    return gates;
  }
  return forbidPythNetwork(() => raydiumValueRebalanceRequired(vault, connection, nowSeconds));
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
  input: { keeper: string; step: "prices" | "rebalance"; vault: string; shareMint: string },
  native: NativeVaultBuilders,
  simulate = true,
): Promise<KakuSanPrepared> {
  if (input.step !== "prices" && input.step !== "rebalance") throw new Error("Unknown keeper step");
  const keeper = assertKakuSanKeeper(address(input.keeper));
  const status = await observeKakuSanVault({ creator: KAKU_SAN_DEPLOYER, vault: input.vault, shareMint: input.shareMint }, native);
  const identity = await kakuSanIdentity(native, input.vault, input.shareMint);
  const { vault } = await native.read(identity);
  if (input.step === "prices") {
    const intent = status.keeper.intents[0]?.address ?? getRebalanceIntentPda(new PublicKey(identity.vaultAccount), new PublicKey(identity.vaultAccount)).toBase58();
    const { payload } = await native.priceUpdateFromVault(vault, keeper, intent, KAKU_SAN_RAYDIUM_POOLS);
    const transactions = payloadTransactions(payload, keeper);
    if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
    return preparedKeeper("prices", status, transactions, {
      eligible: true, reason: status.keeper.intents.length ? `Updating prices for existing intent ${intent}` : "Updating Raydium prices",
      keeperNext: status.keeper.next,
    });
  }
  if (status.keeper.intents.length) {
    return preparedKeeper("rebalance", status, [], {
      eligible: false, reason: "Existing intents take priority; run update_prices if that is the current action. Do not force a new rebalance.",
      keeperNext: status.keeper.next,
    });
  }
  if (status.eligibility.required !== true) {
    return preparedKeeper("rebalance", status, [], {
      eligible: false, reason: status.eligibility.reason, keeperNext: status.keeper.next,
    });
  }
  const payload = await native.sdk.rebalanceVaultTx({
    keeper, vault_mint: identity.shareMint, rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50,
  });
  const transactions = payloadTransactions(payload, keeper);
  if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
  return preparedKeeper("rebalance", status, transactions, {
    eligible: true, reason: status.eligibility.reason, keeperNext: status.keeper.next,
  });
}

export async function submitKakuSanKeeperSigned(
  input: { keeper: string; vault: string; shareMint: string; signedTransactions: string[] },
  connection: Connection,
): Promise<{ vault: string; shareMint: string; signatures: string[]; slot: number | null }> {
  assertNoPythEnvironment();
  const keeper = assertKakuSanKeeper(address(input.keeper));
  if (await connection.getGenesisHash() !== GENESIS["mainnet-beta"]) throw new Error("RPC genesis/network mismatch");
  const signatures: string[] = [];
  let slot: number | null = null;
  for (const signed of input.signedTransactions) {
    const tx = assertSignedBy(signed, keeper);
    const latest = await connection.getLatestBlockhash("confirmed");
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const confirmation = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
    if (confirmation.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
    signatures.push(signature);
    slot = confirmation.context.slot;
  }
  return { vault: address(input.vault), shareMint: address(input.shareMint), signatures, slot };
}

export function parseKakuSanStatusRequest(body: unknown): { creator: string; vault: string; shareMint: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Status request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "vault", "shareMint"].includes(key))) throw new Error("Unexpected status field");
  if (typeof input.creator !== "string" || typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Creator, vault and share mint required");
  return { creator: assertKakuSanDeployer(address(input.creator)), vault: address(input.vault), shareMint: address(input.shareMint) };
}

export function parseKakuSanKeeperArgs(argv: string[]): { mode: "dry-run" | "execute"; vault: string; shareMint: string; keypair?: string } {
  let mode: "dry-run" | "execute" = "dry-run";
  let vault: string | undefined;
  let shareMint: string | undefined;
  let keypair: string | undefined;
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
    else if (flag === "--keypair") keypair = value();
    else if (flag === "--keypath") throw new Error("Use --keypair PATH; the web app never holds a keeper keypair");
    else if (flag === "--force-rebalance" || flag === "--force") throw new Error("Force-rebalance is not permitted");
    else throw new Error(`Unsupported argument ${flag}`);
  }
  if (sawDryRun && mode === "execute") throw new Error("Pass --dry-run or --execute, not both");
  if (!vault || !shareMint) throw new Error("Usage: --dry-run --vault <addr> --share-mint <addr>  |  --execute --keypair <file> --vault <addr> --share-mint <addr>");
  if (mode === "execute" && !keypair) throw new Error("--execute requires --keypair PATH on the operator machine; fail-closed until that dedicated keeper key exists");
  if (mode === "dry-run" && keypair) throw new Error("--keypair is only valid with --execute");
  return { mode, vault, shareMint, ...(keypair ? { keypair } : {}) };
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
