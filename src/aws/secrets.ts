import { GetParameterCommand } from '@aws-sdk/client-ssm';

import type { Provider } from '../llm/registry.js';

/**
 * Reads the Lambda's secrets from SSM Parameter Store into the process
 * environment (issue 93).
 *
 * The keys are SecureString parameters created by the owner with the CLI, so
 * the values never enter Terraform state, a Lambda environment variable or a
 * log line. This module logs parameter NAMES only, and an SSM error is rethrown
 * with the parameter name and the error class, never the SDK's message, so a
 * value echoed back by a proxy cannot reach a log through it.
 *
 * The environment is the hand-off because the existing clients read it:
 * `src/lib/supabase.ts` at import (which is why the entry files load the
 * Supabase pair BEFORE importing anything that imports it), and the Anthropic
 * and DeepSeek clients at their first call.
 *
 * The model key is loaded per provider, and only for the provider the route
 * resolved: the DeepSeek key is never read while the route is Anthropic.
 */

/** The one method of the SSM client this module uses. */
export interface ParameterSender {
  send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string } }>;
}

export interface SecretLoader {
  loadSupabase(): Promise<void>;
  loadModelKey(provider: Provider): Promise<void>;
}

const MODEL_KEYS: Record<Provider, { parameter: string; env: string }> = {
  anthropic: { parameter: 'anthropic-api-key', env: 'ANTHROPIC_API_KEY' },
  deepseek: { parameter: 'deepseek-api-key', env: 'DEEPSEEK_API_KEY' },
};

export function createSecretLoader(
  ssm: ParameterSender,
  /** `/radar/dev` or `/radar/prod`. */
  prefix: string,
  options: {
    env?: Record<string, string | undefined>;
    log?: (line: string) => void;
  } = {},
): SecretLoader {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const loaded = new Set<string>();

  async function read(name: string): Promise<string> {
    let value: string | undefined;
    try {
      const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      value = out.Parameter?.Value;
    } catch (err) {
      const kind = err instanceof Error ? err.name : 'Error';
      throw new Error(`leitura do parâmetro ${name} falhou (${kind})`);
    }
    if (value === undefined || value.length === 0) {
      throw new Error(`parâmetro ${name} ausente ou vazio`);
    }
    return value;
  }

  async function load(parameter: string, envName: string): Promise<void> {
    if (loaded.has(envName)) return;
    const name = `${prefix}/${parameter}`;
    env[envName] = await read(name);
    loaded.add(envName);
    log(JSON.stringify({ component: 'aws_secrets', loaded: name }));
  }

  return {
    async loadSupabase() {
      await load('supabase-url', 'SUPABASE_URL');
      await load('supabase-service-key', 'SUPABASE_SERVICE_KEY');
    },
    async loadModelKey(provider) {
      const key = MODEL_KEYS[provider];
      await load(key.parameter, key.env);
    },
  };
}
