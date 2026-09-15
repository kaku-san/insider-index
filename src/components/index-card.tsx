import type { PersonIndex } from "@/lib/disclosures/types";
import { isCrowdIndex } from "@/lib/fomo/index-readiness";

export function indexKindLabel(index: PersonIndex): string {
  const crowd = isCrowdIndex(index);
  return index.kind === "politician" ? crowd ? "Members of Congress" : "Congress" : crowd ? "Company executives" : "Executive";
}
