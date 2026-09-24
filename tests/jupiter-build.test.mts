import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { compileJupiterBuild, jupiterBuildUrl, JUPITER_BUILD_NOT_RAW, parseJupiterBuild, requireJupiterApiKey } from "../src/lib/index-vaults/jupiter-build.ts";
import { MAINNET_USDC } from "../src/lib/nav-vault/constants.ts";

const taker = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
const outputMint = PublicKey.unique().toBase58();

function buildBody(patch: Record<string, unknown> = {}) {
  return {
    inputMint: MAINNET_USDC,
    outputMint,
    inAmount: "1000",
    outAmount: "5",
    otherAmountThreshold: "4",
    swapMode: "ExactIn",
    slippageBps: 50,
    swapInstruction: { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", accounts: [{ pubkey: taker, isSigner: true, isWritable: true }], data: Buffer.from([1]).toString("base64") },
    blockhashWithMetadata: { blockhash: Array.from(new PublicKey(taker).toBytes()), lastValidBlockHeight: 99 },
    ...patch,
  };
}

test("index buys require a Jupiter API key and the router build URL, not an assembled order", () => {
  assert.throws(() => requireJupiterApiKey({}), /Jupiter API key is required/);
  assert.equal(requireJupiterApiKey({ JUPITER_API_KEY: " test-key " }), "test-key");
  const url = jupiterBuildUrl({ inputMint: MAINNET_USDC, outputMint, amountRaw: "1000", taker });
  assert.match(url, /\/swap\/v2\/build\?/);
  assert.doesNotMatch(url, /\/order/);
  assert.throws(() => parseJupiterBuild({ transaction: "AQID", requestId: "order" }, { inputMint: MAINNET_USDC, outputMint, amountRaw: "1000", taker }), new Error(JUPITER_BUILD_NOT_RAW));
});

test("a raw build compiles to one user-signed transaction and rejects another signer", () => {
  const parsed = parseJupiterBuild(buildBody(), { inputMint: MAINNET_USDC, outputMint, amountRaw: "1000", taker });
  assert.equal(parsed.minOutRaw, "4");
  assert.equal(parsed.swapProgramId, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  const compiled = compileJupiterBuild(parsed);
  assert.equal(compiled.recentBlockhash, taker);
  assert.ok(compiled.txBase64.length > 10);
  assert.throws(() => parseJupiterBuild(buildBody({
    swapInstruction: { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", accounts: [{ pubkey: outputMint, isSigner: true, isWritable: true }], data: "AQ==" },
  }), { inputMint: MAINNET_USDC, outputMint, amountRaw: "1000", taker }), /unexpected signer/);
});
