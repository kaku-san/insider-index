import { configuredCyclePolicy } from "./cycle-config.ts";
import { createCycleAccessChallenge, assertCycleAccess } from "./cycle-access.ts";
import { CycleRunner } from "./cycle-runner.ts";
import { CycleJournal } from "./cycle-store.ts";
import { kakuSanBuilders } from "./kaku-san-create.ts";
import { createServiceSupabase } from "../supabase.ts";
import { readVaultDefinition } from "./vault-definition-store.ts";
import type { CyclePolicy } from "./cycle-policy-parse.ts";
export function configuredCycleRunner(policy: CyclePolicy, allowSend = false): CycleRunner {
  return new CycleRunner({ native: kakuSanBuilders(allowSend), policy, journal: new CycleJournal(policy), loadDefinition: async () => {
    const db = createServiceSupabase(); if (!db) throw new Error("CYCLE_DURABLE_SERVICE_ROLE_REQUIRED");
    return readVaultDefinition(db, policy.indexId);
  } });
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("CYCLE_REQUEST_JSON_REQUIRED");
  const reader = request.body?.getReader(); if (!reader) throw new Error("CYCLE_REQUEST_BODY");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > 8192) { await reader.cancel(); throw new Error("CYCLE_REQUEST_TOO_LARGE"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  let parsed: unknown; try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error("CYCLE_REQUEST_JSON_REQUIRED"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CYCLE_REQUEST_BODY");
  return parsed as Record<string, unknown>;
}
/** Private owner endpoint. No client policies, balances, credits, keeper actions or arbitrary
 * relay. A short owner-signed session only grants access; each financial message is separately
 * owner-signed, journal-latched, independently checked and simulated again before relay. */
export async function handleCycleRequest(request: Request, dependencies: { env?: Record<string, string | undefined>; runner?: (policy: CyclePolicy, allowSend: boolean) => CycleRunner } = {}): Promise<Response> {
  const headers = { "Cache-Control": "no-store, private", "Vary": "Origin", "X-Content-Type-Options": "nosniff" };
  try {
    const origin = new URL(request.url).origin;
    if (request.method !== "POST" || request.headers.get("origin") !== origin) throw new Error("CYCLE_REQUEST_ORIGIN");
    const input = await body(request);
    if (typeof input.operationId !== "string" || input.operationId.length > 64 || typeof input.action !== "string" || !["challenge", "read", "prepare", "submit", "reconcile"].includes(input.action)) throw new Error("CYCLE_REQUEST_ACTION");
    const allowed = ["operationId", "action", ...(input.action === "challenge" ? ["wallet"] : ["auth"]), ...(input.action === "prepare" ? ["request"] : []), ...(input.action === "submit" ? ["signedTransaction"] : [])];
    if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error("CYCLE_REQUEST_UNEXPECTED_FIELD");
    const env = dependencies.env ?? process.env, policy = configuredCyclePolicy(input.operationId, env);
    if (input.action === "challenge") {
      if (input.wallet !== policy.owner) throw new Error("CYCLE_ACCESS_WALLET");
      return Response.json({ policy, challenge: createCycleAccessChallenge(policy, origin, env) }, { headers });
    }
    assertCycleAccess(input.auth, policy, origin, env);
    const runner = (dependencies.runner ?? configuredCycleRunner)(policy, input.action === "submit");
    let preparation: Awaited<ReturnType<CycleRunner["prepare"]>> | undefined;
    let submission: Awaited<ReturnType<CycleRunner["submit"]>> | undefined;
    if (input.action === "prepare") {
      if (input.request !== undefined && !["next", "withdraw", "recover"].includes(String(input.request))) throw new Error("CYCLE_REQUEST_PREPARATION");
      preparation = await runner.prepare("owner", (input.request ?? "next") as "next" | "withdraw" | "recover");
    } else if (input.action === "submit") {
      if (typeof input.signedTransaction !== "string" || input.signedTransaction.length > 3000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.signedTransaction)) throw new Error("CYCLE_REQUEST_SIGNED_WIRE");
      submission = await runner.submit("owner", input.signedTransaction);
    } else if (input.action === "reconcile") await runner.reconcile();
    const state = await runner.read(), record = await runner.input.loadDefinition(policy.indexId);
    if (!record) throw new Error("CYCLE_DEFINITION_MISSING_OR_SUBSTITUTED");
    return Response.json({ policy, record, state, preparation, submission }, { headers });
  } catch (error) {
    // Do not return RPC URLs/credentials, signed wires, SQL details or raw program logs.
    const code = error instanceof Error ? error.message.match(/^CYCLE_[A-Z_]+/)?.[0] : null;
    return Response.json({ error: code ?? "CYCLE_OPERATION_REFUSED", recovery: "Retain the existing operation. Reconcile; never replace an ambiguous draft or repeat funding/burn." }, { status: code?.includes("ACCESS") || code?.includes("ORIGIN") ? 403 : code === "CYCLE_PRIVATE_OPERATION_UNAVAILABLE" ? 404 : 409, headers });
  }
}
