import { PublicKey } from "@solana/web3.js";
import { getExtensionTypes, ExtensionType, getTransferHook, getPausableConfig, getDefaultAccountState, AccountState, type Mint } from "@solana/spl-token";
/** Raw Token-2022 units are authoritative; scaled-UI metadata never changes native raw prices. */
export function assertCycleMint(mint: Mint): void {
  if (!mint.isInitialized) throw new Error("CYCLE_MINT_UNINITIALIZED");
  const allowed = new Set<number>([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.PermanentDelegate, ExtensionType.DefaultAccountState,
    ExtensionType.ConfidentialTransferMint, ExtensionType.TransferHook, ExtensionType.InterestBearingConfig, ExtensionType.ScaledUiAmountConfig, ExtensionType.PausableConfig]);
  for (const extension of getExtensionTypes(mint.tlvData)) if (!allowed.has(extension)) throw new Error(`CYCLE_UNPROVED_MINT_EXTENSION:${extension}`);
  const hook = getTransferHook(mint);
  if (hook && !hook.programId.equals(PublicKey.default)) throw new Error("CYCLE_ACTIVE_TRANSFER_HOOK_UNSUPPORTED");
  if (getPausableConfig(mint)?.paused) throw new Error("CYCLE_MINT_PAUSED");
  const defaults = getDefaultAccountState(mint);
  if (defaults && defaults.state !== AccountState.Initialized) throw new Error("CYCLE_FROZEN_DEFAULT_ACCOUNT");
}
