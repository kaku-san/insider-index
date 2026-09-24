/**
 * NAV vault operator CLI (init + keeper). Dry run is the DEFAULT: it simulates and prints, broadcasts nothing.
 *
 *   npm run nav-vault -- init   --index <id> --keeper <pubkey> --fee-owner <pubkey> [--network mainnet-beta] [--definition file.json]
 *                               [--max-price-age 300] [--max-slippage 100] [--entry-fee 25] [--buffer 500] [--max-deposit-raw N (default 0 = no cap)] [--execute --keypair <admin file>]
 *   npm run nav-vault -- keeper (--all | --indexes a,b | --index <id>) [--network mainnet-beta] [--execute --keypair <keeper file>] [--loop <cycle seconds>]
 *   npm run nav-vault -- pause|unpause --index <id> [--execute --keypair <admin file>]
 *
 * Legs/weights come from insiderindex_vault_definitions (service-role Supabase from .env.local) unless
 * --definition points at a PersistedVaultDefinition JSON. Mainnet requires the operator to have deployed
 * programs/bin/nav_vault.so at the program id (docs/nav-vault.md). Keys are file paths on the operator
 * machine only; the keeper must not be the admin. Human report on stderr, JSON on stdout.
 */
import { readFileSync } from "node:fs";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type TransactionInstruction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { getHeliusRpcUrl } from "../src/lib/helius.ts";
import { createServiceSupabase } from "../src/lib/supabase.ts";
import { MAINNET_USDC } from "../src/lib/nav-vault/constants.ts";
import { readVaultDefinition, readVaultDefinitions, type PersistedVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";
import {
  NAV_VAULT_DEVNET_PROGRAM_ID, NAV_VAULT_PROGRAM_ID, ata, mintAuthorityPda, setDefaultProgramId, shareMintPda, decodeVault, initVaultIx, setLookupTableIx, setPausedIx, vaultPda, vaultTokenAccounts,
} from "../src/lib/nav-vault/program.ts";
import { keeperCycleAll, keeperTick, mockVenue } from "../src/lib/nav-vault/keeper.ts";
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

async function run(label: string, payer: Keypair | PublicKey, instructions: TransactionInstruction[], extraSigners: Keypair[] = [], tables: AddressLookupTableAccount[] = []) {
  const payerKey = payer instanceof Keypair ? payer.publicKey : payer;
  for (let attempt = 0; attempt < 4; attempt++) {
    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey, recentBlockhash: latest.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(opt("--priority-micro-lamports") ?? 20_000) }), ...instructions] }).compileToV0Message(tables));
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`);
    if (!execute || !(payer instanceof Keypair)) { log(`[dry-run] ${label}: simulated ok`); return null; }
    tx.sign([payer, ...extraSigners]);
    const raw = tx.serialize();
    const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    // Re-broadcast until it lands or the blockhash expires (then rebuild: an expired tx can never land).
    for (;;) {
      await new Promise(r => setTimeout(r, 2_000));
      const status = (await connection.getSignatureStatuses([signature])).value[0];
      if (status?.err) throw new Error(`${label}: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") { log(`${label}: ${signature}`); return signature; }
      if ((await connection.getBlockHeight("confirmed")) > latest.lastValidBlockHeight) break;
      await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
    log(`${label}: attempt ${attempt + 1} expired, rebuilding`);
  }
  throw new Error(`${label}: did not land after 4 attempts`);
}

/** --slice: the committed tradable slice (src/lib/nav-vault/tradable-slices.json) is the vault leg set. */
function sliceDefinition(indexId: string): PersistedVaultDefinition | null {
  if (!flag("--slice")) return null;
  const file = JSON.parse(readFileSync(opt("--slices-file") ?? "src/lib/nav-vault/tradable-slices.json", "utf8")) as { slices: { indexId: string; eligible: boolean; vaultLegs: { ticker: string; mint: string; decimals: number; pool: string | null; targetWeightBps: number }[] }[] };
  const slice = file.slices.find(item => item.indexId === indexId);
  if (!slice) throw new Error(`No tradable slice for ${indexId}.`);
  if (!slice.eligible) throw new Error(`${indexId}'s tradable slice is below the 3-leg / 30% floor; it stays research only.`);
  return { indexId, name: indexId, symbol: "", status: "SLICE", bookSource: "tradable-slice", provenance: {}, vaultAddress: null, shareMint: null, keeper: { pubkey: null, automationEnabled: false },
    vaultLegs: slice.vaultLegs.map(leg => ({ ticker: leg.ticker, mint: leg.mint, decimals: leg.decimals, pool: leg.pool ?? "", kind: leg.pool ? "raydium_clmm" : "none", targetWeightBps: leg.targetWeightBps })) };
}

async function init() {
  const indexId = need("--index");
  const definition = sliceDefinition(indexId) ?? await loadDefinition(indexId);
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
  // Lookup table FIRST (every address is known before init), so init_vault fits one v0 transaction at up to 25 legs.
  const addresses = [...new Set([
    vault, accounts.authority, mintAuthorityPda(vault, programId), shareMintPda(vault, programId), usdcMint, accounts.usdc, feeAccount,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, programId,
    ...legs.flatMap((leg, i) => [accounts.legs[i]!, leg.mint]),
  ].map(key => key.toBase58()))].map(key => new PublicKey(key));
  let lut: PublicKey;
  const existing = opt("--lut") ? (await connection.getAddressLookupTable(new PublicKey(opt("--lut")!))).value : null;
  if (existing) {
    // Resume: reuse a table from an interrupted init; add whatever it is missing.
    lut = existing.key;
    const have = new Set(existing.state.addresses.map(a => a.toBase58()));
    const missing = addresses.filter(a => !have.has(a.toBase58()));
    for (let i = 0; i < missing.length; i += 20) sigs.push(await run(`extend lookup table ${i / 20 + 1}`, admin, [AddressLookupTableProgram.extendLookupTable({ payer: adminKey, authority: adminKey, lookupTable: lut, addresses: missing.slice(i, i + 20) })]));
  } else {
    const [createLut, created] = AddressLookupTableProgram.createLookupTable({ authority: adminKey, payer: adminKey, recentSlot: await connection.getSlot("finalized") });
    lut = created;
    sigs.push(await run("create lookup table", admin, [createLut]));
    for (let i = 0; i < addresses.length; i += 20) sigs.push(await run(`extend lookup table ${i / 20 + 1}`, admin, [AddressLookupTableProgram.extendLookupTable({ payer: adminKey, authority: adminKey, lookupTable: lut, addresses: addresses.slice(i, i + 20) })]));
  }
  log(`lookup table: ${lut.toBase58()}`);
  const warm = await connection.getSlot("confirmed");
  while ((await connection.getSlot("confirmed")) <= warm + 1) await new Promise(r => setTimeout(r, 400));
  const table = (await connection.getAddressLookupTable(lut)).value;
  if (!table) throw new Error("Lookup table is not readable yet; re-run init.");
  sigs.push(await run("init_vault", admin, [initIx], [], [table]));
  const state = decodeVault(vault, (await connection.getAccountInfo(vault))!.data);
  sigs.push(await run("set_lookup_table", admin, [setLookupTableIx(state, adminKey, lut, programId)]));
  report.shareMint = state.shareMint.toBase58();
  report.lookupTable = lut.toBase58();
  console.log(JSON.stringify(report, null, 2));
}

async function sendConfirmed(keypair: Keypair) {
  return async (tx: VersionedTransaction, step: string) => {
    tx.sign([keypair]);
    const signature = await connection.sendTransaction(tx);
    const latest = await connection.getLatestBlockhash("confirmed");
    const confirmed = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (confirmed.value.err) throw new Error(`${step}: ${JSON.stringify(confirmed.value.err)}`);
    log(`${step}: ${signature}`);
    return signature;
  };
}
const afterPrices = async () => { const slot = await connection.getSlot("confirmed"); while ((await connection.getSlot("confirmed")) <= slot) await new Promise(r => setTimeout(r, 400)); };
const jsonOut = (value: unknown) => console.log(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));

/** --all: every DB index with an on-chain NAV vault; --indexes a,b: explicit list; --index a: one vault. */
async function keeperIndexIds(programId: PublicKey): Promise<string[]> {
  if (opt("--index")) return [need("--index")];
  let ids: string[];
  if (opt("--indexes")) ids = opt("--indexes")!.split(",").map(id => id.trim()).filter(Boolean);
  else if (flag("--all")) {
    const db = createServiceSupabase();
    if (!db) throw new Error("--all needs Supabase service-role credentials to list indexes.");
    ids = (await readVaultDefinitions(db)).map(row => row.indexId);
  } else throw new Error("--index, --indexes or --all is required");
  const infos = await connection.getMultipleAccountsInfo(ids.map(id => vaultPda(id, programId)));
  return ids.filter((_, i) => Boolean(infos[i]));
}

async function keeper() {
  const programId = new PublicKey(opt("--program-id") ?? PROGRAM_DEFAULT.toBase58());
  const keypair = execute ? loadKey(need("--keypair")) : null;
  const priorityMicroLamports = Number(opt("--priority-micro-lamports") ?? (network === "mainnet-beta" ? 20_000 : 0));
  const minTrade = opt("--min-trade-raw") ? { minTradeUsdcRaw: BigInt(opt("--min-trade-raw")!) } : {};
  const loop = Number(opt("--loop") ?? 0);
  if (loop && !execute) throw new Error("--loop requires --execute.");
  const once = async () => {
    const indexIds = await keeperIndexIds(programId);
    if (!indexIds.length) { log("no NAV vaults to keep"); return; }
    const states = await Promise.all(indexIds.map(async id => decodeVault(vaultPda(id, programId), (await connection.getAccountInfo(vaultPda(id, programId)))!.data)));
    const keeperKey = keypair?.publicKey ?? states[0]!.keeper;
    if (keypair && states.some(state => state.admin.equals(keypair.publicKey))) throw new Error("Refusing: the admin key is not a keeper key.");
    const legs = network === "mainnet-beta"
      ? (await Promise.all(indexIds.map(id => loadDefinition(id).catch(() => null)))).flatMap(definition => definition?.vaultLegs ?? [])
      : [];
    const venue = network === "mainnet-beta"
      ? mainnetVenue({ connection, legs, quoteOwner: keeperKey.toBase58(), env: { JUPITER_API_KEY: process.env.JUPITER_API_KEY } })
      : mockVenue(connection, states[0]!.usdcMint);
    const execute_ = keypair ? await sendConfirmed(keypair) : undefined;
    if (indexIds.length === 1) {
      jsonOut(await keeperTick({ connection, indexId: indexIds[0]!, keeper: keeperKey, programId, ...venue, priorityMicroLamports, ...minTrade, execute: execute_, afterPrices }));
      return;
    }
    const cycle = await keeperCycleAll({ connection, indexIds, keeper: keeperKey, programId, ...venue, priorityMicroLamports, ...minTrade, execute: execute_, afterPrices });
    for (const vault of cycle.vaults) if (!vault.ok) log(`vault ${vault.indexId} skipped: ${vault.error}`);
    jsonOut({ priceTransactions: cycle.priceTransactions, marks: cycle.marks, vaults: cycle.vaults.map(v => ({ indexId: v.indexId, ok: v.ok, error: v.error, plan: v.result?.plan, signatures: v.result?.signatures, after: v.result?.after })) });
  };
  if (!loop) return once();
  for (;;) {
    const started = Date.now();
    try { await once(); } catch (error) { log(`tick failed: ${(error as Error).message}`); }
    // --loop is the target cycle period (seconds), so marks stay fresh as the vault count grows.
    await new Promise(r => setTimeout(r, Math.max(1_000, loop * 1000 - (Date.now() - started))));
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

/** Mirror the committed tradable slices (+ on-chain vault identity) into insiderindex_nav_vault_slices. */
async function slices() {
  const doc = JSON.parse(readFileSync(opt("--slices-file") ?? "src/lib/nav-vault/tradable-slices.json", "utf8")) as { generatedAt: string; criteria: unknown; slices: { indexId: string; eligible: boolean }[] };
  const programId = new PublicKey(opt("--program-id") ?? PROGRAM_DEFAULT.toBase58());
  const infos = await connection.getMultipleAccountsInfo(doc.slices.map(slice => vaultPda(slice.indexId, programId)));
  const rows = doc.slices.map((slice, i) => {
    const info = infos[i];
    const state = info ? decodeVault(vaultPda(slice.indexId, programId), info.data) : null;
    return { ...slice, vaultAddress: state?.address.toBase58() ?? null, shareMint: state?.shareMint.toBase58() ?? null };
  });
  const document = { generatedAt: doc.generatedAt, criteria: doc.criteria, slices: rows };
  if (!flag("--publish")) { jsonOut(rows.map(r => ({ indexId: r.indexId, eligible: r.eligible, vault: r.vaultAddress }))); log("[dry-run] pass --publish to write insiderindex_nav_vault_slices (migration 202609230001 must be applied)."); return; }
  const db = createServiceSupabase();
  if (!db) throw new Error("Supabase service-role credentials are required to publish slices.");
  const { data, error } = await db.rpc("publish_insiderindex_nav_vault_slices", { p_document: JSON.stringify(document) });
  if (error) throw new Error(`Slice publication failed (${error.code ?? "storage"}); apply migration 202609230001 first.`);
  jsonOut(data);
}

(command === "slices" ? slices() : command === "init" ? init() : command === "keeper" ? keeper() : command === "pause" ? pause(true) : command === "unpause" ? pause(false) : Promise.reject(new Error("usage: nav-vault (init|keeper) --index <id> ...")))
  .catch(error => { console.error(JSON.stringify({ mode: "failed-closed", error: (error as Error).message })); process.exitCode = 1; });
