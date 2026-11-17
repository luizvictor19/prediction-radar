/**
 * Runs the handler once, the way a Lambda invocation would, from the shell.
 *
 *   echo '{"rule_text": "...", "headline": "..."}' | npx tsx experiments/aws-digest-slice/cli.ts
 *
 * The response goes to stdout as JSON; the structured log line goes to stderr.
 * The model is always the replay client: this entry point never calls a paid
 * model.
 */
import { readFileSync } from 'node:fs';
import { createHandler, type DigestEvent } from './handler.js';
import { replayClientFor, type Recordings } from './replay-client.js';
import { InMemoryStore } from './store.js';

const recordings = JSON.parse(
  readFileSync(new URL('recorded-outputs.json', import.meta.url), 'utf8'),
) as Recordings;

const event = JSON.parse(readFileSync(0, 'utf8')) as DigestEvent;
if (typeof event.rule_text !== 'string' || typeof event.headline !== 'string') {
  console.error('input must be {"rule_text": string, "headline": string}');
  process.exit(2);
}

const handler = createHandler({
  clientFor: replayClientFor(recordings),
  store: new InMemoryStore(),
  timeoutMs: 30_000,
});

console.log(JSON.stringify(await handler(event)));
