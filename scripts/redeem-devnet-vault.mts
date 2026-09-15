import { SymmetryCore } from "@symmetry-hq/sdk";
import { buildRedeemDiagnostic, observeRedeem, redeemPreflight, redeemReadConnection } from "../src/lib/index-vaults/devnet-redeem.ts";

// Intentionally no keypair, wallet, network, vault, conversion or broadcast options.
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--shares-raw")) {
  console.error("Usage: npm run vault:redeem:preflight -- [--shares-raw POSITIVE_INTEGER] (read-only, devnet only)");
  process.exitCode = 1;
} else {
  try {
    const connection = redeemReadConnection();
    const sdk = new SymmetryCore({ connection, network: "devnet", priorityFee: 25_000 });
    const result = await redeemPreflight(args[1] ?? "1", {
      observe: () => observeRedeem(connection, sdk),
      build: (observation, amount) => buildRedeemDiagnostic(sdk, observation, amount),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2; // Explicit safe stop, never a successful redemption receipt.
  } catch (error) {
    console.error(JSON.stringify({ status: "ERROR", error: error instanceof Error ? error.message : "Redeem preflight failed", transactionsBroadcast: 0 }));
    process.exitCode = 1;
  }
}
