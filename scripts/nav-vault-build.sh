#!/usr/bin/env bash
# Rebuild the NAV vault + mock swap SBF binaries and refresh programs/bin (committed so `npm test`
# runs without a Rust toolchain). Toolchain: agave 3.0.x cargo-build-sbf, platform-tools v1.52.
# Optional: `source .toolchain/env.sh` first to keep platform-tools/rustup/cargo state inside the worktree.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
( cd programs
  cargo-build-sbf --tools-version v1.52 --manifest-path nav-vault/Cargo.toml --sbf-out-dir "$OUT/mainnet"
  cargo-build-sbf --tools-version v1.52 --manifest-path nav-vault/Cargo.toml --features devnet --sbf-out-dir "$OUT/devnet"
  cargo-build-sbf --tools-version v1.52 --manifest-path mock-swap/Cargo.toml --sbf-out-dir "$OUT/mock" )
mkdir -p programs/bin
cp "$OUT/mainnet/nav_vault.so" programs/bin/nav_vault.so
cp "$OUT/devnet/nav_vault.so" programs/bin/nav_vault_devnet.so
cp "$OUT/mock/mock_swap.so" programs/bin/mock_swap.so
node -e '
const {createHash}=require("crypto"),fs=require("fs");
const out={};for(const f of ["nav_vault.so","nav_vault_devnet.so","mock_swap.so"])out[f]=createHash("sha256").update(fs.readFileSync("programs/bin/"+f)).digest("hex");
fs.writeFileSync("programs/bin/MANIFEST.json",JSON.stringify(out,null,2)+"\n");console.log(out);'
rm -rf "$OUT"
