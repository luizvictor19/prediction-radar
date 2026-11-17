/**
 * Bundles the two Lambda entries of the scheduled digestion (issue 93).
 *
 *   npm run build:lambda
 *
 * One ESM file per entry, for Node 24, with every dependency inside: the
 * function does not rely on the SDK version the runtime happens to ship. The
 * output is `build/<entrada>/index.mjs` and `build/<entrada>.zip`, the zip
 * that Terraform uploads (PR 3). `build/` is not versioned.
 *
 * The Railway process still has no build step: this bundles only `src/aws/`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { build } from 'esbuild';

const ENTRADAS = {
  plan: 'src/aws/entry-plan.ts',
  read: 'src/aws/entry-read.ts',
} as const;

const SAIDA = 'build';

rmSync(SAIDA, { recursive: true, force: true });

for (const [nome, entrada] of Object.entries(ENTRADAS)) {
  const pasta = join(SAIDA, nome);
  mkdirSync(pasta, { recursive: true });
  await build({
    entryPoints: [entrada],
    outfile: join(pasta, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    // Some bundled dependencies are CommonJS and call `require`; ESM output
    // has no `require` unless one is created.
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
  // `-X` drops extra file attributes and `-j` stores the file without its
  // folder, so the zip holds `index.mjs` at its root, where Lambda looks.
  execFileSync('zip', ['-q', '-X', '-j', join(SAIDA, `${nome}.zip`), join(pasta, 'index.mjs')]);
  const kb = Math.round(statSync(join(SAIDA, `${nome}.zip`)).size / 1024);
  console.log(`${nome}: ${join(SAIDA, `${nome}.zip`)} (${kb} KB)`);
}
