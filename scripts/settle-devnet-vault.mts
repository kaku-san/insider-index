import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DevnetSettler, loadDevnetSigner, parseSettleArgs, runSettleStep, SETTLE_STEPS, SETTLE_TEST_VAULT, settleConnection } from "../src/lib/index-vaults/devnet-settle.ts";
import { assertNoPythEnvironment } from "../src/lib/index-vaults/raydium-oracles.ts";

const RECEIPTS = "evidence/vaults/devnet-raydium-settlement.json";
const usage = `Usage: npm run vault:settle:devnet -- --step <${SETTLE_STEPS.join("|")}> [--intent PUBKEY] [--usdc-raw N] [--max-sol-debit SOL] [--execute] [--keypair PATH]
Existing devnet test vault ${SETTLE_TEST_VAULT.vault} only. Raydium-only prices; refuses to run with any HERMES_*/PYTH_* env.
Dry-run (default) builds and simulates without loading a signer. --execute signs with the authorized devnet keypair
(default ${SETTLE_TEST_VAULT.defaultKeypairPath}; never printed) and appends public receipts to ${RECEIPTS}.`;

const args = process.argv.slice(2);
if (args.includes("--help")) { console.log(usage); process.exit(0); }
try {
  assertNoPythEnvironment();
  const options = parseSettleArgs(args);
  const settler = new DevnetSettler(settleConnection(options.execute));
  if (options.step === "observe") {
    console.log(JSON.stringify(await settler.observe(), null, 2));
  } else {
    const signer = options.execute ? loadDevnetSigner(options.keypairPath) : undefined;
    const result = await runSettleStep(settler, options, signer);
    console.log(JSON.stringify(result, null, 2));
    if (result.receipts.length) {
      mkdirSync(dirname(RECEIPTS), { recursive: true });
      const existing = existsSync(RECEIPTS) ? JSON.parse(readFileSync(RECEIPTS, "utf8")) : [];
      writeFileSync(RECEIPTS, JSON.stringify([...existing, ...result.receipts.map(r => ({ ...r, recordedAt: new Date().toISOString(), intent: options.intent ?? null }))], null, 2) + "\n");
      mkdirSync(".data/index-vaults", { recursive: true });
      appendFileSync(".data/index-vaults/devnet-settle.log", JSON.stringify({ at: new Date().toISOString(), step: options.step, signatures: result.receipts.map(r => r.signature) }) + "\n");
    }
  }
} catch (error) {
  console.error(JSON.stringify({ status: "FAILED_CLOSED", error: error instanceof Error ? error.message : String(error) }));
  console.error(usage);
  process.exitCode = 1;
}
