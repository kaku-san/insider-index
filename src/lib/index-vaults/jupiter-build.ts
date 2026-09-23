import { AddressLookupTableAccount, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { rawAmount, sha256 } from "./amounts.ts";

/** Router build, not Meta-Aggregator `/order`. Raw instructions stay composable; an assembled order transaction does not. */
export const JUPITER_BUILD_URL = "https://api.jup.ag/swap/v2/build";
export const JUPITER_API_KEY_REQUIRED = "Jupiter API key is required for index sells.";
export const JUPITER_API_KEY_REJECTED = "Jupiter API key was rejected.";
export const JUPITER_BUILD_NOT_RAW = "Jupiter build did not return raw swap instructions.";

export type ParsedJupiterBuild = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minOutRaw: string;
  slippageBps: number;
  taker: string;
  destinationTokenAccount: string | null;
  swapProgramId: string;
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function instruction(value: unknown, taker: string): TransactionInstruction {
  const row = record(value, "Jupiter instruction");
  if (typeof row.programId !== "string" || typeof row.data !== "string" || !Array.isArray(row.accounts)) throw new Error(JUPITER_BUILD_NOT_RAW);
  const keys = row.accounts.map(account => {
    const meta = record(account, "Jupiter account");
    if (typeof meta.pubkey !== "string" || typeof meta.isSigner !== "boolean" || typeof meta.isWritable !== "boolean") throw new Error(JUPITER_BUILD_NOT_RAW);
    if (meta.isSigner && meta.pubkey !== taker) throw new Error("Jupiter build requires an unexpected signer.");
    return { pubkey: new PublicKey(meta.pubkey), isSigner: meta.isSigner, isWritable: meta.isWritable };
  });
  return new TransactionInstruction({ programId: new PublicKey(row.programId), keys, data: Buffer.from(row.data, "base64") });
}

function blockhash(value: unknown): string {
  if (typeof value === "string" && value.length >= 32) return new PublicKey(value).toBase58() === value ? value : new PublicKey(Buffer.from(value, "base64")).toBase58();
  if (!Array.isArray(value) || value.length !== 32 || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error(JUPITER_BUILD_NOT_RAW);
  return new PublicKey(Uint8Array.from(value)).toBase58();
}

function tables(value: unknown): AddressLookupTableAccount[] {
  if (value == null) return [];
  const rows = record(value, "Jupiter lookup tables");
  return Object.entries(rows).map(([key, addresses]) => {
    if (!Array.isArray(addresses) || addresses.some(item => typeof item !== "string")) throw new Error(JUPITER_BUILD_NOT_RAW);
    return new AddressLookupTableAccount({
      key: new PublicKey(key),
      state: {
        deactivationSlot: 0xffffffffffffffffn,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: addresses.map(item => new PublicKey(item)),
      },
    });
  });
}

/** Parse a `/swap/v2/build` body. An `/order` transaction string is not a substitute. */
export function parseJupiterBuild(body: unknown, expected: { inputMint: string; outputMint: string; amountRaw: string; taker: string; destinationTokenAccount?: string }): ParsedJupiterBuild {
  const row = record(body, "Jupiter build");
  if (typeof row.transaction === "string" && !row.swapInstruction) throw new Error(JUPITER_BUILD_NOT_RAW);
  if (row.inputMint !== expected.inputMint || row.outputMint !== expected.outputMint || row.inAmount !== expected.amountRaw || row.swapMode !== "ExactIn") {
    throw new Error(JUPITER_BUILD_NOT_RAW);
  }
  const outAmount = rawAmount(String(row.outAmount ?? ""), true).toString();
  const minOutRaw = rawAmount(String(row.otherAmountThreshold ?? ""), true).toString();
  const slippageBps = row.slippageBps;
  if (BigInt(minOutRaw) > BigInt(outAmount) || typeof slippageBps !== "number" || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error(JUPITER_BUILD_NOT_RAW);
  const meta = record(row.blockhashWithMetadata, "Jupiter blockhash");
  const lastValidBlockHeight = meta.lastValidBlockHeight;
  if (typeof lastValidBlockHeight !== "number" || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) throw new Error(JUPITER_BUILD_NOT_RAW);
  const list = [
    ...(Array.isArray(row.computeBudgetInstructions) ? row.computeBudgetInstructions : []),
    ...(Array.isArray(row.setupInstructions) ? row.setupInstructions : []),
    row.swapInstruction,
    ...(row.cleanupInstruction ? [row.cleanupInstruction] : []),
    ...(Array.isArray(row.otherInstructions) ? row.otherInstructions : []),
    ...(row.tipInstruction ? [row.tipInstruction] : []),
  ];
  if (!row.swapInstruction) throw new Error(JUPITER_BUILD_NOT_RAW);
  const swapProgramId = record(row.swapInstruction, "Jupiter swap").programId;
  if (typeof swapProgramId !== "string") throw new Error(JUPITER_BUILD_NOT_RAW);
  const destination = typeof row.destinationTokenAccount === "string" ? row.destinationTokenAccount : expected.destinationTokenAccount ?? null;
  if (expected.destinationTokenAccount && destination !== expected.destinationTokenAccount) throw new Error(JUPITER_BUILD_NOT_RAW);
  return {
    swapProgramId,
    inputMint: expected.inputMint,
    outputMint: expected.outputMint,
    inAmount: expected.amountRaw,
    outAmount,
    minOutRaw,
    slippageBps,
    taker: expected.taker,
    destinationTokenAccount: destination,
    instructions: list.map(item => instruction(item, expected.taker)),
    lookupTables: tables(row.addressesByLookupTableAddress),
    recentBlockhash: blockhash(meta.blockhash),
    lastValidBlockHeight,
  };
}

export function jupiterBuildUrl(input: { inputMint: string; outputMint: string; amountRaw: string; taker: string; slippageBps?: number; destinationTokenAccount?: string }): string {
  const url = new URL(JUPITER_BUILD_URL);
  url.searchParams.set("inputMint", input.inputMint);
  url.searchParams.set("outputMint", input.outputMint);
  url.searchParams.set("amount", input.amountRaw);
  url.searchParams.set("taker", input.taker);
  url.searchParams.set("slippageBps", String(input.slippageBps ?? 50));
  url.searchParams.set("wrapAndUnwrapSol", "false");
  if (input.destinationTokenAccount) url.searchParams.set("destinationTokenAccount", input.destinationTokenAccount);
  return url.toString();
}

export function requireJupiterApiKey(env: { JUPITER_API_KEY?: string } = process.env as { JUPITER_API_KEY?: string }): string {
  const key = env.JUPITER_API_KEY?.trim();
  if (!key) throw new Error(JUPITER_API_KEY_REQUIRED);
  return key;
}

/** Compile the raw build instructions ourselves. Never sign or broadcast. */
export function compileJupiterBuild(parsed: ParsedJupiterBuild): { txBase64: string; messageHash: string; recentBlockhash: string; lastValidBlockHeight: number } {
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: new PublicKey(parsed.taker),
    recentBlockhash: parsed.recentBlockhash,
    instructions: parsed.instructions,
  }).compileToV0Message(parsed.lookupTables));
  if (tx.message.header.numRequiredSignatures !== 1 || tx.message.staticAccountKeys[0]?.toBase58() !== parsed.taker) throw new Error("Jupiter build payer is not the cashing-out wallet.");
  let bytes: Uint8Array;
  try { bytes = tx.serialize(); } catch { throw new Error("Jupiter build does not fit in one transaction."); }
  if (bytes.length > 1232) throw new Error("Jupiter build does not fit in one transaction.");
  return {
    txBase64: Buffer.from(bytes).toString("base64"),
    messageHash: sha256(tx.message.serialize()),
    recentBlockhash: parsed.recentBlockhash,
    lastValidBlockHeight: parsed.lastValidBlockHeight,
  };
}

export async function fetchJupiterBuild(input: {
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  taker: string;
  destinationTokenAccount?: string;
  slippageBps?: number;
  env?: { JUPITER_API_KEY?: string };
  fetchImpl?: typeof fetch;
}): Promise<ParsedJupiterBuild | null> {
  const key = requireJupiterApiKey(input.env);
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(jupiterBuildUrl(input), {
    headers: { Accept: "application/json", "x-api-key": key },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error(JUPITER_API_KEY_REJECTED);
  if (!response.ok) return null;
  try { return parseJupiterBuild(await response.json(), input); } catch (error) {
    if (error instanceof Error && error.message === JUPITER_API_KEY_REJECTED) throw error;
    return null;
  }
}
