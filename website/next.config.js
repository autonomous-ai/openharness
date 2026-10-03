module.exports = {
  // Self-contained build (.next/standalone: server.js + pruned node_modules) for a lean
  // production container — the runtime image copies this instead of installing deps.
  output: 'standalone',
  // The shell-script routes read their scripts from disk instead of importing them, so nothing traces
  // those files automatically — list them explicitly or a standalone build serves a 500. The KEY is
  // the route path: rename a route and this entry must move with it.
  outputFileTracingIncludes: {
    // '/cli/install.sh' and '/desktop/install.sh' moved to the CDN (see redirects() below) — nothing
    // left here to trace for either.
    '/flash-circle.sh': ['./src/app/flash-circle.sh/flash-circle.sh'],
  },
  turbopack: {},
  // Local dev is reached through the local-harness.autonomous.ai hostname (proxied to :3000) — allow it
  // to load /_next/* dev assets cross-origin (Next warns now, will hard-block in a future major).
  allowedDevOrigins: ['local-harness.autonomous.ai', 'local-ac.autonomous.ai', 'localhost', '127.0.0.1'],
  // Domain migration: every legacy web host 308-redirects to the current canonical one, preserving
  // the path. `ac` was the original name and `fleet` the intermediate one — both now land on
  // `harness`. Only WEB domains are redirected — the legacy API hosts stay functional for field
  // devices/adapters that still hardcode them until they OTA/self-update.
  async redirects() {
    return [
      ...['ac.autonomous.ai', 'fleet.autonomous.ai'].map((host) => ({
        source: '/:path*',
        has: [{ type: 'host', value: host }],
        destination: 'https://harness.autonomous.ai/:path*',
        permanent: true,
      })),
      { source: '/install', destination: '/download', permanent: true },
      // The public CLI command uses this short URL; the script stays on the CDN.
      { source: '/install.sh', destination: 'https://cdn.autonomous.ai/harness/cli/install.sh', permanent: true },
      // Both installer scripts moved to the CDN-fronted public bucket (make upload-cli-install-sh /
      // make upload-desktop-install-sh in the repo root) — these keep `curl -fsSL
      // https://harness.autonomous.ai/{cli,desktop}/install.sh | bash` working for anyone with the old
      // URL (`-fsSL` already follows redirects).
      { source: '/cli/install.sh', destination: 'https://cdn.autonomous.ai/harness/cli/install.sh', permanent: true },
      { source: '/desktop/install.sh', destination: 'https://cdn.autonomous.ai/harness/desktop/install.sh', permanent: true },
    ]
  },
  // Image optimization for mobile
  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080, 1200],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 60,
  },
  // Compression
  compress: true,
  // Performance optimizations
  poweredByHeader: false,
  // Everything user-facing is the Flutter app; this host only adds the routes below (install and
  // download pages, download and installer redirects). Flutter's base
  // href places its assets under /harness-web/ without changing the visible URL.
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/', destination: '/harness-web/index.html' },
        { source: '/s/:id', destination: '/harness-web/index.html' },
        { source: '/auth/callback', destination: '/harness-web/index.html' },
        // Local website previews use the SSO service's native loopback callback.
        { source: '/callback', destination: '/harness-web/index.html' },
        { source: '/harness-web', destination: '/harness-web/index.html' },
      ],
    }
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'origin' },
        ],
      },
      {
        source: '/harness-web/:path*',
        headers: [
          // Legacy paths stay available for existing tabs. New entries use the
          // archive-specific namespace below, since edge caches can lengthen
          // this revalidation policy.
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
      {
        source: '/harness-web/releases/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      ...['/', '/s/:id', '/auth/callback', '/callback', '/harness-web', '/harness-web/index.html', '/harness-web/release.json'].map((source) => ({
        source,
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      })),
    ]
  },
}
