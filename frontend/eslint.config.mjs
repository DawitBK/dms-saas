// Frontend ESLint (flat config, ESLint 9) — Next.js core-web-vitals rules,
// the `next lint` default. Gated in CI alongside the backend lint.
//
// eslint-config-next 16 ships NATIVE flat configs, so the `FlatCompat` shim
// this file used on v15 is gone. It was not merely redundant: loading a v16
// config through eslintrc compat throws "Converting circular structure to
// JSON" before a single file is linted.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const eslintConfig = [
  {
    ignores: ['.next/**', '.next-mirror/**', '.next-release-*/**', 'node_modules/**', 'next-env.d.ts'],
  },
  ...nextCoreWebVitals,
  {
    // Scoped to the glob eslint-config-next registers its plugins under. In
    // flat config a plugin namespace is only visible to config objects that
    // match the SAME file, and next's object declares
    // `files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}']` — note no .cjs. An
    // unscoped block naming a jsx-a11y rule fails outright on the .cjs files
    // in scripts/ with "could not find plugin".
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    rules: {
      // A clickable <div> with no keyboard path recurred three times across
      // this platform's frontends (SSO's mobile-nav backdrop, GMS's guest
      // rows, DMS's hierarchy browser) before being caught — catch it in
      // review instead of a fourth time. These were `warn` while 75 pre-
      // existing violations stood; they were all fixed on 2026-09-06, so the
      // rules are errors now and the next one fails the build.
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
    },
  },
  {
    // Node-side CommonJS: the standalone launcher and PostCSS/Tailwind config.
    // These run under Node before any bundler exists, so `require()` and an
    // anonymous default export are the correct forms, not lint debt.
    files: ['**/*.cjs', 'postcss.config.js', 'tailwind.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'import/no-anonymous-default-export': 'off',
    },
  },
];

export default eslintConfig;
