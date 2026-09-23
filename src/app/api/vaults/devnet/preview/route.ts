export const runtime = "nodejs";

/** Retired: the Symmetry devnet test rail is no longer publicly reachable. */
export async function POST() {
  return Response.json({ error: "This rail is retired. Invest and cash out use the NAV vault." }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
