# Hetzner Mag7 keeper deployment

These steps run InsiderIndex's own Mag7 settlement process on a VPS. They do not
deploy a keeper key to Vercel, Next.js, git, or a user-facing API.

```sh
# 1. Run once as root on a new Hetzner host.
adduser --disabled-password --gecos '' insiderindex
install -d -o insiderindex -g insiderindex -m 0750 /srv/insiderindex
install -d -o root -g insiderindex -m 0750 /etc/insiderindex

# 2. As the service user, put the approved checkout at this exact unit path.
sudo -u insiderindex git clone <approved-insiderindex-repository-url> /srv/insiderindex/stocklana
sudo -u insiderindex sh -lc 'cd /srv/insiderindex/stocklana && npm ci'

# 3. As root, copy the dedicated external key from secure operator storage.
# Never use a repository path, Vercel secret, or NEXT_PUBLIC variable.
install -o insiderindex -g insiderindex -m 0600 /secure/operator/mag7-keeper.json /etc/insiderindex/mag7-keeper.json

# 4. Create the VPS-only definition/RPC environment file. It contains no keypair.
install -o root -g insiderindex -m 0640 /dev/null /etc/insiderindex/mag7-keeper.env
editor /etc/insiderindex/mag7-keeper.env
```

`/etc/insiderindex/mag7-keeper.env` needs the normal service-role Supabase and RPC
variables required by `readVaultDefinition`/the Raydium builder. Do not add
`KEEPER_KEYPAIR`, a secret key, or a depositor `USER` variable.

```sh
# 5. Verify the external key is exactly the persisted Mag7 keeper wallet.
sudo -u insiderindex node --input-type=module - <<'NODE'
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('/etc/insiderindex/mag7-keeper.json', 'utf8'))));
if (key.publicKey.toBase58() !== 'GLq9gScm99eUypsc5a7WsP7rmsc3aAUfpzqmAPNqXvmq') throw new Error('Wrong Mag7 keeper key');
console.log(key.publicKey.toBase58());
NODE

# 6. Dry-run the fixed-vault scanner. This loads no key and broadcasts nothing.
sudo -u insiderindex sh -lc 'cd /srv/insiderindex/stocklana && npm run keeper:mag7-deposit -- --watch-vault --dry-run'

# 7. Install and start the always-on watcher.
install -o root -g root -m 0644 /srv/insiderindex/stocklana/docs/systemd/insiderindex-mag7-keeper.service /etc/systemd/system/insiderindex-mag7-keeper.service
systemctl daemon-reload
systemctl enable --now insiderindex-mag7-keeper
systemctl status insiderindex-mag7-keeper --no-pager
journalctl -u insiderindex-mag7-keeper -f
```

The service runs `npm run keeper:mag7-watch -- --keypair
/etc/insiderindex/mag7-keeper.json`: it scans every locked deposit on Mag7 every
five minutes and needs no wallet-specific command or environment variable. Each
poll has a 0.05 SOL keeper-debit ceiling. Read its JSON and investigate an error or
cap stop; the next poll starts with a new cap. A user has shares only when the
wallet's on-chain Mag7 share balance is positive.
