import { PublicKey } from "@solana/web3.js";
import { address } from "./amounts.ts";
import { DEVNET_TEST_VAULT } from "./devnet-contract.ts";
import { devnetNativeReader, devnetTestIdentity } from "./devnet-deposit.ts";
import type { NativeVaultBuilders } from "./symmetry-adapter.ts";
import type { DevnetVaultPosition } from "./positions-contract.ts";

function walletOwner(value: string | null): string {
  if (!value || value.length > 44) throw new Error("Wallet required");
  address(value);
  if (!PublicKey.isOnCurve(new PublicKey(value))) throw new Error("Wallet must be on curve");
  return value;
}

export async function readDevnetPosition(owner: string, native = devnetNativeReader()): Promise<DevnetVaultPosition> {
  walletOwner(owner);
  if (native.network !== "devnet") throw new Error("Devnet reader required");
  // Native position validates genesis, vault identity, share mint and every owner token account.
  // It sums on-chain share accounts, never Jupiter receipts or pending deposit estimates.
  const position = await native.position(devnetTestIdentity, owner);
  return {
    identity: DEVNET_TEST_VAULT, owner, shareBalanceRaw: position.shareBalanceRaw,
    shareDecimals: position.shareDecimals, observedSlot: position.observedSlot,
    observedAt: new Date().toISOString(), source: "native-token-accounts",
    nativeIntent: null, navUsd: null, valueUsd: null,
  };
}

/** Public, read-only chain data. No all-wallet listing, RPC override, or alternative vault. */
export async function handleDevnetPositions(request: Request, native?: NativeVaultBuilders): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  let owner: string;
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => key !== "wallet") || params.getAll("wallet").length !== 1) throw new Error("Unexpected query");
    owner = walletOwner(params.get("wallet"));
  } catch {
    return Response.json({ error: "A valid connected Solana wallet is required; only the existing devnet test vault is supported." }, { status: 400, headers });
  }
  try {
    const position = await readDevnetPosition(owner, native);
    return Response.json({ position }, { headers });
  } catch {
    return Response.json({ error: "Devnet share balance unavailable. Retry the on-chain read; no balance has been inferred." }, { status: 503, headers });
  }
}
