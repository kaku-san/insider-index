import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getGlobalConfigPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { GENESIS, readOnlyConnection, SYMMETRY_PROGRAM_ID, SYMMETRY_SDK_VERSION, networkUsdc } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { sha256 } from "../src/lib/index-vaults/amounts.ts";

const [network, rpcUrl] = process.argv.slice(2);
if (!rpcUrl || !["devnet", "mainnet-beta"].includes(network)) {
  console.log("Usage: node --experimental-strip-types scripts/verify-index-readiness.ts <devnet|mainnet-beta> <rpc-url>\nOnly reads public deployment/config accounts. No wallet, airdrop, send, or native readiness PASS.");
} else {
  const connection = readOnlyConnection(rpcUrl);
  const sdkRoot = dirname(createRequire(import.meta.url).resolve("@symmetry-hq/sdk/package.json"));
  const genesisHash = await connection.getGenesisHash();
  const expectedGenesis = GENESIS[network as "devnet" | "mainnet-beta"];
  if (genesisHash !== expectedGenesis) throw new Error("Network genesis mismatch: no implicit network switch");
  const program = await connection.getAccountInfoAndContext(new PublicKey(SYMMETRY_PROGRAM_ID), "finalized");
  const config = await connection.getAccountInfoAndContext(getGlobalConfigPda(), "finalized");
  const dataAddress = program.value?.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111" && program.value.data.readUInt32LE(0) === 2 ? new PublicKey(program.value.data.subarray(4, 36)) : null;
  const programData = dataAddress ? await connection.getAccountInfo(dataAddress, "finalized") : null;
  const upgradeAuthority = programData && programData.data.readUInt32LE(0) === 3 && programData.data[12] === 1 ? new PublicKey(programData.data.subarray(13, 45)).toBase58() : null;
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), network, genesisHash, sdkVersion: SYMMETRY_SDK_VERSION,
    programId: SYMMETRY_PROGRAM_ID, programSlot: program.context.slot, executable: program.value?.executable ?? false,
    programDataAddress: dataAddress?.toBase58() ?? null, programDataHash: programData ? sha256(programData.data) : null, upgradeAuthority,
    configSlot: config.context.slot, globalConfigHash: config.value ? sha256(config.value.data) : null,
    configOwnerVerified: config.value?.owner.toBase58() === SYMMETRY_PROGRAM_ID,
    sdkUsdcMint: networkUsdc(network as "devnet" | "mainnet-beta"),
    sdkTypesHash: sha256(await readFile(join(sdkRoot, "dist/index.d.ts"))), sdkLayoutHash: sha256(await readFile(join(sdkRoot, "dist/layouts/basket.js"))),
    standaloneIdl: "NOT_DISTRIBUTED", publicFundsEnabled: false, nativeUsdcExitVerified: false,
    readiness: "UNTESTED", candidates: [], roundtrip: "NOT_RUN", notes: ["No mint/feed/route/transfer evidence collected", "Read-only account observations are not contract security or settlement tests"] }, null, 2));
}
