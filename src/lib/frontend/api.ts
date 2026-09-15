const previewFlag =
  (process.env.NEXT_PUBLIC_INSIDERINDEX_PREVIEW ?? process.env.NEXT_PUBLIC_STOCKLANA_PREVIEW) === "1";
export const PREVIEW_MODE = process.env.NODE_ENV !== "production" && previewFlag;

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(response.status, "The API did not return JSON.", text);
  }
}

export async function requestApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await parseJson(response);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : response.status === 404
          ? "This record is unavailable."
          : `Request failed (${response.status}).`;
    throw new ApiError(response.status, message, payload);
  }
  return payload as T;
}

export async function readApi<T>(url: string, signal?: AbortSignal): Promise<T> {
  if (PREVIEW_MODE) {
    const { previewRead } = await import("./preview-data");
    return previewRead(url) as T;
  }
  return requestApi<T>(url, { signal });
}

export async function writeApi<T>(url: string, body: unknown): Promise<T> {
  // A preview never signs, submits, or fabricates a successful trade.
  if (PREVIEW_MODE) throw new Error("UI preview only. No transactions or server-side changes are submitted.");
  return requestApi<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
