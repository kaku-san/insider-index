import { CYCLE_STAGES, missingCycleStages, publicInvestSignAllowed } from "../src/lib/index-vaults/full-cycle.ts";
import { VAULT_RELEASE } from "../src/lib/index-vaults/release.ts";
import { NATIVE_CAPS } from "../src/lib/index-vaults/native-caps.ts";
import { DEVNET_TEST_VAULT } from "../src/lib/index-vaults/devnet-contract.ts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: npm run vault:cycle\nOffline full-cycle gate. No signer, RPC send, execute, or public Invest Sign.");
} else if (args.length !== 0) {
  console.error("Unsupported arguments. Pass nothing, or --help. No transaction execution is installed.");
  process.exitCode = 1;
} else {
  const identity = { network: "devnet" as const, vaultAccount: DEVNET_TEST_VAULT.vaultAccount, shareMint: DEVNET_TEST_VAULT.shareMint };
  const missing = missingCycleStages([], identity);
  console.log(JSON.stringify({
    schema: "stocklana-vault-full-cycle-v1",
    mode: "dry-run",
    stages: CYCLE_STAGES,
    missing,
    proven: missing.length === 0,
    publicInvestSignAllowed: publicInvestSignAllowed([], identity),
    release: VAULT_RELEASE,
    nativeCaps: NATIVE_CAPS,
    broadcasts: 0,
  }, null, 2));
}
