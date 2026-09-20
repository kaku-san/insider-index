import { PublicKey } from "@solana/web3.js";
import { configuredCyclePolicies } from "./cycle-config.ts";
import { createCycleAccessChallenge } from "./cycle-access.ts";
import { configuredCycleRunner, handleCycleRequest, readCycleRequestBody, type CycleApiDependencies } from "./cycle-api.ts";
import { CycleRunner } from "./cycle-runner.ts";
import { cyclePolicyHash } from "./cycle-policy-parse.ts";
import { assertPublicCycleScope, PUBLIC_MAG7 } from "./public-cycle-parse.ts";
import { publicCycleIndexEnabled, publicCyclePolicyActive, publicCycleReleaseOpen, type PublicCycleRelease } from "./public-cycle-release.ts";
import { VAULT_RELEASE } from "./release.ts";

const headers = { "Cache-Control": "no-store, private", Vary: "Origin", "X-Content-Type-Options": "nosniff" };
export type PublicCycleDependencies = Pick<CycleApiDependencies, "env" | "runner"> & { release?: PublicCycleRelease };
/** Public URL, narrowly configured owner authority. It uses the SAME cycle journal, planner,
 * receipt reconciliation and audited relay as the private operator surface. No new budgets,
 * operation IDs, keeper signing, receipt-only relay or client-supplied policy is accepted. */
export async function handlePublicCycleRequest(request: Request, indexId: string, dependencies: PublicCycleDependencies = {}): Promise<Response> {
  try {
    const origin = new URL(request.url).origin;
    if (request.method !== "POST" || request.headers.get("origin") !== origin) throw new Error("CYCLE_REQUEST_ORIGIN");
    if (indexId !== PUBLIC_MAG7.indexId) throw new Error("CYCLE_PUBLIC_SCOPE");
    const input = await readCycleRequestBody(request), env = dependencies.env ?? process.env;
    const release = dependencies.release ?? VAULT_RELEASE;
    if (input.action === "discover") {
      if (Object.keys(input).length !== 2 || typeof input.wallet !== "string" || input.wallet.length > 44) throw new Error("CYCLE_PUBLIC_DISCOVERY_REQUEST");
      const wallet = new PublicKey(input.wallet);
      if (wallet.toBase58() !== input.wallet || !PublicKey.isOnCurve(wallet.toBytes())) throw new Error("CYCLE_PUBLIC_DISCOVERY_REQUEST");
      const activePolicies = configuredCyclePolicies(env)
        .filter(p => p.indexId === indexId)
        .filter(p => publicCyclePolicyActive(p));
      if (!activePolicies.length) throw new Error("CYCLE_PUBLIC_POLICY_UNAVAILABLE");
      if (activePolicies.length !== 1) throw new Error("CYCLE_PUBLIC_AMBIGUOUS_POLICY");
      const policy = activePolicies[0];
      if (policy.owner !== input.wallet) throw new Error("CYCLE_PUBLIC_POLICY_UNAVAILABLE");
      assertPublicCycleScope(policy);
      // Do not publish private budgets/approval references by wallet enumeration. Owner signs
      // access-only canonical text, then reads the full policy and checks this hash.
      return Response.json({ binding: { operationId: policy.operationId, owner: policy.owner, policyHash: cyclePolicyHash(policy) }, challenge: createCycleAccessChallenge(policy, origin, env) }, { headers });
    }
    if (input.action === "challenge") throw new Error("CYCLE_PUBLIC_USE_DISCOVERY");
    const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(input) });
    const response = await handleCycleRequest(forwarded, {
      env, assertPolicy: assertPublicCycleScope,
      runner: (policy, allowSend) => {
        const runner = (dependencies.runner ?? configuredCycleRunner)(policy, allowSend);
        return new CycleRunner({ ...runner.input, executionGate: purpose => {
          runner.input.executionGate?.(purpose);
          if (purpose === "deposit" && !publicCycleReleaseOpen(release)) throw new Error("CYCLE_PUBLIC_DEPOSITS_CLOSED");
        } });
      },
    });
    if (!response.ok) return response;
    const reply = await response.json();
    return Response.json({ ...reply, depositEnabled: publicCyclePolicyActive(reply.policy) && publicCycleIndexEnabled(reply.record, env, release) }, { headers });
  } catch (error) {
    const code = error instanceof Error ? error.message.match(/^CYCLE_[A-Z_]+/)?.[0] : null;
    return Response.json({ error: code ?? "CYCLE_PUBLIC_OPERATION_REFUSED", recovery: "Retain the operation and exact signed bytes. Reconcile; never repeat funding or burn." }, { status: code?.includes("ORIGIN") ? 403 : code === "CYCLE_PUBLIC_POLICY_UNAVAILABLE" || code === "CYCLE_PUBLIC_SCOPE" ? 404 : 409, headers });
  }
}
