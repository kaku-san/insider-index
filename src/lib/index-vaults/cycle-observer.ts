import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { getRebalanceIntentPda, getVaultFeesPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { VaultLayout } from "@symmetry-hq/sdk/dist/layouts/basket.js";
import { RebalanceIntentLayout, RebalanceType } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { formatRebalanceIntent } from "@symmetry-hq/sdk/dist/states/intents/rebalanceIntent.js";
import type { Vault, UIRebalanceIntent } from "@symmetry-hq/sdk";
import { hashObject, sha256 } from "./amounts.ts";
import { assertCycleDefinition, type CyclePolicy } from "./cycle-policy.ts";
import { assertCycleBacking } from "./cycle-accounting.ts";
import { assertCycleMint } from "./cycle-routes.ts";
import { assertInstalledComposition, MAINNET_USDC, NATIVE_DEFAULT_BINDINGS } from "./native-defaults.ts";
import { pendingCompositionIntents } from "./composition-transactions.ts";
import { indexTokenInput } from "./index-vault-create.ts";
import { assertIndexKeeper } from "./keeper-tick.ts";
import { SYMMETRY_PROGRAM_ID, type NativeVaultBuilders } from "./symmetry-adapter.ts";
import { WSOL_MINT } from "./raydium-oracles.ts";
import type { PersistedVaultDefinition } from "./vault-definition-store.ts";
import type { CycleMintBinding } from "./cycle-receipts.ts";

export interface CycleChain {
  slot: number; timestamp: number; vault: Vault; intent: UIRebalanceIntent | null; intentAddress: string;
  mintBindings: CycleMintBinding[]; accounts: Map<string, AccountInfo<Buffer> | null>;
  stateHash: string; shareSupply: bigint; actualBacking: Map<string, bigint>; unaccountedBacking: Map<string, bigint>;
  balance(owner: string, mint: string): bigint;
}
const pk = (s: string) => new PublicKey(s);
export const cycleAta = (owner: string, m: CycleMintBinding) => getAssociatedTokenAddressSync(pk(m.mint), pk(owner), true, pk(m.tokenProgram)).toBase58();

/** One slot-consistent account snapshot after discovering ALL native intents and vault-owned token
 * accounts. Never equate weights, ATAs, bounty counters or a purchase journal with owned backing. */
export async function observeCycle(native: NativeVaultBuilders, record: PersistedVaultDefinition, policy: CyclePolicy, purpose: "strict" | "recovery" = "strict"): Promise<CycleChain> {
  assertCycleDefinition(record, policy.indexId, "recovery"); await native.assertNetwork();
  if (native.network !== "mainnet-beta" || record.vaultAddress !== policy.vault || record.shareMint !== policy.shareMint) throw new Error("CYCLE_NETWORK_OR_IDENTITY");
  if ((await pendingCompositionIntents(native, policy.vault)).length) throw new Error("CYCLE_PENDING_CONFIGURATION_RECOVERY_REQUIRED");
  const original = await native.sdk.fetchVault(policy.vault);
  if (original.ownAddress.toBase58() !== policy.vault || original.mint.toBase58() !== policy.shareMint) throw new Error("CYCLE_NATIVE_IDENTITY");
  const intentAddress = getRebalanceIntentPda(pk(policy.vault), pk(policy.owner)).toBase58();
  const intentRows = await native.connection.getProgramAccounts(pk(SYMMETRY_PROGRAM_ID), { commitment: "confirmed", filters: [{ dataSize: RebalanceIntentLayout.span + 8 }, { memcmp: { offset: 8, bytes: policy.vault } }] });
  const tokenRows = (await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(programId => native.connection.getTokenAccountsByOwner(pk(policy.vault), { programId }, "confirmed")))).flatMap(r => r.value);
  const mintIds = [...new Set([...record.vaultLegs.map(l => l.mint), ...NATIVE_DEFAULT_BINDINGS.map(b => b.mint), policy.shareMint])];
  const mintAccounts = await native.connection.getMultipleAccountsInfo(mintIds.map(pk), "confirmed");
  const mintBindings: CycleMintBinding[] = mintIds.map((mint, n) => {
    const account = mintAccounts[n]; if (!account || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(account.owner))) throw new Error("CYCLE_MINT_PROGRAM");
    const decoded = unpackMint(pk(mint), account, account.owner); assertCycleMint(decoded);
    const expectedDecimals = mint === MAINNET_USDC || mint === policy.shareMint ? 6 : mint === WSOL_MINT ? 9 : record.vaultLegs.find(l => l.mint === mint)?.decimals;
    if (decoded.decimals !== expectedDecimals || (mint === policy.shareMint && !account.owner.equals(TOKEN_PROGRAM_ID))) throw new Error("CYCLE_NATIVE_SHARE_OR_LEG_PRECISION");
    return { mint, tokenProgram: account.owner.toBase58(), decimals: decoded.decimals };
  });
  const owners = [policy.owner, policy.keeper, policy.vault, getVaultFeesPda(pk(policy.vault)).toBase58()];
  const keys = [...new Set([policy.vault, intentAddress, ...intentRows.map(r => r.pubkey.toBase58()), ...tokenRows.map(r => r.pubkey.toBase58()), ...mintIds, ...owners,
    ...owners.slice(0, 3).flatMap(o => mintBindings.map(m => cycleAta(o, m))), cycleAta(owners[3], mintBindings.find(m => m.mint === policy.shareMint)!)])];
  const chunks: string[][] = []; for (let start = 0; start < keys.length; start += 100) chunks.push(keys.slice(start, start + 100));
  const snapshots = await Promise.all(chunks.map(chunk => native.connection.getMultipleAccountsInfoAndContext(chunk.map(pk), "confirmed")));
  const slot = snapshots[0].context.slot;
  if (!snapshots.every(s => s.context.slot === slot)) throw new Error("CYCLE_SNAPSHOT_SLOT_RACE_RETRY");
  const accounts = new Map(keys.map((key, n) => [key, snapshots[Math.floor(n / 100)].value[n % 100]]));
  const vaultAccount = accounts.get(policy.vault);
  if (!vaultAccount?.owner.equals(pk(SYMMETRY_PROGRAM_ID))) throw new Error("CYCLE_NATIVE_VAULT_OWNER");
  const vault = { ...original, ...VaultLayout.decode(vaultAccount.data.subarray(8)) } as Vault;
  assertInstalledComposition(vault, record.vaultLegs.map(l => ({ ...l, token: indexTokenInput({ ...l, kind: l.kind as "raydium_clmm" | "raydium_cpmm", tvlUsd: l.tvlUsd ?? null }) })));
  if (vault.mint.toBase58() !== policy.shareMint || vault.settings.fees.hostDepositFeeBps !== 25 || vault.settings.fees.hostWithdrawFeeBps !== 0) throw new Error("CYCLE_NATIVE_IDENTITY_OR_FEES_CHANGED");
  assertIndexKeeper(policy.keeper, { deployer: vault.settings.creator.toBase58(), host: vault.settings.host.toBase58(), strategy: vault.settings.managers.managers.map(m => m.toBase58()).filter(m => m !== PublicKey.default.toBase58()), namedKeeper: record.keeper.pubkey });
  const intents = [...new Set([...intentRows.map(r => r.pubkey.toBase58()), intentAddress])].flatMap(id => {
    const a = accounts.get(id); if (!a) return [];
    if (!a.owner.equals(pk(SYMMETRY_PROGRAM_ID))) throw new Error("CYCLE_NATIVE_INTENT_OWNER");
    return [formatRebalanceIntent({ ...RebalanceIntentLayout.decode(a.data.subarray(8)), ownAddress: pk(id), solBalance: a.lamports })];
  });
  const intent = intents.find(i => i.chain_data.ownAddress?.toBase58() === intentAddress) ?? null;
  if (intent && (intent.chain_data.owner.toBase58() !== policy.owner || intent.chain_data.vault.toBase58() !== policy.vault)) throw new Error("CYCLE_NATIVE_INTENT_IDENTITY");
  if (intents.some(i => i.chain_data.rebalanceType === RebalanceType.Vault)) throw new Error("CYCLE_ACTIVE_VAULT_REBALANCE_REQUIRES_RECONCILIATION");
  // Other investors' deposits/claims are separate liabilities, not a reason to strand this
  // owner's recovery. Include every one, and reject discovery races rather than undercount.
  const currentIntentRows = await native.connection.getProgramAccounts(pk(SYMMETRY_PROGRAM_ID), { commitment: "confirmed", filters: [{ dataSize: RebalanceIntentLayout.span + 8 }, { memcmp: { offset: 8, bytes: policy.vault } }] });
  if (hashObject(currentIntentRows.map(r => r.pubkey.toBase58()).sort()) !== hashObject(intentRows.map(r => r.pubkey.toBase58()).sort())) throw new Error("CYCLE_INTENT_DISCOVERY_RACE_RETRY");
  const actualBacking = new Map<string, bigint>();
  const ownedTokenAccounts = new Set([...tokenRows.map(row => row.pubkey.toBase58()), ...mintBindings.map(m => cycleAta(policy.vault, m)).filter(key => accounts.get(key))]);
  for (const key of ownedTokenAccounts) {
    const a = accounts.get(key); if (!a) throw new Error("CYCLE_TOKEN_ACCOUNT_DISCOVERY_RACE");
    const token = unpackAccount(pk(key), a, a.owner);
    if (!token.isInitialized || token.isFrozen || token.owner.toBase58() !== policy.vault) throw new Error("CYCLE_VAULT_TOKEN_STATE");
    actualBacking.set(token.mint.toBase58(), (actualBacking.get(token.mint.toBase58()) ?? 0n) + token.amount);
  }
  const unaccountedBacking = assertCycleBacking(vault, intents, actualBacking, purpose);
  const share = mintBindings.find(m => m.mint === policy.shareMint)!;
  const shareSupply = unpackMint(pk(share.mint), accounts.get(share.mint)!, pk(share.tokenProgram)).supply;
  if (shareSupply !== BigInt(vault.supplyOutstanding.toString())) throw new Error("CYCLE_SHARE_SUPPLY_DIVERGENCE");
  for (const [n, mint] of mintIds.entries()) if (!accounts.get(mint)?.data.equals(mintAccounts[n]!.data)) throw new Error("CYCLE_MINT_STATE_RACE_RETRY");
  const timestamp = await native.connection.getBlockTime(slot); if (timestamp === null || Math.abs(Date.now() / 1000 - timestamp) > 60) throw new Error("CYCLE_CHAIN_CLOCK_UNAVAILABLE");
  function balance(owner: string, mint: string): bigint {
    const m = mintBindings.find(b => b.mint === mint); if (!m) throw new Error("CYCLE_UNKNOWN_MINT");
    const key = cycleAta(owner, m), a = accounts.get(key); if (!a) return 0n;
    if (a.owner.toBase58() !== m.tokenProgram) throw new Error("CYCLE_OWNER_TOKEN_PROGRAM");
    const token = unpackAccount(pk(key), a, pk(m.tokenProgram));
    if (!token.isInitialized || token.isFrozen || token.owner.toBase58() !== owner || token.mint.toBase58() !== mint || token.delegate || token.closeAuthority) throw new Error("CYCLE_OWNER_TOKEN_ACCOUNT_AUTHORITY");
    return token.amount;
  }
  const stateHash = hashObject([...accounts].map(([key, a]) => [key, a ? [a.owner.toBase58(), sha256(a.data), a.lamports.toString()] : null]));
  return { slot, timestamp, vault, intent, intentAddress, mintBindings, accounts, stateHash, shareSupply, actualBacking, unaccountedBacking, balance };
}
