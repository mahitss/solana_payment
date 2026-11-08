import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * ESLint flat configuration.
 *
 * Next.js 16 and ESLint 9 use flat config; the legacy `.eslintrc.json` format
 * is no longer supported.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      '@next/next/no-img-element': 'off',
      // Database rows are typed as `any` throughout the data layer. This is a
      // style rule rather than a correctness one, so it stays a warning.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['log', 'warn', 'error'] }],
    },
  },
  {
    // CLI scripts are console-based by nature.
    files: ['scripts/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'graphify-out/**',
    'node_modules/**',
    'types/**',
    // Untracked local smoke-test helper (CommonJS by design, kept out of the
    // repository on purpose).
    '.smoke-auth.cjs',
  ]),
]);

export default eslintConfig;
