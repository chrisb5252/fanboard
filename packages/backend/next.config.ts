import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // pg and redis open raw sockets — keep them out of any bundling attempt so
  // they are require()'d from node_modules at runtime.
  serverExternalPackages: ['pg', 'redis'],
};

export default nextConfig;
