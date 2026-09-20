import type { CyclePolicy } from "./cycle-policy-parse.ts";

/** A public surface for the existing vault, never a replacement or a generic index release. */
export const PUBLIC_MAG7 = {
  indexId: "idx-theme-mag7-caucus",
  vault: "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh",
  shareMint: "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4",
} as const;
export function assertPublicCycleScope(policy: Pick<CyclePolicy, "indexId" | "vault" | "shareMint">): void {
  if (policy.indexId !== PUBLIC_MAG7.indexId || policy.vault !== PUBLIC_MAG7.vault || policy.shareMint !== PUBLIC_MAG7.shareMint) throw new Error("CYCLE_PUBLIC_SCOPE");
}
export interface PublicCycleBinding { operationId: string; owner: string; policyHash: string; }
