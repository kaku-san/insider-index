/** QuickNode Discover accepts at most five accounts per getMultipleAccounts call. */
export const DEFAULT_RPC_MAX_MULTIPLE_ACCOUNTS = 5;
const SOLANA_MAX_MULTIPLE_ACCOUNTS = 100;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function checkedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > SOLANA_MAX_MULTIPLE_ACCOUNTS) {
    throw new Error("RPC_MAX_MULTIPLE_ACCOUNTS must be an integer from 1 to 100.");
  }
  return value;
}

export function rpcMaxMultipleAccounts(value = process.env.RPC_MAX_MULTIPLE_ACCOUNTS): number {
  return checkedLimit(value?.trim() ? Number(value) : DEFAULT_RPC_MAX_MULTIPLE_ACCOUNTS);
}

function accountKeys(call: unknown): unknown[] | null {
  if (!object(call) || call.method !== "getMultipleAccounts" || !Array.isArray(call.params)) return null;
  return Array.isArray(call.params[0]) ? call.params[0] : null;
}

/** Split at the transport boundary so SDK, keeper and browser-proxy callers share one policy.
 * Wrap the paced transport, not vice versa: every chunk must obey pacing and retry limits.
 * Chunked reads are not atomic; their merged context reports the oldest observed slot.
 * Like web3.js and our proxy, callers supply JSON as a string in init.body.
 */
export function chunkedRpcFetch(options: { fetchImpl?: typeof fetch; maxMultipleAccounts?: number } = {}): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = checkedLimit(options.maxMultipleAccounts ?? DEFAULT_RPC_MAX_MULTIPLE_ACCOUNTS);
  return async (input, init) => {
    if (typeof init?.body !== "string") return fetchImpl(input, init);
    let payload: unknown;
    try { payload = JSON.parse(init.body); } catch { return fetchImpl(input, init); }
    const calls = Array.isArray(payload) ? payload : [payload];
    const needsSplit = (call: unknown) => (accountKeys(call)?.length ?? 0) > limit;
    if (!calls.some(needsSplit)) return fetchImpl(input, init);
    // Match Solana's original per-call bound; chunking must not enable unbounded browser fan-out.
    if (calls.some(call => (accountKeys(call)?.length ?? 0) > SOLANA_MAX_MULTIPLE_ACCOUNTS)) {
      throw new Error("getMultipleAccounts supports at most 100 accounts.");
    }

    const send = (call: unknown) => fetchImpl(input, { ...init, body: JSON.stringify(call) });
    const split = async (call: unknown): Promise<Response> => {
      if (!needsSplit(call) || !object(call)) return send(call);
      const keys = accountKeys(call)!;
      const params = call.params as unknown[];
      const values: unknown[] = [];
      let context: Record<string, unknown> | undefined;
      const notification = !Object.hasOwn(call, "id");
      for (let start = 0; start < keys.length; start += limit) {
        const chunk = keys.slice(start, start + limit);
        const response = await send({ ...call, params: [chunk, ...params.slice(1)] });
        if (!response.ok) return response;
        if (notification && response.status === 204) continue;
        const reply: unknown = await response.json();
        if (!object(reply) || reply.jsonrpc !== "2.0" || (!notification && reply.id !== call.id)) {
          throw new Error("Invalid getMultipleAccounts response.");
        }
        if (Object.hasOwn(reply, "error")) return Response.json(reply);
        const result = reply.result;
        if (!object(result) || !Array.isArray(result.value) || result.value.length !== chunk.length
          || !object(result.context) || !Number.isSafeInteger(result.context.slot) || Number(result.context.slot) < 0) {
          throw new Error("Invalid getMultipleAccounts result.");
        }
        values.push(...result.value);
        context = context
          ? { ...context, slot: Math.min(Number(context.slot), Number(result.context.slot)) }
          : result.context;
      }
      if (notification) return new Response(null, { status: 204 });
      return Response.json({ jsonrpc: "2.0", id: call.id, result: { context, value: values } });
    };

    if (!Array.isArray(payload)) return split(payload);
    const replies: unknown[] = [];
    for (const call of calls) {
      const response = await split(call);
      if (!response.ok) return response;
      if (response.status !== 204) replies.push(await response.json());
    }
    return replies.length ? Response.json(replies) : new Response(null, { status: 204 });
  };
}
