import type { NextConfig } from 'next';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = process.env.NEXT_DIST_DIR || '.next';

const nextConfig: NextConfig = {
  // This is deliberately a build-time value: the production portal exposes
  // DMS below https://portal.examplecorp.com/dms while development stays at the
  // root of localhost:7101. Next applies it to links and static assets.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  output: 'standalone',
  distDir: DIST_DIR,
  compress: true,
  poweredByHeader: false,
  reactStrictMode: true,
  devIndicators: false,
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Service-Worker-Allowed', value: '/' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
    ];
  },
  experimental: {
    // optimizeCss removed: it requires the deprecated `critters` package and
    // fails every production build with MODULE_NOT_FOUND at prerender.
    optimizePackageImports: ['lucide-react', '@radix-ui/react-dropdown-menu', '@radix-ui/react-tooltip'],
  },
  // Turbopack is the default bundler for BOTH `next dev` and `next build` as
  // of Next 16, so this is now the only bundler config. The parallel webpack
  // block that used to sit here is gone: its @features/@shared/@state/
  // @providers/@app aliases only restated tsconfig.json's `paths`, which
  // Turbopack reads natively, and its `canvas: false` is expressed below.
  // Keeping it would also have been an outright build error — Next 16 refuses
  // a config with a `webpack` key when Turbopack is driving.
  //
  // react-pdf pulls `canvas`, a native Node module with no browser build.
  // Turbopack's resolveAlias must point at a real module rather than webpack's
  // `false`, hence empty-module.ts.
  turbopack: {
    // Pin the project root. Turbopack otherwise picks one by walking up for
    // the nearest lockfile, and this machine has a stray package-lock.json in
    // the home directory; DMS is an npm workspace, so the root that matters is
    // the one holding node_modules and the lockfile — the repo root, one level
    // above this app, NOT the frontend directory.
    root: path.resolve(PROJECT_DIR, '..'),
    resolveAlias: {
      canvas: './empty-module.ts',
    },
  },
};

export default nextConfig;
