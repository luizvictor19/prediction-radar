import { hashDescription } from './digest.js';

/**
 * The rule text, recovered and planned — pure, no database.
 *
 * `market_rule_digests` stores `description_sha256` and never the text. The
 * text lives in `events.description`, which is the CURRENT version, overwritten
 * in place whenever Polymarket edits a description. On the day of an edit the
 * digested text stops existing anywhere, and every finding from it becomes a
 * quotation of a document nobody holds.
 *
 * `market_rule_texts` is where the text goes. This module decides WHAT goes in
 * it, and it is separate from the script that writes for the usual reason: the
 * rule that says which text may be stored under which hash is testable without
 * a network, and inside a paginated loop over the database it is not.
 *
 * The one invariant, and everything here serves it: **a text is only ever
 * stored under a hash it actually produces.** A backfill that stored a
 * plausible-looking text under a hash it does not hash to would manufacture
 * exactly the evidence this table exists to preserve.
 */

/** One market that pointed at a text, and the description it holds today. */
export interface TextCandidate {
  eventId: string;
  description: string | null;
}

/**
 * What one candidate turned out to be.
 *
 * `edited` and `no_description` are different losses with different repairs:
 * one means somebody overwrote the rule with another rule, the other means the
 * row carries no text at all. Collapsing them would make the report say less
 * than it knows.
 */
export type RecoveryStep = 'no_description' | 'edited' | 'match';

export interface Recovery {
  /** The trimmed text, or `null` when no candidate still holds it. */
  description: string | null;
  /** One verdict per candidate visited, in order. Ends at the first match. */
  trail: RecoveryStep[];
}

/**
 * The text behind one hash, looked for in every market that shares it.
 *
 * **Every market, not the first.** The corpus is 267 distinct texts for 1033
 * markets (measured 23/08/2026), so most rule texts have siblings — the same
 * regulation published across a family of markets, which is what the inherited
 * findings are built on. A recovery that gave up on the first edited
 * description would report a loss that the second market can still repair.
 *
 * The hash is recomputed from the candidate's own text and compared. It is not
 * an optimisation and it is not a sanity check: it is the only thing standing
 * between "this is the text that was digested" and "this is some text that was
 * near it".
 *
 * `trim` before hashing, because `readMarketsToDigest` trims before handing the
 * text to the model — so the stored hash is the hash of the trimmed text. What
 * is returned is the trimmed text too: the hash names that string, not the one
 * with the newline in front of it.
 */
export function recoverText(
  descriptionSha256: string,
  candidates: readonly TextCandidate[],
): Recovery {
  const trail: RecoveryStep[] = [];

  for (const candidate of candidates) {
    const description = candidate.description?.trim() ?? '';

    if (description.length === 0) {
      trail.push('no_description');
      continue;
    }

    if (hashDescription(description) !== descriptionSha256) {
      trail.push('edited');
      continue;
    }

    trail.push('match');
    return { description, trail };
  }

  return { description: null, trail };
}

/** A digest row, reduced to what the text store cares about. */
export interface DigestedTextRef {
  eventId: string;
  descriptionSha256: string;
}

/** A row ready for `market_rule_texts`. */
export interface TextToStore {
  descriptionSha256: string;
  description: string;
}

export interface LostText {
  descriptionSha256: string;
  /** `edited` wins over `no_description`: at least one market still has A text. */
  reason: 'no_description' | 'edited';
  /** Every market that pointed at this text. The loss reaches all of them. */
  markets: string[];
}

export interface BackfillPlan {
  toStore: TextToStore[];
  /** Hashes already in `market_rule_texts`. Nothing to do, and it is said. */
  alreadyStored: string[];
  unrecoverable: LostText[];
}

/**
 * The whole backfill, decided before a single row is written.
 *
 * Grouped by HASH and not by digest row: 1264 readings collapse onto 267 texts,
 * and the table is keyed by content precisely so that the same regulation
 * shared by ten markets is one row. Planning per row would ask the database to
 * reject 997 duplicates that were never worth sending.
 *
 * The order of `toStore` is the order the hashes first appear, so a dry run and
 * the write that follows it list the same texts in the same places.
 */
export function planBackfill(
  refs: readonly DigestedTextRef[],
  descriptions: ReadonlyMap<string, string | null>,
  stored: ReadonlySet<string>,
): BackfillPlan {
  const marketsByText = new Map<string, string[]>();
  for (const ref of refs) {
    const markets = marketsByText.get(ref.descriptionSha256);
    if (markets === undefined) marketsByText.set(ref.descriptionSha256, [ref.eventId]);
    else if (!markets.includes(ref.eventId)) markets.push(ref.eventId);
  }

  const toStore: TextToStore[] = [];
  const alreadyStored: string[] = [];
  const unrecoverable: LostText[] = [];

  for (const [descriptionSha256, markets] of marketsByText) {
    if (stored.has(descriptionSha256)) {
      alreadyStored.push(descriptionSha256);
      continue;
    }

    const { description, trail } = recoverText(
      descriptionSha256,
      // A market missing from the map is a market that did not come back from
      // the lookup. Absent must read as "has no text", never as a match.
      markets.map((eventId) => ({ eventId, description: descriptions.get(eventId) ?? null })),
    );

    if (description !== null) {
      toStore.push({ descriptionSha256, description });
      continue;
    }

    unrecoverable.push({
      descriptionSha256,
      reason: trail.includes('edited') ? 'edited' : 'no_description',
      markets,
    });
  }

  return { toStore, alreadyStored, unrecoverable };
}
