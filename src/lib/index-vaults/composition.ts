import type { PolicyValidatedComposition } from "./adapter-contract.ts";
import { weightsValid } from "./amounts.ts";

/** Track A publishes this execution envelope after its ModelComposition is mapped and validated.
 * No raw FMP rows, inferred tickers, naming authority or trading authority cross this boundary.
 * The repository's legacy annual/PTR calculators are deliberately not used here.
 */
export interface PublishedComposition {
  label: "FMP published model" | "Execution Test — not politician holdings";
  source: "fmp-store" | "execution-test";
  sourceCompleteness: "complete" | "partial" | "failed";
  published: boolean; fetchedAt: string; composition: PolicyValidatedComposition;
}
export function consumePublishedComposition(input: PublishedComposition, now: number, maxAgeMs: number): PolicyValidatedComposition {
  const age = now - Date.parse(input.fetchedAt);
  if (!input.published || input.sourceCompleteness !== "complete" || !Number.isFinite(age) || age < 0 || age > maxAgeMs) throw new Error("WAIT_DATA: preserve current composition");
  if ((input.source === "execution-test" && input.label !== "Execution Test — not politician holdings") || (input.source === "fmp-store" && input.label !== "FMP published model")) throw new Error("Unlabelled composition provenance");
  const c = input.composition;
  if (input.source === "execution-test" && (!c.indexId.startsWith("execution-test-") || c.personId !== "execution-test")) throw new Error("Execution test cannot impersonate a person index");
  if (!Number.isSafeInteger(c.version) || c.version < 1 || ![c.sourceDisclosureHash, c.manifestHash, c.policyHash, c.decisionEvidenceHash].every(h => /^[a-f0-9]{64}$/.test(h))) throw new Error("Composition version/provenance missing");
  weightsValid(c.assets);
  return c;
}
