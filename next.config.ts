import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@solana/kit", "@privy-io/react-auth"],
};

export default nextConfig;
