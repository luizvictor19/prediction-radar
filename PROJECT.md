# Prediction Radar — Sistema Pessoal

> v3 — atualizado com decisão estratégica de instrumentação ampla (todas categorias) + filtragem por edge líquido após fees.

## Contexto e propósito

Sistema **pessoal e privado** pra detectar oportunidades em prediction markets do Polymarket. Sem produto público, sem clientes, sem marca. Apenas eu (Luiz) usando.

**Modelo operacional:** instrumentação ampla, decisão filtrada.
- Sistema monitora **todas as categorias** com volume e liquidez relevantes
- Detectores trabalham em qualquer market, agnósticos a categoria
- Sinais são ranqueados por **edge líquido após fees** (não só desvio matemático)
- **Eu decido manualmente** quais sinais operar, com base em:
  1. Força do sinal (edge líquido alto)
  2. Tese fundamental (quando tenho conhecimento de domínio)
  3. Combinação dos dois (cenário ouro)
- Tracking registra `domain_confidence` por operação pra analytics futuros: "onde eu tenho edge real?"

**Domínio com vantagem informacional:** AI/LLM e Big Tech (acompanho LMSYS Arena, releases, benchmarks). Mas não é mais filtro de descarte — é **uma dimensão de análise** entre outras.

**Objetivo de longo prazo:** gerar histórico documentado de operações com edge mensurável que possa eventualmente virar:
- Sistema vendável (código + metodologia)
- Base pra SaaS futuro (se regulação BR mudar)
- Track record pra captação de capital ou consultoria

**Princípio operacional:** o sistema NÃO toma decisões — apenas detecta sinais e organiza informação. Decisão final é minha, baseada em análise fundamental + sinal técnico + edge líquido.

## Realidade regulatória (Brasil, 2026)

CMN baniu prediction markets via Resolução 5.298 (vigente em 4 de maio de 2026). Polymarket bloqueado pela Anatel. Operação pessoal continua viável via VPN + USDC/Polygon, mas:
- Sistema é puramente pessoal, sem distribuição
- Sem comercialização enquanto regulação BR for desfavorável
- Tracking fiscal cuidadoso
- Capital alocado apenas o que posso perder sem afetar vida

## Salvaguardas inegociáveis

1. **Tracking obrigatório de TODA operação** — antes de executar, registro com tese articulada (1-3 frases) + categoria + domain_confidence (1-10). Se tese não cabe em 3 frases coerentes, não opera.
2. **Bankroll fixo de US$ 500 nas primeiras 8 semanas.** Não escalar até CLV positivo após 50+ operações.
3. **Cap de 3% do bankroll por operação** (US$ 15 max em US$ 500). Sem exceção.
4. **Drawdown stop:** 20% do bankroll em 30 dias = pausa de 7 dias.
5. **Detector NÃO é alterado retrospectivamente** pra explicar operação ruim.
6. **Edge líquido após fees é critério, não desvio bruto.** Sinal só conta se sobrevive aos custos.

## Princípios estratégicos

### Onde edge pode aparecer

- **Edge informacional**: você sabe algo sobre o domínio que o mercado precificou errado. Forte em AI/Tech, fraco em outros domínios.
- **Edge estatístico**: padrão matemático que o mercado não corrigiu (ex: soma de negRiskGroup desviada). Independente de domínio.
- **Cenário ouro**: ambos alinhados.

### Por que detector + decisão manual

Detector puro pode flagar ineficiência que **não é explorável** (caso típico: spread + fee maior que desvio). Operador puro perde sinais que escapam à atenção. Combinação é robusta.

### Por que monitorar todas categorias

Edge estatístico explorável depende fortemente do **fee da categoria**:
- Geopolitics (fee 0%): desvios pequenos viram edge real
- Sports (fee 3%): edge moderado a partir de desvios médios
- Tech/Finance/Politics (fee 4%): precisa desvio significativo
- Economics/Culture/Weather (fee 5%): só desvios grandes
- Crypto (fee 7.2%): só desvios muito grandes

Restringir a Tech artificialmente exclui categorias com fees baixos onde sinais de baixo desvio são exploráveis.

## Stack técnica

- **Backend único**: Node.js + TypeScript (monolito)
- **Banco**: Supabase (Postgres) — Free tier (500 MB)
- **Hospedagem**: Railway (deploy automático via push)
- **APIs**: Polymarket Gamma API (CLOB API reservada pra detectores futuros)
- **Análise**: Claude API (claude-sonnet-4-5) — Fase 5
- **Interface**: Telegram bot — Fase 4
- **Dashboard**: Next.js + Tailwind + shadcn/ui — Fase 6
- **VPN**: Mullvad ou ProtonVPN

## Estratégia de coleta — Gamma API only, agnóstico a categoria

A Gamma API retorna em uma única chamada paginada todos os dados que os detectores básicos precisam: `bestBid`, `bestAsk`, `spread`, `lastTradePrice`, `volume24hr`, `volumeNum`, `liquidityNum`, `outcomes`, `outcomePrices`, `negRiskMarketID`, `series`, `eventMetadata`, **`category`/`tags`** (categoria do Polymarket).

**Filtros aplicados pelo collector (atualizados v3):**
- `active === true` e `closed === false`
- `volume24hr > $10k` (era $5k — endurecido pra reduzir ruído com universo ampliado)
- `liquidity > $20k` (novo — garante operacionalidade)
- Resolução entre 7 e 90 dias
- `category` populado (descarta markets sem categoria identificável)
- Categoria não está em `system_config.excluded_categories` (default vazio)

**O que MUDOU:**
- Categorizer não é mais filtro de descarte
- Categoria do Polymarket (pra fee rate) é capturada
- Categorizer regex AI/Tech vira flag secundária `is_ai_tech` em `events`

## Descobertas críticas da Gamma API

### `negRiskMarketID`
Polymarket organiza conjuntos de markets binários relacionados em "Negative Risk" groups, onde no máximo 1 dos members pode resolver Yes. Soma de P(Yes) deveria ser ~1.0. **Agrupador primário do detector inter-market.**

### `series`
Markets recorrentes (mensais, trimestrais) compartilham um `series` array. Fundamental pro Resolution Anchor Detector (Fase 2.5).

### `eventMetadata.context_description`
Texto editorial gerado pelo Polymarket. Será input principal do prompt do Claude na Fase 5.

### `category` / `tags`
Define **fee rate aplicável**. Hoje no banco temos `category` próprio (regex AI/Tech). Vamos adicionar `polymarket_category` separado pra capturar a categoria nativa do Polymarket.

## Fee structure do Polymarket (referência)

Tabela hardcoded no código (`src/lib/fees.ts`):

| Categoria Polymarket | Taker Fee Rate |
|---------------------|----------------|
| Geopolitics | 0% |
| Sports | 3% |
| Finance / Politics / Mentions / Tech | 4% |
| Economics / Culture / Weather / Other | 5% |
| Crypto | 7.2% |

Fórmula de fee USDC: `fee = shares × feeRate × p × (1 - p)`

Fee é simétrica em torno de 50% — trade a 30¢ tem mesmo fee que trade a 70¢.

## Arquitetura

```
┌────────────────────────────────────────────────────┐
│  Railway (Node.js process único)                   │
│                                                    │
│  ┌──────────────┐    ┌──────────────────┐          │
│  │  Collector   │ →  │  Detector Runner │          │
│  │  TODAS       │    │  (orquestra      │          │
│  │  categorias  │    │   detectores)    │          │
│  │  (cron 3min) │    │  (cron 5min)     │          │
│  └──────┬───────┘    └──────┬───────────┘          │
│         │                   │                      │
│         ▼                   ▼                      │
│  ┌──────────────────────────────────┐              │
│  │      Supabase (Postgres)         │              │
│  │  events com polymarket_category  │              │
│  │  + neg_risk_market_id            │              │
│  │  + is_ai_tech (flag secundária)  │              │
│  └──────────────────────────────────┘              │
│         │                   │                      │
│         ▼                   ▼                      │
│  ┌──────────────┐    ┌──────────────────┐          │
│  │ Telegram Bot │    │ Retention Job    │          │
│  │  (Fase 4)    │    │ (snapshots 7d)   │          │
│  └──────────────┘    └──────────────────┘          │
└────────────────────────────────────────────────────┘
```

## Estado atual

### Fase 1 + 1.5 completas
- Collector roda a cada 3 min, filtra markets, persiste em `events` + `polymarket_snapshots`
- Categorizer regex (AI/Tech) — vai virar flag secundária na v3
- Logger persiste em `system_logs`
- Schema Supabase com 6 tabelas
- Cross-Market Detector intra-market roda (gera sinal raro)
- Cross-Market Detector inter-market roda (gera sinais de 3-5% bruto, mas insuficiente após fees em Tech)
- Detector Runner orquestrador
- Retention Job (snapshots 14d, logs 30d)
- Config helper com cache 60s
- 56/65 events com `neg_risk_market_id` populado, 9 grupos distintos identificados

### Fase 1.6 — atual (instrumentação ampla)
- Coletor sem filtro de categoria
- Captura `polymarket_category` da Gamma
- Detector inter-market ajusta confidence por fee da categoria
- Sinais ranqueados por `expected_edge_pct` líquido
- `is_ai_tech` como flag secundária

### Stubs criados
- `src/detectors/calendar-driven.ts`
- `src/detectors/hype-reality-gap.ts`
- `src/telegram/`
- `src/claude/`

## Detectores

### 1. Cross-Market Consistency Detector

**1a. Intra-market (Fase 1 — implementado):** múltiplos outcomes do mesmo market.

**1b. Inter-market (Fase 1.5 — implementado):** agrupa events por `negRiskMarketID`. Soma P(Yes). 

**1c. Refinamento Fase 1.6:** ajusta confidence por fee da categoria. `expected_edge_pct` calculado.

### 2. Calendar-Driven Detector (Fase 2)
Markets com data de resolução próxima. Compara movimento de preço com padrão histórico.

### 2.5. Resolution Anchor Detector (Fase 2.5)
Pré-requisito: 2-3 ciclos de resolução de séries recorrentes com snapshots completos.

### 3. Hype/Reality Gap Detector (Fase 3)
Movimento pós-anúncio cruzado com padrão histórico de "hype decay". Usa CLOB API.

### 4. Benchmark divergence detector (futuro)

## Schema Supabase

### `events`

```sql
create table events (
  id uuid primary key default gen_random_uuid(),
  polymarket_id text not null unique,
  slug text,
  title text not null,
  -- Categoria interna (regex AI/Tech) — vira flag opcional
  category text,
  sub_category text,
  is_ai_tech boolean default false,           -- NOVO Fase 1.6
  -- Categoria nativa do Polymarket (define fee rate)
  polymarket_category text,                   -- NOVO Fase 1.6
  description text,
  outcomes jsonb,
  volume_total numeric,
  volume_24h numeric,
  liquidity numeric,
  end_date timestamptz,
  status text default 'active',
  resolved_outcome text,
  tracked boolean default true,
  -- Fase 1.5
  neg_risk_market_id text,
  series_id text,
  series_slug text,
  series_recurrence text,
  event_metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_events_status_volume on events(status, volume_24h desc);
create index idx_events_polymarket_category on events(polymarket_category);
create index idx_events_is_ai_tech on events(is_ai_tech) where is_ai_tech = true;
create index idx_events_neg_risk on events(neg_risk_market_id) where neg_risk_market_id is not null;
create index idx_events_series on events(series_id) where series_id is not null;
```

### `polymarket_snapshots`
Política de retenção: **7 dias** (reduzido de 14 — universo ampliado).

### `detected_signals`
Tipos: `cross_market_intra` | `cross_market_inter` | `calendar_driven` | `hype_reality_gap` | `resolution_anchor`.

Metadata pra inter-market agora inclui:
```json
{
  "neg_risk_market_id": "...",
  "polymarket_category": "tech",
  "fee_rate": 0.04,
  "price_sum": 1.04,
  "deviation_gross": 0.04,
  "estimated_fee_cost": 0.022,
  "deviation_net": 0.018,
  "expected_edge_pct": 1.8,
  "members": [...]
}
```

### `my_bets`

```sql
create table my_bets (
  id uuid primary key default gen_random_uuid(),
  external_id text,
  event_id uuid references events(id),
  signal_id uuid references detected_signals(id),
  outcome text not null,
  entry_price numeric(5,4) not null,
  closing_price numeric(5,4),
  resolution_price numeric(5,4),
  stake_usd numeric(10,2) not null,
  shares numeric(10,4),
  thesis text,
  thesis_type text,                       -- 'fundamental' | 'technical' | 'mixed' | 'gut'
  domain_confidence integer,              -- 1-10, NOVO v3 (quanto de domínio você tem)
  polymarket_category text,               -- NOVO v3, captura categoria
  confidence_self numeric(3,1),
  result text,
  pnl_usd numeric(10,2),
  clv numeric(5,4),
  notes text,
  placed_at timestamptz default now(),
  closed_at timestamptz
);
```

### `system_config`
1 row única. Lida com cache 60s.

```sql
create table system_config (
  id integer primary key,
  bankroll_usd numeric not null default 500,
  max_stake_pct numeric not null default 0.03,
  kelly_fraction numeric not null default 0.25,
  min_confidence_alert numeric not null default 0.70,
  drawdown_stop_pct numeric not null default 0.20,
  telegram_chat_id text,
  daily_report_hour integer default 9,
  -- Cross-Market Detectors
  cross_market_log_threshold numeric default 0.03,
  cross_market_high_confidence_threshold numeric default 0.08,
  cross_market_dedup_window_minutes integer default 30,
  inter_market_min_members integer default 3,
  inter_market_min_total_volume_24h numeric default 10000,
  -- NOVO Fase 1.6
  min_expected_edge_pct numeric default 1.5,    -- abaixo disso, confidence_score = 0
  log_expected_edge_pct numeric default 0.5,    -- abaixo disso, nem loga sinal
  excluded_categories text[] default '{}',      -- categorias do Polymarket pra ignorar
  collector_min_volume_24h numeric default 10000,
  collector_min_liquidity numeric default 20000,
  -- Retenção
  snapshot_retention_days integer default 7,    -- reduzido de 14
  system_logs_retention_days integer default 30,
  updated_at timestamptz default now()
);
```

### `system_logs`
Política de retenção: 30 dias.

## Estrutura de arquivos

```
prediction-radar/
├── src/
│   ├── collectors/
│   │   ├── polymarket.ts              ✅ (precisa atualizar v3)
│   │   └── categorizer.ts             ✅ (vira classificador secundário v3)
│   ├── detectors/
│   │   ├── runner.ts                  ✅
│   │   ├── cross-market.ts            ✅
│   │   ├── cross-market-inter.ts      ✅ (precisa ajuste fee v3)
│   │   ├── calendar-driven.ts         🟡
│   │   └── hype-reality-gap.ts        🟡
│   ├── jobs/
│   │   └── retention.ts               ✅
│   ├── telegram/                      🟡
│   ├── claude/                        🟡
│   ├── lib/
│   │   ├── supabase.ts                ✅
│   │   ├── polymarket-api.ts          ✅
│   │   ├── normalize.ts               ✅ (precisa atualizar v3)
│   │   ├── logger.ts                  ✅
│   │   ├── kelly.ts                   ✅
│   │   ├── config.ts                  ✅
│   │   └── fees.ts                    🔴 NOVO Fase 1.6
│   ├── types/index.ts                 ✅ (precisa atualizar v3)
│   └── index.ts                       ✅
├── supabase/migrations/
│   ├── 001_initial_schema.sql          ✅
│   ├── 002_cross_market_config.sql     ✅
│   ├── 003_inter_market.sql            ✅
│   └── 004_broad_collection.sql        🔴 Fase 1.6
├── scripts/
│   ├── seed-categories.ts              ✅
│   ├── backfill.ts                     ✅
│   ├── backfill-neg-risk-ids.ts        ✅
│   └── backfill-polymarket-category.ts 🔴 Fase 1.6
├── .env.example
├── package.json
├── tsconfig.json
└── railway.toml
```

## Roadmap

### Fase 1 — concluída
Cross-Market intra + infra.

### Fase 1.5 — concluída
Cross-Market inter-market via negRiskMarketID.

### Fase 1.6 — atual (instrumentação ampla)
- Coletor sem filtro de categoria
- `polymarket_category` capturado e indexado
- Ajuste de fee no detector inter-market
- `expected_edge_pct` líquido como métrica primária
- Filtros de volume/liquidez endurecidos

### Fase 2 — Calendar-Driven (semana 2-3)

### Fase 2.5 — Resolution Anchor (semana 5-6)

### Fase 3 — Hype/Reality Gap (semana 4-5)

### Fase 4 — Telegram Bot (semana 4)
Comandos: `/signals`, `/today`, `/track`, `/positions`, `/clv`, `/status`, `/categories` (analytics por categoria).

### Fase 5 — Claude API integration (semana 4-5)

### Fase 6 — Dashboard web (semana 5-6)

### Decisão honesta — semana 8
Avaliar:
1. CLV agregado em 60-100 operações é positivo?
2. **Em qual categoria do Polymarket tenho melhor performance? Em qual domain_confidence?**
3. Os detectores ajudam ou geram ruído?
4. Estou sustentando 2-3h de estudo diário?
5. Estou registrando 100% das operações?

## Princípios de execução

1. Ferramenta amplifica edge, não cria edge
2. Tracking é não-negociável
3. Bankroll pequeno na fase de calibração
4. Detector e operação evoluem juntos
5. Estudo é trabalho de domínio, não hobby
6. Dado vence intuição
7. Aceitar "sem edge" é sucesso, não falha
8. **Edge líquido > desvio bruto**
9. **Fee da categoria importa tanto quanto o desvio**

## Variáveis de ambiente

```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
POLYMARKET_CLOB_URL=https://clob.polymarket.com
ANTHROPIC_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_AUTHORIZED_CHAT_ID=
NODE_ENV=production
LOG_LEVEL=info
```

## Notas de segurança

- Repo privado no GitHub
- Telegram bot autorizado só pro chat_id do Luiz
- API keys via env vars
- Free tier sem backup automático — dump manual semanal
- Operação manual no Polymarket via VPN
- Capital em USDC/Polygon, declarado fiscalmente
