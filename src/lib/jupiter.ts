import {
  USDC_MINT,
  assertCanBuyMint,
  fromAtomicAmount,
  toAtomicAmount,
} from "@/lib/allowlist";

export const JUPITER_SWAP_V2_BASE = "https://api.jup.ag/swap/v2";

export type JupiterOrderRequest = {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker?: string;
};

export type JupiterOrder = {
  requestId: string;
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
  stub: boolean;
};

function stubRequestId(): string {
  return `stub-${crypto.randomUUID()}`;
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
  if (request.inputMint !== USDC_MINT) {
    throw new Error("V1 quotes buy xStocks with USDC only.");
  }

  const xstock = assertCanBuyMint(request.outputMint);
  const usdcAmount = fromAtomicAmount(request.amount, 6);
  const outUi = usdcAmount / xstock.stubUsdPrice;
  const outAmount = toAtomicAmount(outUi, xstock.decimals);
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
  };

  return {
    ...order,
    transaction: stubTransactionPayload(order),
  };
}

export async function fetchJupiterOrder(
  request: JupiterOrderRequest,
): Promise<JupiterOrder> {
  assertCanBuyMint(request.outputMint);

  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
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
    headers: { "x-api-key": apiKey },
    cache: "no-store",
  });

  if (!response.ok) {
    return buildStubOrder(request);
  }

  const payload = (await response.json()) as {
    requestId?: string;
    transaction?: string;
    inAmount?: string;
    outAmount?: string;
    otherAmountThreshold?: string;
    router?: string;
    errorMessage?: string;
  };

  if (!payload.requestId || payload.errorMessage) {
    return buildStubOrder(request);
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
    taker: request.taker,
    stub: false,
  };
}

export async function executeJupiterOrder(
  request: JupiterExecuteRequest,
): Promise<JupiterExecuteResult> {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey || request.requestId.startsWith("stub-")) {
    return {
      status: "Success",
      signature: `STUB${request.requestId.replace(/[^A-Za-z0-9]/g, "").slice(0, 80)}`,
      requestId: request.requestId,
      stub: true,
    };
  }

  const response = await fetch(`${JUPITER_SWAP_V2_BASE}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      signedTransaction: request.signedTransaction,
      requestId: request.requestId,
    }),
  });

  const payload = (await response.json()) as {
    status?: "Success" | "Failed";
    signature?: string;
    inputAmountResult?: string;
    outputAmountResult?: string;
  };

  return {
    status: payload.status ?? "Failed",
    signature: payload.signature ?? "",
    requestId: request.requestId,
    inputAmountResult: payload.inputAmountResult,
    outputAmountResult: payload.outputAmountResult,
    stub: false,
  };
}
