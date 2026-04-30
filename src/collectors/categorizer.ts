import type { MarketCategory, MarketSubCategory, GammaMarket } from '../types/index.js';

const AI_LLM_KEYWORDS = [
  'gpt', 'claude', 'gemini', 'llama', 'mistral', 'openai', 'anthropic', 'deepmind',
  'llm', 'ai model', 'language model', 'benchmark', 'arena', 'mmlu', 'gpqa',
  'chatbot', 'foundation model', 'grok', 'xai', 'perplexity', 'cohere',
];

const BIG_TECH_KEYWORDS = [
  'apple', 'microsoft', 'google', 'meta', 'amazon', 'nvidia', 'tesla',
  'earnings', 'revenue', 'quarterly', 'aapl', 'msft', 'googl', 'amzn', 'nvda',
];

const AI_INFRA_KEYWORDS = [
  'datacenter', 'data center', 'gpu', 'h100', 'b200', 'chip', 'semiconductor',
  'compute', 'infrastructure', 'hyperscaler',
];

const AI_POLICY_KEYWORDS = [
  'regulation', 'regulatory', 'doj', 'ftc', 'antitrust', 'ai act', 'executive order',
  'ban', 'restriction', 'congress', 'senate', 'eu ai',
];

const SUB_CATEGORY_MAP: Record<string, MarketSubCategory> = {
  release: 'model_release',
  launch: 'model_release',
  deploy: 'model_release',
  benchmark: 'benchmark',
  arena: 'benchmark',
  ranking: 'benchmark',
  earnings: 'earnings',
  revenue: 'earnings',
  quarterly: 'earnings',
  regulation: 'regulation',
  antitrust: 'regulation',
  ban: 'regulation',
};

function matchesKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

export function categorizeMarket(market: GammaMarket): {
  category: MarketCategory;
  sub_category: MarketSubCategory | null;
} {
  const text = `${market.title} ${market.description ?? ''}`;

  let category: MarketCategory = 'other';
  if (matchesKeywords(text, AI_LLM_KEYWORDS)) category = 'ai_llm';
  else if (matchesKeywords(text, AI_POLICY_KEYWORDS)) category = 'ai_policy';
  else if (matchesKeywords(text, AI_INFRA_KEYWORDS)) category = 'ai_infra';
  else if (matchesKeywords(text, BIG_TECH_KEYWORDS)) category = 'big_tech';

  let sub_category: MarketSubCategory | null = null;
  const lower = text.toLowerCase();
  for (const [keyword, sub] of Object.entries(SUB_CATEGORY_MAP)) {
    if (lower.includes(keyword)) {
      sub_category = sub;
      break;
    }
  }

  return { category, sub_category };
}

export function isRelevantMarket(market: GammaMarket): boolean {
  const { category } = categorizeMarket(market);
  return category !== 'other';
}
