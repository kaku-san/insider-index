import { unavailableVaultResponse } from "../../../../lib/index-vaults/release.ts";

/** Legacy fake receipt/per-leg index execution has been retired. No signed payload is consumed. */
export async function POST() { return unavailableVaultResponse(); }
