import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Keypair } from "@solana/web3.js";
import { parseCyclePolicy } from "../src/lib/index-vaults/cycle-config.ts";
import { configuredCycleRunner } from "../src/lib/index-vaults/cycle-api.ts";
import { cycleKeeperTick } from "../src/lib/index-vaults/cycle-keeper.ts";
import { assertCycleExecutionAuthorized } from "../src/lib/index-vaults/cycle-policy.ts";
import { listIncompleteCycleOperations } from "../src/lib/index-vaults/cycle-store.ts";
import { resumePublicCyclePolicy } from "../src/lib/index-vaults/public-cycle-policy.ts";
import { PUBLIC_MAG7 } from "../src/lib/index-vaults/public-cycle-parse.ts";

export function parseCycleKeeperArgs(args: readonly string[]) {
  let policyPath: string | undefined, keypairPath: string | undefined, execute = false, watch = false, pollMs = 3000;
  const seen = new Set<string>();
  for (let n = 0; n < args.length; n++) {
    const flag = args[n]; if (seen.has(flag)) throw new Error("CYCLE_KEEPER_DUPLICATE_ARGUMENT"); seen.add(flag);
    if (flag === "--execute") execute = true;
    else if (flag === "--dry-run") { /* Explicit spelling of the default. */ }
    else if (flag === "--watch") watch = true;
    else if (["--policy", "--keypair", "--poll-ms"].includes(flag)) {
      const value = args[++n]; if (!value || value.startsWith("--")) throw new Error("CYCLE_KEEPER_ARGUMENT_VALUE");
      if (flag === "--policy") policyPath = value;
      else if (flag === "--keypair") keypairPath = value;
      else { if (!/^\d+$/.test(value)) throw new Error("CYCLE_KEEPER_POLL_INTERVAL"); pollMs = Number(value); }
    } else throw new Error("CYCLE_KEEPER_UNKNOWN_ARGUMENT");
  }
  if (!policyPath || !isAbsolute(policyPath) || (execute && seen.has("--dry-run")) || (execute && (!keypairPath || !isAbsolute(keypairPath))) || (!execute && (keypairPath || watch)) || !Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 60000) throw new Error("CYCLE_KEEPER_ARGUMENT_CONTRACT");
  return { policyPath, keypairPath, execute, watch, pollMs };
}
export async function loadExternalCycleKeeper(path: string, repository = fileURLToPath(new URL("../", import.meta.url))): Promise<Keypair> {
  if (!isAbsolute(path)) throw new Error("CYCLE_KEEPER_EXTERNAL_KEY_PATH");
  const actual = await realpath(path), root = await realpath(repository), inside = relative(root, actual);
  if (!inside || (!inside.startsWith("../") && !isAbsolute(inside))) throw new Error("CYCLE_KEEPER_KEY_MUST_BE_OUTSIDE_REPOSITORY");
  const info = await stat(actual);
  if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0) throw new Error("CYCLE_KEEPER_KEY_FILE_PERMISSIONS");
  const bytes: unknown = JSON.parse(await readFile(actual, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error("CYCLE_KEEPER_KEY_FORMAT");
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (process.env.VERCEL || process.env.NEXT_RUNTIME) throw new Error("CYCLE_KEEPER_OPERATOR_MACHINE_ONLY");
  const options = parseCycleKeeperArgs(args), policyFile = await stat(options.policyPath);
  if (!policyFile.isFile() || policyFile.size > 16384) throw new Error("CYCLE_KEEPER_POLICY_FILE");
  const template = parseCyclePolicy(JSON.parse(await readFile(options.policyPath, "utf8")));
  const policy = template.indexId === PUBLIC_MAG7.indexId ? await resumePublicCyclePolicy(template, template.owner) : template;
  const runner = configuredCycleRunner(policy, options.execute);
  let signer: Keypair | undefined;
  if (options.execute) {
    const record = await runner.input.loadDefinition(policy.indexId);
    if (!record) throw new Error("CYCLE_DEFINITION_MISSING_OR_SUBSTITUTED");
    assertCycleExecutionAuthorized(policy, record); // before even opening an external key file
    signer = await loadExternalCycleKeeper(options.keypairPath!);
    if (signer.publicKey.toBase58() !== policy.keeper) throw new Error("CYCLE_KEEPER_WRONG_EXTERNAL_KEY");
  }
  do {
    const result = await cycleKeeperTick(runner, { execute: options.execute, signer });
    // Public identifiers/results only: no private key bytes, policy secret, or signed wire.
    console.log(JSON.stringify({ indexId: policy.indexId, operationId: policy.operationId, keeper: policy.keeper, ...result }));
    try {
      for (const row of await listIncompleteCycleOperations(policy.vault)) {
        if (row.operationId === policy.operationId) continue;
        try {
          const depositor = await resumePublicCyclePolicy(template, row.owner);
          if (depositor.operationId !== row.operationId || depositor.keeper !== policy.keeper) continue;
          const other = await cycleKeeperTick(configuredCycleRunner(depositor, options.execute), { execute: options.execute, signer });
          console.log(JSON.stringify({ indexId: depositor.indexId, operationId: depositor.operationId, keeper: depositor.keeper, ...other }));
        } catch { continue; }
      }
    } catch { /* Listing other Mag7 depositors is additive; the configured operation already ticked. */ }
    if (!options.watch || ("phase" in result && result.phase === "complete")) break;
    await sleep(options.pollMs);
  } while (true);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message.match(/^CYCLE_[A-Z_]+/)?.[0] ?? "CYCLE_KEEPER_REFUSED" : "CYCLE_KEEPER_REFUSED");
    process.exitCode = 1;
  });
}
