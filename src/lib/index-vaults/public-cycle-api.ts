import { PublicKey } from "@solana/web3.js";
import { createCycleAccessChallenge } from "./cycle-access.ts";
import { configuredCycleRunner, handleCycleRequest, readCycleRequestBody, type CycleApiDependencies } from "./cycle-api.ts";
import { CycleRunner } from "./cycle-runner.ts";
import { cyclePolicyHash } from "./cycle-policy-parse.ts";
import { assertPublicCycleScope, PUBLIC_MAG7 } from "./public-cycle-parse.ts";
import { publicCyclePolicyForWallet, resolvePublicCyclePolicy } from "./public-cycle-policy.ts";
import { publicCycleIndexEnabled, publicCyclePolicyActive, publicCycleReleaseOpen, type PublicCycleRelease } from "./public-cycle-release.ts";
import { VAULT_RELEASE } from "./release.ts";
import type { CycleRpc } from "./cycle-store.ts";
import { publicCycleErrorBody } from "../frontend/public-cycle-copy.ts";

const headers = { "Cache-Control": "no-store, private", Vary: "Origin", "X-Content-Type-Options": "nosniff" };
export type PublicCycleDependencies = Pick<CycleApiDependencies, "env" | "runner" | "policy"> & { release?: PublicCycleRelease; rpc?: CycleRpc };

function publicCycleErrorResponse(error: unknown, status?: number, mode: "deposit" | "withdraw" = "deposit"): Response {
  const body = publicCycleErrorBody(error, mode);
  const code = body.code;
  return Response.json(body, {
    status: status ?? (code.includes("ORIGIN") ? 403 : code === "CYCLE_PUBLIC_POLICY_UNAVAILABLE" || code === "CYCLE_PUBLIC_SCOPE" ? 404 : 409),
    headers,
  });
}

async function sanitizeCycleFailure(response: Response, mode: "deposit" | "withdraw"): Promise<Response> {
  const payload = await response.json().catch(() => null);
  const code = payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string"
    ? payload.code
    : payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : "CYCLE_PUBLIC_OPERATION_REFUSED";
  return publicCycleErrorResponse(code, response.status, mode);
}

/** Public URL. Every connected Mag7 wallet gets a derived operation on the same vault. The
 * configured template operation remains available only to the private operator path. Discovery binds the selected amount;
 * client slippage/cost budgets, operation IDs, keeper signing and policies are never accepted. */
export async function handlePublicCycleRequest(request: Request, indexId: string, dependencies: PublicCycleDependencies = {}): Promise<Response> {
  let mode: "deposit" | "withdraw" = "deposit";
  try {
    const origin = new URL(request.url).origin;
    if (request.method !== "POST" || request.headers.get("origin") !== origin) throw new Error("CYCLE_REQUEST_ORIGIN");
    if (indexId !== PUBLIC_MAG7.indexId) throw new Error("CYCLE_PUBLIC_SCOPE");
    const input = await readCycleRequestBody(request), env = dependencies.env ?? process.env;
    mode = input.request === "withdraw" ? "withdraw" : "deposit";
    const release = dependencies.release ?? VAULT_RELEASE;
    if (input.action === "discover") {
      if (Object.keys(input).some(k => !["action", "wallet", "amountRaw"].includes(k)) || typeof input.wallet !== "string" || input.wallet.length > 44 || (input.amountRaw !== undefined && typeof input.amountRaw !== "string")) throw new Error("CYCLE_PUBLIC_DISCOVERY_REQUEST");
      const wallet = new PublicKey(input.wallet);
      if (wallet.toBase58() !== input.wallet || !PublicKey.isOnCurve(wallet.toBytes())) throw new Error("CYCLE_PUBLIC_DISCOVERY_REQUEST");
      const policy = await publicCyclePolicyForWallet(input.wallet, env, Date.now(), input.amountRaw as string | undefined, dependencies.rpc);
      assertPublicCycleScope(policy);
      return Response.json({ binding: { operationId: policy.operationId, owner: policy.owner, policyHash: cyclePolicyHash(policy) }, challenge: createCycleAccessChallenge(policy, origin, env) }, { headers });
    }
    if (input.action === "challenge") throw new Error("CYCLE_PUBLIC_USE_DISCOVERY");
    const policy = dependencies.policy ?? resolvePublicCyclePolicy(input, env);
    const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(input) });
    const response = await handleCycleRequest(forwarded, {
      env, policy, assertPolicy: assertPublicCycleScope,
      runner: (bound, allowSend) => {
        const runner = (dependencies.runner ?? configuredCycleRunner)(bound, allowSend);
        return new CycleRunner({ ...runner.input, executionGate: purpose => {
          runner.input.executionGate?.(purpose);
          if (purpose === "deposit" && !publicCycleReleaseOpen(release)) throw new Error("CYCLE_PUBLIC_DEPOSITS_CLOSED");
        } });
      },
    });
    if (!response.ok) return sanitizeCycleFailure(response, mode);
    const reply = await response.json();
    return Response.json({ ...reply, depositEnabled: publicCyclePolicyActive(reply.policy) && publicCycleIndexEnabled(reply.record, env, release) }, { headers });
  } catch (error) {
    return publicCycleErrorResponse(error, undefined, mode);
  }
}
