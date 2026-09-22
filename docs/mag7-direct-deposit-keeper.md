# Mag7 direct-deposit keeper

`scripts/mag7-settle-deposit.mts` is InsiderIndex's own external settlement process for
locked direct Mag7 `buyVaultTx` + `lockDepositsTx` intents. It is not a
third-party keeper SaaS and it is not part of the Next/Vercel deployment.

The normal path scans the one fixed Mag7 vault
`AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh` for **every** locked user deposit,
then advances each through Raydium-only price update, fill, mint, and bounty cleanup.
It also settles native withdrawal intents, including post-mint cash leftovers.
No depositor wallet (`USER` or `--owner`) is needed. `--owner` remains a narrow,
single-intent troubleshooting option.

The keeper must be the persisted wallet
`GLq9gScm99eUypsc5a7WsP7rmsc3aAUfpzqmAPNqXvmq`. The command refuses a different
DB keeper or keypair. It does not use the public cycle journal, `keeper:index`,
Pyth/Hermes, or a server-side signer.

## Commands

The package exposes these scripts:

```sh
# One scan, no key loaded and no broadcast (the default).
npm run keeper:mag7-deposit -- --watch-vault --dry-run

# The always-on process: idle polls every 15 seconds until Ctrl-C.
# The keypair is an absolute path outside this checkout.
npm run keeper:mag7-watch -- --keypair /absolute/external/keeper.json

# Equivalent explicit form; interval is 15 seconds by default (5..86400 accepted).
# Do not override to a long interval: native auction windows are short.
npm run keeper:mag7-deposit -- --watch-vault --execute --watch \
  --interval-seconds 15 --keypair /absolute/external/keeper.json
```

Every poll begins with a fresh **0.05 SOL** observed-debit cap for the keeper.
While a native auction is open, the keeper immediately refreshes and sends the next
fill transaction after each confirmed fill (deposits remain capped at two swaps), until
all legs are filled, the auction closes, or the debit cap is reached. Price updates
immediately advance into the auction; mint/redeem immediately advance into cleanup.
The 15-second poll is idle-only. The process stops starting more deposits in that poll
when the cap is reached; inspect the emitted JSON before resuming. It never creates a
user deposit or opens public funds. Mint requires **seven distinct legs, each positive
and at least its positive native target**. Zero/partial fills fail, never mint. Quote-size
failures may be skipped while seeking other deposit fills, but never waive this gate.
Nonzero accounted WSOL, missing required keeper ATAs, wrong keeper identity,
non-Raydium configuration, and Pyth/Hermes environment also refuse settlement.

Cash-out pairs are vault-relative: **stock OUT, USDC IN**. Each sell is one atomic
Raydium CLMM swap inside the native flash pair; its minimum proceeds cover the native
USDC repayment. Keeper inventory is not the funding source. The settler re-reads after
each sale. A USDC-only intent needs no pairs: wait through the window, return vault USDC
to the owner's canonical ATA, then close the bounty/intent. Missing owner USDC ATA is
created in that redemption transaction; unrelated keeper stock ATAs do not block it.
Unsold non-USDC claims after expiry **fail closed in native custody**, never become an
in-kind payout. No native restart, post-expiry stock sale, or keeper side-payment exists
in this path. An empty-keep stock auction with no USDC receive target also refuses.

Public deposits remain paused. Even if the release gate is later enabled, the prepare
path refuses positive-supply cash-only/partial Mag7 backing and zero-supply accounted
leftovers before another contribution. These guards are containment, **not a refund**:
expired zero/partial deposits and missed stock exits still require separately proved
native recovery. All-seven mint and USDC return/intent closure need actual receipts;
an old share balance or successful prepare alone is not completion.

## Hetzner / VPS always-on

Use a dedicated VPS user and a dedicated keeper hot wallet. Keep the 64-byte JSON
key **outside** the checkout and outside Vercel/Next environment configuration. The
service role values are needed only to read the persisted definition; put them in a
service-user-readable VPS environment file, never in git.

1. Deploy this checkout on the VPS and install dependencies/build artifacts as your
   normal release process requires.
2. Put the keeper key at `/etc/insiderindex/mag7-keeper.json` (`0600`, owned by the
   `insiderindex` service user). Confirm its public key is the configured
   `GLq9gScm99eUypsc5a7WsP7rmsc3aAUfpzqmAPNqXvmq`.
3. Put only required RPC/Supabase variables in
   `/etc/insiderindex/mag7-keeper.env` (readable by the `insiderindex` service user,
   for example `0640` root:insiderindex). Do **not** put the keypair in that file and
   do not set a `USER` variable.
4. Dry-run once from the checkout using the first command above, then install the
   systemd unit below. Monitor JSON output with `journalctl`; a locked deposit is
   complete only with an attributable all-seven mint and settled leftover claims.

The example unit lives at
[`docs/systemd/insiderindex-mag7-keeper.service`](systemd/insiderindex-mag7-keeper.service).
Install it as root with `install -m 0644`, then run `systemctl daemon-reload` and
`systemctl enable --now insiderindex-mag7-keeper`. The ordinary command left running
by the captain is `npm run keeper:mag7-watch -- --keypair /etc/insiderindex/mag7-keeper.json`;
it needs no depositor-specific environment variable.

Symmetry's `KeeperMonitor` may be evaluated as a substitute only after it proves the
same fixed-vault scope, configured keeper identity, Raydium-only transaction policy,
and debit cap. It is not enabled or assumed by this runbook.
