"use client";

import { Icon } from "@/components/social/icon";
import { usePrivySolana } from "@/components/providers/privy-provider";
import { PREVIEW_MODE } from "@/lib/frontend/api";
import { ELIGIBILITY_BANNER } from "@/lib/compliance";

export function EligibilityBanner() {
  const wallet = usePrivySolana();
  const tag = PREVIEW_MODE
    ? "UI preview · synthetic data"
    : wallet.mode === "live"
      ? "User-signed"
      : wallet.mode === "stub" ? "Local preview wallet" : "Wallet unavailable";

  return (
    <div className="eligibility-banner">
      <Icon name="shield" size={13} />
      <p>
        {ELIGIBILITY_BANNER}
        <span className="eligibility-extra">
          {" "}
          Every trade needs your signature. Public filings are delayed.
        </span>
      </p>
      <span className="preview-tag">{tag}</span>
    </div>
  );
}
