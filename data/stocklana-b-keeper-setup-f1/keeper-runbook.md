# Mag7 direct-deposit keeper demo

This is Path B: a user finalizes the app's `buyVaultTx` and `lockDepositsTx`, then
an **external laptop keeper** prices, fills, mints, and cleans up that one native
deposit intent. It does **not** use the public cycle journal. The keeper key stays
in an owner-only file outside the repository and is never loaded by the app.

Run from the repository checkout with the required service-role Supabase settings in
`.env.local`. The script reads the persisted Mag7 definition and refuses a changed
identity, no keeper authority, a wrong keeper, missing ATAs, Pyth/Hermes environment
variables, a non-Raydium configuration, an incomplete book, or more than `0.05 SOL`
of observed keeper debit in one invocation.

```sh
export INDEX_ID=idx-theme-mag7-caucus
export VAULT=AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh
export SHARE_MINT=9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4
export SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
export KEEPER_KEYPAIR=/absolute/path/outside-this-repository/mag7-keeper.json
```

The keeper public key must equal the keeper configured in the persisted Mag7
definition, be distinct from the vault deployer/host/strategy wallets, and have
`automationEnabled: true`. There is no app environment variable for this key.

## 1. List and create missing keeper ATAs

The seven investment legs are MSFT, AAPL, AMZN, GOOGL, NVDA, META, and TSLA. WSOL
and USDC are also required keeper ATAs because the installed vault has those two
zero-target support/cash slots. `GOOG.US` is deliberately not included: it was
collapsed into the xStock GOOGL leg.

Derive the external keeper public key and list its canonical ATAs. This is read-only;
the mint program is read from chain so Token-2022 stock mints and classic support
mints derive correctly.

```sh
set -eu
case "$(realpath "$KEEPER_KEYPAIR")" in "$(pwd -P)"/*) echo "Refusing key inside repository" >&2; exit 1;; esac
chmod 600 "$KEEPER_KEYPAIR"
export KEEPER="$(node --input-type=module - "$KEEPER_KEYPAIR" <<'NODE'
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[2], 'utf8')))).publicKey.toBase58());
NODE
)"
printf 'keeper=%s\n' "$KEEPER"

node --input-type=module - "$KEEPER" <<'NODE'
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const owner = new PublicKey(process.argv[2]);
const mints = [
 ['MSFT','XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX'], ['AAPL','XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp'],
 ['AMZN','Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg'], ['GOOGL','XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN'],
 ['NVDA','Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'], ['META','Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'],
 ['TSLA','XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'], ['WSOL support','So11111111111111111111111111111111111111112'],
 ['USDC support','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
];
let missing = 0;
for (const [name, text] of mints) {
 const mint = new PublicKey(text), mintInfo = await connection.getAccountInfo(mint); if (!mintInfo) throw new Error(`missing mint ${name}`);
 const ata = getAssociatedTokenAddressSync(mint, owner, false, mintInfo.owner), account = await connection.getAccountInfo(ata);
 const state = account?.owner.equals(mintInfo.owner) ? 'PRESENT' : 'MISSING';
 console.log(`${state}\t${name}\t${ata.toBase58()}`); if (state === 'MISSING') missing++;
}
console.log(`missing=${missing}`);
NODE
```

Create every missing ATA idempotently. This sends only associated-token-account
creation transactions; it cannot deposit, lock, fill, mint, sell, or withdraw.

```sh
node --input-type=module - "$KEEPER_KEYPAIR" "$KEEPER" <<'NODE'
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
const [path, expected] = process.argv.slice(2), keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
if (keeper.publicKey.toBase58() !== expected) throw new Error('keeper key does not match $KEEPER');
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const mints = [
 ['MSFT','XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX'], ['AAPL','XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp'],
 ['AMZN','Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg'], ['GOOGL','XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN'],
 ['NVDA','Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'], ['META','Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'],
 ['TSLA','XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB'], ['WSOL support','So11111111111111111111111111111111111111112'],
 ['USDC support','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
];
for (const [name, text] of mints) {
 const mint = new PublicKey(text), mintInfo = await connection.getAccountInfo(mint); if (!mintInfo) throw new Error(`missing mint ${name}`);
 const ata = getAssociatedTokenAddressSync(mint, keeper.publicKey, false, mintInfo.owner), account = await connection.getAccountInfo(ata);
 if (account?.owner.equals(mintInfo.owner)) { console.log(`PRESENT ${name} ${ata}`); continue; }
 const signature = await sendAndConfirmTransaction(connection, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, ata, keeper.publicKey, mint, mintInfo.owner)), [keeper], { commitment: 'confirmed' });
 console.log(`CREATED ${name} ${ata} ${signature}`);
}
NODE
```

Re-run the read-only command; it must print `missing=0`.

## 2. Fund the laptop keeper

**Target balance: 0.07 SOL.** The direct settler enforces a 0.05 SOL cumulative
per-invocation execution cap; the remaining 0.02 SOL covers the nine ATA
create/check transactions. This is a demo operational float, not a change to vault
weights or a permission to bypass the script cap.

```sh
export TARGET_LAMPORTS=70000000
export CURRENT_LAMPORTS="$(node --input-type=module - "$KEEPER" <<'NODE'
import { Connection, PublicKey } from '@solana/web3.js';
console.log(await new Connection(process.env.SOLANA_RPC_URL, 'confirmed').getBalance(new PublicKey(process.argv[2]), 'confirmed'));
NODE
)"
export TOP_UP_LAMPORTS="$(( TARGET_LAMPORTS > CURRENT_LAMPORTS ? TARGET_LAMPORTS - CURRENT_LAMPORTS : 0 ))"
printf 'target=%s current=%s top-up=%s lamports\n' "$TARGET_LAMPORTS" "$CURRENT_LAMPORTS" "$TOP_UP_LAMPORTS"
```

If the top-up is nonzero, use a separately approved external funder (never the
vault deployer, host, strategy, or app-held key):

```sh
solana transfer "$KEEPER" "$TOP_UP_LAMPORTS" --lamports --allow-unfunded-recipient \
  --url "$SOLANA_RPC_URL" --keypair /absolute/path/outside-this-repository/demo-funder.json
```

## 3. Run the direct Mag7 settler after user buy + lock

After the user's app-signed `buyVaultTx` **and** `lockDepositsTx` are finalized, set
`USER` to that same wallet. First inspect without loading a key; it must report the
expected locked deposit intent rather than `deposit_tokens`/no intent.

```sh
export USER=<base58-wallet-that-finalized-buyVaultTx-and-lockDepositsTx>
npm run keeper:mag7-deposit -- --owner "$USER" --dry-run
```

Then run the external keeper. `--watch` advances the same locked intent through
Raydium price updates, bounded two-leg fills, post-auction mint, and bounty cleanup.
It does not use `keeper:index` (rebalance-only), does not use `keeper:cycle`, and
does not create a replacement user intent.

```sh
npm run keeper:mag7-deposit -- --owner "$USER" --execute --keypair "$KEEPER_KEYPAIR" --watch
```

If the command reaches its 0.05 SOL bound, prints an auction wait, or a single
execution times out, inspect its JSON/signatures and re-run that **same** command
for the same owner/intent. Do not make a second user deposit. `MAG7_INCOMPLETE_BOOK_DO_NOT_MINT`
means do not mint a partial stock book.

## 4. Verify share supply and user position

After the keeper prints a finalized `mint` signature, run this read-only check. It
prints raw and UI amounts and exits nonzero unless the native share supply and the
locking user's canonical share ATA are both positive.

```sh
node --input-type=module - "$USER" "$SHARE_MINT" <<'NODE'
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
const [userText, mintText] = process.argv.slice(2), user = new PublicKey(userText), mint = new PublicKey(mintText);
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed'), mintInfo = await connection.getAccountInfo(mint);
if (!mintInfo || !mintInfo.owner.equals(TOKEN_PROGRAM_ID)) throw new Error('Mag7 share mint missing or wrong token program');
const userShareAta = getAssociatedTokenAddressSync(mint, user, false, TOKEN_PROGRAM_ID);
const [supply, position] = await Promise.all([connection.getTokenSupply(mint, 'confirmed'), connection.getTokenAccountBalance(userShareAta, 'confirmed').catch(() => null)]);
console.log(JSON.stringify({ vault: 'AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh', shareMint: mint.toBase58(), user: user.toBase58(), userShareAta: userShareAta.toBase58(), shareSupplyRaw: supply.value.amount, shareSupplyUi: supply.value.uiAmountString, userSharesRaw: position?.value.amount ?? '0', userSharesUi: position?.value.uiAmountString ?? '0' }, null, 2));
if (BigInt(supply.value.amount) <= 0n || !position || BigInt(position.value.amount) <= 0n) process.exitCode = 1;
NODE
```

Positive share supply plus a positive user share ATA is the ownership check. Keeper
logs and UI receipts are not balances or NAV.
