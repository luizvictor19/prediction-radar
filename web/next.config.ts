import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * The repository root. The screen imports three files from `../src/lib`
 * (`prob-self.ts`, `prob-self-outcome.ts`, `polymarket-url.ts`) so that there
 * is never a second parser, and Turbopack does not resolve files outside its
 * root. The same root goes to file tracing, so Vercel ships those files.
 */
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const config: NextConfig = {
  turbopack: { root: raiz },
  outputFileTracingRoot: raiz,

  // The phone reaches the dev server through `adb reverse`, as 127.0.0.1.
  allowedDevOrigins: ['127.0.0.1'],

  // `next dev` would otherwise write its own block into AGENTS.md on start.
  agentRules: false,

  poweredByHeader: false,

  // Nothing of the journal in a search index, pages and API alike.
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }];
  },
};

export default config;
