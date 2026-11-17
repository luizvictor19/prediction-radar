import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import type { CompletionStop } from '../llm/client.js';

/**
 * Where the scheduled digestion keeps what each model call returned, and how
 * much the month has spent (issue 93, PR 2 of issue 86).
 *
 * One DynamoDB table, two kinds of item:
 *
 * - **Raw reading:** `PK=RULE#<sha256>`, `SK=READING#<run started at>#<event_id>`.
 *   The raw text, the stop reason, the four token counts and the cost of one
 *   call, valid or not. The sort key is built only from the Step Functions
 *   input, so a retried task computes the same key: the conditional put refuses
 *   the second write, and the handler replays the stored output instead of
 *   paying for a new one. Raw items never expire: they are the eval's input.
 * - **Spend counter:** `PK=SPEND#<yyyy-mm>`, `SK=TOTAL`, one per UTC month,
 *   incremented after every paid call. The monthly cap is checked against it
 *   before every paid call.
 *
 * The interface is the seam: the DynamoDB adapter below is what the Lambda
 * uses, and the in-memory one is what the tests and the local eval use.
 */

export interface ReadingKey {
  PK: string;
  SK: string;
}

export interface RawReading extends ReadingKey {
  event_id: string;
  sha256: string;
  /** The canonical name, the one `market_rule_digests.model` stores. */
  model: string;
  /** `provider:model-id`, as the route resolved it for this call. */
  route: string;
  prompt_version: string;
  /** `null` when the provider returned no text: refusal or truncation. */
  raw_text: string | null;
  stop: CompletionStop;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost_usd: number | null;
  latency_ms: number;
  recorded_at: string;
}

export function readingKey(sha256: string, runStartedAt: string, eventId: string): ReadingKey {
  return { PK: `RULE#${sha256}`, SK: `READING#${runStartedAt}#${eventId}` };
}

/** The UTC month of an instant, `yyyy-mm`: the spend counter's period. */
export function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

export function spendKey(month: string): ReadingKey {
  return { PK: `SPEND#${month}`, SK: 'TOTAL' };
}

export interface RecordStore {
  getReading(key: ReadingKey): Promise<RawReading | null>;
  /**
   * Writes one raw reading and refuses to overwrite an existing key
   * (`attribute_not_exists(PK)`): a retried invocation must never replace the
   * output it already paid for. Throws `ConditionalCheckFailed` when the key
   * exists.
   */
  putReading(reading: RawReading): Promise<void>;
  /** Model spend of the month in US$, 0 when nothing was spent yet. */
  readSpend(month: string): Promise<number>;
  addSpend(month: string, usd: number): Promise<void>;
}

export class ConditionalCheckFailed extends Error {
  constructor(key: ReadingKey) {
    super(`o item já existe: ${key.PK} / ${key.SK}`);
    this.name = 'ConditionalCheckFailed';
  }
}

export class InMemoryRecordStore implements RecordStore {
  private readonly readings = new Map<string, RawReading>();
  private readonly spend = new Map<string, number>();

  getReading(key: ReadingKey): Promise<RawReading | null> {
    const found = this.readings.get(`${key.PK}|${key.SK}`);
    return Promise.resolve(found === undefined ? null : structuredClone(found));
  }

  putReading(reading: RawReading): Promise<void> {
    const id = `${reading.PK}|${reading.SK}`;
    if (this.readings.has(id)) return Promise.reject(new ConditionalCheckFailed(reading));
    this.readings.set(id, structuredClone(reading));
    return Promise.resolve();
  }

  readSpend(month: string): Promise<number> {
    return Promise.resolve(this.spend.get(month) ?? 0);
  }

  addSpend(month: string, usd: number): Promise<void> {
    this.spend.set(month, (this.spend.get(month) ?? 0) + usd);
    return Promise.resolve();
  }

  readingCount(): number {
    return this.readings.size;
  }
}

/**
 * The one method of the DynamoDB document client this adapter uses.
 *
 * Typed by hand because the SDK's `send` is overloaded per command type; the
 * wiring passes `(command) => client.send(command)` and a test passes a fake
 * that records the commands it receives.
 */
export interface DocumentSender {
  send(command: GetCommand | PutCommand | UpdateCommand): Promise<unknown>;
}

function isConditionalFailure(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}

export class DynamoRecordStore implements RecordStore {
  constructor(
    private readonly client: DocumentSender,
    private readonly table: string,
  ) {}

  async getReading(key: ReadingKey): Promise<RawReading | null> {
    const out = (await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: key.PK, SK: key.SK },
        ConsistentRead: true,
      }),
    )) as { Item?: RawReading };
    return out.Item ?? null;
  }

  async putReading(reading: RawReading): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: reading,
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (err) {
      if (isConditionalFailure(err)) throw new ConditionalCheckFailed(reading);
      throw err;
    }
  }

  async readSpend(month: string): Promise<number> {
    const out = (await this.client.send(
      new GetCommand({ TableName: this.table, Key: spendKey(month), ConsistentRead: true }),
    )) as { Item?: { spend_usd?: unknown } };
    const value = out.Item?.spend_usd;
    return typeof value === 'number' ? value : 0;
  }

  async addSpend(month: string, usd: number): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: spendKey(month),
        UpdateExpression: 'ADD spend_usd :usd',
        ExpressionAttributeValues: { ':usd': usd },
      }),
    );
  }
}
