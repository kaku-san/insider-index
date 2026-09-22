import { getBountyVaultPda, getGlobalConfigPda, getRebalanceIntentPda, getRentPayerPda, getVaultFeesPda, getAta } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import type { TxPayload, TxPayloadBatchSequence } from "@symmetry-hq/sdk/dist/txUtils.js";
import { ComputeBudgetProgram, PACKET_DATA_SIZE, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { createServiceSupabase } from "@/lib/supabase";
import { address, hashObject, rawAmount, sdkRawAmount } from "./amounts.ts";
import { validateAndSimulate } from "./transaction-policy.ts";
import { kakuSanBuilders } from "./kaku-san-create.ts";
import { VAULT_RELEASE } from "./release.ts";
import { networkUsdc, SYMMETRY_PROGRAM_ID, type NativeVaultBuilders } from "./symmetry-adapter.ts";
import { readVaultDefinition, type PersistedVaultDefinition } from "./vault-definition-store.ts";
import { PUBLIC_DEPOSIT_MINIMUM_USDC_RAW, publicDepositMinimumMessage } from "./deposit-floor.ts";

const HEADERS = { "Cache-Control": "no-store" };
const REQUEST_LIMIT = 4096;

type DepositInput = { owner: string; amountRaw: string; idempotencyKey?: string };
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
  if (Object.keys(input).some(key => !["owner", "amountUsdc", "amountRaw", "idempotencyKey"].includes(key))) throw new Error("Unexpected deposit field.");
  if (typeof input.owner !== "string") throw new Error("Wallet owner is required.");
  if (input.amountRaw != null && input.amountUsdc != null) throw new Error("Provide either amountRaw or amountUsdc, not both.");
  if (input.amountRaw == null && input.amountUsdc == null) throw new Error("USDC amount is required.");
  const amountRaw = input.amountRaw != null ? input.amountRaw : usdcDisplayToRaw(input.amountUsdc);
  if (typeof amountRaw !== "string") throw new Error("USDC amount is required.");
  if (input.idempotencyKey != null && (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey))) throw new Error("Idempotency key is invalid.");
  address(input.owner);
  rawAmount(amountRaw, true);
  sdkRawAmount(amountRaw);
  assertPublicDepositMinimum(amountRaw);
  return { owner: input.owner, amountRaw, ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}) };
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

function payloadTransaction(transaction: VersionedTransaction, recentBlockhash: string, lastValidBlockHeight: number, payer: string, instructions: TransactionInstruction[]): TxPayload {
  return {
    tx_b64: Buffer.from(transaction.serialize()).toString("base64"), message_version: "0", recent_blockhash: recentBlockhash, last_valid_block_height: lastValidBlockHeight,
    payer, lookup_tables: [], instructions: instructions.map(instruction => ({ program_id: instruction.programId.toBase58(), data: instruction.data.toString("base64"),
      accounts: instruction.keys.map(account => ({ pubkey: account.pubkey.toBase58(), is_signer: account.isSigner, is_writable: account.isWritable })) })),
  };
}

/** SDK emits first-intent setup, contribution, and lock in separate batches. Simulation does not
 * retain writes between transactions, so the latter two see the intent PDA as system-owned. Keep
 * the user-visible first deposit atomic, after refusing ALT or compute-budget shape changes. */
function atomicFirstDepositPayload(buy: TxPayloadBatchSequence, lock: TxPayloadBatchSequence, owner: string): TxPayloadBatchSequence {
  const transactions = [...buy.batches.flatMap(batch => batch.transactions), ...lock.batches.flatMap(batch => batch.transactions)];
  if (buy.batches.length !== 2 || buy.batches.some(batch => batch.transactions.length !== 1) || lock.batches.length !== 1 || lock.batches[0]?.transactions.length !== 1 || transactions.length !== 3) throw new Error("Unexpected first-depositor transaction sequence.");
  const first = transactions[0]!;
  if (typeof first.last_valid_block_height !== "number" || transactions.some(transaction => transaction.payer !== owner || transaction.lookup_tables.length !== 0)) throw new Error("First-depositor transaction identity is invalid.");
  const instructions = transactions.flatMap(payloadInstructions);
  const seenCompute = new Map<number, Buffer>();
  const compacted = instructions.filter(instruction => {
    if (!instruction.programId.equals(ComputeBudgetProgram.programId)) return true;
    const discriminator = instruction.data[0];
    const previous = seenCompute.get(discriminator);
    if (!previous) { seenCompute.set(discriminator, instruction.data); return true; }
    if (!previous.equals(instruction.data)) throw new Error("First-depositor compute budget is inconsistent.");
    return false;
  });
  const combined = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: first.recent_blockhash, instructions: compacted }).compileToV0Message());
  if (combined.serialize().length > PACKET_DATA_SIZE) throw new Error("First-depositor transaction exceeds the Solana packet limit.");
  return { batches: [{ transactions: [payloadTransaction(combined, first.recent_blockhash, first.last_valid_block_height, owner, compacted)] }] };
}

async function assertTokenSemantics(native: NativeVaultBuilders, instructions: TransactionInstruction[], owner: string, vaultAddress: string, maxDebits: PreparedTransaction["maxDebits"]) {
  const tokenPrograms = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
  let validatedTransfers = 0;
  let tokenInstructions = 0;
  for (const instruction of instructions) {
    if (!tokenPrograms.has(instruction.programId.toBase58())) continue;
    const discriminator = instruction.data[0];
    // SyncNative is only admitted after assertAncillarySemantics verifies its paired
    // System transfer into the buyer's expected WSOL ATA.
    if (discriminator === 17 && instruction.programId.equals(TOKEN_PROGRAM_ID)) continue;
    tokenInstructions += 1;
    if ((discriminator !== 3 && discriminator !== 12) || instruction.keys.length < 3 || instruction.data.length < (discriminator === 12 ? 10 : 9)) throw new Error("Unsupported token instruction");
    const source = instruction.keys[0].pubkey;
    const destination = instruction.keys[discriminator === 12 ? 2 : 1].pubkey;
    const authority = instruction.keys[discriminator === 12 ? 3 : 2]?.pubkey;
    if (!authority?.equals(new PublicKey(owner)) || !instruction.keys[0].isWritable || !instruction.keys[discriminator === 12 ? 2 : 1].isWritable) throw new Error("Token transfer authority or accounts are invalid.");
    if (source.equals(destination)) throw new Error("Token transfer accounts are invalid.");
    if (discriminator === 12 && !instruction.keys[1].pubkey.equals(new PublicKey(networkUsdc("mainnet-beta")))) throw new Error("Token transfer mint is invalid.");
    const [sourceInfo, destinationInfo] = await Promise.all([
      native.connection.getAccountInfo(source, "confirmed"),
      native.connection.getAccountInfo(destination, "confirmed"),
    ]);
    if (!sourceInfo || !destinationInfo || !tokenPrograms.has(sourceInfo.owner.toBase58()) || !tokenPrograms.has(destinationInfo.owner.toBase58()) || !sourceInfo.owner.equals(destinationInfo.owner)) throw new Error("Token accounts are unavailable or use different programs.");
    const sourceAccount = unpackAccount(source, sourceInfo, sourceInfo.owner);
    const destinationAccount = unpackAccount(destination, destinationInfo, destinationInfo.owner);
    if (sourceAccount.mint.toBase58() !== networkUsdc("mainnet-beta") || destinationAccount.mint.toBase58() !== networkUsdc("mainnet-beta") || sourceAccount.owner.toBase58() !== owner || destinationAccount.owner.toBase58() !== vaultAddress) throw new Error("Token transfer mint or custody account is invalid.");
    const amountRaw = instruction.data.readBigUInt64LE(1).toString();
    if (amountRaw !== maxDebits[0]?.amountRaw) throw new Error("Token transfer amount is invalid.");
    validatedTransfers += 1;
  }
  if (tokenInstructions > (maxDebits.length ? 1 : 0) || validatedTransfers !== tokenInstructions) throw new Error("Prepared transaction contains invalid USDC transfers.");
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

function transactionPolicy(instructions: TransactionInstruction[], owner: string, maxDebits: PreparedTransaction["maxDebits"], expectedRecipients: PreparedTransaction["expectedRecipients"]) {
  const tokenPrograms = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
  const allowedPrograms = new Set([ComputeBudgetProgram.programId.toBase58(), SystemProgram.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), ...tokenPrograms, SYMMETRY_PROGRAM_ID]);
  const programs = [...new Set(instructions.map(instruction => instruction.programId.toBase58()))];
  if (!programs.length || programs.some(program => !allowedPrograms.has(program))) throw new Error("Prepared transaction uses an unapproved program.");
  return {
    payer: owner,
    signers: [owner],
    programs,
    writableAccounts: [...new Set(instructions.flatMap(instruction => instruction.keys.filter(key => key.isWritable).map(key => key.pubkey.toBase58()))), owner],
    expectedInstructions: instructions,
    maxDebits,
    recipients: expectedRecipients,
    minima: [],
    maxComputeUnits: 1_400_000,
    maxMicroLamports: 100_000n,
    decode: (instruction: TransactionInstruction) => {
      if (!tokenPrograms.has(instruction.programId.toBase58())) return { debits: [], recipients: [], minima: [] };
      const discriminator = instruction.data[0];
      if (discriminator === 17 && instruction.programId.equals(TOKEN_PROGRAM_ID)) return { debits: [], recipients: [], minima: [] };
      if (discriminator !== 3 && discriminator !== 12) throw new Error("Unsupported token instruction");
      if (instruction.data.length < 9) throw new Error("Malformed token instruction");
      return { debits: [{ owner, mint: networkUsdc("mainnet-beta"), amountRaw: instruction.data.readBigUInt64LE(1).toString() }], recipients: expectedRecipients, minima: [] };
    },
  };
}

async function transactionFromPayload(native: NativeVaultBuilders, tx: TxPayload, stepId: string, owner: string, vaultAddress: string, shareMint: string, bountyMint: string, maxDebits: PreparedTransaction["maxDebits"]): Promise<PreparedTransaction> {
  if (tx.payer !== owner) throw new Error("Prepared transaction payer does not match the investing wallet.");
  const lastValidBlockHeight = tx.last_valid_block_height;
  if (!tx.tx_b64 || typeof lastValidBlockHeight !== "number" || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) throw new Error("Prepared transaction is missing its expiry.");
  const parsed = VersionedTransaction.deserialize(Buffer.from(tx.tx_b64, "base64"));
  const signers = parsed.message.staticAccountKeys.slice(0, parsed.message.header.numRequiredSignatures).map(key => key.toBase58());
  if (signers.length !== 1 || signers[0] !== owner || parsed.signatures.some(signature => signature.some(byte => byte !== 0))) throw new Error("Prepared transaction requires an unexpected signer.");
  if (parsed.message.staticAccountKeys[0]?.toBase58() !== owner || parsed.message.recentBlockhash !== tx.recent_blockhash) throw new Error("Prepared transaction identity mismatch.");
  const instructions = payloadInstructions(tx);
  assertAncillarySemantics(instructions, owner, shareMint, bountyMint);
  await assertTokenSemantics(native, instructions, owner, vaultAddress, maxDebits);
  assertSymmetrySemantics(instructions, owner, vaultAddress, shareMint, maxDebits[0]?.amountRaw, bountyMint);
  const expectedRecipients = maxDebits.length ? [{ owner: vaultAddress, mint: networkUsdc("mainnet-beta") }] : [];
  return validateAndSimulate(native.connection, { stepId, transactionBase64: tx.tx_b64, lastValidBlockHeight }, transactionPolicy(instructions, owner, maxDebits, expectedRecipients));
}

async function transactionsFromPayload(native: NativeVaultBuilders, payload: TxPayloadBatchSequence, prefix: string, owner: string, vaultAddress: string, shareMint: string, bountyMint: string, amountRaw?: string): Promise<PreparedTransaction[]> {
  const all = payload.batches.flatMap(batch => batch.transactions);
  if (!all.length) throw new Error("The vault did not prepare a transaction.");
  return Promise.all(all.map((tx, index) => transactionFromPayload(native, tx, `${prefix}-${index + 1}`, owner, vaultAddress, shareMint, bountyMint,
    amountRaw && index === all.length - 1 ? [{ owner, mint: networkUsdc("mainnet-beta"), amountRaw }] : [])));
}

async function assertLiveVault(native: NativeVaultBuilders, definition: PersistedVaultDefinition, owner: string) {
  await native.assertNetwork();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet vault builder required.");
  const vault = await native.sdk.fetchVault(definition.vaultAddress!);
  if (vault.ownAddress.toBase58() !== definition.vaultAddress || vault.mint.toBase58() !== definition.shareMint) throw new Error("Native vault identity mismatch.");
  const intent = getRebalanceIntentPda(new PublicKey(definition.vaultAddress!), new PublicKey(owner));
  if (await native.connection.getAccountInfo(intent, "confirmed")) throw new Error("An existing deposit is awaiting keeper minting.");
  return vault;
}

export async function prepareIndexDeposit(indexId: string, input: DepositInput, dependencies: IndexDepositDependencies = defaultDependencies()) {
  assertPublicDepositMinimum(input.amountRaw);
  const definition = await dependencies.loadDefinition(indexId);
  if (!definition) throw new Error("Index not found.");
  requireDepositGate(definition, dependencies.release);
  const native = dependencies.nativeBuilder();
  const vault = await assertLiveVault(native, definition, input.owner);
  const buy = await native.sdk.buyVaultTx({
    buyer: input.owner,
    vault_mint: definition.shareMint!,
    contributions: [{ mint: networkUsdc("mainnet-beta"), amount: sdkRawAmount(input.amountRaw) }],
    rebalance_slippage_bps: 100,
    per_trade_rebalance_slippage_bps: 50,
  });
  const lock = await native.sdk.lockDepositsTx({ buyer: input.owner, vault_mint: definition.shareMint! });
  const prepared = atomicFirstDepositPayload(buy, lock, input.owner);
  const operationId = `deposit-${hashObject({ indexId, owner: input.owner, amountRaw: input.amountRaw, key: input.idempotencyKey ?? "" }).slice(0, 32)}`;
  return {
    network: "mainnet-beta" as const,
    operationId,
    phase: "AWAITING_SIGNATURE",
    requires: "user-signature" as const,
    transactions: await transactionsFromPayload(native, prepared, "deposit", input.owner, definition.vaultAddress!, definition.shareMint!, vault.settings.bountyMint.toBase58(), input.amountRaw),
    configHash: hashObject({ indexId, vault: definition.vaultAddress, shareMint: definition.shareMint, depositsEnabled: definition.depositsEnabled }),
    constraints: [{ label: "Settlement", value: "Your deposit locks after wallet approval. A keeper mints shares later." }],
    costs: { hostEntryFeeBps: definition.hostEntryFeeBps ?? 25, hostExitFeeBps: definition.hostExitFeeBps ?? 0, estimatedOnly: true },
    blockers: [],
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
