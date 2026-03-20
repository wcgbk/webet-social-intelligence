import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/claudeconvo",
  assetPrefix: "/claudeconvo",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
