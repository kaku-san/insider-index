import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { RebalanceAction, RebalanceType } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";

register("./support/ui-loader.mjs", import.meta.url);
const { lockedMag7DepositIntentAddresses, parseArgs } = await import("../scripts/mag7-settle-deposit.mts");

const VAULT = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const OTHER_VAULT = "8vQmbDWWSph7qQvSdvYcJ4W3xQnn6Nwg3Bh85P6iyReL";
const OWNER = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
const key = (value: string) => ({ toBase58: () => value });

function intent(pubkey: string, vault = VAULT, action = RebalanceAction.UpdatePrices, type = RebalanceType.Deposit) {
  return { formatted_data: { pubkey }, chain_data: { vault: key(vault), owner: key(OWNER), rebalanceType: type, currentAction: action } };
}

test("Mag7 watcher defaults to the fixed vault and keeps external-key safeguards", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.watchVault, true);
  assert.equal(defaults.pollMs, 300_000);
  assert.equal(defaults.execute, false);
  assert.deepEqual(parseArgs(["--watch-vault", "--dry-run"]), defaults);
  assert.equal(parseArgs(["--watch-vault", "--execute", "--keypair", "/external/keeper.json", "--watch", "--interval-seconds", "60"]).pollMs, 60_000);
  assert.throws(() => parseArgs(["--watch-vault", "--execute"]), /--keypair/);
  assert.throws(() => parseArgs(["--owner", OWNER, "--watch-vault"]), /single-intent/);
  assert.throws(() => parseArgs(["--watch-vault", "--interval-seconds", "4"]), /5 to 86400/);
});

test("Mag7 watcher selects every locked Mag7 deposit but no unlocked or foreign intent", () => {
  assert.deepEqual(lockedMag7DepositIntentAddresses([
    intent("locked-price"), intent("locked-auction", VAULT, RebalanceAction.Auction), intent("locked-price"),
    intent("unlocked", VAULT, RebalanceAction.DepositTokens), intent("inactive", VAULT, RebalanceAction.NotActive),
    intent("other-vault", OTHER_VAULT), intent("withdraw", VAULT, RebalanceAction.UpdatePrices, RebalanceType.Withdraw),
  ]), ["locked-price", "locked-auction"]);
});
