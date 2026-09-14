/**
 * Jupiter Swap V2 (Ultra-style) `/order` → user signs → `/execute`.
 * https://api.jup.ag/swap/v2 works keyless at a low rate limit; JUPITER_API_KEY
 * raises it. Mode selection lives in `jupiterMode()`:
 *   live  → real quotes; failures surface as errors, never as a fake fill
 *   stub  → deterministic fixture pricing for offline development
 */

import {
  USDC_DECIMALS,
  USDC_MINT,
  assertCanBuyMint,
  fromAtomicAmount,
  isAllowlistedMint,
  toAtomicAmount,
} from "@/lib/allowlist";
import { jupiterMode } from "@/lib/runtime";

export const JUPITER_SWAP_V2_BASE = "https://api.jup.ag/swap/v2";

export type JupiterOrderRequest = {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker?: string;
};

export type JupiterOrder = {
  requestId: string;
  /** Base64 unsigned transaction. Empty when quoting without a taker. */
  transaction: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  router: string;
  mode: "live" | "stub";
  taker?: string;
  stub: boolean;
  /** Unix seconds; the order must be executed before this. */
  expireAt: number | null;
  inUsdValue: number | null;
  outUsdValue: number | null;
  priceImpactPct: number | null;
  slippageBps: number | null;
  swapType: string | null;
  gasless: boolean;
  /** Set when Jupiter could quote but not build a transaction (no taker / insufficient funds). */
  errorMessage: string | null;
};

export type JupiterExecuteRequest = {
  signedTransaction: string;
  requestId: string;
};

export type JupiterExecuteResult = {
  status: "Success" | "Failed";
  signature: string;
  requestId: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
  code?: number;
  stub: boolean;
};

export class JupiterError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "JupiterError";
    this.status = status;
  }
}

function stubRequestId(): string {
  return `stub-${crypto.randomUUID()}`;
}

export function isStubRequestId(requestId: string): boolean {
  return requestId.startsWith("stub-");
}

export function isStubSignedTransaction(signed: string): boolean {
  return signed.startsWith("privy-stub:");
}

function stubTransactionPayload(order: Omit<JupiterOrder, "transaction">): string {
  return Buffer.from(
    JSON.stringify({
      kind: "stocklana-jupiter-v2-stub",
      ...order,
    }),
  ).toString("base64");
}

export function buildStubOrder(request: JupiterOrderRequest): JupiterOrder {
  const buying = request.inputMint === USDC_MINT;
  const xstockMint = buying ? request.outputMint : request.inputMint;
  const xstock = assertCanBuyMint(xstockMint);

  let outAmount: string;
  let usd: number;
  if (buying) {
    usd = fromAtomicAmount(request.amount, USDC_DECIMALS);
    outAmount = toAtomicAmount(usd / xstock.stubUsdPrice, xstock.decimals);
  } else {
    const tokens = fromAtomicAmount(request.amount, xstock.decimals);
    usd = tokens * xstock.stubUsdPrice;
    outAmount = toAtomicAmount(usd, USDC_DECIMALS);
  }
  const requestId = stubRequestId();

  const order: Omit<JupiterOrder, "transaction"> = {
    requestId,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inAmount: request.amount,
    outAmount,
    otherAmountThreshold: outAmount,
    router: "stub",
    mode: "stub",
    taker: request.taker,
    stub: true,
    expireAt: Math.floor(Date.now() / 1000) + 60,
    inUsdValue: usd,
    outUsdValue: usd,
    priceImpactPct: 0,
    slippageBps: 0,
    swapType: "stub",
    gasless: false,
    errorMessage: null,
  };

  return {
    ...order,
    transaction: stubTransactionPayload(order),
  };
}

function jupiterHeaders(): HeadersInit {
  const apiKey = process.env.JUPITER_API_KEY?.trim();
  return apiKey
    ? { Accept: "application/json", "x-api-key": apiKey }
    : { Accept: "application/json" };
}

type JupiterOrderPayload = {
  requestId?: string;
  transaction?: string | null;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  router?: string;
  errorMessage?: string;
  error?: string;
  expireAt?: string | number | null;
  inUsdValue?: number;
  outUsdValue?: number;
  priceImpactPct?: string | number;
  slippageBps?: number;
  swapType?: string;
  gasless?: boolean;
  taker?: string | null;
};

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeJupiterOrder(
  payload: JupiterOrderPayload,
  request: JupiterOrderRequest,
): JupiterOrder {
  if (!payload.requestId) {
    throw new JupiterError(502, payload.errorMessage ?? payload.error ?? "Jupiter returned no requestId.");
  }
  return {
    requestId: payload.requestId,
    transaction: payload.transaction ?? "",
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inAmount: payload.inAmount ?? request.amount,
    outAmount: payload.outAmount ?? "0",
    otherAmountThreshold: payload.otherAmountThreshold,
    router: payload.router ?? "jupiter",
    mode: "live",
    taker: payload.taker ?? request.taker,
    stub: false,
    expireAt: toNumber(payload.expireAt),
    inUsdValue: toNumber(payload.inUsdValue),
    outUsdValue: toNumber(payload.outUsdValue),
    priceImpactPct: toNumber(payload.priceImpactPct),
    slippageBps: toNumber(payload.slippageBps),
    swapType: payload.swapType ?? null,
    gasless: Boolean(payload.gasless),
    errorMessage: payload.errorMessage ?? payload.error ?? null,
  };
}

export async function fetchJupiterOrder(
  request: JupiterOrderRequest,
): Promise<JupiterOrder> {
  const xstockMint =
    request.inputMint === USDC_MINT ? request.outputMint : request.inputMint;
  if (!isAllowlistedMint(xstockMint)) {
    throw new JupiterError(403, "Copy blocked: xStock mint is not on the V1 allowlist.");
  }

  if (jupiterMode() === "stub") {
    return buildStubOrder(request);
  }

  const params = new URLSearchParams({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: request.amount,
  });
  if (request.taker) {
    params.set("taker", request.taker);
  }

  const response = await fetch(`${JUPITER_SWAP_V2_BASE}/order?${params}`, {
    headers: jupiterHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await response.json().catch(() => ({}))) as JupiterOrderPayload;
  if (!response.ok) {
    throw new JupiterError(
      response.status === 429 ? 429 : 502,
      payload.errorMessage ?? payload.error ?? `Jupiter /order ${response.status}`,
    );
  }
  return normalizeJupiterOrder(payload, request);
}

export async function executeJupiterOrder(
  request: JupiterExecuteRequest,
): Promise<JupiterExecuteResult> {
  const live = jupiterMode() === "live";

  if (isStubRequestId(request.requestId)) {
    if (live) {
      throw new JupiterError(400, "Stub order cannot be executed in live mode. Request a fresh quote.");
    }
    return {
      status: "Success",
      signature: `STUB${request.requestId.replace(/[^A-Za-z0-9]/g, "").slice(0, 80)}`,
      requestId: request.requestId,
      stub: true,
    };
  }

  if (isStubSignedTransaction(request.signedTransaction)) {
    throw new JupiterError(400, "A stub wallet signature cannot settle a live Jupiter order. Connect a real Solana wallet.");
  }

  const response = await fetch(`${JUPITER_SWAP_V2_BASE}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...jupiterHeaders(),
    },
    body: JSON.stringify({
      signedTransaction: request.signedTransaction,
      requestId: request.requestId,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    status?: "Success" | "Failed";
    signature?: string;
    inputAmountResult?: string;
    outputAmountResult?: string;
    error?: string;
    code?: number;
  };

  return {
    status: payload.status === "Success" ? "Success" : "Failed",
    signature: payload.signature ?? "",
    requestId: request.requestId,
    inputAmountResult: payload.inputAmountResult,
    outputAmountResult: payload.outputAmountResult,
    error: payload.error ?? (response.ok ? undefined : `Jupiter /execute ${response.status}`),
    code: payload.code,
    stub: false,
  };
}
