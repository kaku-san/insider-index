import { unavailableVaultResponse } from "../../../../lib/index-vaults/release.ts";

/** Native unsigned messages will use adapter-contract.ts after native release gates pass. */
export async function POST() { return unavailableVaultResponse(); }
