import type { NextConfig } from "next";

const config: NextConfig = {
  // Stream responses from API routes where possible
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb", // .skill uploads can be a few MB
    },
  },
  // Cloudflare Access header forwarding for admin routes (future)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
