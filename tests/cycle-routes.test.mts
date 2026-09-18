import assert from "node:assert/strict";
import { test } from "node:test";
import { TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { allSevenVm, definition, pk } from "./support/all-seven-vm.mts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";
import { buildCycleRoute, assertCycleRouteInstruction, assertCycleMint } from "../src/lib/index-vaults/cycle-routes.ts";
import { encodeCycleWire } from "../src/lib/index-vaults/cycle-wire.ts";

test("route instruction independently binds exact input, on-chain minimum, pool and canonical owner ATAs", async () => {
  const vm = allSevenVm(), leg = definition.vaultLegs.find(l => l.ticker === "TSLA")!;
  const route = await buildCycleRoute({ connection: vm.connection, leg, owner: vm.keeper, inputMint: MAINNET_USDC, outputMint: leg.mint, amountInRaw: "500000", slippageBps: 50, maxAgeMs: 60000, metadata: vm.metadata, now: vm.now });
  assertCycleRouteInstruction(route, vm.keeper);
  const clone = () => ({ ...route, instruction: new TransactionInstruction({ programId: route.instruction.programId, keys: route.instruction.keys.map(k => ({ ...k })), data: Buffer.from(route.instruction.data) }) });
  const wrong = clone(); wrong.instruction.keys[4].pubkey = pk(vm.owner);
  assert.throws(() => assertCycleRouteInstruction(wrong, vm.keeper), /RECIPIENT/);
  const amount = clone(); amount.instruction.data.writeBigUInt64LE(500001n, 8);
  assert.throws(() => assertCycleRouteInstruction(amount, vm.keeper), /AMOUNTS/);
  const floor = clone(); floor.instruction.data.writeBigUInt64LE(1n, 16);
  assert.throws(() => assertCycleRouteInstruction(floor, vm.keeper), /AMOUNTS/);
  const exactOut = clone(); exactOut.instruction.data[40] = 0;
  assert.throws(() => assertCycleRouteInstruction(exactOut, vm.keeper), /SHAPE/);
  assert.throws(() => encodeCycleWire({ instructions: [route.instruction], payer: vm.keeper, blockhash: vm.svm.latestBlockhash(), computeUnits: 1_400_000, microLamports: "1", maxPriorityFeeLamports: "1" }), /PRIORITY_FEE_CAP/);
});
test("unsupported pools, sub-$10k TVL, stale metadata, impossible min-out and transfer-fee extensions refuse", async () => {
  const vm = allSevenVm(), leg = definition.vaultLegs[0];
  const input = { connection: vm.connection, leg, owner: vm.owner, inputMint: MAINNET_USDC, outputMint: leg.mint, amountInRaw: "500000", slippageBps: 50, maxAgeMs: 60000, metadata: vm.metadata, now: vm.now };
  await assert.rejects(buildCycleRoute({ ...input, leg: { ...leg, kind: "unproved" } }), /POOL_EXECUTION_NOT_PROVED/);
  await assert.rejects(buildCycleRoute({ ...input, metadata: async p => { const m = await vm.metadata(p); m.pool.tvl = 9999.99; return m; } }), /FLOOR_OR_STALE/);
  await assert.rejects(buildCycleRoute({ ...input, metadata: async p => ({ ...await vm.metadata(p), observedAt: vm.now() - 60001 }) }), /FLOOR_OR_STALE/);
  await assert.rejects(buildCycleRoute({ ...input, minimumOutRaw: "18446744073709551615" }), /MINIMUM_UNSATISFIABLE/);
  const mint = unpackMint(pk(leg.mint), await vm.connection.getAccountInfo(pk(leg.mint)), TOKEN_2022_PROGRAM_ID);
  assertCycleMint(mint);
  const tlvData = Buffer.from(mint.tlvData); tlvData.writeUInt16LE(1, 0); // TransferFeeConfig: never silently ignored.
  assert.throws(() => assertCycleMint({ ...mint, tlvData }), /UNPROVED_MINT_EXTENSION/);
});
