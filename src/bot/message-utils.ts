import type { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from './index.js';

const MAX_CHARS = 3800;

export function splitTextIntoChunks(text: string, maxChars: number = MAX_CHARS): string[] {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);

      if (para.length > maxChars) {
        const lineChunks = splitByLines(para, maxChars);
        chunks.push(...lineChunks);
        current = '';
      } else {
        current = para;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function splitByLines(para: string, maxChars: number): string[] {
  const lines = para.split('\n');
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = line.length > maxChars ? line.slice(0, maxChars) : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface SendLongMessageOptions {
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  replyMarkup?: InlineKeyboard;
}

export async function sendLongMessage(
  bot: Bot<BotContext>,
  chatId: string | number,
  text: string,
  options: SendLongMessageOptions = {},
): Promise<void> {
  const chunks = splitTextIntoChunks(text);
  let firstMessageId: number | undefined;

  console.log(`[sendLongMessage] Splitting into ${chunks.length} chunks. Lengths: ${chunks.map(c => c.length).join(', ')}`);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const sendOpts = {
      parse_mode: options.parseMode,
      reply_parameters: i > 0 && firstMessageId !== undefined
        ? { message_id: firstMessageId }
        : undefined,
      reply_markup: isLast ? options.replyMarkup : undefined,
    };

    console.log(`[sendLongMessage] Sending chunk ${i+1}/${chunks.length}, ${chunks[i]!.length} chars`);
    try {
      const sent = await bot.api.sendMessage(chatId, chunks[i]!, sendOpts);
      console.log(`[sendLongMessage] Chunk ${i+1} sent OK, message_id=${sent.message_id}`);
      if (i === 0) firstMessageId = sent.message_id;
    } catch (err) {
      console.error(`[sendLongMessage] Chunk ${i+1} FAILED: ${err}`);
      throw err;
    }
  }
}

export async function replyLongMessage(
  ctx: BotContext,
  text: string,
  options: SendLongMessageOptions = {},
): Promise<void> {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const chunks = splitTextIntoChunks(text);
  let firstMessageId: number | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;

    const sent = await ctx.api.sendMessage(chatId, chunks[i]!, {
      parse_mode: options.parseMode,
      reply_parameters: i > 0 && firstMessageId !== undefined
        ? { message_id: firstMessageId }
        : undefined,
      reply_markup: isLast ? options.replyMarkup : undefined,
    });

    if (i === 0) firstMessageId = sent.message_id;
  }
}
