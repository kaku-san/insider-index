# Mag7 direct-deposit keeper

`scripts/mag7-settle-deposit.mts` is InsiderIndex's own external settlement process for
**finalized** direct Mag7 `buyVaultTx` + `lockDepositsTx` intents. It is not a
third-party keeper SaaS and it is not part of the Next/Vercel deployment.

The normal path scans the one fixed Mag7 vault
`AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh` for **every** locked user deposit,
then advances each through Raydium-only price update, fill, mint, and bounty cleanup.
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

# The always-on process: polls every five minutes until Ctrl-C.
# The keypair is an absolute path outside this checkout.
npm run keeper:mag7-watch -- --keypair /absolute/external/keeper.json

# Equivalent explicit form; interval is 300 seconds by default (5..86400 accepted).
npm run keeper:mag7-deposit -- --watch-vault --execute --watch \
  --interval-seconds 300 --keypair /absolute/external/keeper.json
```

Every poll begins with a fresh **0.05 SOL** observed-debit cap for the keeper.
The process stops starting more deposits in that poll when the cap is reached;
inspect the emitted JSON and let the next scheduled poll resume. It never creates a
user deposit or opens public funds. After at least one stock leg is filled, Symmetry
may mint a partial book; unspent USDC remains in the deposit intent and the emitted
`filledLegMints`/`skippedLegMints` identify the result. Only
`CYCLE_ROUTE_MINIMUM_UNSATISFIABLE` and `CYCLE_NO_FULL_SIZE_ROUTE` are treated as
skippable dust/unroutable legs; other route errors refuse settlement. A nonzero
accounted WSOL balance, no filled stock legs, missing keeper ATAs, wrong keeper
identity, non-Raydium configuration, and Pyth/Hermes environment all refuse before
settlement. A positive owner share balance is the completion signal.

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
   complete only after its owner's on-chain share balance is positive.

The example unit lives at
[`docs/systemd/insiderindex-mag7-keeper.service`](systemd/insiderindex-mag7-keeper.service).
Install it as root with `install -m 0644`, then run `systemctl daemon-reload` and
`systemctl enable --now insiderindex-mag7-keeper`. The ordinary command left running
by the captain is `npm run keeper:mag7-watch -- --keypair /etc/insiderindex/mag7-keeper.json`;
it needs no depositor-specific environment variable.

Symmetry's `KeeperMonitor` may be evaluated as a substitute only after it proves the
same fixed-vault scope, configured keeper identity, Raydium-only transaction policy,
and debit cap. It is not enabled or assumed by this runbook.
