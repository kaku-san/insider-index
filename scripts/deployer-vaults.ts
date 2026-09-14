import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ReadOnlyDeployer } from "../src/lib/index-vaults/deployer.ts";
import { NativeVaultBuilders, readOnlyConnection } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { consumePublishedComposition } from "../src/lib/index-vaults/composition.ts";
import type { PublishedComposition } from "../src/lib/index-vaults/composition.ts";
import type { DeployerAuthorization, DeployerManifest } from "../src/lib/index-vaults/adapter-contract.ts";

// No --execute, wallet/keypair loading, airdrops, signing or broadcasting.
const [bundlePath, indexId, rpcUrl, journalPath, approvedDeployer] = process.argv.slice(2);
if (!bundlePath || !indexId || !rpcUrl || !journalPath || !approvedDeployer || process.argv.includes("--help")) {
  console.log("Usage: node --experimental-strip-types scripts/deployer-vaults.ts <approved-bundle.json> <indexId> <rpc-url> <durable-journal-path> <approved-deployer-pubkey>\nRead-only preparation only. The operator pins the expected deployer separately from the bundle. Bundle: manifest, authorization, signatureBase64, metadataBase64, publishedComposition. No readiness is asserted by this CLI; untested baskets WAIT_READINESS.");
} else {
  const bundle = JSON.parse(await readFile(resolve(bundlePath), "utf8")) as { manifest: DeployerManifest; authorization: DeployerAuthorization; signatureBase64: string; metadataBase64: string; publishedComposition: PublishedComposition };
  const composition = consumePublishedComposition(bundle.publishedComposition, Date.now(), 24 * 60 * 60 * 1000);
  const native = new NativeVaultBuilders(readOnlyConnection(rpcUrl), bundle.manifest.network);
  const deployer = new ReadOnlyDeployer(native, resolve(journalPath), { approvedDeployer, signatureBase64: bundle.signatureBase64, metadataBytes: Buffer.from(bundle.metadataBase64, "base64"), readinessHash: null });
  const result = await deployer.prepareInitialize({ manifest: bundle.manifest, authorization: bundle.authorization, indexId, composition });
  console.log(JSON.stringify(result, null, 2));
}
