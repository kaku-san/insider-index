import { getBountyVaultPda, getGlobalConfigPda, getRebalanceIntentPda, getRentPayerPda, getVaultFeesPda, getAta } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { RebalanceAction } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import type { TxPayload, TxPayloadBatchSequence } from "@symmetry-hq/sdk/dist/txUtils.js";
import { ComputeBudgetProgram, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createServiceSupabase } from "@/lib/supabase";
import { address, hashObject, rawAmount, sdkRawAmount } from "./amounts.ts";
import { validateAndSimulate } from "./transaction-policy.ts";
import { kakuSanBuilders } from "./kaku-san-create.ts";
import { VAULT_RELEASE } from "./release.ts";
import { assertMag7DepositBacking } from "./mag7-deposit-backing.ts";
import { quoteIndexZap, type BuiltSlice } from "./in-kind-deposit.ts";
import { attributeSwapDeltas, contributionsFromObservation, observeAcquisition, planWeightedUsdcSlices, zapStatusLine, type ObservedZap } from "./in-kind-zap.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import { networkUsdc, SYMMETRY_PROGRAM_ID, type NativeVaultBuilders } from "./symmetry-adapter.ts";
import { readVaultDefinition, type PersistedVaultDefinition } from "./vault-definition-store.ts";
import { PUBLIC_DEPOSIT_MINIMUM_USDC_RAW, publicDepositMinimumMessage } from "./deposit-floor.ts";

const HEADERS = { "Cache-Control": "no-store" };
const REQUEST_LIMIT = 4096;

type DepositInput = { owner: string; amountRaw: string; idempotencyKey?: string; stage?: "acquire" | "contribute"; signatures?: string[] };
type DepositRelease = { publicFundsEnabled: boolean; publicInvestSign: boolean };
type PreparedTransaction = {
  stepId: string;
  messageBase64: string;
  messageHash: string;
  requiredSigners: string[];
  allowedProgramIds: string[];
  maxDebits: { owner: string; mint: string; amountRaw: string }[];
  expectedRecipients: { owner: string; mint: string }[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
};

export type IndexDepositDependencies = {
  loadDefinition: (indexId: string) => Promise<PersistedVaultDefinition | null>;
  nativeBuilder: () => NativeVaultBuilders;
  release: DepositRelease;
  assertSlicesRoutable?: (native: NativeVaultBuilders, definition: PersistedVaultDefinition, amountRaw: string, owner: string) => Promise<void>;
  quoteZap?: typeof quoteIndexZap;
  readSwapDeltas?: (native: NativeVaultBuilders, owner: string, signatures: readonly string[]) => Promise<{ acquiredRawByMint: Record<string, string>; usdcSpentRaw: string }>;
  env?: { JUPITER_API_KEY?: string };
};

function defaultDependencies(): IndexDepositDependencies {
  return {
    loadDefinition: async indexId => {
      const db = createServiceSupabase();
      if (!db) throw new Error("Vault definitions are unavailable.");
      return readVaultDefinition(db, indexId);
    },
    nativeBuilder: () => kakuSanBuilders(false),
    release: VAULT_RELEASE,
  };
}

function plainError(error: unknown, status = 503) {
  return Response.json({ error: error instanceof Error ? error.message : "Deposit preparation is unavailable." }, { status, headers: HEADERS });
}

export function assertPublicDepositMinimum(amountRaw: string) {
  if (BigInt(amountRaw) < BigInt(PUBLIC_DEPOSIT_MINIMUM_USDC_RAW)) throw new Error(publicDepositMinimumMessage());
}

function usdcDisplayToRaw(value: unknown): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) throw new Error("USDC amount is invalid.");
  const [whole, fraction = ""] = text.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6))).toString();
}

export function parseIndexDepositRequest(body: unknown): DepositInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A deposit request is required.");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["owner", "amountUsdc", "amountRaw", "idempotencyKey", "stage", "signatures"].includes(key))) throw new Error("Unexpected deposit field.");
  if (typeof input.owner !== "string") throw new Error("Wallet owner is required.");
  if (input.amountRaw != null && input.amountUsdc != null) throw new Error("Provide either amountRaw or amountUsdc, not both.");
  if (input.amountRaw == null && input.amountUsdc == null) throw new Error("USDC amount is required.");
  const amountRaw = input.amountRaw != null ? input.amountRaw : usdcDisplayToRaw(input.amountUsdc);
  if (typeof amountRaw !== "string") throw new Error("USDC amount is required.");
  if (input.idempotencyKey != null && (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey))) throw new Error("Idempotency key is invalid.");
  if (input.stage != null && input.stage !== "acquire" && input.stage !== "contribute") throw new Error("Deposit stage is invalid.");
  const signatures = input.signatures == null ? undefined : input.signatures;
  if (signatures != null && (!Array.isArray(signatures) || signatures.length > 100 || signatures.some(item => typeof item !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(item)))) throw new Error("Buy signatures are invalid.");
  address(input.owner);
  rawAmount(amountRaw, true);
  sdkRawAmount(amountRaw);
  assertPublicDepositMinimum(amountRaw);
  return {
    owner: input.owner, amountRaw,
    ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.stage === "acquire" || input.stage === "contribute" ? { stage: input.stage } : {}),
    ...(signatures ? { signatures } : {}),
  };
}

function requireDepositGate(definition: PersistedVaultDefinition, release: DepositRelease) {
  if (definition.network !== "mainnet-beta") throw new Error("This vault is not on mainnet.");
  if (!definition.vaultAddress || !definition.shareMint) throw new Error("This index does not have a created vault.");
  address(definition.vaultAddress); address(definition.shareMint);
  if (definition.depositsEnabled !== true) throw new Error("This vault is not accepting deposits.");
  if (release.publicFundsEnabled !== true || release.publicInvestSign !== true) throw new Error("Investing is not open for signatures.");
}

function payloadInstructions(tx: TxPayload): TransactionInstruction[] {
  return tx.instructions.map(instruction => new TransactionInstruction({
    programId: new PublicKey(address(instruction.program_id)),
    keys: instruction.accounts.map(account => ({ pubkey: new PublicKey(address(account.pubkey)), isSigner: account.is_signer, isWritable: account.is_writable })),
    data: Buffer.from(instruction.data, "base64"),
  }));
}

function assertAncillarySemantics(instructions: TransactionInstruction[], owner: string, shareMint: string, bountyMint: string) {
  const buyer = new PublicKey(owner);
  const permittedMints = new Set([networkUsdc("mainnet-beta"), shareMint, bountyMint]);
  const permittedAta = (mint: PublicKey) => permittedMints.has(mint.toBase58()) && getAta(buyer, mint, TOKEN_PROGRAM_ID);
  const bountyWsolAta = new PublicKey(bountyMint).equals(NATIVE_MINT) ? getAta(buyer, NATIVE_MINT, TOKEN_PROGRAM_ID) : null;
  const systemTransfers = new Set<string>();

  for (const instruction of instructions) {
    const program = instruction.programId.toBase58();
    if (program === SystemProgram.programId.toBase58()) {
      if (instruction.data.length !== 12 || instruction.data.readUInt32LE(0) !== 2 || instruction.data.readBigUInt64LE(4) === 0n || instruction.keys.length !== 2 || !instruction.keys[0].pubkey.equals(buyer) || !instruction.keys[0].isSigner || !instruction.keys[0].isWritable || !bountyWsolAta || !instruction.keys[1].pubkey.equals(bountyWsolAta) || instruction.keys[1].isSigner || !instruction.keys[1].isWritable) throw new Error("System transfer is not an approved WSOL bounty wrap.");
      if (systemTransfers.has(bountyWsolAta.toBase58())) throw new Error("Duplicate WSOL bounty wrap.");
      systemTransfers.add(bountyWsolAta.toBase58());
      continue;
    }
    if (program === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
      const mint = instruction.keys[3]?.pubkey;
      const ata = mint && permittedAta(mint);
      if (!ata || (instruction.data.length !== 0 && !instruction.data.equals(Buffer.from([1]))) || instruction.keys.length !== 6 || !instruction.keys[0].pubkey.equals(buyer) || !instruction.keys[0].isSigner || !instruction.keys[0].isWritable || !instruction.keys[1].pubkey.equals(ata) || instruction.keys[1].isSigner || !instruction.keys[1].isWritable || !instruction.keys[2].pubkey.equals(buyer) || instruction.keys[2].isSigner || instruction.keys[2].isWritable || instruction.keys[3].isSigner || instruction.keys[3].isWritable || !instruction.keys[4].pubkey.equals(SystemProgram.programId) || instruction.keys[4].isSigner || instruction.keys[4].isWritable || !instruction.keys[5].pubkey.equals(TOKEN_PROGRAM_ID) || instruction.keys[5].isSigner || instruction.keys[5].isWritable) throw new Error("Associated token account creation is invalid.");
      continue;
    }
    if (program === ComputeBudgetProgram.programId.toBase58()) continue;
    if (program === SYMMETRY_PROGRAM_ID || program === TOKEN_PROGRAM_ID.toBase58() || program === TOKEN_2022_PROGRAM_ID.toBase58()) continue;
    throw new Error("Unsupported ancillary instruction.");
  }

  for (const instruction of instructions) {
    if (!instruction.programId.equals(TOKEN_PROGRAM_ID) || instruction.data[0] !== 17) continue;
    if (instruction.data.length !== 1 || instruction.keys.length !== 1 || instruction.keys[0].isSigner || !instruction.keys[0].isWritable || !systemTransfers.delete(instruction.keys[0].pubkey.toBase58())) throw new Error("WSOL sync is invalid.");
  }
  if (systemTransfers.size) throw new Error("System transfer is missing its WSOL sync.");
}

const SYMMETRY_DEPOSIT = Buffer.from([88, 92, 158, 219, 83, 71, 239, 164]);
const SYMMETRY_CREATE_INTENT = Buffer.from([120, 80, 245, 123, 212, 149, 163, 47]);
const SYMMETRY_RESIZE_INTENT = Buffer.from([71, 204, 243, 183, 209, 118, 111, 94]);
const SYMMETRY_INIT_INTENT = Buffer.from([127, 215, 41, 110, 244, 179, 131, 7]);
const SYMMETRY_LOCK = Buffer.from([64, 238, 171, 198, 135, 253, 37, 9]);

function sameInstruction(actual: TransactionInstruction, expected: TransactionInstruction) {
  return actual.programId.equals(expected.programId) && actual.data.equals(expected.data) && actual.keys.length === expected.keys.length && actual.keys.every((key, index) => key.pubkey.equals(expected.keys[index].pubkey) && key.isSigner === expected.keys[index].isSigner && key.isWritable === expected.keys[index].isWritable);
}

function assertSymmetrySemantics(instructions: TransactionInstruction[], owner: string, vaultAddress: string, shareMint: string, amountRaw: string | undefined, bountyMint: string) {
  const vault = new PublicKey(vaultAddress), buyer = new PublicKey(owner), mint = new PublicKey(shareMint), usdc = new PublicKey(networkUsdc("mainnet-beta"));
  const intent = getRebalanceIntentPda(vault, buyer);
  const expectedDeposit = new TransactionInstruction({ programId: new PublicKey(SYMMETRY_PROGRAM_ID), keys: [
    { pubkey: buyer, isSigner: true, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: true }, { pubkey: intent, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: usdc, isSigner: false, isWritable: false }, { pubkey: getAta(buyer, usdc, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true }, { pubkey: getAta(vault, usdc, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
  ], data: Buffer.concat([SYMMETRY_DEPOSIT, Buffer.alloc(80)]) });
  if (amountRaw) expectedDeposit.data.writeBigUInt64LE(BigInt(amountRaw), 8);
  const expectedLock = new TransactionInstruction({ programId: new PublicKey(SYMMETRY_PROGRAM_ID), keys: [
    { pubkey: buyer, isSigner: true, isWritable: true }, { pubkey: intent, isSigner: false, isWritable: true }, { pubkey: getGlobalConfigPda(), isSigner: false, isWritable: false },
  ], data: SYMMETRY_LOCK });
  const rentPayerPda = getRentPayerPda();
  let selectedRentPayer: PublicKey | null = null;
  let deposits = 0;
  let locks = 0;
  let creates = 0;
  let resizes = 0;
  let initializations = 0;
  for (const instruction of instructions.filter(ix => ix.programId.toBase58() === SYMMETRY_PROGRAM_ID)) {
    const discriminator = instruction.data.subarray(0, 8);
    if (discriminator.equals(SYMMETRY_DEPOSIT)) {
      if (!amountRaw || !sameInstruction(instruction, expectedDeposit)) throw new Error("Symmetry deposit accounts or amount are invalid.");
      deposits += 1;
    } else if (discriminator.equals(SYMMETRY_LOCK)) {
      if (!sameInstruction(instruction, expectedLock)) throw new Error("Symmetry lock accounts are invalid.");
      locks += 1;
    } else if (discriminator.equals(SYMMETRY_CREATE_INTENT)) {
      if (instruction.data.length !== 8) throw new Error("Symmetry intent parameters are invalid.");
      const candidateRentPayer = instruction.keys[4]?.pubkey;
      if (!candidateRentPayer || (!candidateRentPayer.equals(rentPayerPda) && !candidateRentPayer.equals(buyer)) || (selectedRentPayer && !candidateRentPayer.equals(selectedRentPayer))) throw new Error("Symmetry intent rent payer is invalid.");
      selectedRentPayer = candidateRentPayer;
      creates += 1;
      if (instruction.keys.length !== 9 || !instruction.keys[0].pubkey.equals(buyer) || !instruction.keys[0].isSigner || !instruction.keys[1].pubkey.equals(buyer) || !instruction.keys[2].pubkey.equals(vault) || !instruction.keys[3].pubkey.equals(intent) || !instruction.keys[5].pubkey.equals(getGlobalConfigPda()) || !instruction.keys[6].pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY) || !instruction.keys[7].pubkey.equals(SYSVAR_RENT_PUBKEY) || !instruction.keys[8].pubkey.equals(SystemProgram.programId)) throw new Error("Symmetry intent accounts are invalid.");
    } else if (discriminator.equals(SYMMETRY_RESIZE_INTENT)) {
      resizes += 1;
      if (instruction.data.length !== 8 || instruction.keys.length !== 1 || !instruction.keys[0].pubkey.equals(intent) || !instruction.keys[0].isWritable) throw new Error("Symmetry resize accounts are invalid.");
    } else if (discriminator.equals(SYMMETRY_INIT_INTENT)) {
      const candidateRentPayer = instruction.keys[4]?.pubkey;
      if (!candidateRentPayer || (!candidateRentPayer.equals(rentPayerPda) && !candidateRentPayer.equals(buyer)) || (selectedRentPayer && !candidateRentPayer.equals(selectedRentPayer))) throw new Error("Symmetry intent rent payer is invalid.");
      selectedRentPayer = candidateRentPayer;
      initializations += 1;
      if (instruction.data.length !== 126 || instruction.keys.length !== 18 || !instruction.keys[0].pubkey.equals(buyer) || !instruction.keys[0].isSigner || !instruction.keys[1].pubkey.equals(buyer) || !instruction.keys[2].pubkey.equals(vault) || !instruction.keys[3].pubkey.equals(intent) || !instruction.keys[5].pubkey.equals(mint) || !instruction.keys[6].pubkey.equals(getAta(buyer, mint, TOKEN_PROGRAM_ID)) || !instruction.keys[7].pubkey.equals(getGlobalConfigPda()) || !instruction.keys[8].pubkey.equals(new PublicKey(bountyMint)) || !instruction.keys[9].pubkey.equals(getAta(buyer, new PublicKey(bountyMint), TOKEN_PROGRAM_ID)) || !instruction.keys[10].pubkey.equals(getBountyVaultPda()) || !instruction.keys[11].pubkey.equals(getAta(getBountyVaultPda(), new PublicKey(bountyMint), TOKEN_PROGRAM_ID)) || !instruction.keys[12].pubkey.equals(getVaultFeesPda(vault)) || !instruction.keys[13].pubkey.equals(getAta(getVaultFeesPda(vault), mint, TOKEN_PROGRAM_ID)) || !instruction.keys[14].pubkey.equals(new PublicKey(SYMMETRY_PROGRAM_ID)) || !instruction.keys[15].pubkey.equals(SystemProgram.programId) || !instruction.keys[16].pubkey.equals(TOKEN_PROGRAM_ID) || !instruction.keys[17].pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || !new PublicKey(instruction.data.subarray(8, 40)).equals(instruction.keys[4].pubkey) || instruction.data[40] !== 0 || instruction.data.readUInt16LE(41) !== 100 || instruction.data.readUInt16LE(43) !== 50) throw new Error("Symmetry intent parameters or accounts are invalid.");
    } else throw new Error("Unsupported Symmetry instruction.");
  }
  const setup = selectedRentPayer !== null;
  const firstDeposit = deposits === 1 && locks === 1 && setup && creates === 1 && resizes === 1 && initializations === 1;
  if (amountRaw ? !(deposits === 1 && locks === 0 && !setup) && !firstDeposit : !((locks === 1 && !setup && !creates && !resizes && !initializations) || (locks === 0 && setup && creates === 1 && resizes === 1 && initializations === 1))) throw new Error("Prepared transaction contains an unexpected Symmetry operation.");
}

async function assertLiveVault(native: NativeVaultBuilders, definition: PersistedVaultDefinition, owner: string, resumeUnlocked = false) {
  await native.assertNetwork();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet vault builder required.");
  const vault = await native.sdk.fetchVault(definition.vaultAddress!);
  if (vault.ownAddress.toBase58() !== definition.vaultAddress || vault.mint.toBase58() !== definition.shareMint) throw new Error("Native vault identity mismatch.");
  const intent = getRebalanceIntentPda(new PublicKey(definition.vaultAddress!), new PublicKey(owner));
  if (await native.connection.getAccountInfo(intent, "confirmed")) {
    if (!resumeUnlocked || !native.sdk.fetchRebalanceIntent) throw new Error("An existing deposit is awaiting keeper minting.");
    const existing = await native.sdk.fetchRebalanceIntent(intent.toBase58());
    if (existing.chain_data.currentAction !== RebalanceAction.DepositTokens) throw new Error("An existing deposit is awaiting keeper minting.");
  }
  return vault;
}

function depositOperationId(indexId: string, input: DepositInput) {
  return `deposit-${hashObject({ indexId, owner: input.owner, amountRaw: input.amountRaw, key: input.idempotencyKey ?? "" }).slice(0, 32)}`;
}

function basketPayload(observed: ObservedZap, stage: "acquire" | "contribute" | "incomplete", packaging: "atomic" | "resumable", leftoverUsdcRaw: string) {
  return {
    stage, packaging, targetCount: observed.targetCount, bought: observed.bought, missing: observed.missing,
    complete: observed.complete, claimCount: observed.claimCount, leftoverUsdcRaw, statusLine: observed.statusLine,
  };
}

function inKindDepositRows(instruction: TransactionInstruction, owner: string, vaultAddress: string): { mint: string; amount: string }[] | null {
  if (instruction.programId.toBase58() !== SYMMETRY_PROGRAM_ID || !instruction.data.subarray(0, 8).equals(SYMMETRY_DEPOSIT) || instruction.data.length !== 88) return null;
  const buyer = new PublicKey(owner);
  const vault = new PublicKey(vaultAddress);
  const intent = getRebalanceIntentPda(vault, buyer);
  const count = (instruction.keys.length - 7) / 3;
  if (!Number.isInteger(count) || count < 1 || count > 5 || !instruction.keys[0]?.pubkey.equals(buyer) || !instruction.keys[0].isSigner || !instruction.keys[1]?.pubkey.equals(vault) || !instruction.keys[2]?.pubkey.equals(intent)) throw new Error("In-kind deposit accounts are invalid.");
  const rows: { mint: string; amount: string }[] = [];
  for (let i = 0; i < count; i++) {
    const amount = instruction.data.readBigUInt64LE(8 + i * 8);
    const mint = instruction.keys[7 + i * 3]?.pubkey;
    const ownerAta = instruction.keys[8 + i * 3]?.pubkey;
    const vaultAta = instruction.keys[9 + i * 3]?.pubkey;
    if (!mint || !ownerAta || !vaultAta || amount === 0n || mint.toBase58() === MAINNET_USDC) throw new Error("In-kind deposit includes cash or an empty leg.");
    const program = getAta(buyer, mint, TOKEN_2022_PROGRAM_ID).equals(ownerAta) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    if (!getAta(buyer, mint, program).equals(ownerAta) || !getAta(vault, mint, program).equals(vaultAta)) throw new Error("In-kind deposit custody account is invalid.");
    rows.push({ mint: mint.toBase58(), amount: amount.toString() });
  }
  for (let i = count; i < 10; i++) if (instruction.data.readBigUInt64LE(8 + i * 8) !== 0n) throw new Error("In-kind deposit encoding is invalid.");
  return rows;
}

async function releaseInKindContribution(native: NativeVaultBuilders, buy: TxPayloadBatchSequence, lock: TxPayloadBatchSequence, owner: string, vaultAddress: string, shareMint: string, bountyMint: string, contributions: { mint: string; amount: string }[]): Promise<PreparedTransaction[]> {
  const all = [...buy.batches.flatMap(batch => batch.transactions), ...lock.batches.flatMap(batch => batch.transactions)];
  if (!all.length) throw new Error("The vault did not prepare a contribution.");
  const seen: { mint: string; amount: string }[] = [];
  const prepared = await Promise.all(all.map(async (tx, index) => {
    if (tx.payer !== owner) throw new Error("Prepared transaction payer does not match the investing wallet.");
    const instructions = payloadInstructions(tx);
    assertAncillarySemantics(instructions, owner, shareMint, bountyMint);
    const rows = instructions.flatMap(instruction => inKindDepositRows(instruction, owner, vaultAddress) ?? []);
    if (!rows.length) assertSymmetrySemantics(instructions, owner, vaultAddress, shareMint, undefined, bountyMint);
    seen.push(...rows);
    const maxDebits = rows.map(row => ({ owner, mint: row.mint, amountRaw: row.amount }));
    const recipients = rows.map(row => ({ owner: vaultAddress, mint: row.mint }));
    return validateAndSimulate(native.connection, { stepId: `contribute-${index + 1}`, transactionBase64: tx.tx_b64, lastValidBlockHeight: tx.last_valid_block_height as number }, {
      payer: owner, signers: [owner],
      programs: [...new Set(instructions.map(instruction => instruction.programId.toBase58()))],
      writableAccounts: [...new Set(instructions.flatMap(instruction => instruction.keys.filter(key => key.isWritable).map(key => key.pubkey.toBase58()))), owner],
      expectedInstructions: instructions, maxDebits, recipients, minima: [], maxComputeUnits: 1_400_000, maxMicroLamports: 100_000n,
      decode: (instruction: TransactionInstruction) => {
        const decoded = inKindDepositRows(instruction, owner, vaultAddress);
        return decoded ? { debits: decoded.map(row => ({ owner, mint: row.mint, amountRaw: row.amount })), recipients: decoded.map(row => ({ owner: vaultAddress, mint: row.mint })), minima: [] } : { debits: [], recipients: [], minima: [] };
      },
    });
  }));
  if (seen.length !== contributions.length || seen.some((row, index) => row.mint !== contributions[index]?.mint || row.amount !== contributions[index]?.amount)) throw new Error("In-kind contribution does not match the bought basket.");
  return prepared;
}

async function validateBuiltSlice(native: NativeVaultBuilders, slice: BuiltSlice, owner: string, index: number): Promise<PreparedTransaction> {
  const parsed = VersionedTransaction.deserialize(Buffer.from(slice.txBase64, "base64"));
  const tables = await Promise.all(parsed.message.addressTableLookups.map(async lookup => {
    const result = await native.connection.getAddressLookupTable(lookup.accountKey);
    if (!result.value?.isActive()) throw new Error("Unavailable/deactivated lookup table");
    return result.value;
  }));
  const instructions = TransactionMessage.decompile(parsed.message, { addressLookupTableAccounts: tables }).instructions;
  const programs = [...new Set(instructions.map(instruction => instruction.programId.toBase58()))];
  if (!programs.includes(slice.swapProgramId)) throw new Error("Prepared buy is missing its swap instruction.");
  const maxDebits = [{ owner, mint: networkUsdc("mainnet-beta"), amountRaw: slice.usdcInRaw }];
  const recipients = [{ owner, mint: slice.mint }];
  return validateAndSimulate(native.connection, { stepId: `buy-${index + 1}`, transactionBase64: slice.txBase64, lastValidBlockHeight: slice.lastValidBlockHeight }, {
    payer: owner,
    signers: [owner],
    programs,
    writableAccounts: [...new Set(instructions.flatMap(instruction => instruction.keys.filter(key => key.isWritable).map(key => key.pubkey.toBase58()))), owner],
    expectedInstructions: instructions,
    maxDebits,
    recipients,
    minima: [{ mint: slice.mint, amountRaw: slice.minOutRaw }],
    maxComputeUnits: 1_400_000,
    maxMicroLamports: 100_000n,
    decode: (instruction: TransactionInstruction) => instruction.programId.toBase58() === slice.swapProgramId
      ? { debits: maxDebits, recipients, minima: [{ mint: slice.mint, amountRaw: slice.minOutRaw }] }
      : { debits: [], recipients: [], minima: [] },
  });
}

async function readChainSwapDeltas(native: NativeVaultBuilders, owner: string, signatures: readonly string[], legs: readonly { mint: string }[]) {
  const parsed = [];
  for (const signature of signatures) {
    const tx = await native.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const meta = tx?.meta;
    if (!tx || !meta || meta.err) throw new Error("A buy signature is not confirmed.");
    const rows = (balances: { mint: string; owner?: string; uiTokenAmount?: { amount?: string } }[] | null | undefined) => (balances ?? []).flatMap(row =>
      row.owner === owner && row.mint && row.uiTokenAmount?.amount ? [{ mint: row.mint, owner, amountRaw: row.uiTokenAmount.amount }] : []);
    parsed.push({ signature, pre: rows(meta.preTokenBalances as never), post: rows(meta.postTokenBalances as never) });
  }
  return attributeSwapDeltas({ owner, legs, signatures: parsed });
}

export async function prepareIndexDeposit(indexId: string, input: DepositInput, dependencies: IndexDepositDependencies = defaultDependencies()) {
  assertPublicDepositMinimum(input.amountRaw);
  const definition = await dependencies.loadDefinition(indexId);
  if (!definition) throw new Error("Index not found.");
  requireDepositGate(definition, dependencies.release);
  const native = dependencies.nativeBuilder();
  const vault = await assertLiveVault(native, definition, input.owner, input.stage === "contribute");
  assertMag7DepositBacking(vault, definition);
  if (definition.vaultLegs.length < 1) throw new Error("This index has no investment legs.");
  const operationId = depositOperationId(indexId, input);
  const configHash = hashObject({ indexId, vault: definition.vaultAddress, shareMint: definition.shareMint, depositsEnabled: definition.depositsEnabled });
  const costs = { hostEntryFeeBps: definition.hostEntryFeeBps ?? 25, hostExitFeeBps: definition.hostExitFeeBps ?? 0, estimatedOnly: true };
  if (dependencies.assertSlicesRoutable) await dependencies.assertSlicesRoutable(native, definition, input.amountRaw, input.owner);

  if (input.stage === "contribute") {
    const weighted = planWeightedUsdcSlices(input.amountRaw, definition.vaultLegs);
    const deltas = input.signatures?.length
      ? await (dependencies.readSwapDeltas ?? ((builders, owner, signatures) => readChainSwapDeltas(builders, owner, signatures, definition.vaultLegs)))(native, input.owner, input.signatures)
      : { acquiredRawByMint: {}, usdcSpentRaw: "0" };
    const observed = observeAcquisition({
      legs: definition.vaultLegs,
      acquiredRawByMint: deltas.acquiredRawByMint,
      minimumRawByMint: Object.fromEntries(weighted.slices.map(slice => [slice.mint, "1"])),
      leftoverUsdcRaw: (BigInt(input.amountRaw) - BigInt(deltas.usdcSpentRaw)).toString(),
    });
    if (!observed.complete) {
      return {
        network: "mainnet-beta" as const, operationId, phase: "INCOMPLETE", requires: "wait" as const, transactions: [],
        configHash, costs, blockers: [observed.statusLine],
        basket: basketPayload(observed, "incomplete", "resumable", observed.leftoverUsdcRaw),
        constraints: [{ label: "Resume", value: "Retry the names that did not buy. Bought tokens and unspent USDC stay in your wallet." }],
      };
    }
    const contributions = contributionsFromObservation(observed);
    if (contributions.some(leg => leg.mint === MAINNET_USDC)) throw new Error("IN_KIND_USDC_CONTRIBUTION_FORBIDDEN");
    const buy = await native.sdk.buyVaultTx({
      buyer: input.owner, vault_mint: definition.shareMint!, contributions: contributions.map(leg => ({ mint: leg.mint, amount: sdkRawAmount(leg.amount) })),
      rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50,
    });
    const lock = await native.sdk.lockDepositsTx({ buyer: input.owner, vault_mint: definition.shareMint! });
    return {
      network: "mainnet-beta" as const, operationId, phase: "AWAITING_SIGNATURE", requires: "user-signature" as const,
      transactions: await releaseInKindContribution(native, buy, lock, input.owner, definition.vaultAddress!, definition.shareMint!, vault.settings.bountyMint.toBase58(), contributions),
      configHash, costs, blockers: [],
      basket: basketPayload(observed, "contribute", "resumable", observed.leftoverUsdcRaw),
      constraints: [{ label: "Contribute", value: zapStatusLine(observed) }, { label: "Leftover USDC", value: "Unspent USDC stays in your wallet." }],
    };
  }

  const heldMints = input.signatures?.length
    ? Object.entries((await (dependencies.readSwapDeltas ?? ((builders, owner, signatures) => readChainSwapDeltas(builders, owner, signatures, definition.vaultLegs)))(native, input.owner, input.signatures)).acquiredRawByMint).filter(([, amount]) => BigInt(amount) > 0n).map(([mint]) => mint)
    : [];
  const missingMints = heldMints.length ? definition.vaultLegs.map(leg => leg.mint).filter(mint => !heldMints.includes(mint)) : undefined;
  const quoted = await (dependencies.quoteZap ?? quoteIndexZap)({
    native, definition, amountRaw: input.amountRaw, owner: input.owner, env: dependencies.env, ...(missingMints ? { onlyMints: missingMints } : {}),
  });
  const slices = quoted.slices;
  const transactions = await Promise.all(slices.map((slice, index) => validateBuiltSlice(native, slice, input.owner, index)));
  const observed = observeAcquisition({
    legs: definition.vaultLegs,
    acquiredRawByMint: {},
    minimumRawByMint: Object.fromEntries(quoted.plan.quotes.map(quote => [quote.mint, quote.minOutRaw])),
    leftoverUsdcRaw: quoted.plan.leftoverUsdcRaw,
  });
  return {
    network: "mainnet-beta" as const,
    operationId,
    phase: "AWAITING_SIGNATURE",
    requires: "user-signature" as const,
    transactions,
    configHash,
    costs,
    blockers: [],
    basket: {
      ...basketPayload({ ...observed, bought: [], missing: quoted.plan.slices.map(slice => ({ ticker: slice.ticker, mint: slice.mint })), complete: false, claimCount: null, statusLine: `Quoted ${quoted.plan.legCount} names. Unspent USDC stays in your wallet.` }, "acquire", quoted.plan.packaging, quoted.plan.leftoverUsdcRaw),
      quotes: quoted.plan.quotes,
      keeperUsdcRaw: quoted.plan.keeperUsdcRaw,
      usesAuctionPairs: quoted.plan.usesAuctionPairs,
    },
    constraints: [
      { label: "Buys", value: `Market-buys ${quoted.plan.legCount} names with your USDC on Jupiter, or Raydium if Jupiter has no route. Unspent USDC stays in your wallet.` },
      { label: "Shares", value: "Shares are minted only after every quoted name is contributed. A missed name is not counted as bought." },
    ],
  };
}

/** Public wallet prepare has no cycle policy, journal, access message, or recovery rail. */
export async function handleIndexDepositPrepare(request: Request, indexId: string, dependencies: IndexDepositDependencies = defaultDependencies()): Promise<Response> {
  if (!/^(insiderindex-|idx-theme-)[a-z0-9-]+$/.test(indexId)) return plainError(new Error("Invalid index ID."), 400);
  let input: DepositInput;
  try {
    const text = await request.text();
    if (text.length > REQUEST_LIMIT) return plainError(new Error("Request too large."), 413);
    input = parseIndexDepositRequest(JSON.parse(text));
  } catch (error) {
    return plainError(error, 400);
  }
  try {
    return Response.json(await prepareIndexDeposit(indexId, input, dependencies), { headers: HEADERS });
  } catch (error) {
    return plainError(error);
  }
}
