/**
 * NAV vault operator CLI (init + keeper). Dry run is the DEFAULT: it simulates and prints, broadcasts nothing.
 *
 *   npm run nav-vault -- init   --index <id> --keeper <pubkey> --fee-owner <pubkey> [--network mainnet-beta] [--definition file.json]
 *                               [--max-price-age 300] [--max-slippage 100] [--entry-fee 25] [--buffer 500] [--max-deposit-raw N (default 0 = no cap)] [--execute --keypair <admin file>]
 *   npm run nav-vault -- keeper --index <id> [--network mainnet-beta] [--execute --keypair <keeper file>] [--loop <seconds>]
 *   npm run nav-vault -- pause|unpause --index <id> [--execute --keypair <admin file>]
 *
 * Legs/weights come from insiderindex_vault_definitions (service-role Supabase from .env.local) unless
 * --definition points at a PersistedVaultDefinition JSON. Mainnet requires the operator to have deployed
 * programs/bin/nav_vault.so at the program id (docs/nav-vault.md). Keys are file paths on the operator
 * machine only; the keeper must not be the admin. Human report on stderr, JSON on stdout.
 */
import { readFileSync } from "node:fs";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { getHeliusRpcUrl } from "../src/lib/helius.ts";
import { createServiceSupabase } from "../src/lib/supabase.ts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";
import { readVaultDefinition, type PersistedVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";
import {
  NAV_VAULT_DEVNET_PROGRAM_ID, NAV_VAULT_PROGRAM_ID, ata, setDefaultProgramId, decodeVault, initVaultIx, setLookupTableIx, setPausedIx, vaultLookupAddresses, vaultPda, vaultTokenAccounts,
} from "../src/lib/nav-vault/program.ts";
import { keeperTick, mockVenue } from "../src/lib/nav-vault/keeper.ts";
import { mainnetVenue } from "../src/lib/nav-vault/mainnet-venue.ts";

const MAX_LEGS = 16;
const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const need = (name: string) => { const v = opt(name); if (!v) throw new Error(`${name} is required`); return v; };
const network = (opt("--network") ?? "mainnet-beta") as "mainnet-beta" | "devnet";
if (network !== "mainnet-beta" && network !== "devnet") throw new Error("--network must be mainnet-beta or devnet");
const execute = flag("--execute");
const rpc = opt("--rpc") ?? (network === "mainnet-beta" ? getHeliusRpcUrl() : "https://api.devnet.solana.com");
const connection = new Connection(rpc, { commitment: "confirmed" });
const PROGRAM_DEFAULT = network === "mainnet-beta" ? NAV_VAULT_PROGRAM_ID : NAV_VAULT_DEVNET_PROGRAM_ID;
setDefaultProgramId(new PublicKey(opt("--program-id") ?? PROGRAM_DEFAULT.toBase58()));
const loadKey = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const log = (...parts: unknown[]) => console.error(...parts);

async function loadDefinition(indexId: string): Promise<PersistedVaultDefinition | null> {
  const file = opt("--definition");
  if (file) return JSON.parse(readFileSync(file, "utf8")) as PersistedVaultDefinition;
  const db = createServiceSupabase();
  if (!db) return null;
  return readVaultDefinition(db, indexId);
}

async function run(label: string, payer: Keypair | PublicKey, instructions: TransactionInstruction[], extraSigners: Keypair[] = []) {
  const payerKey = payer instanceof Keypair ? payer.publicKey : payer;
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey, recentBlockhash: latest.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...instructions] }).compileToV0Message());
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`);
  if (!execute || !(payer instanceof Keypair)) { log(`[dry-run] ${label}: simulated ok`); return null; }
  tx.sign([payer, ...extraSigners]);
  const signature = await connection.sendTransaction(tx);
  const confirmed = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmed.value.err) throw new Error(`${label}: ${JSON.stringify(confirmed.value.err)}`);
  log(`${label}: ${signature}`);
  return signature;
}

async function init() {
  const indexId = need("--index");
  const definition = await loadDefinition(indexId);
  if (!definition) throw new Error("No vault definition (DB unavailable and no --definition).");
  if (definition.vaultLegs.length > MAX_LEGS) throw new Error(`${indexId} has ${definition.vaultLegs.length} legs; the NAV vault holds at most ${MAX_LEGS}. Refusing (never truncates).`);
  const usdcMint = new PublicKey(network === "mainnet-beta" ? MAINNET_USDC : need("--usdc-mint"));
  const mintInfos = await connection.getMultipleAccountsInfo(definition.vaultLegs.map(leg => new PublicKey(leg.mint)));
  const legs = definition.vaultLegs.map((leg, i) => {
    const info = mintInfos[i];
    if (!info) throw new Error(`Leg mint ${leg.ticker} ${leg.mint} is not on ${network}.`);
    return { mint: new PublicKey(leg.mint), tokenProgram: info.owner, weightBps: leg.targetWeightBps };
  });
  if (legs.reduce((sum, leg) => sum + leg.weightBps, 0) !== 10_000) throw new Error("Leg weights must sum to 10000 bps.");
  const keeper = new PublicKey(need("--keeper"));
  const feeOwner = new PublicKey(need("--fee-owner"));
  const admin: Keypair | PublicKey = execute ? loadKey(need("--keypair")) : new PublicKey(opt("--admin") ?? need("--fee-owner"));
  const adminKey = admin instanceof Keypair ? admin.publicKey : admin;
  if (keeper.equals(adminKey)) throw new Error("The keeper must be a dedicated hot wallet, not the admin.");
  const programId = new PublicKey(opt("--program-id") ?? PROGRAM_DEFAULT.toBase58());
  if (!(await connection.getAccountInfo(programId))?.executable) throw new Error(`Program ${programId.toBase58()} is not deployed on ${network}.`);
  const vault = vaultPda(indexId, programId);
  if (await connection.getAccountInfo(vault)) throw new Error(`Vault ${vault.toBase58()} already exists for ${indexId}.`);
  const accounts = vaultTokenAccounts(indexId, usdcMint, legs, programId);
  const feeAccount = ata(feeOwner, usdcMint);
  const report: Record<string, unknown> = { indexId, network, programId: programId.toBase58(), vault: vault.toBase58(), authority: accounts.authority.toBase58(), keeper: keeper.toBase58(), feeAccount: feeAccount.toBase58(), legs: definition.vaultLegs.map(l => ({ ticker: l.ticker, mint: l.mint, weightBps: l.targetWeightBps })), signatures: [] as string[] };
  const sigs = report.signatures as (string | null)[];
  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(adminKey, feeAccount, feeOwner, usdcMint),
    createAssociatedTokenAccountIdempotentInstruction(adminKey, accounts.usdc, accounts.authority, usdcMint),
    ...legs.map((leg, i) => createAssociatedTokenAccountIdempotentInstruction(adminKey, accounts.legs[i]!, accounts.authority, leg.mint, leg.tokenProgram)),
  ];
  for (let i = 0; i < ataIxs.length; i += 4) sigs.push(await run(`vault token accounts ${i / 4 + 1}`, admin, ataIxs.slice(i, i + 4)));
  const initIx = initVaultIx({
    admin: adminKey, indexId, keeper, usdcMint, feeAccount, programId, legs,
    maxPriceAgeSecs: Number(opt("--max-price-age") ?? 300), maxSlippageBps: Number(opt("--max-slippage") ?? 100),
    entryFeeBps: Number(opt("--entry-fee") ?? 25), bufferBps: Number(opt("--buffer") ?? 500),
    maxDepositUsdc: BigInt(opt("--max-deposit-raw") ?? "0"),
    maxPriceMoveBps: Number(opt("--max-price-move") ?? 1500), requestTimeoutSecs: Number(opt("--request-timeout") ?? 600),
  });
  if (!execute) { log("[dry-run] init_vault needs the token accounts above to exist; not simulated in dry run."); console.log(JSON.stringify(report, null, 2)); return; }
  if (legs.length > 7) throw new Error("More than 7 legs: create the vault LUT first and send init_vault as a v0 transaction with it (see docs/nav-vault.md).");
  sigs.push(await run("init_vault", admin, [initIx]));
  const state = decodeVault(vault, (await connection.getAccountInfo(vault))!.data);
  const [createLut, lut] = AddressLookupTableProgram.createLookupTable({ authority: adminKey, payer: adminKey, recentSlot: await connection.getSlot("finalized") });
  const addresses = vaultLookupAddresses(state, programId);
  sigs.push(await run("create lookup table", admin, [createLut]));
  for (let i = 0; i < addresses.length; i += 20) sigs.push(await run(`extend lookup table ${i / 20 + 1}`, admin, [AddressLookupTableProgram.extendLookupTable({ payer: adminKey, authority: adminKey, lookupTable: lut, addresses: addresses.slice(i, i + 20) })]));
  sigs.push(await run("set_lookup_table", admin, [setLookupTableIx(state, adminKey, lut, programId)]));
  report.shareMint = state.shareMint.toBase58();
  report.lookupTable = lut.toBase58();
  console.log(JSON.stringify(report, null, 2));
}

async function keeper() {
  const indexId = need("--index");
  const programId = new PublicKey(opt("--program-id") ?? PROGRAM_DEFAULT.toBase58());
  const vaultInfo = await connection.getAccountInfo(vaultPda(indexId, programId));
  if (!vaultInfo) throw new Error(`No NAV vault for ${indexId} on ${network}.`);
  const state = decodeVault(vaultPda(indexId, programId), vaultInfo.data);
  const keypair = execute ? loadKey(need("--keypair")) : null;
  const keeperKey = keypair?.publicKey ?? state.keeper;
  if (keypair && keypair.publicKey.equals(state.admin)) throw new Error("Refusing: the admin key is not a keeper key.");
  const definition = network === "mainnet-beta" ? await loadDefinition(indexId).catch(() => null) : null;
  const venue = network === "mainnet-beta"
    ? mainnetVenue({ connection, legs: definition?.vaultLegs ?? [], quoteOwner: keeperKey.toBase58(), env: { JUPITER_API_KEY: process.env.JUPITER_API_KEY } })
    : mockVenue(connection, state.usdcMint);
  const once = async () => {
    const result = await keeperTick({
      connection, indexId, keeper: keeperKey, programId, ...venue,
      execute: keypair ? async (tx, step) => {
        tx.sign([keypair]);
        const signature = await connection.sendTransaction(tx);
        const latest = await connection.getLatestBlockhash("confirmed");
        const confirmed = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
        if (confirmed.value.err) throw new Error(`${step}: ${JSON.stringify(confirmed.value.err)}`);
        log(`${step}: ${signature}`);
        return signature;
      } : undefined,
      afterPrices: async () => { const slot = await connection.getSlot("confirmed"); while ((await connection.getSlot("confirmed")) <= slot) await new Promise(r => setTimeout(r, 400)); },
    });
    console.log(JSON.stringify(result, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
  };
  const loop = Number(opt("--loop") ?? 0);
  if (!loop) return once();
  if (!execute) throw new Error("--loop requires --execute.");
  for (;;) {
    try { await once(); } catch (error) { log(`tick failed: ${(error as Error).message}`); }
    await new Promise(r => setTimeout(r, loop * 1000));
  }
}

async function pause(paused: boolean) {
  const indexId = need("--index");
  const programId = new PublicKey(opt("--program-id") ?? PROGRAM_DEFAULT.toBase58());
  const address = vaultPda(indexId, programId);
  const info = await connection.getAccountInfo(address);
  if (!info) throw new Error(`No NAV vault for ${indexId} on ${network}.`);
  const state = decodeVault(address, info.data);
  const admin: Keypair | PublicKey = execute ? loadKey(need("--keypair")) : state.admin;
  const adminKey = admin instanceof Keypair ? admin.publicKey : admin;
  if (!adminKey.equals(state.admin)) throw new Error("This key is not the vault admin.");
  const signature = await run(paused ? "pause" : "unpause", admin, [setPausedIx(state, adminKey, paused, programId)]);
  console.log(JSON.stringify({ indexId, paused, signature }, null, 2));
}

(command === "init" ? init() : command === "keeper" ? keeper() : command === "pause" ? pause(true) : command === "unpause" ? pause(false) : Promise.reject(new Error("usage: nav-vault (init|keeper) --index <id> ...")))
  .catch(error => { console.error(JSON.stringify({ mode: "failed-closed", error: (error as Error).message })); process.exitCode = 1; });
