import { PublicKey, SystemInstruction, SystemProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { rawAmount } from "./amounts.ts";
import { WSOL_MINT } from "./raydium-oracles.ts";
import { VAULTS_V3_PROGRAM_ID } from "@symmetry-hq/sdk/dist/constants.js";
const SYMMETRY_PROGRAM_ID = VAULTS_V3_PROGRAM_ID.toBase58();
const INIT = Buffer.from([127, 215, 41, 110, 244, 179, 131, 7]);

/** Native requires the canonical WSOL ATA (a temporary source fails native 6057). Reset that
 * source ATOMICALLY: unwrap to its owner, fund exactly N, init, return unused N, restore the
 * original WSOL. If anything fails, every unwrap/wrap/init rolls back. No temporary keys,
 * changed bounty schedule, extra signers, wallet-wide funding, or stock sales.
 * max_bounty_amount is only a schedule override; this source balance is the actual ceiling. */
export async function isolateCycleBounty(input: { connection: Connection; owner: string; fundingRaw: string; maximumRaw: string; instructions: TransactionInstruction[] }) {
  const owner = new PublicKey(input.owner), mint = new PublicKey(WSOL_MINT), funding = rawAmount(input.fundingRaw);
  if (funding > rawAmount(input.maximumRaw)) throw new Error("CYCLE_BOUNTY_FUNDING_CAP");
  const canonical = getAssociatedTokenAddressSync(mint, owner), before = await input.connection.getAccountInfo(canonical, "confirmed");
  let restore = 0n;
  if (before) {
    const token = unpackAccount(canonical, before, TOKEN_PROGRAM_ID);
    if (!token.owner.equals(owner) || !token.mint.equals(mint) || !token.isNative || !token.isInitialized || token.isFrozen || token.delegate || token.closeAuthority) throw new Error("CYCLE_BOUNTY_SOURCE_AUTHORITY");
    restore = token.amount;
  }
  let found = false;
  const instructions = input.instructions.flatMap(ix => {
    if (ix.programId.equals(SystemProgram.programId)) {
      if (SystemInstruction.decodeInstructionType(ix) !== "Transfer") throw new Error("CYCLE_BOUNTY_UNEXPECTED_SYSTEM_INSTRUCTION");
      const transfer = SystemInstruction.decodeTransfer(ix);
      if (!transfer.fromPubkey.equals(owner) || !transfer.toPubkey.equals(canonical)) throw new Error("CYCLE_BOUNTY_UNEXPECTED_RECIPIENT");
      return [];
    }
    if (ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 17) {
      if (ix.keys.length !== 1 || !ix.keys[0].pubkey.equals(canonical)) throw new Error("CYCLE_BOUNTY_UNEXPECTED_SYNC");
      return [];
    }
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.keys[1]?.pubkey.equals(canonical)) {
      if (!ix.keys[0].pubkey.equals(owner) || !ix.keys[2].pubkey.equals(owner) || !ix.keys[3].pubkey.equals(mint)) throw new Error("CYCLE_BOUNTY_UNEXPECTED_ATA");
      return [];
    }
    if (ix.programId.toBase58() === SYMMETRY_PROGRAM_ID && ix.data.subarray(0, 8).equals(INIT)) {
      if (found || !ix.keys[0].pubkey.equals(owner) || !ix.keys[8].pubkey.equals(mint) || !ix.keys[9].pubkey.equals(canonical)) throw new Error("CYCLE_BOUNTY_NATIVE_BINDING");
      found = true;
    }
    return [ix];
  });
  if (!found) throw new Error("CYCLE_BOUNTY_INIT_MISSING");
  const create = () => createAssociatedTokenAccountIdempotentInstruction(owner, canonical, owner, mint);
  const close = () => createCloseAccountInstruction(canonical, owner, owner);
  const wrap = (amount: bigint) => amount ? [SystemProgram.transfer({ fromPubkey: owner, toPubkey: canonical, lamports: amount }), createSyncNativeInstruction(canonical)] : [];
  return { account: canonical.toBase58(), restoreWsolRaw: restore.toString(), fundingRaw: funding.toString(), instructions: [
    // Always reset, even if absent at quote time: another party can create/fund an ATA.
    create(), close(), create(), ...wrap(funding), ...instructions,
    close(), create(), ...wrap(restore),
  ] };
}
