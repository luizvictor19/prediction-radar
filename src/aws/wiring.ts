import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { hashDescription } from '../digest/digest.js';
import { recordDigest } from '../digest/persist.js';
import {
  digestExists,
  readDigestConfig,
  readDigested,
  readMarketToDigest,
  readMarketsToDigest,
} from '../digest/store.js';
import { supabase } from '../lib/supabase.js';
import { routedClient } from '../llm/registry.js';
import { createPlanHandler, type PlanInput, type PlanResult } from './plan-handler.js';
import { createReadHandler, type ReadInput, type ReadResult } from './read-handler.js';
import { DynamoRecordStore } from './record-store.js';
import type { SecretLoader } from './secrets.js';
import type { Settings } from './settings.js';

/**
 * The production wiring of the two handlers.
 *
 * Imported dynamically by the entry files, AFTER the Supabase pair is in the
 * environment: `../lib/supabase.js` throws at import when it is missing, and
 * everything here that touches the database goes through it. No test imports
 * this module; the handlers are tested through their injected dependencies.
 */

function recordStore(settings: Settings): DynamoRecordStore {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return new DynamoRecordStore(
    { send: (command) => client.send(command as never) },
    settings.table,
  );
}

export function buildPlanHandler(settings: Settings): (input: PlanInput) => Promise<PlanResult> {
  const store = recordStore(settings);
  return createPlanHandler({
    readConfig: readDigestConfig,
    readSpend: (month) => store.readSpend(month),
    readMarkets: readMarketsToDigest,
    readDigested,
    monthlyCapUsd: settings.monthlyCapUsd,
    maxItems: settings.maxItems,
    routes: settings.routes,
  });
}

export function buildReadHandler(
  settings: Settings,
  secrets: SecretLoader,
): (input: ReadInput) => Promise<ReadResult> {
  return createReadHandler({
    async checkReading(key) {
      if (await digestExists(key)) return { status: 'done' };
      const market = await readMarketToDigest(key.eventId);
      if (market === null || hashDescription(market.input.description) !== key.sha256) {
        return { status: 'stale' };
      }
      return { status: 'todo', market };
    },
    store: recordStore(settings),
    // The model key is read from SSM only when a call is about to happen, and
    // only for the provider of the resolved route.
    clientForRoute: (route) => ({
      async complete(request) {
        await secrets.loadModelKey(route.provider);
        return routedClient(route).complete(request);
      },
    }),
    persist: (rows) => recordDigest(supabase, rows),
    monthlyCapUsd: settings.monthlyCapUsd,
    routes: settings.routes,
  });
}
