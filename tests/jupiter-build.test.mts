import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { JUPITER_API_KEY_REQUIRED, JUPITER_BUILD_NOT_RAW, compileJupiterBuild, jupiterBuildUrl, parseJupiterBuild, requireJupiterApiKey } from "../src/lib/index-vaults/jupiter-build.ts";

const taker = "8RZ4GrQDsctRGrW4tDZcYZRqFAW23eWkrVcJQ1DH7GyX";
const inputMint = "H6pLh8nFv1teY9G6JAVQuZQxeUvGfwYf1aPXHkDPDRph";
const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const destination = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";

function body() {
  const swap = SystemProgram.transfer({ fromPubkey: new PublicKey(taker), toPubkey: new PublicKey(taker), lamports: 1 });
  return {
    inputMint, outputMint, inAmount: "5", outAmount: "1000", otherAmountThreshold: "900", swapMode: "ExactIn", slippageBps: 50,
    destinationTokenAccount: destination,
    swapInstruction: { programId: swap.programId.toBase58(), accounts: swap.keys.map(key => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })), data: swap.data.toString("base64") },
    blockhashWithMetadata: { blockhash: taker, lastValidBlockHeight: 99 },
  };
}

test("Jupiter build URL is the v2 router and carries the API-key contract inputs", () => {
  assert.throws(() => requireJupiterApiKey({}), new RegExp(JUPITER_API_KEY_REQUIRED));
  const url = new URL(jupiterBuildUrl({ inputMint, outputMint, amountRaw: "5", taker, destinationTokenAccount: destination }));
  assert.equal(url.origin + url.pathname, "https://api.jup.ag/swap/v2/build");
  assert.equal(url.searchParams.get("amount"), "5");
  assert.equal(url.searchParams.get("destinationTokenAccount"), destination);
  assert.equal(url.searchParams.get("wrapAndUnwrapSol"), "false");
  assert.equal(url.searchParams.get("taker"), taker);
});

test("parser accepts raw ExactIn instructions and refuses an order transaction", () => {
  const parsed = parseJupiterBuild(body(), { inputMint, outputMint, amountRaw: "5", taker, destinationTokenAccount: destination });
  assert.equal(parsed.minOutRaw, "900");
  assert.equal(parsed.destinationTokenAccount, destination);
  assert.equal(parsed.instructions.length, 1);
  const compiled = compileJupiterBuild(parsed);
  assert.equal(compiled.recentBlockhash, taker);
  assert.ok(compiled.txBase64.length > 10);
  assert.throws(() => parseJupiterBuild({ transaction: "abc" }, { inputMint, outputMint, amountRaw: "5", taker }), new RegExp(JUPITER_BUILD_NOT_RAW));
});
