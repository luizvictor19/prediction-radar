import { InlineKeyboard } from 'grammy';
import type { SignalRow, PositionRow } from './format.js';
import { polymarketSlug } from './format.js';

export function signalKeyboard(signal: SignalRow): InlineKeyboard {
  return new InlineKeyboard()
    .url('Ver no Polymarket', polymarketSlug(signal))
    .text('Track', `track:${signal.id}`)
    .text('Dismiss', `dismiss:${signal.id}`);
}

export function positionKeyboard(positionId: string): InlineKeyboard {
  return new InlineKeyboard().text('Fechar posição', `close:${positionId}`);
}

export function confirmKeyboard(action: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Confirmar', `confirm:${action}`)
    .text('Cancelar', `cancel:${action}`);
}
