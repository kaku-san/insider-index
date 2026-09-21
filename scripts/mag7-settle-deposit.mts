import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getSwapPairs } from "@symmetry-hq/sdk/dist/states/intents/rebalanceIntent.js";
import { RebalanceAction, RebalanceType } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { getHeliusRpcUrl } from "../src/lib/helius.ts";
import { address } from "../src/lib/index-vaults/amounts.ts";
import { buildCycleFillWire } from "../src/lib/index-vaults/cycle-wire.ts";
import { buildCycleRoute } from "../src/lib/index-vaults/cycle-routes.ts";
import { kakuSanBuilders, kakuSanConnection, simulateUnsigned } from "../src/lib/index-vaults/kaku-san-create.ts";
import { assertIndexKeeper, legBindings } from "../src/lib/index-vaults/keeper-tick.ts";
import { MAINNET_USDC, NATIVE_DEFAULT_BINDINGS, assertNativeSupportTargets } from "../src/lib/index-vaults/native-defaults.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyVault, WSOL_MINT } from "../src/lib/index-vaults/raydium-oracles.ts";
import { createServiceSupabase } from "../src/lib/supabase.ts";
import { readVaultDefinition, type PersistedVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";

const INDEX_ID = "idx-theme-mag7-caucus";
const VAULT = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const SHARE_MINT = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";
const POLL_MS = 5_000;
const MAX_SOL_DEBIT_LAMPORTS = 50_000_000n; // 0.05 SOL, a per-run demo bound.

type Options = { owner: string; execute: boolean; watch: boolean; keypair?: string };

function usage() {
  return `Usage:
  npm run keeper:mag7-deposit -- --owner <locked-deposit-wallet> --dry-run
  npm run keeper:mag7-deposit -- --owner <locked-deposit-wallet> --execute --keypair /absolute/external/keeper.json --watch

External laptop-only Mag7 deposit settler. It reads the persisted Mag7 definition, observes the
user's already-finalized native deposit intent, then runs only Raydium price/fill/mint/cleanup steps.
It never creates a user deposit, opens public funds, uses Pyth/Hermes, uses the cycle journal, or
loads a key in the app. Dry-run is the default and broadcasts nothing. Execute is bounded to 0.05 SOL
of observed keeper debit per invocation; restart the same command to continue after the bound.`;
}

function parseArgs(argv: readonly string[]): Options {
  let owner: string | undefined, keypair: string | undefined, execute = false, watch = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--owner") owner = address(value());
    else if (flag === "--keypair") keypair = value();
    else if (flag === "--execute") execute = true;
    else if (flag === "--dry-run") { /* Explicit spelling of the default. */ }
    else if (flag === "--watch") watch = true;
    else throw new Error(`Unsupported argument ${flag}`);
  }
  if (!owner || (execute && !keypair) || (!execute && (keypair || watch)) || (execute && !isAbsolute(keypair!))) {
    throw new Error("Use --owner <wallet>; --execute requires an absolute external --keypair path; --watch requires --execute");
  }
  return { owner, execute, watch, ...(keypair ? { keypair } : {}) };
}

function loadExternalKeypair(path: string): Keypair {
  const absolute = resolve(path), root = resolve(".");
  const outside = relative(root, absolute);
  if (!outside || (!outside.startsWith("..") && !isAbsolute(outside))) throw new Error("Keeper keypair must be outside this repository");
  const bytes: unknown = JSON.parse(readFileSync(absolute, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error("Keypair file must be a 64-byte JSON array");
  const keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
  bytes.fill(0);
  return keypair;
}

function requireMag7Definition(record: PersistedVaultDefinition | null): PersistedVaultDefinition {
  if (!record || record.indexId !== INDEX_ID || record.vaultAddress !== VAULT || record.shareMint !== SHARE_MINT || record.network !== "mainnet-beta" || record.status !== "CREATABLE") {
    throw new Error("Persisted Mag7 definition/identity is not ready");
  }
  if (!record.keeper?.pubkey || record.keeper.automationEnabled !== true) throw new Error("Persisted Mag7 keeper automation is not enabled");
  if (record.vaultLegs.length !== 7) throw new Error("Persisted Mag7 definition must contain exactly seven investment legs");
  return record;
}

async function sendTransactions(input: { transactions: { txBase64: string }[]; keeper: Keypair; native: ReturnType<typeof kakuSanBuilders>; spent: bigint }) {
  const sender = kakuSanConnection(true, getHeliusRpcUrl());
  const signatures: string[] = [];
  let spent = input.spent;
  for (const transaction of input.transactions) {
    await simulateUnsigned(input.native.connection, transaction.txBase64);
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction.txBase64, "base64"));
    if (tx.message.staticAccountKeys[0]?.toBase58() !== input.keeper.publicKey.toBase58()) throw new Error("Prepared transaction payer is not the keeper");
    const before = await sender.getBalance(input.keeper.publicKey, "confirmed");
    const fee = await sender.getFeeForMessage(tx.message, "confirmed");
    if (fee.value === null || spent + BigInt(fee.value) > MAX_SOL_DEBIT_LAMPORTS) throw new Error("MAG7_KEEPER_SOL_DEBIT_CAP");
    tx.sign([input.keeper]);
    const signature = await sender.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    let landed = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const status = (await sender.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") { landed = true; break; }
      await sleep(1_000);
    }
    if (!landed) throw new Error(`Transaction ${signature} did not confirm; reconcile before retrying`);
    const after = await sender.getBalance(input.keeper.publicKey, "confirmed");
    spent += BigInt(Math.max(0, before - after));
    if (spent > MAX_SOL_DEBIT_LAMPORTS) throw new Error("MAG7_KEEPER_SOL_DEBIT_CAP");
    signatures.push(signature);
  }
  return { signatures, spent };
}

async function missingKeeperAtas(native: ReturnType<typeof kakuSanBuilders>, record: PersistedVaultDefinition, keeper: string) {
  const mints = [...record.vaultLegs.map(leg => leg.mint), WSOL_MINT, MAINNET_USDC];
  const infos = await native.connection.getMultipleAccountsInfo(mints.map(mint => new PublicKey(mint)), "confirmed");
  const missing: string[] = [];
  for (const [index, mint] of mints.entries()) {
    const info = infos[index];
    if (!info) throw new Error(`Mint missing: ${mint}`);
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(keeper), false, info.owner);
    const account = await native.connection.getAccountInfo(ata, "confirmed");
    if (!account?.owner.equals(info.owner)) missing.push(`${mint}:${ata.toBase58()}`);
  }
  return missing;
}

async function tick(options: Options, spent: bigint) {
  assertNoPythEnvironment();
  const db = createServiceSupabase();
  if (!db) throw new Error("Supabase service-role credentials are required");
  const record = requireMag7Definition(await readVaultDefinition(db, INDEX_ID));
  const native = kakuSanBuilders(false);
  await native.assertNetwork();
  const vault = await native.sdk.fetchVault(VAULT);
  if (vault.ownAddress.toBase58() !== VAULT || vault.mint.toBase58() !== SHARE_MINT) throw new Error("On-chain Mag7 vault identity mismatch");
  assertRaydiumOnlyVault(vault, [...legBindings(record.vaultLegs), ...NATIVE_DEFAULT_BINDINGS]);
  assertNativeSupportTargets(vault);
  const intentAddress = (await import("@symmetry-hq/sdk/dist/instructions/pda.js")).getRebalanceIntentPda(new PublicKey(VAULT), new PublicKey(options.owner)).toBase58();
  const account = await native.connection.getAccountInfo(new PublicKey(intentAddress), "confirmed");
  if (!account) return { action: "wait", reason: "No locked deposit intent exists for this owner", signatures: [], spent };
  const intent = await native.sdk.fetchRebalanceIntent(intentAddress);
  const chain = intent.chain_data;
  if (chain.vault.toBase58() !== VAULT || chain.owner.toBase58() !== options.owner || chain.rebalanceType !== RebalanceType.Deposit) throw new Error("Native intent is not this user's Mag7 deposit");
  const action = chain.currentAction;
  const now = Math.floor(Date.now() / 1000);
  if (!options.execute) return { action: "dry-run", intent: intentAddress, nativeAction: intent.formatted_data.current_action, executionStart: chain.executionStartTime.toString(), now, signatures: [], spent };

  const keeper = loadExternalKeypair(options.keypair!);
  const managers = (vault.settings as { managers?: { managers?: { toBase58(): string }[] } }).managers?.managers ?? [];
  const keeperAddress = assertIndexKeeper(keeper.publicKey.toBase58(), {
    deployer: vault.settings.creator.toBase58(), host: vault.settings.host.toBase58(), strategy: managers.map(manager => manager.toBase58()), namedKeeper: record.keeper.pubkey,
  });
  const missing = await missingKeeperAtas(native, record, keeperAddress);
  if (missing.length) throw new Error(`Missing keeper ATAs: ${missing.join(", ")}`);
  if (action === RebalanceAction.DepositTokens) return { action: "wait", reason: "User deposit is not locked/finalized yet", intent: intentAddress, signatures: [], spent };

  if (action === RebalanceAction.UpdatePrices) {
    if (now < Number(chain.executionStartTime.toString())) return { action: "wait", reason: "Native execution start time has not arrived", intent: intentAddress, signatures: [], spent };
    const prepared = await native.priceUpdateFromVault(vault, keeperAddress, intentAddress, [...legBindings(record.vaultLegs), ...NATIVE_DEFAULT_BINDINGS]);
    const transactions = prepared.payload.batches.flatMap(batch => batch.transactions).map(tx => ({ txBase64: tx.tx_b64 }));
    const result = await sendTransactions({ transactions, keeper, native, spent });
    return { action: "prices", intent: intentAddress, ...result };
  }

  if (action === RebalanceAction.Auction) {
    const end = Number(chain.auctions[2]?.endTime.toString() ?? "0");
    if (now > end) {
      const incomplete = record.vaultLegs.filter(leg => !chain.tokens.some(token => token.mint.toBase58() === leg.mint && !token.amount.isZero()));
      if (incomplete.length || chain.tokens.some(token => token.mint.toBase58() === WSOL_MINT && !token.amount.isZero())) throw new Error("MAG7_INCOMPLETE_BOOK_DO_NOT_MINT");
      const payload = await native.sdk.mintTx({ keeper: keeperAddress, rebalance_intent: intentAddress });
      const result = await sendTransactions({ transactions: payload.batches.flatMap(batch => batch.transactions).map(tx => ({ txBase64: tx.tx_b64 })), keeper, native, spent });
      return { action: "mint", intent: intentAddress, ...result };
    }
    const missingLegs = new Set(record.vaultLegs.filter(leg => !chain.tokens.some(token => token.mint.toBase58() === leg.mint && !token.amount.isZero())).map(leg => leg.mint));
    const pairs = getSwapPairs(chain, vault).filter(pair => pair.outMint === MAINNET_USDC && missingLegs.has(pair.inMint));
    const fills = [];
    for (const pair of pairs) {
      const leg = record.vaultLegs.find(candidate => candidate.mint === pair.inMint);
      if (!leg || !Number.isSafeInteger(pair.inAmount) || !Number.isSafeInteger(pair.outAmount)) continue;
      const route = await buildCycleRoute({ connection: native.connection, leg, owner: keeperAddress, inputMint: MAINNET_USDC, outputMint: leg.mint,
        amountInRaw: String(pair.outAmount), minimumOutRaw: String(pair.inAmount), slippageBps: 50, maxAgeMs: 60_000 });
      fills.push({ route, maxRepaymentRaw: String(pair.inAmount) });
      if (fills.length === 2) break;
    }
    if (!fills.length) return { action: "wait", reason: "No complete Raydium CLMM fill is available inside the native auction", intent: intentAddress, signatures: [], spent };
    const wire = await buildCycleFillWire({ native, keeper: keeperAddress, vault: VAULT, intent: intentAddress, fills, computeUnits: 1_400_000, microLamports: "25000", maxPriorityFeeLamports: (MAX_SOL_DEBIT_LAMPORTS - spent).toString() });
    const result = await sendTransactions({ transactions: [{ txBase64: wire.txBase64 }], keeper, native, spent });
    return { action: "fill", intent: intentAddress, filled: fills.map(fill => fill.route.outputMint), ...result };
  }

  if (intent.claim_bounty_data) {
    const payload = await native.sdk.claimBountyTx({ keeper: keeperAddress, rebalance_intent: intentAddress });
    const result = await sendTransactions({ transactions: payload.batches.flatMap(batch => batch.transactions).map(tx => ({ txBase64: tx.tx_b64 })), keeper, native, spent });
    return { action: "cleanup", intent: intentAddress, ...result };
  }
  return { action: "wait", reason: `Unsupported deposit intent action ${intent.formatted_data.current_action}`, intent: intentAddress, signatures: [], spent };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let spent = 0n;
  do {
    const result = await tick(options, spent);
    spent = result.spent;
    console.log(JSON.stringify({ schema: "insiderindex-mag7-direct-settler-v1", indexId: INDEX_ID, vault: VAULT, shareMint: SHARE_MINT, mode: options.execute ? "execute" : "dry-run", maxSolDebitLamports: MAX_SOL_DEBIT_LAMPORTS.toString(), ...result }, null, 2));
    if (!options.watch || result.action === "cleanup" || ("reason" in result && result.reason?.includes("No locked"))) break;
    await sleep(POLL_MS);
  } while (true);
}

if (process.argv.includes("--help")) console.log(usage());
else void main().catch(error => { console.error(error instanceof Error ? error.message : "MAG7_KEEPER_REFUSED"); process.exitCode = 1; });
