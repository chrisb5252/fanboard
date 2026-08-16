/** @type {import('next').NextConfig} */

/*
 * The backend origin. Only ever read on the server, so it is not NEXT_PUBLIC_:
 * the browser must never call the backend directly. See the rewrite below.
 */
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? 'http://localhost:3000';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /*
   * Proxies /api to the backend so the browser sees ONE origin.
   *
   * This is load-bearing, not a convenience. The player's session cookie is
   * httpOnly and SameSite=Lax, which means the browser will not attach it to a
   * cross-site request. If this app called a Railway backend directly from the
   * browser, every authenticated call — placing a pick, listing your picks —
   * would arrive with no cookie and 401, while the public reads carried on
   * working. The failure would look like "picks are broken" rather than "auth
   * is misconfigured".
   *
   * Rewriting keeps the request same-origin from the browser's point of view;
   * Next forwards it server-side, where SameSite does not apply. It also
   * removes the need for CORS entirely, which matters because the backend's
   * allowlist fails closed in production.
   */
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${BACKEND_ORIGIN}/api/:path*` }];
  },
};

module.exports = nextConfig;
