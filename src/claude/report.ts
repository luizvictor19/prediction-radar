import Anthropic from '@anthropic-ai/sdk';
import { buildDailyReportPrompt } from './prompts.js';
import type { DetectedSignal, Event } from '../types/index.js';

const client = new Anthropic();

export async function generateDailyReport(signals: DetectedSignal[], events: Event[]): Promise<string> {
  const prompt = buildDailyReportPrompt(signals, events);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = message.content[0];
  if (content?.type !== 'text') throw new Error('Unexpected response type from Claude');
  return content.text;
}
