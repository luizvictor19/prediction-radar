import { DEFAULT_MODEL_ROUTES, parseRoutes } from '../llm/registry.js';

/**
 * The Lambda's non-secret settings, read from its environment (issue 93).
 *
 * Terraform sets these variables (PR 3). Secrets are NOT here: they come from
 * SSM at cold start (`secrets.ts`). A missing or malformed value throws at
 * cold start, before any read or paid call, instead of running with a guess.
 */
export interface Settings {
  /** `/radar/dev` or `/radar/prod`: where `secrets.ts` reads the keys. */
  ssmPrefix: string;
  table: string;
  monthlyCapUsd: number;
  maxItems: number;
  routes: Readonly<Record<string, string>>;
}

/** US$ 3.00 of model spend per month: the cap approved in the plan on issue 86. */
const DEFAULT_MONTHLY_CAP_USD = 3;
const DEFAULT_MAX_ITEMS = 100;

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`variável ${name} ausente no ambiente da Lambda`);
  }
  return value;
}

function positiveNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`variável ${name} inválida: esperado número positivo`);
  }
  return value;
}

/** A whole number of 1 or more: a fraction would round down to a run of 0 items. */
function positiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = positiveNumber(env, name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`variável ${name} inválida: esperado inteiro positivo`);
  }
  return value;
}

export function readSettings(env: Record<string, string | undefined>): Settings {
  const routesJson = env['RADAR_MODEL_ROUTES'];
  return {
    ssmPrefix: required(env, 'RADAR_SSM_PREFIX'),
    table: required(env, 'RADAR_TABLE'),
    monthlyCapUsd: positiveNumber(env, 'RADAR_MONTHLY_MODEL_BUDGET_USD', DEFAULT_MONTHLY_CAP_USD),
    maxItems: positiveInteger(env, 'RADAR_MAX_ITEMS', DEFAULT_MAX_ITEMS),
    routes:
      routesJson === undefined || routesJson.trim().length === 0
        ? DEFAULT_MODEL_ROUTES
        : parseRoutes(routesJson),
  };
}
