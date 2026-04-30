import type { MarketCategory, MarketSubCategory, GammaMarket } from '../types/index.js';
import { logEvent } from '../lib/logger.js';

const _stats = { total: 0, ai_llm: 0, ai_policy: 0, ai_infra: 0, big_tech: 0, other: 0 };

// Letter-only boundary: prevents matching inside compound words or URLs.
// Digits are allowed adjacent — so GPT4, H100, B200 all match correctly.
// "amazonaws.com" → "amazon" followed by 'a' (letter) → NO match ✓
function wb(pattern: string, flags = 'i'): RegExp {
  return new RegExp(`(?<![a-zA-Z])(?:${pattern})(?![a-zA-Z])`, flags);
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// ai_llm: specific AI model or company names only
const AI_LLM_PATTERNS: RegExp[] = [
  wb('GPT|ChatGPT'),
  wb('Gemini'),
  wb('Llama'),
  wb('Mistral'),
  wb('OpenAI'),
  wb('Anthropic'),
  wb('DeepSeek'),
  wb('Qwen'),
  wb('Grok'),
  wb('xAI'),
  wb('Perplexity'),
  wb('Cohere'),
  /(?<![a-zA-Z])language\s+model(?![a-zA-Z])/i,
  /(?<![a-zA-Z])LLM(?![a-zA-Z])/,
  /(?<![a-zA-Z])foundation\s+model(?![a-zA-Z])/i,
  /(?<![a-zA-Z])chatbot\s+arena(?![a-zA-Z])/i,
  /(?<![a-zA-Z])(?:GPQA|MMLU)(?![a-zA-Z])/,
  /(?<![a-zA-Z])AI\s+(?:model|agent|benchmark|assistant)(?![a-zA-Z])/i,
];

const CLAUDE_PATTERN = wb('Claude');
const CLAUDE_EXCLUSIONS = wb('Giroux|NHL|hockey|Trophy|Calder|Hart');

// big_tech: specific company names only
// Meta and Apple use no 'i' flag (case-sensitive) to avoid Spanish "meta" and lowercase "apple"
const BIG_TECH_PATTERNS: RegExp[] = [
  wb('Apple', ''),
  wb('Microsoft'),
  wb('Google'),
  wb('Alphabet'),
  wb('Meta', ''),
  wb('Amazon'),
  wb('Nvidia'),
  wb('Tesla'),
  /(?<![a-zA-Z])(?:AAPL|MSFT|GOOGL|AMZN|NVDA|TSLA)(?![a-zA-Z])/,
];

// Geopolitical signals → override big_tech match, return other
// "capture" and "war" excluded intentionally — too generic
// ("Will Nvidia capture 80% of AI chip market?" would be a false negative)
const BIG_TECH_GEO_EXCLUSIONS = wb('Russia|Ukraine|Putin|Zelensky|ceasefire|NATO|invasion|Kyiv|Moscow');

// ai_infra: GPU/chip/datacenter — specific enough to avoid most false positives
const AI_INFRA_PATTERNS: RegExp[] = [
  /(?<![a-zA-Z])GPU(?![a-zA-Z])/i,
  /(?<![a-zA-Z])(?:H100|H200|H800|A100|B100|B200|GB200|GB100)(?![a-zA-Z0-9])/,
  /(?<![a-zA-Z])TSMC(?![a-zA-Z])/,
  /(?<![a-zA-Z])chip\s+(?:restriction|export|ban)(?![a-zA-Z])/i,
  /(?<![a-zA-Z])semiconductor\s+(?:export|restriction|ban)(?![a-zA-Z])/i,
  /(?<![a-zA-Z])AI\s+compute(?![a-zA-Z])|(?<![a-zA-Z])compute\s+capacity(?![a-zA-Z])/i,
  /(?<![a-zA-Z])data\s*center(?![a-zA-Z])|(?<![a-zA-Z])datacenter(?![a-zA-Z])/i,
  /(?<![a-zA-Z])hyperscaler(?![a-zA-Z])/i,
];

// ai_policy: MUST have explicit "AI" or "artificial intelligence" + regulatory action
const AI_POLICY_PATTERNS: RegExp[] = [
  /(?<![a-zA-Z])AI\s+Act(?![a-zA-Z])/i,
  /(?<![a-zA-Z])AI\s+safety(?![a-zA-Z])/i,
  /(?<![a-zA-Z])AI\s+regulat/i,
  /(?<![a-zA-Z])regulat\w*\s+(?:AI|artificial intelligence)(?![a-zA-Z])/i,
  /(?<![a-zA-Z])AI\s+(?:ban|banned|restriction)(?![a-zA-Z])/i,
  /(?<![a-zA-Z])executive\s+order.{0,40}AI(?![a-zA-Z])/i,
  /(?<![a-zA-Z])AI.{0,40}executive\s+order(?![a-zA-Z])/i,
  /(?<![a-zA-Z])FTC.{0,60}AI(?![a-zA-Z])|(?<![a-zA-Z])AI.{0,60}FTC(?![a-zA-Z])/i,
  /(?<![a-zA-Z])DoJ.{0,60}AI(?![a-zA-Z])|(?<![a-zA-Z])AI.{0,60}DoJ(?![a-zA-Z])/i,
  /(?<![a-zA-Z])AI\s+governance(?![a-zA-Z])/i,
  /(?<![a-zA-Z])artificial\s+intelligence.{0,50}(?:regulat|ban|policy|law|act|safety)/i,
];

const SUB_CATEGORY_MAP: Array<[RegExp, MarketSubCategory]> = [
  [/(?<![a-zA-Z])(?:release|launch|deploy|unveil).{0,30}(?:model|AI|version)(?![a-zA-Z])/i, 'model_release'],
  [/(?<![a-zA-Z])model\s+(?:release|launch)(?![a-zA-Z])/i, 'model_release'],
  [/(?<![a-zA-Z])(?:benchmark|arena|ranking|MMLU|GPQA)(?![a-zA-Z])/i, 'benchmark'],
  [/(?<![a-zA-Z])(?:earnings|revenue|quarterly)(?![a-zA-Z])/i, 'earnings'],
  [/(?<![a-zA-Z])(?:regulat\w+|antitrust|AI\s+Act)(?![a-zA-Z])/i, 'regulation'],
];

function isAiLlm(title: string): boolean {
  if (matchesAny(title, AI_LLM_PATTERNS)) return true;
  return CLAUDE_PATTERN.test(title) && !CLAUDE_EXCLUSIONS.test(title);
}

function isBigTech(title: string): boolean {
  if (BIG_TECH_GEO_EXCLUSIONS.test(title)) return false;
  return matchesAny(title, BIG_TECH_PATTERNS);
}

export function categorizeMarket(market: GammaMarket): {
  category: MarketCategory;
  sub_category: MarketSubCategory | null;
} {
  // Title only — descriptions contain URLs, boilerplate, and resolution sources
  // that pollute keyword matching (e.g. "amazonaws.com" triggering Amazon pattern)
  const title = market.question;
  _stats.total++;

  let category: MarketCategory = 'other';
  if (isAiLlm(title)) category = 'ai_llm';
  else if (matchesAny(title, AI_POLICY_PATTERNS)) category = 'ai_policy';
  else if (matchesAny(title, AI_INFRA_PATTERNS)) category = 'ai_infra';
  else if (isBigTech(title)) category = 'big_tech';

  _stats[category]++;

  if (category === 'other') {
    console.warn(`[categorizer] Discarded (other): "${market.question.slice(0, 80)}"`);
    return { category, sub_category: null };
  }

  let sub_category: MarketSubCategory | null = null;
  for (const [pattern, sub] of SUB_CATEGORY_MAP) {
    if (pattern.test(title)) {
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

export async function logCategorizerStats(): Promise<void> {
  const { total, ai_llm, ai_policy, ai_infra, big_tech, other } = _stats;
  await logEvent({
    component: 'categorizer',
    status: 'success',
    message: `Categorized ${total} titles`,
    metadata: { total, ai_llm, ai_policy, ai_infra, big_tech, other },
  });
  Object.assign(_stats, { total: 0, ai_llm: 0, ai_policy: 0, ai_infra: 0, big_tech: 0, other: 0 });
}

// VALIDATION CASES — run manually: categorizeMarket({ question: title, description: '' })
// "Will Russia capture Kostyantynivka by June 30?"          → other     ✓ (Russia geo exclusion)
// "Will Apple be the largest company on June 30?"           → big_tech  ✓
// "Will Amazon stock hit $200 by Q3?"                       → big_tech  ✓
// "Will Tesla deliver 350k vehicles in Q2?"                 → big_tech  ✓
// "Will Claude 5 release by June 30?"                       → ai_llm    ✓
// "Will Claude Giroux win MVP?"                             → other     ✓ (Giroux exclusion)
