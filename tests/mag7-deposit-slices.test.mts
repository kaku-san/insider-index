import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  MAG7_INDEX_ID, MAG7_UNROUTABLE_AMOUNT, assertWeightedSlicesRoutable, mag7WeightedSliceRaw,
} from "../src/lib/index-vaults/mag7-deposit-slices.ts";
import { PUBLIC_DEPOSIT_MINIMUM_USDC_RAW } from "../src/lib/index-vaults/deposit-floor.ts";
import type { CycleRoute } from "../src/lib/index-vaults/cycle-route-parse.ts";
import type { PersistedVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";

const WEIGHTS = [3448, 2740, 1424, 1151, 854, 322, 61] as const;
const TEN_USDC = "10000000";

function mag7Definition(): PersistedVaultDefinition {
  return {
    indexId: MAG7_INDEX_ID, network: "mainnet-beta", name: "Mag7 Caucus", symbol: "IIMAG7", status: "CREATABLE",
    depositsEnabled: true, depositReason: null, bookSource: null, provenance: {},
    vaultAddress: PublicKey.unique().toBase58(), shareMint: PublicKey.unique().toBase58(),
    vaultLegs: WEIGHTS.map((targetWeightBps, i) => ({
      mint: PublicKey.unique().toBase58(), ticker: `LEG${i}`, targetWeightBps, decimals: 8,
      pool: PublicKey.unique().toBase58(), kind: "raydium_clmm" as const,
    })),
    keeper: { pubkey: null, automationEnabled: false }, hostEntryFeeBps: 25, hostExitFeeBps: 0,
  } as PersistedVaultDefinition;
}

function fakeRoute(): CycleRoute {
  return { minOutRaw: "1" } as CycleRoute;
}

test("Mag7 slices at this size use the deposit, not a smaller stale floor", () => {
  assert.deepEqual(WEIGHTS.reduce((sum, weight) => sum + weight, 0), 10000);
  assert.equal(PUBLIC_DEPOSIT_MINIMUM_USDC_RAW, TEN_USDC);
  const ten = WEIGHTS.map(weight => mag7WeightedSliceRaw(TEN_USDC, weight));
  const twenty = WEIGHTS.map(weight => mag7WeightedSliceRaw("20000000", weight));
  assert.notDeepEqual(ten, twenty);
  assert.equal(ten[0], "3448000");
  assert.equal(twenty[0], "6896000");
});

test("every Mag7 name is quoted at this size; one unroutable slice refuses the basket", async () => {
  const definition = mag7Definition();
  const quoted: string[] = [];
  await assertWeightedSlicesRoutable({
    connection: {} as never, definition, amountRaw: TEN_USDC,
    routeBuilder: async input => { quoted.push(`${input.outputMint}:${input.amountInRaw}`); return fakeRoute(); },
  });
  assert.deepEqual(quoted, definition.vaultLegs.map(leg => `${leg.mint}:${mag7WeightedSliceRaw(TEN_USDC, leg.targetWeightBps)}`));

  const partial: string[] = [];
  await assert.rejects(assertWeightedSlicesRoutable({
    connection: {} as never, definition, amountRaw: TEN_USDC,
    routeBuilder: async input => {
      partial.push(input.outputMint);
      if (partial.length === 4) throw new Error("CYCLE_ROUTE_MINIMUM_UNSATISFIABLE");
      return fakeRoute();
    },
  }), new Error(MAG7_UNROUTABLE_AMOUNT));
  assert.equal(partial.length, 4);
  assert.ok(partial.length < 7);
});

test("a size the $1 floor would pass still refuses when this size cannot fill", async () => {
  const definition = mag7Definition();
  const ten = new Set(definition.vaultLegs.map(leg => mag7WeightedSliceRaw(TEN_USDC, leg.targetWeightBps)));
  await assert.rejects(assertWeightedSlicesRoutable({
    connection: {} as never, definition, amountRaw: "20000000",
    routeBuilder: async input => {
      if (ten.has(input.amountInRaw)) return fakeRoute();
      throw new Error("CYCLE_NO_FULL_SIZE_ROUTE");
    },
  }), new Error(MAG7_UNROUTABLE_AMOUNT));
});
