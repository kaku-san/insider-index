import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { KAKU_SAN_DEPLOYER, assertKakuSanKeeper } from "../src/lib/index-vaults/kaku-san.ts";
import { kakuSanBuilders, kakuSanConnection } from "../src/lib/index-vaults/kaku-san-create.ts";
import { observeKakuSanVault, parseKakuSanKeeperArgs, prepareKakuSanKeeperStep, submitKakuSanKeeperSigned } from "../src/lib/index-vaults/kaku-san-rebalance.ts";

const HELP = `Usage:
  npm run keeper:kaku-san -- --dry-run --vault <addr> --share-mint <addr>
  npm run keeper:kaku-san -- --execute --keypair <file> --vault <addr> --share-mint <addr>

Automated Kaku San keeper tick. --dry-run is the default and never loads a key or sends.
--execute requires a dedicated hot-wallet keypair on this operator machine (not the
deployer Phantom, not the web app). Fail-closed until that file exists. No --force-rebalance.
JSON on stdout.`;

function assertNotWebAppKeypair(path: string): string {
  const resolved = resolve(path);
  const root = resolve(".");
  for (const dir of ["src", "app", "public", ".next"]) {
    const blocked = resolve(root, dir);
    if (resolved === blocked || resolved.startsWith(`${blocked}/`)) throw new Error("Keeper keypair must not live in the web app tree");
  }
  return resolved;
}

function loadKeeperKey(path: string): Keypair {
  const parsed = JSON.parse(readFileSync(assertNotWebAppKeypair(path), "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error("Keypair file must be a 64-byte JSON array");
  const keypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
  parsed.fill(0);
  assertKakuSanKeeper(keypair.publicKey.toBase58());
  return keypair;
}

function signAll(transactions: { txBase64: string }[], keypair: Keypair): string[] {
  return transactions.map(tx => {
    const parsed = VersionedTransaction.deserialize(Buffer.from(tx.txBase64, "base64"));
    parsed.sign([keypair]);
    return Buffer.from(parsed.serialize()).toString("base64");
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(HELP);
    return;
  }
  try {
    const options = parseKakuSanKeeperArgs(argv);
    const native = kakuSanBuilders(false);
    const status = await observeKakuSanVault({ creator: KAKU_SAN_DEPLOYER, vault: options.vault, shareMint: options.shareMint }, native);
    if (options.mode === "dry-run") {
      console.log(JSON.stringify({
        schema: "stocklana-kaku-san-keeper-tick-v1", mode: "dry-run", network: "mainnet-beta",
        status, signerAuthorization: false, keeper: null, transactions: [], broadcasts: 0, simulation: "NOT_RUN",
      }, null, 2));
      return;
    }
    const keypair = loadKeeperKey(options.keypair!);
    const keeper = keypair.publicKey.toBase58();
    const signatures: string[] = [];
    const submit = async (step: "prices" | "rebalance", prepared: Awaited<ReturnType<typeof prepareKakuSanKeeperStep>>) => {
      if (!prepared.transactions.length) return;
      const signed = signAll(prepared.transactions, keypair);
      const result = await submitKakuSanKeeperSigned({
        keeper, vault: options.vault, shareMint: options.shareMint, signedTransactions: signed,
      }, kakuSanConnection(true));
      signatures.push(...result.signatures);
    };
    if (status.keeper.intents.length) {
      await submit("prices", await prepareKakuSanKeeperStep({ keeper, step: "prices", vault: options.vault, shareMint: options.shareMint }, kakuSanBuilders(false)));
    } else if (status.eligibility.required === true) {
      const rebalance = await prepareKakuSanKeeperStep({ keeper, step: "rebalance", vault: options.vault, shareMint: options.shareMint }, kakuSanBuilders(false));
      if (rebalance.eligible !== true) throw new Error(rebalance.reason ?? "Not eligible to rebalance");
      await submit("rebalance", rebalance);
      await submit("prices", await prepareKakuSanKeeperStep({ keeper, step: "prices", vault: options.vault, shareMint: options.shareMint }, kakuSanBuilders(false)));
    } else {
      console.log(JSON.stringify({
        schema: "stocklana-kaku-san-keeper-tick-v1", mode: "execute", network: "mainnet-beta", keeper,
        status, signerAuthorization: true, transactions: [], broadcasts: 0,
        skipped: status.eligibility.reason,
      }, null, 2));
      return;
    }
    console.log(JSON.stringify({
      schema: "stocklana-kaku-san-keeper-tick-v1", mode: "execute", network: "mainnet-beta", keeper,
      vault: options.vault, shareMint: options.shareMint, signatures, broadcasts: signatures.length,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ mode: "failed-closed", error: (error as Error).message, broadcasts: 0 }));
    process.exitCode = 1;
  }
}

void main();
