import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCycleKeeperArgs, loadExternalCycleKeeper } from "../scripts/insiderindex-cycle-keeper.mts";
import { cycleTestKeeper } from "./support/cycle-policy.mts";

test("cycle keeper defaults dry, requires explicit execute plus external path, and rejects silent custody/flag changes", () => {
  assert.deepEqual(parseCycleKeeperArgs(["--policy", "/operator/policy.json"]), { policyPath: "/operator/policy.json", keypairPath: undefined, execute: false, watch: false, pollMs: 3000 });
  const live = parseCycleKeeperArgs(["--policy", "/operator/policy.json", "--execute", "--keypair", "/operator/keeper.json", "--watch"]);
  assert.equal(live.execute, true); assert.equal(live.watch, true);
  for (const args of [[], ["--policy", "relative.json"], ["--policy", "/policy", "--execute"], ["--policy", "/policy", "--keypair", "/key"], ["--policy", "/policy", "--watch"], ["--policy", "/policy", "--execute", "--dry-run", "--keypair", "/key"], ["--policy", "/policy", "--vault", "substitute"], ["--policy", "/policy", "--force"], ["--policy", "/policy", "--poll-ms", "0"], ["--policy", "/policy", "--execute", "--execute"]]) assert.throws(() => parseCycleKeeperArgs(args), /CYCLE_KEEPER_/);
});
test("external keeper loader refuses repository paths and permissive files; only synthetic test keys are loaded offline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "insiderindex-cycle-key-test-")), path = join(directory, "synthetic.json");
  try {
    await assert.rejects(loadExternalCycleKeeper(fileURLToPath(new URL("../.env.example", import.meta.url))), /OUTSIDE_REPOSITORY/);
    await writeFile(path, JSON.stringify([...cycleTestKeeper.secretKey]), { mode: 0o600 });
    assert.equal((await loadExternalCycleKeeper(path)).publicKey.toBase58(), cycleTestKeeper.publicKey.toBase58());
    await chmod(path, 0o644);
    await assert.rejects(loadExternalCycleKeeper(path), /FILE_PERMISSIONS/);
    await chmod(path, 0o600); await writeFile(path, JSON.stringify([1, 2, 3]));
    await assert.rejects(loadExternalCycleKeeper(path), /KEY_FORMAT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
