import { ComputeBudgetProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { sha256 } from "./amounts.ts";
import { buildCycleRoute } from "./cycle-routes.ts";
import { encodeCycleWire } from "./cycle-wire.ts";
import {
  quoteInKindSlices, unroutableLegMessage, type InKindLegQuote, type InKindZapPlan, type WeightedSlice,
} from "./in-kind-zap.ts";
import { compileJupiterBuild, fetchJupiterBuild, JUPITER_API_KEY_REQUIRED, requireJupiterApiKey } from "./jupiter-build.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import type { NativeVaultBuilders } from "./symmetry-adapter.ts";
import type { PersistedVaultDefinition, PersistedVaultLeg } from "./vault-definition-store.ts";

export type BuiltSlice = {
  mint: string;
  ticker: string;
  venue: "jupiter" | "raydium";
  usdcInRaw: string;
  expectedOutRaw: string;
  minOutRaw: string;
  swapProgramId: string;
  txBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
};

const NO_ROUTE = new Set([
  "CYCLE_NO_FULL_SIZE_ROUTE",
  "CYCLE_ROUTE_MINIMUM_UNSATISFIABLE",
  "CYCLE_POOL_FLOOR_OR_STALE",
  "CYCLE_POOL_TICKS_UNAVAILABLE",
  "CYCLE_POOL_EXECUTION_NOT_PROVED",
  "CYCLE_QUOTE_EXPIRED_WHILE_BUILDING",
  "CYCLE_PACKET_TOO_LARGE",
  "Jupiter build does not fit in one transaction.",
]);

export function isNoRoute(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return NO_ROUTE.has(message) || message.startsWith("CYCLE_POOL_EXECUTION_NOT_PROVED");
}

function legFor(definition: PersistedVaultDefinition, slice: WeightedSlice): PersistedVaultLeg {
  const leg = definition.vaultLegs.find(item => item.mint === slice.mint);
  if (!leg) throw new Error(unroutableLegMessage(definition.indexId, slice.ticker));
  return leg;
}

/**
 * Jupiter `/swap/v2/build` first, for every DB leg. Raydium direct pool only if that build has no route.
 * A missing API key fails before any quote or spend. No `/order` transaction and no auction pair.
 */
export async function quoteIndexZap(input: {
  native: NativeVaultBuilders;
  definition: PersistedVaultDefinition;
  amountRaw: string;
  owner: string;
  env?: { JUPITER_API_KEY?: string };
  fetchImpl?: typeof fetch;
  onlyMints?: readonly string[];
  jupiter?: (slice: WeightedSlice) => Promise<BuiltSlice | null>;
  raydium?: (slice: WeightedSlice, leg: PersistedVaultLeg) => Promise<BuiltSlice | null>;
}): Promise<{ plan: InKindZapPlan; slices: BuiltSlice[] }> {
  if (!input.jupiter) requireJupiterApiKey(input.env);
  const jupiter = input.jupiter ?? (async slice => {
    const built = await fetchJupiterBuild({
      inputMint: MAINNET_USDC, outputMint: slice.mint, amountRaw: slice.usdcInRaw, taker: input.owner, env: input.env, fetchImpl: input.fetchImpl,
    });
    if (!built) return null;
    let compiled: ReturnType<typeof compileJupiterBuild>;
    try { compiled = compileJupiterBuild(built); } catch { return null; }
    const simulated = await input.native.connection.simulateTransaction(VersionedTransaction.deserialize(Buffer.from(compiled.txBase64, "base64")), { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false });
    if (simulated.value.err) return null;
    return {
      mint: slice.mint, ticker: slice.ticker, venue: "jupiter" as const, usdcInRaw: slice.usdcInRaw,
      expectedOutRaw: built.outAmount, minOutRaw: built.minOutRaw, swapProgramId: built.swapProgramId, txBase64: compiled.txBase64,
      recentBlockhash: compiled.recentBlockhash, lastValidBlockHeight: compiled.lastValidBlockHeight,
    };
  });
  const raydium = input.raydium ?? (async (slice, leg) => {
    const route = await buildCycleRoute({
      connection: input.native.connection, leg, owner: input.owner, inputMint: MAINNET_USDC, outputMint: leg.mint,
      amountInRaw: slice.usdcInRaw, slippageBps: 50, maxAgeMs: 60_000,
    });
    const latest = await input.native.connection.getLatestBlockhash("confirmed");
    const wire = encodeCycleWire({
      instructions: [route.instruction], tables: route.lookupTables, payer: input.owner, blockhash: latest.blockhash,
      computeUnits: 400_000, microLamports: "0", maxPriorityFeeLamports: "0",
    });
    return {
      mint: slice.mint, ticker: slice.ticker, venue: "raydium" as const, usdcInRaw: slice.usdcInRaw,
      expectedOutRaw: route.expectedOutRaw, minOutRaw: route.minOutRaw, swapProgramId: route.instruction.programId.toBase58(), txBase64: wire.txBase64,
      recentBlockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight,
    };
  });
  try {
    const quoted = await quoteInKindSlices({
      indexId: input.definition.indexId,
      amountRaw: input.amountRaw,
      legs: input.definition.vaultLegs,
      onlyMints: input.onlyMints,
      jupiter: async slice => jupiter(slice),
      raydium: async slice => raydium(slice, legFor(input.definition, slice)),
    });
    const slices = quoted.executions as BuiltSlice[];
    if (slices.some(slice => !slice.txBase64 || slice.usdcInRaw === "0")) throw new Error(unroutableLegMessage(input.definition.indexId, slices[0]?.ticker ?? ""));
    return { plan: quoted.plan, slices };
  } catch (error) {
    if (error instanceof Error && (error.message === JUPITER_API_KEY_REQUIRED || error.message.includes("API key was rejected"))) throw error;
    if (error instanceof Error && error.message.startsWith("This amount cannot buy")) throw error;
    if (error instanceof Error && error.message.startsWith("Mag7 requires")) throw error;
    throw new Error(unroutableLegMessage(input.definition.indexId, input.definition.vaultLegs[0]?.ticker ?? ""));
  }
}

export function swapDebitInstruction(txBase64: string, owner: string): TransactionInstruction[] {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  if (tx.message.staticAccountKeys[0]?.toBase58() !== owner || tx.message.header.numRequiredSignatures !== 1) throw new Error("Prepared buy is not signed by the investing wallet.");
  return TransactionMessage.decompile(tx.message).instructions.filter(instruction => !instruction.programId.equals(ComputeBudgetProgram.programId));
}

export function swapMessageHash(txBase64: string): string {
  return sha256(VersionedTransaction.deserialize(Buffer.from(txBase64, "base64")).message.serialize());
}

export type { InKindLegQuote };
