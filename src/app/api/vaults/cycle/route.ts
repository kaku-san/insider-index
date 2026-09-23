export const runtime = "nodejs";

/** Retired: the Symmetry cycle is no longer a public rail. Invest/cash-out use the NAV vault. */
export async function POST() {
  return Response.json({ error: "This rail is retired. Invest and cash out use the NAV vault." }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
