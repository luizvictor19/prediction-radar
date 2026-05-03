import { InlineKeyboard } from 'grammy';

export function signalKeyboard(signalId: string, polymarketUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .url('Ver no Polymarket', polymarketUrl)
    .text('Track', `track:${signalId}`)
    .text('Dismiss', `dismiss:${signalId}`);
}

export function positionKeyboard(positionId: string): InlineKeyboard {
  return new InlineKeyboard().text('Fechar posição', `close:${positionId}`);
}

export function confirmKeyboard(action: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Confirmar', `confirm:${action}`)
    .text('Cancelar', `cancel:${action}`);
}
