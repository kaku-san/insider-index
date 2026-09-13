import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@solana/kit", "@privy-io/react-auth"],
};

export default nextConfig;
