import { SSMClient } from '@aws-sdk/client-ssm';

import type { PlanInput, PlanResult } from './plan-handler.js';
import { createSecretLoader } from './secrets.js';
import { readSettings } from './settings.js';

/**
 * Lambda entry of the plan handler (issue 93).
 *
 * Cold start: settings from the environment, the Supabase pair from SSM, and
 * only then the dynamic import of the wiring, which imports the database
 * client. A failed cold start is not cached, so the next invocation retries it.
 */

let ready: Promise<(input: PlanInput) => Promise<PlanResult>> | null = null;

async function build(): Promise<(input: PlanInput) => Promise<PlanResult>> {
  const settings = readSettings(process.env);
  const secrets = createSecretLoader(new SSMClient({}), settings.ssmPrefix);
  await secrets.loadSupabase();
  const wiring = await import('./wiring.js');
  return wiring.buildPlanHandler(settings);
}

export async function handler(input: PlanInput): Promise<PlanResult> {
  ready ??= build().catch((err: unknown) => {
    ready = null;
    throw err;
  });
  return (await ready)(input ?? {});
}
