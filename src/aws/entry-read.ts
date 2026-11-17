import { SSMClient } from '@aws-sdk/client-ssm';

import type { ReadInput, ReadResult } from './read-handler.js';
import { createSecretLoader } from './secrets.js';
import { readSettings } from './settings.js';

/**
 * Lambda entry of the read handler (issue 93).
 *
 * Cold start: settings from the environment, the Supabase pair from SSM, and
 * only then the dynamic import of the wiring, which imports the database
 * client. The model key is loaded later, on the first call that needs it. A
 * failed cold start is not cached, so the next invocation retries it.
 */

let ready: Promise<(input: ReadInput) => Promise<ReadResult>> | null = null;

async function build(): Promise<(input: ReadInput) => Promise<ReadResult>> {
  const settings = readSettings(process.env);
  const secrets = createSecretLoader(new SSMClient({}), settings.ssmPrefix);
  await secrets.loadSupabase();
  const wiring = await import('./wiring.js');
  return wiring.buildReadHandler(settings, secrets);
}

export async function handler(input: ReadInput): Promise<ReadResult> {
  ready ??= build().catch((err: unknown) => {
    ready = null;
    throw err;
  });
  return (await ready)(input);
}
