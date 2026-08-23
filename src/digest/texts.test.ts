import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashDescription } from './digest.js';
import { planBackfill, recoverText, type DigestedTextRef } from './texts.js';

/**
 * The backfill, tested where it is pure: no network, no database.
 *
 * The real `hashDescription` is used, never a stub. The whole point of these
 * functions is that a text is only ever stored under a hash it actually
 * produces, and a stubbed hash would let that promise pass without being kept.
 */

/** The hash of a text, computed the way the digestion computes it: trimmed. */
function shaOf(description: string): string {
  return hashDescription(description.trim());
}

const RULE = 'This market resolves YES if the team wins by 11:59 PM ET on March 3, 2027.';
const EDITED = `${RULE} Edited afterwards by Polymarket.`;
const SHA = shaOf(RULE);

test('recoverText walks every market sharing the text and stops at the first that still holds it', () => {
  // The sequence, not the destination. Three markets share this rule: the first
  // was edited, the second lost its description, the third still has it. A
  // recovery that gave up on the first failure would report the text as lost
  // while a market that still holds it sits two rows down -- and the final
  // string alone cannot tell the two implementations apart.
  const { description, trail } = recoverText(SHA, [
    { eventId: 'ev-editado', description: EDITED },
    { eventId: 'ev-sem-descricao', description: null },
    { eventId: 'ev-intacto', description: RULE },
    { eventId: 'ev-nunca-visitado', description: RULE },
  ]);

  assert.deepEqual(trail, ['edited', 'no_description', 'match']);
  assert.equal(description, RULE);
});

test('recoverText matches a description that only differs by surrounding whitespace', () => {
  // `readMarketsToDigest` trims before handing the text to the model, so the
  // stored hash is the hash of the TRIMMED text. Without the same trim here, no
  // description that starts with a newline would ever match its own digestion.
  const { description, trail } = recoverText(SHA, [
    { eventId: 'ev', description: `\n\n  ${RULE}  \n` },
  ]);

  assert.deepEqual(trail, ['match']);
  assert.equal(description, RULE, 'stores the trimmed text, which is what the hash names');
});

test('recoverText never returns a text whose hash is not the one asked for', () => {
  const { description, trail } = recoverText(SHA, [{ eventId: 'ev', description: EDITED }]);

  assert.deepEqual(trail, ['edited']);
  assert.equal(description, null);
});

test('recoverText tells an empty description apart from an edited one', () => {
  // Blank is `no_description`, not `edited`: nobody overwrote the rule with a
  // different rule, the row simply has no text. The two have different fixes.
  const { trail } = recoverText(SHA, [
    { eventId: 'a', description: null },
    { eventId: 'b', description: '   ' },
  ]);

  assert.deepEqual(trail, ['no_description', 'no_description']);
});

// ---------------------------------------------------------------------------
// planBackfill
// ---------------------------------------------------------------------------

const OUTRA = 'This market resolves YES if the price closes above $100.';
const SHA_OUTRA = shaOf(OUTRA);

function refs(...pares: [string, string][]): DigestedTextRef[] {
  return pares.map(([eventId, descriptionSha256]) => ({ eventId, descriptionSha256 }));
}

test('planBackfill collapses the readings of one text into a single row', () => {
  // 1264 readings, 267 texts: the whole reason the text lives in its own table.
  // Four rows pointing at the same rule must produce ONE row to store.
  const plan = planBackfill(
    refs(['ev-1', SHA], ['ev-1', SHA], ['ev-2', SHA], ['ev-3', SHA]),
    new Map([
      ['ev-1', RULE],
      ['ev-2', RULE],
      ['ev-3', RULE],
    ]),
    new Set(),
  );

  assert.deepEqual(plan.toStore, [{ descriptionSha256: SHA, description: RULE }]);
  assert.deepEqual(plan.unrecoverable, []);
  assert.deepEqual(plan.alreadyStored, []);
});

test('planBackfill skips a text that is already stored instead of rewriting it', () => {
  const plan = planBackfill(
    refs(['ev-1', SHA], ['ev-2', SHA_OUTRA]),
    new Map([
      ['ev-1', RULE],
      ['ev-2', OUTRA],
    ]),
    new Set([SHA]),
  );

  assert.deepEqual(plan.alreadyStored, [SHA]);
  assert.deepEqual(plan.toStore, [{ descriptionSha256: SHA_OUTRA, description: OUTRA }]);
});

test('planBackfill reports an unrecoverable text with every market that pointed at it', () => {
  // The text is gone, and the report is the only thing left. Naming a single
  // market would hide that the loss reaches all three.
  // `ev-1` appears twice because it was read twice -- the levelling writes more
  // than one reading of the same pair. The market is named ONCE in the report:
  // a list that repeated it would inflate the reach of the loss.
  const plan = planBackfill(
    refs(['ev-1', SHA], ['ev-1', SHA], ['ev-2', SHA], ['ev-3', SHA]),
    new Map([
      ['ev-1', EDITED],
      ['ev-2', EDITED],
      ['ev-3', null],
    ]),
    new Set(),
  );

  assert.deepEqual(plan.toStore, []);
  assert.deepEqual(plan.unrecoverable, [
    { descriptionSha256: SHA, reason: 'edited', markets: ['ev-1', 'ev-2', 'ev-3'] },
  ]);
});

test('planBackfill calls a text lost to blank descriptions no_description, not edited', () => {
  const plan = planBackfill(
    refs(['ev-1', SHA], ['ev-2', SHA]),
    new Map([
      ['ev-1', null],
      ['ev-2', ''],
    ]),
    new Set(),
  );

  assert.deepEqual(plan.unrecoverable, [
    { descriptionSha256: SHA, reason: 'no_description', markets: ['ev-1', 'ev-2'] },
  ]);
});

test('planBackfill recovers a text from a sibling market when the first one was edited', () => {
  // The measured shape of this corpus: 267 texts for 1033 markets, so most
  // texts have siblings. A backfill that only looked at the first market of
  // each text would report losses that the second market can still repair.
  const plan = planBackfill(
    refs(['ev-editado', SHA], ['ev-intacto', SHA]),
    new Map([
      ['ev-editado', EDITED],
      ['ev-intacto', RULE],
    ]),
    new Set(),
  );

  assert.deepEqual(plan.toStore, [{ descriptionSha256: SHA, description: RULE }]);
  assert.deepEqual(plan.unrecoverable, []);
});

test('planBackfill keeps the order the texts first appear in, and never repeats one', () => {
  const plan = planBackfill(
    refs(['ev-2', SHA_OUTRA], ['ev-1', SHA], ['ev-2', SHA_OUTRA]),
    new Map([
      ['ev-1', RULE],
      ['ev-2', OUTRA],
    ]),
    new Set(),
  );

  assert.deepEqual(
    plan.toStore.map((t) => t.descriptionSha256),
    [SHA_OUTRA, SHA],
  );
});

test('planBackfill treats a market absent from the description map as having none', () => {
  // The lookup is by primary key in batches; a market deleted between the two
  // reads simply does not come back. Absent must not read as "matches".
  const plan = planBackfill(refs(['ev-sumido', SHA]), new Map(), new Set());

  assert.deepEqual(plan.toStore, []);
  assert.deepEqual(plan.unrecoverable, [
    { descriptionSha256: SHA, reason: 'no_description', markets: ['ev-sumido'] },
  ]);
});
