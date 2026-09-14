import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker/Barely Stable uses standalone. Vercel supplies its own output tracing.
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  serverExternalPackages: ["@solana/kit", "@privy-io/react-auth"],
};

export default nextConfig;
