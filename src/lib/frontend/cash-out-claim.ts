/**
 * Observed cash-out request state. A reserved withdrawal is either still converting (the keeper is
 * selling the carved slice) or past its timeout and owner-claimable in kind. Neither state is a
 * finished cash out, so the UI always shows the next step instead of an endless spinner.
 */

const rawAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const CLAIM_IN_KIND_NOTE = "The keeper could not sell this share of the vault within the request timeout. It is reserved for you: claim it in kind to your wallet. That delivers stocks and USDC — not a pure USDC exit.";
export const CONVERTING_NOTE = "The keeper is converting your share of the vault to USDC. If it does not finish within the request timeout, you can claim your share in kind yourself.";
export const CLAIM_IN_KIND_CHECK = "Checking your in-kind claim…";
export const CLAIM_IN_KIND_ACTION = "Claim in kind";
export const CLAIM_ALREADY_FINISHED = "This cash out request is already finished.";

export type CashOutRequestSource = {
  pendingOperations?: { operationId: string; kind: string; phase: string; complete?: boolean; nextAction?: string | null }[] | null;
};

export type CashOutRequestView = {
  /** The on-chain request account: what the claim prepare endpoint needs. */
  requestId: string;
  phase: string;
  /** True once the request is past its timeout and the owner can deliver the slice in kind. */
  claimable: boolean;
  /** The plain next step, read from the observed operation, never invented. */
  nextAction: string;
};

/** The open cash-out request for this position, if any. A claimable request is not a settled one. */
export function cashOutRequestView(position?: CashOutRequestSource | null): CashOutRequestView | null {
  const operation = position?.pendingOperations?.find(item => item.kind === "withdraw" && item.complete !== true);
  if (!operation || !rawAddressPattern.test(operation.operationId)) return null;
  const claimable = operation.phase === "CLAIMABLE_IN_KIND";
  const observed = typeof operation.nextAction === "string" && operation.nextAction.trim() ? operation.nextAction.trim() : null;
  return {
    requestId: operation.operationId,
    phase: operation.phase,
    claimable,
    nextAction: observed ?? (claimable ? CLAIM_IN_KIND_NOTE : CONVERTING_NOTE),
  };
}

/** A claim is prepared against this request for this wallet on this network; changing any of them invalidates it. */
export function claimRequestKey(input: { owner: string; network: string; requestId: string }): string {
  return JSON.stringify([input.owner, input.network, input.requestId]);
}

/** True when this position has a timed-out request the owner must claim in kind themselves. */
export function positionNeedsOwnerClaim(position?: CashOutRequestSource | null): boolean {
  return cashOutRequestView(position)?.claimable === true;
}
