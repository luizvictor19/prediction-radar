import { InlineKeyboard } from 'grammy';
import { truncate } from '../lib/format-helpers.js';

function getOutcomeEmojis(values: string[], prices: string[]): [string, string] {
  const v0 = values[0]?.toLowerCase() ?? '';
  const v1 = values[1]?.toLowerCase() ?? '';

  if (v0 === 'yes' && v1 === 'no') return ['✅', '❌'];
  if (v0 === 'no' && v1 === 'yes') return ['❌', '✅'];

  if (v0 === 'up' && v1 === 'down') return ['⬆️', '⬇️'];
  if (v0 === 'down' && v1 === 'up') return ['⬇️', '⬆️'];

  if (v0 === 'over' && v1 === 'under') return ['⬆️', '⬇️'];
  if (v0 === 'under' && v1 === 'over') return ['⬇️', '⬆️'];

  const p0 = parseFloat(prices[0] ?? '0.5');
  const p1 = parseFloat(prices[1] ?? '0.5');
  return p0 >= p1 ? ['👑', '🐺'] : ['🐺', '👑'];
}

export function signalKeyboard(signalId: string, polymarketUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .url('Ver no Polymarket', polymarketUrl)
    .text('Track', `track:${signalId}`)
    .text('Dismiss', `dismiss:${signalId}`);
}

export function calendarDrivenKeyboard(
  signalId: string,
  polymarketUrl: string,
  outcomes: { values?: string[]; prices?: string[] } | null,
): InlineKeyboard {
  const values = outcomes?.values ?? ['Yes', 'No'];
  const prices = outcomes?.prices ?? ['0.5', '0.5'];
  const v0 = values[0] ?? 'Yes';
  const v1 = values[1] ?? 'No';
  const isLiteralYesNo = v0 === 'Yes' && v1 === 'No';

  const [emoji0, emoji1] = getOutcomeEmojis(values, prices);
  const label0 = isLiteralYesNo ? `${emoji0} Track YES` : `${emoji0} Track ${truncate(v0, 25)}`;
  const label1 = isLiteralYesNo ? `${emoji1} Track NO`  : `${emoji1} Track ${truncate(v1, 25)}`;

  return new InlineKeyboard()
    .url('Ver no Polymarket ↗', polymarketUrl)
    .row()
    .text(label0, `track_yes:${signalId}`)
    .text(label1, `track_no:${signalId}`)
    .row()
    .text('Dismiss', `dismiss:${signalId}`);
}

export function positionKeyboard(positionId: string): InlineKeyboard {
  return new InlineKeyboard().text('Fechar posição', `close:${positionId}`);
}

export function basketKeyboard(betId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Fechar tudo', `close:${betId}`)
    .text('Fechar leg específica', `close_leg_select:${betId}`);
}

export function confirmKeyboard(action: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Confirmar', `confirm:${action}`)
    .text('Cancelar', `cancel:${action}`);
}
