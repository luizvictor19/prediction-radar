/**
 * A model client that replays recorded outputs instead of calling a model.
 *
 * It is the default in this slice, so running the eval costs nothing and gives
 * the same numbers every time. The trade-off is explicit: replay measures the
 * model and prompt that produced the recordings, not today's model. A new model
 * or prompt version needs new recordings.
 *
 * The recordings are keyed by the rule's sha256. A live client would ignore the
 * key; the handler asks for a client per rule so the replay can find its entry.
 */
import type { CompletionResult, LlmClient } from '../../src/llm/client.js';

export interface Recording {
  source: string;
  output: unknown;
}

export type Recordings = Record<string, Recording>;

export class MissingRecording extends Error {
  constructor(sha256: string) {
    super(`no recorded output for rule ${sha256}`);
    this.name = 'MissingRecording';
  }
}

export function replayClientFor(recordings: Recordings): (sha256: string) => LlmClient {
  return (sha256) => ({
    complete(): Promise<CompletionResult> {
      const recording = recordings[sha256];
      if (recording === undefined) return Promise.reject(new MissingRecording(sha256));
      return Promise.resolve({
        text: JSON.stringify(recording.output),
        stop: 'ok',
        // Replay spends nothing. The recorded token counts live in the
        // production table, not here.
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    },
  });
}
