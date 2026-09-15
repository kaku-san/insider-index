export const PREVIEW_MODE = process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_STOCKLANA_PREVIEW === "1";
export async function readApi<T>(url: string, signal?: AbortSignal): Promise<T> {
  if (PREVIEW_MODE) {
    const { previewRead } = await import("./preview-data");
    return previewRead(url) as T;
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(response.status === 404 ? "This record is unavailable. Check the original API connection." : `Could not load this view (${response.status}). Please retry.`);
  try { return await response.json() as T; }
  catch { throw new Error("The API did not return JSON. Connect the original Stocklana backend, or enable the labelled UI preview."); }
}
export async function writeApi<T>(url: string, body: unknown): Promise<T> {
  // A preview never signs, submits, or fabricates a successful trade.
  if (PREVIEW_MODE) throw new Error("UI preview only. No transactions or server-side changes are submitted.");
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Request failed. Please retry.");
  return payload as T;
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
