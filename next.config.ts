import type { NextConfig } from "next";

/**
 * Two settings here are load-bearing for the reverse-proxy contract, not preferences:
 *
 * - `skipTrailingSlashRedirect`: Next's built-in trailing-slash redirect emits an ABSOLUTE
 *   Location against the request host — which is our edge hostname, not the customer's
 *   domain. That leaks `*.blogedge` into a redirect and breaks the "no rendered byte
 *   contains our edge hostname" rule. We normalise trailing slashes ourselves in
 *   middleware with a root-relative Location instead.
 *
 * - `assetPrefix`: the customer's rewrite only covers their content prefix, so
 *   `/_next/static/*` would resolve against THEIR origin and 404. Assets are served
 *   absolutely from our own CDN. Article pages additionally inline their CSS and ship
 *   zero client JS, so a blocked CDN degrades nothing that matters.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  assetPrefix: process.env.NEXT_PUBLIC_ASSET_PREFIX || undefined,
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
