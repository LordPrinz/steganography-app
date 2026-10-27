import type { NextConfig } from "next";

const apiUrl = process.env.API_URL ?? "http://localhost:4000";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@stego/contracts"],
  // Stego images must reach the browser byte-for-byte; Next's optimizer would re-encode them.
  images: { unoptimized: true },
  // Same-origin API: no CORS, and auth cookies just work.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
};

export default config;
