/**
 * Runs the production read handler (`src/aws/read-handler.ts`) once, from the
 * shell, against a recorded model output. It drives `eval_golden.py`.
 *
 *   echo '{"rule_text": "...", "headline": "..."}' | npx tsx experiments/aws-digest-slice/cli.ts
 *
 * Everything around the handler is local and free: the rule comes from stdin
 * instead of Supabase, the raw store is in memory, the write is captured
 * instead of sent, and the model is a replay of `recorded-outputs.json`
 * (stored `deepseek-v4-flash` prompt `v4` readings, keyed by rule sha256).
 * This entry point never calls a paid model and never touches a database.
 *
 * The response goes to stdout as JSON; the handler's log line goes to stderr.
 */
import { readFileSync } from 'node:fs';

import { hashDescription } from '../../src/digest/digest.js';
import type { DigestRows } from '../../src/digest/rows.js';
import type { CompletionResult } from '../../src/llm/client.js';
import { createReadHandler } from '../../src/aws/read-handler.js';
import { InMemoryRecordStore } from '../../src/aws/record-store.js';

interface Recording {
  source: string;
  output: unknown;
}

const recordings = JSON.parse(
  readFileSync(new URL('recorded-outputs.json', import.meta.url), 'utf8'),
) as Record<string, Recording>;

const event = JSON.parse(readFileSync(0, 'utf8')) as { rule_text?: unknown; headline?: unknown };
if (typeof event.rule_text !== 'string' || typeof event.headline !== 'string') {
  console.error('input must be {"rule_text": string, "headline": string}');
  process.exit(2);
}
const ruleText = event.rule_text;
const headline = event.headline;
const sha256 = hashDescription(ruleText);

const written: DigestRows[] = [];
const handler = createReadHandler({
  checkReading: () =>
    Promise.resolve({
      status: 'todo',
      market: {
        eventId: 'eval',
        polymarketId: 'eval',
        tema: null,
        liquidez: null,
        status: null,
        input: {
          question: headline,
          description: ruleText,
          slug: null,
          endDate: null,
          outcomes: null,
        },
      },
    }),
  store: new InMemoryRecordStore(),
  clientForRoute: () => ({
    complete(): Promise<CompletionResult> {
      const recording = recordings[sha256];
      if (recording === undefined) {
        return Promise.reject(new Error(`no recorded output for rule ${sha256}`));
      }
      return Promise.resolve({
        text: JSON.stringify(recording.output),
        stop: 'ok',
        // Replay spends nothing.
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    },
  }),
  persist: (rows) => {
    written.push(rows);
    return Promise.resolve('inserted');
  },
  monthlyCapUsd: 3,
  log: (line) => console.error(line),
});

const result = await handler({
  event_id: 'eval',
  sha256,
  run_started_at: new Date().toISOString(),
  model: 'deepseek-v4-flash',
  prompt_version: 'v4',
  timeout_ms: 30_000,
});

const findings = (written[0]?.pegadinhas ?? []).map((p) => ({
  severidade: p['severidade'] ?? null,
  trecho: p['trecho'] ?? null,
  texto: p['texto'],
}));

console.log(
  JSON.stringify({ reason: result.reason, sha256, findings, pruned: result.pruned ?? 0 }),
);
