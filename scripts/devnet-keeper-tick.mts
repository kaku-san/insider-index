import { devnetTickReader, runDevnetKeeperTick } from "../workers/devnet-keeper-tick.ts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: npm run keeper:devnet -- [--dry-run]\nOne no-send observation of the existing Stocklana devnet test vault. Fixed public devnet RPC; no signer, force, execute, loop, vault override or mainnet option. JSON on stdout. Private lease/history: .data/index-vaults/devnet-keeper-tick.json");
} else if (args.length && !(args.length === 1 && args[0] === "--dry-run")) {
  console.error("Unsupported arguments. Only --dry-run or --help is accepted; no transaction execution is installed.");
  process.exitCode = 1;
} else {
  try {
    const result = await runDevnetKeeperTick(devnetTickReader(), ".data/index-vaults/devnet-keeper-tick.json");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ mode: "dry-run", network: "devnet", status: "FAILED_CLOSED", error: (error as Error).message, broadcasts: 0 }));
    process.exitCode = 1;
  }
}
