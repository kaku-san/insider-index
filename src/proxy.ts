import { NextResponse, type NextRequest } from "next/server";

/**
 * Scanners often POST junk `Next-Action` headers. Next.js then logs
 * "Server Reference ID did not match the expected format".
 * Reject obviously invalid IDs; leave real action hashes alone.
 */
function isPlausibleServerActionId(value: string): boolean {
  if (value.length < 8 || value.length > 256) return false;
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    return false;
  }
  return /^[\w:$#.-]+$/.test(value);
}

export function proxy(request: NextRequest) {
  const actionId =
    request.headers.get("next-action") ?? request.headers.get("Next-Action");
  if (actionId && !isPlausibleServerActionId(actionId)) {
    return new NextResponse(null, { status: 400 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
