import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Standalone Vitest + React Testing Library setup for component/unit tests.
// Deliberately separate from Next's own SWC/webpack build (this only needs
// to compile TSX and resolve the same path aliases tsconfig.json declares,
// not run the App Router itself) — see tests/README.md for what this covers
// and how it differs from the backend's Jest suite.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    css: false,
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next'],
  },
  resolve: {
    alias: {
      '@': path.resolve(dirname, '.'),
      '@features': path.resolve(dirname, 'features'),
      '@shared': path.resolve(dirname, 'shared'),
      '@state': path.resolve(dirname, 'state'),
      '@providers': path.resolve(dirname, 'providers'),
      '@app': path.resolve(dirname, 'app'),
    },
  },
});
