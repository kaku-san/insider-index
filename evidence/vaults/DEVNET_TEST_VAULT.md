# Tiny devnet vault attempt

Creation **finalized**; deposit **not funded**. This is an unseeded execution-test vault, not a Pelosi basket, production index, or completed deposit roundtrip.

## Identity and receipt

- Network: devnet; RPC `https://api.devnet.solana.com`, genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
- Existing Symmetry V3 program: `BASKT7aKd8n7ibpUbwLP3Wiyxyi3yoiXsxBk4Hpumate` (executable verified).
- Vault: `Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8`.
- Native share mint: `Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A` (6 decimals, supply **0**).
- Name/symbol read back: **Stocklana Devnet Test / SLDTEST**.
- Creator and host: `C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB`.
- [Finalized creation transaction](https://explorer.solana.com/tx/5FZHgG2SxpEMY9FC45hjCq4FTYJG5Pp3Lu6DYuZrXstivS7WiEJhjUpmKQEPLi622fVc3gAhcYa6ZwSL59tbz53b?cluster=devnet), slot **498565132**.

[Machine-readable receipt and deposit simulation](devnet-test-vault.json) records the exact message hash, balances and native readback checks. [SDK-formatted state](devnet-test-vault-state.json) records the complete small basket/configuration. The earlier `devnet-funded-preflight.json` is historical: its missing-base blocker was resolved by supervisor-authorized rebase onto `f86af32`.

## Basket and costs

The SDK/native creation default is a **50% WSOL / 50% SDK devnet USDC** test basket, verified after creation:

| Mint | Decimals | Weight |
| --- | ---: | ---: |
| `So11111111111111111111111111111111111111112` | 9 | 5,000 bps |
| `USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT` | 6 | 5,000 bps |

Both mint accounts were read from devnet and verified as initialized classic SPL mints. No securities mints were certified. Oracle settings exist on the vault; current price freshness and swap routes are **not verified**.

- Initial wallet: **5 SOL**; remaining: **4.809072640 SOL**.
- One broadcast; wallet debit: **0.190927360 SOL**, including **0.000030 SOL** transaction fee, account setup/rent and wrapped SOL. Wallet debit is not all an irrecoverable fee.
- The SDK wrapped **0.01025 SOL** into the creator's WSOL account; creation did **not** credit it to native vault bounty balance (read back **0**). No backing contribution was made.
- Creation was simulated under a stricter **0.25 SOL** subcap before loading the authorized signer. Total authorization remains capped at the original **5 SOL**; no airdrop, external funding, mainnet RPC, or mainnet transaction was used.

## Deposit attempt and next prerequisite

Used existing `NativeVaultBuilders.deposit` / `@symmetry-hq/sdk@1.0.22` to prepare a **0.1 SDK-devnet-USDC** contribution (`100000` raw units). The SDK returned two batches (intent initialization, contribution). First-stage intent initialization simulated successfully at slot **498565434**, consuming **80,392 CU**.

The wallet has **no token accounts for the SDK's USDC mint**. Therefore neither batch was signed or broadcast: creating an orphan intent and knowingly failing its contribution would waste rent/fees. Contribution, lock, settlement, share minting, transfer and redemption are **NOT_RUN**. Readback confirms no pending owner intent and zero share supply.

To continue, fund this same wallet with at least 0.1 of **the exact SDK mint above** on devnet; a different Circle/test USDC mint is not interchangeable. No mint authority or verified faucet was available to this task. Then reuse the existing vault/share mint, re-attest configuration, budget and price/route readiness, and rebuild a fresh deposit transaction. Do **not** create a second vault. Lock is a separate SDK step, not included in the returned buy batches.

## Release limits and validation

- On-chain deposits default to enabled; automation, LP, force and custom rebalance are disabled. Stocklana app/public-funds gates and registry were **not** enabled or changed.
- Host entry fee read back at **25 bps**, other host/creator/manager/vault fees at zero. Protocol fees are separate; this is not an all-in fee quote.
- Test metadata is on-chain name/symbol only, URI empty. No immutable hosted metadata, role separation or production manifest readiness is claimed.
- Start-price SDK input was `"1"`; native formatted value is approximately `0.000001` (SDK scaling). No bootstrap fairness or NAV proof is claimed with zero shares/backing.
- Finalized receipt hash, creator/host, mint authority/decimals/supply, basket mints/weights, fees, remaining SOL and absence of an owner intent were checked against RPC using the existing native module.
- Repository tests: **73 passed**. `npm run typecheck`: **passed** after regenerating stale worktree route types with `next typegen`.
- No secret key, signed wire transaction, or private deployment journal is committed. This operational evidence is not a general-purpose signing endpoint or an audited live-funds release.
