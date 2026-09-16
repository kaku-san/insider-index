import { getHeliusRpcUrl } from "../src/lib/helius.ts";
import { kakuSanBuilders, kakuSanConnection } from "../src/lib/index-vaults/kaku-san-create.ts";
import {
  INDEX_KEEPER_SCHEMA, formatKeeperReport, loadKeeperKeypair, observeIndexVault, parseIndexKeeperArgs,
  prepareIndexKeeperStep, runIndexKeeperTick, signKeeperTransactions, submitKeeperSigned, type IndexKeeperIo,
} from "../src/lib/index-vaults/keeper-tick.ts";
import { createServiceSupabase } from "../src/lib/supabase.ts";
import { readVaultDefinition, recordRebalanceOutcome } from "../src/lib/index-vaults/vault-definition-store.ts";

const HELP = `Usage:
  npm run keeper:index -- --index <indexId> --dry-run
  npm run keeper:index -- --index <indexId> --execute --keypair <file>

DB-driven InsiderIndex keeper tick. The vault address, share mint, legs, target weights, cap, keeper
and fee parameters are all read from insiderindex_vault_definitions for <indexId> — never from the
command line, never a hardcoded basket. Refuses an index with no created vault, an unreadable
definition, or a row that names a different keeper than the connected keypair.

--dry-run is the DEFAULT: it prints current weights, target weights, drift against the shared
eligibility rule and the trades it would place, and broadcasts NOTHING. --execute requires a
dedicated hot-wallet keypair file on this operator machine (never the deployer/host/strategy wallet,
never a key in the web app tree) AND must pass the same shared eligibility rule; a tick that is not
eligible does nothing and says so. No --force-rebalance. Human report on stderr, JSON on stdout.

Requires SUPABASE service-role credentials in the environment to read the definition and record the
outcome (npm run keeper:index reads .env.local).`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(HELP);
    return;
  }
  try {
    const args = parseIndexKeeperArgs(argv);
    const db = createServiceSupabase();
    if (!db) throw new Error("Supabase service-role credentials required to read the definition and record the outcome");
    // Read-only native builder for observation; a separate send-allowed connection only when executing.
    const io: IndexKeeperIo = {
      readDefinition: (indexId) => readVaultDefinition(db, indexId),
      observe: (record) => observeIndexVault(record, kakuSanBuilders(false)),
      loadKeypair: (path) => loadKeeperKeypair(path),
      prepare: (observation, keeper) => prepareIndexKeeperStep(observation, keeper, kakuSanBuilders(false)),
      sign: (transactions, keypair) => signKeeperTransactions(transactions, keypair),
      submit: (input) => submitKeeperSigned(input, kakuSanConnection(true, getHeliusRpcUrl())),
      recordOutcome: (indexId, result) => recordRebalanceOutcome(db, indexId, result),
    };
    const result = await runIndexKeeperTick(args, io);
    console.error(formatKeeperReport(result));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ schema: INDEX_KEEPER_SCHEMA, mode: "failed-closed", error: (error as Error).message, broadcasts: 0 }));
    process.exitCode = 1;
  }
}

void main();
