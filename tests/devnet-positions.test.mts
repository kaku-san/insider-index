import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DEVNET_TEST_VAULT } from "../src/lib/index-vaults/devnet-contract.ts";
import { NativeVaultBuilders, GENESIS, SYMMETRY_PROGRAM_ID } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { handleDevnetPositions, readDevnetPosition } from "../src/lib/index-vaults/devnet-positions.ts";
import { formatVaultShares } from "../src/lib/index-vaults/positions-contract.ts";
import { GET } from "../src/app/api/positions/route.ts";

const owner = "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB";
const other = Keypair.generate().publicKey.toBase58();
const key = (value: string) => new PublicKey(value);
const info = (data: Buffer, program = TOKEN_PROGRAM_ID) => ({ data, owner: program, executable: false, lamports: 1, rentEpoch: 0 });
function token(amount: bigint, mint = DEVNET_TEST_VAULT.shareMint as string, wallet = owner) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: key(mint), owner: key(wallet), amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { pubkey: Keypair.generate().publicKey, account: info(data) };
}
function fixture(t: TestContext, amounts: bigint[] = []) {
  const connection = new Connection("https://api.devnet.solana.com");
  const native = new NativeVaultBuilders(connection, "devnet");
  const accounts = amounts.map(amount => token(amount));
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 18446744073709551615n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  t.mock.method(connection, "getGenesisHash", async () => GENESIS.devnet);
  t.mock.method(connection, "getAccountInfo", async (address: PublicKey) => {
    if (address.toBase58() === DEVNET_TEST_VAULT.vaultAccount) return info(Buffer.from("vault"), key(SYMMETRY_PROGRAM_ID));
    if (address.toBase58() === DEVNET_TEST_VAULT.shareMint) return info(mintData);
    return null; // No pending intent.
  });
  t.mock.method(native.sdk, "fetchVault", async () => ({ mint: key(DEVNET_TEST_VAULT.shareMint), ownAddress: key(DEVNET_TEST_VAULT.vaultAccount), settings: { creator: key(owner), host: key(owner) } }));
  t.mock.method(connection, "getTokenAccountsByOwner", async (wallet: PublicKey, filter: { mint: PublicKey }, commitment: string) => {
    assert.equal(wallet.toBase58(), owner);
    assert.equal(filter.mint.toBase58(), DEVNET_TEST_VAULT.shareMint);
    assert.equal(commitment, "confirmed");
    return { context: { slot: 456 }, value: accounts };
  });
  return { native, connection, accounts };
}
const request = (query = `wallet=${owner}`) => new Request(`http://localhost/api/positions?${query}`);

test("positions execute native account decoding and sum all share accounts exactly, not receipts", async t => {
  const { native } = fixture(t, [9007199254740993n, 7n]);
  const response = await handleDevnetPositions(request(), native);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const { position } = await response.json();
  assert.deepEqual(position.identity, DEVNET_TEST_VAULT);
  assert.equal(position.owner, owner);
  assert.equal(position.shareBalanceRaw, "9007199254741000");
  assert.equal(position.shareDecimals, 6);
  assert.equal(position.observedSlot, 456);
  assert.equal(position.source, "native-token-accounts");
  assert.equal(position.navUsd, null);
  assert.equal(position.valueUsd, null);
  assert.equal(position.nativeIntent, null);
  assert.ok(Number.isFinite(Date.parse(position.observedAt)));
});

test("no accounts means confirmed zero; re-reading reflects transferred shares", async t => {
  const { native, accounts } = fixture(t);
  assert.equal((await readDevnetPosition(owner, native)).shareBalanceRaw, "0");
  accounts.push(token(1n));
  assert.equal((await readDevnetPosition(owner, native)).shareBalanceRaw, "1");
  accounts.pop();
  assert.equal((await readDevnetPosition(owner, native)).shareBalanceRaw, "0");
});

test("pending intent is separate and does not inflate owned shares", async t => {
  const { native } = fixture(t, [3n]);
  t.mock.method(native, "ownerIntent", async () => ({ chain_data: { ownAddress: key(other) } }));
  const result = await readDevnetPosition(owner, native);
  assert.equal(result.shareBalanceRaw, "3");
  assert.equal(result.nativeIntent, other);
});

test("HTTP rejects absent/invalid/fixture wallets and alternate network/vault/RPC selectors", async () => {
  for (const query of ["", "wallet=", "wallet=privy-stub:test", `wallet=${owner}&wallet=${other}`, `wallet=${owner}&network=mainnet-beta`, `wallet=${owner}&vault=${other}`, `wallet=${owner}&rpcUrl=https://api.mainnet-beta.solana.com`]) {
    const response = await GET(request(query));
    assert.equal(response.status, 400);
    assert.deepEqual(Object.keys(await response.json()), ["error"]);
  }
});

for (const failure of ["rpc", "genesis", "vault", "mint", "owner", "program", "mint-program", "decimals", "network"] as const) {
  test(`native ${failure} failure returns unavailable, never zero or receipts`, async t => {
    const { native, connection, accounts } = fixture(t, [10n]);
    if (failure === "rpc") t.mock.method(connection, "getTokenAccountsByOwner", async () => { throw new Error("private RPC details"); });
    if (failure === "genesis") t.mock.method(connection, "getGenesisHash", async () => GENESIS["mainnet-beta"]);
    if (failure === "vault") t.mock.method(native.sdk, "fetchVault", async () => ({ mint: key(other) }));
    if (failure === "mint") accounts[0] = token(10n, other);
    if (failure === "owner") accounts[0] = token(10n, DEVNET_TEST_VAULT.shareMint, other);
    if (failure === "program") accounts[0].account.owner = key(other);
    if (failure === "mint-program" || failure === "decimals") {
      const original = connection.getAccountInfo.bind(connection);
      t.mock.method(connection, "getAccountInfo", async (address: PublicKey) => {
        const account = await original(address);
        if (address.toBase58() === DEVNET_TEST_VAULT.shareMint && account) {
          if (failure === "mint-program") account.owner = key(other);
          else account.data[44] = 9;
        }
        return account;
      });
    }
    if (failure === "network") Object.assign(native, { network: "mainnet-beta" });
    const response = await handleDevnetPositions(request(), native);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.ok(!body.error.includes("private RPC"));
  });
}

test("share display keeps raw precision, including one base unit and large balances", () => {
  assert.equal(formatVaultShares("0", 6), "0");
  assert.equal(formatVaultShares("1", 6), "0.000001");
  assert.equal(formatVaultShares("1230000", 6), "1.23");
  assert.equal(formatVaultShares("9007199254740993", 6), "9,007,199,254.740993");
  assert.equal(formatVaultShares("1000", 0), "1,000");
  assert.throws(() => formatVaultShares("1e6", 6));
  assert.throws(() => formatVaultShares("1", -1));
});
