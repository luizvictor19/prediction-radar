/**
 * Shared by the monthly archive script (`scripts/arquivar-particao.ts`) and
 * the bot's size alert (`src/bot/database-size.ts`), so both agree on when a
 * closed month may leave the database (issue 60).
 *
 * v_radar's widest anchor reaches back 7 days + 6 hours from the latest
 * price, so a month is still read until day 8 of the next one. Day 9 clears it.
 */
export const ARCHIVE_MIN_DAY = 9;
