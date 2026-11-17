import type { CompletionResult, LlmClient } from '../llm/client.js';

/**
 * An `LlmClient` decorator that keeps what the provider returned.
 *
 * It sits between `runDigest` and the provider, so it sees the completion
 * BEFORE validation: an output the guard rejects is captured the same way as a
 * valid one, and it was billed the same way. `src/digest/digest.ts` stays
 * untouched (decision in the plan on issue 86).
 *
 * A call that throws (network, deadline, 429) leaves nothing: there is no
 * completion to keep.
 */
export interface CapturedCall {
  completion: CompletionResult;
  latencyMs: number;
}

export interface Capture {
  client: LlmClient;
  /** Every completion that came back, in call order. */
  calls(): readonly CapturedCall[];
}

export function captureCalls(inner: LlmClient, clock: () => number = Date.now): Capture {
  const calls: CapturedCall[] = [];
  return {
    client: {
      async complete(request) {
        const startedAt = clock();
        const completion = await inner.complete(request);
        calls.push({ completion, latencyMs: clock() - startedAt });
        return completion;
      },
    },
    calls: () => calls,
  };
}
