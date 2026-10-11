/** @type {import('next').NextConfig} */

// NOTE: Content-Security-Policy is set per-request in middleware.ts with a fresh
// nonce so we can drop 'unsafe-inline' from script-src (F4). The static headers
// below apply to every route.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  // Keep the portal out of search indexes.
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // pdfjs-dist is loaded by /api/paylater/extract to read customer report PDFs.
  // Left OUT of the server bundle on purpose: bundling it rewrites the paths it
  // uses to locate its own worker, and the route then fails at runtime with
  // "Setting up fake worker failed: Cannot find module .../pdf.worker.mjs".
  // Kept external, Node resolves it from node_modules and it works as shipped.
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist'],
  },
  // The portal was called PayLater and lived at /paylater. It is Collections
  // now, at /collections. Anything already sent out — a bookmark, a link in an
  // email, a sign-in redirect from an older deploy — must keep working, so the
  // old path forwards permanently rather than 404ing.
  //
  // The API keeps its /api/paylater paths, and the tables keep their
  // paylater_* names: those are addresses the product never showed anyone, and
  // renaming stored things is how access quietly breaks (see the note on
  // permanent keys in lib/platform/capabilities.ts).
  async redirects() {
    return [
      { source: '/paylater', destination: '/collections', permanent: true },
      {
        source: '/paylater/:path*',
        destination: '/collections/:path*',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

module.exports = nextConfig;
