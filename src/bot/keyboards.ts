import { InlineKeyboard } from 'grammy';
import { truncate } from '../lib/format-helpers.js';

export function signalKeyboard(signalId: string, polymarketUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .url('Ver no Polymarket', polymarketUrl)
    .text('Track', `track:${signalId}`)
    .text('Dismiss', `dismiss:${signalId}`);
}

export function calendarDrivenKeyboard(
  signalId: string,
  polymarketUrl: string,
  outcomes: { values?: string[] } | null,
): InlineKeyboard {
  const label0 = outcomes?.values?.[0] ?? 'Yes';
  const label1 = outcomes?.values?.[1] ?? 'No';
  const isLiteralYesNo = label0 === 'Yes' && label1 === 'No';

  const yesButton = isLiteralYesNo ? 'Track Yes' : `Track ${truncate(label0, 14)}`;
  const noButton = isLiteralYesNo ? 'Track No'  : `Track ${truncate(label1, 14)}`;

  return new InlineKeyboard()
    .url('🔗 Ver no Polymarket', polymarketUrl)
    .row()
    .text(yesButton, `track_yes:${signalId}`)
    .text(noButton, `track_no:${signalId}`)
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
