import { ShieldAlert } from "lucide-react";
import { ELIGIBILITY_BANNER } from "@/lib/compliance";

export function EligibilityBanner() {
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10">
      <div className="mx-auto flex max-w-6xl items-start gap-3 px-4 py-3 text-sm text-amber-100 sm:items-center">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-400 sm:mt-0" />
        <p>{ELIGIBILITY_BANNER}</p>
      </div>
    </div>
  );
}
