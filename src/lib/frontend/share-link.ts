export type ShareResult = "shared" | "copied" | "manual" | "cancelled";

type ShareData = { title: string; text?: string; url: string };
type ShareBridge = {
  share?: (data: ShareData) => Promise<void>;
  copy: (value: string) => Promise<void>;
};

/** Browser capability wrapper with explicit outcomes so UI never claims a share or copy that failed. */
export async function shareLink(bridge: ShareBridge, data: ShareData): Promise<ShareResult> {
  if (bridge.share) {
    try {
      await bridge.share(data);
      return "shared";
    } catch (error) {
      if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") return "cancelled";
    }
  }
  try {
    await bridge.copy(data.url);
    return "copied";
  } catch {
    return "manual";
  }
}
