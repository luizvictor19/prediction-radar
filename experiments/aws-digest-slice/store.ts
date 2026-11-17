/**
 * The record a digest reading leaves behind, in DynamoDB single-table shape.
 *
 * One partition per rule text (`RULE#<sha256>`), one item per reading
 * (`READING#<iso timestamp>`). The rule hash is the identity because the same
 * rule text is shared by many markets (ADR 0006): reading it once serves all of
 * them, and "every reading of this rule" is a single Query on the partition.
 *
 * There is no AWS SDK here on purpose. The interface has the PutItem/GetItem
 * shape, so a real implementation is a thin adapter over `@aws-sdk/lib-dynamodb`,
 * and the slice runs with no account and no dependency.
 */

export interface DigestFinding {
  severidade: string | null;
  trecho: string | null;
  texto: string;
}

export interface DigestRecord {
  PK: string;
  SK: string;
  model: string;
  prompt_version: string;
  headline: string;
  findings: DigestFinding[];
  pruned: number;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number | null;
}

export function partitionKey(sha256: string): string {
  return `RULE#${sha256}`;
}

export function sortKey(at: Date): string {
  return `READING#${at.toISOString()}`;
}

export interface RecordStore {
  /**
   * Writes one reading. Refuses to overwrite an existing key, the equivalent
   * of `ConditionExpression: attribute_not_exists(SK)`: a retried invocation
   * must not silently replace the reading it already wrote.
   */
  put(record: DigestRecord): Promise<void>;
  get(pk: string, sk: string): Promise<DigestRecord | null>;
}

export class ConditionalCheckFailed extends Error {
  constructor(pk: string, sk: string) {
    super(`item already exists: ${pk} / ${sk}`);
    this.name = 'ConditionalCheckFailed';
  }
}

export class InMemoryStore implements RecordStore {
  private readonly items = new Map<string, DigestRecord>();

  put(record: DigestRecord): Promise<void> {
    const key = `${record.PK}|${record.SK}`;
    if (this.items.has(key)) {
      return Promise.reject(new ConditionalCheckFailed(record.PK, record.SK));
    }
    this.items.set(key, structuredClone(record));
    return Promise.resolve();
  }

  get(pk: string, sk: string): Promise<DigestRecord | null> {
    const found = this.items.get(`${pk}|${sk}`);
    return Promise.resolve(found === undefined ? null : structuredClone(found));
  }

  size(): number {
    return this.items.size;
  }
}
