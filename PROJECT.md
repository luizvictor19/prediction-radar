# Prediction Radar — Sistema Pessoal (Foco AI + Big Tech)

> v2 — atualizado após Fase 1 implementada e descoberta da estrutura de `negRiskMarketID` + `series` na Gamma API.

## Contexto e propósito

Sistema **pessoal e privado** pra detectar oportunidades em mercados Polymarket relacionados a AI e Big Tech. Sem produto público, sem clientes, sem marca. Apenas eu (Luiz) usando.

**Domínio escolhido:** AI/LLM (releases, benchmarks, capabilities) + Big Tech (earnings, lançamentos, decisões regulatórias).

**Objetivo de longo prazo:** gerar histórico documentado de operações com edge mensurável que possa eventualmente virar:
- Sistema vendável (código + metodologia)
- Base pra SaaS futuro (se regulação BR mudar)
- Track record pra captação de capital ou consultoria

**Princípio operacional:** o sistema NÃO toma decisões — apenas detecta sinais e organiza informação. Decisão final é minha, baseada em análise fundamental + sinal técnico.

## Realidade regulatória (Brasil, 2026)

CMN baniu prediction markets via Resolução 5.298 (vigente em 4 de maio de 2026). Polymarket bloqueado pela Anatel. Operação pessoal continua viável via VPN + USDC/Polygon, mas:

- Sistema é puramente pessoal, sem distribuição
- Sem comercialização enquanto regulação BR for desfavorável
- Tracking fiscal cuidadoso
- Capital alocado apenas o que posso perder sem afetar vida

## Salvaguardas inegociáveis

1. **Tracking obrigatório de TODA operação** — antes de executar, registro completo com tese articulada (1-3 frases). Se tese não cabe em 3 frases coerentes, não opera.
2. **Bankroll fixo de US$ 500 nas primeiras 8 semanas.** Não escalar até CLV positivo após 50+ operações.
3. **Cap de 3% do bankroll por operação** (US$ 15 max em US$ 500). Sem exceção.
4. **Drawdown stop:** se perder 20% do bankroll em 30 dias, pausa de 7 dias.
5. **Detector NÃO é alterado retrospectivamente** pra explicar operação ruim.

## Stack técnica

- **Backend único**: Node.js + TypeScript (monolito)
- **Banco**: Supabase (Postgres) — Free tier (500 MB)
- **Hospedagem**: Railway (deploy automático via push)
- **APIs**: Polymarket Gamma API (CLOB API reservada pra detectores futuros)
- **Análise**: Claude API (claude-sonnet-4-5) — Fase 5
- **Interface**: Telegram bot — Fase 4
- **Dashboard**: Next.js + Tailwind + shadcn/ui — Fase 6
- **VPN**: Mullvad ou ProtonVPN

## Estratégia de coleta — Gamma API only

A Gamma API retorna em uma única chamada paginada todos os dados que os detectores básicos precisam: `bestBid`, `bestAsk`, `spread`, `lastTradePrice`, `volume24hr`, `volumeNum`, `liquidityNum`, `outcomes`, `outcomePrices`, `negRiskMarketID`, `series`, `eventMetadata`. Uma única request a cada 3 minutos com `limit=500` cobre todos os ~50-100 markets monitorados. CLOB API só é chamada por detectores específicos (Hype/Reality Gap).

**Filtros aplicados pelo collector:**
- `active === true` e `closed === false`
- `volume24hr > $5k` (liquidez mínima)
- Resolução entre 7 e 90 dias
- Categoria identificada como AI/Tech via categorizer

## Descoberta crítica: `negRiskMarketID`, `series`, `eventMetadata`

Investigação direta da Gamma API revelou três campos que mudaram a arquitetura do detector inter-market.

### `negRiskMarketID`
Polymarket organiza conjuntos de markets binários relacionados em "Negative Risk" groups, onde no máximo 1 dos members pode resolver Yes. Todos os markets do mesmo grupo compartilham um `negRiskMarketID` único.

```json
"negRisk": true,
"negRiskMarketID": "0x00aedaca097ba5dbb1846364114809c3628059eb730bdea1c59de2ea90646600"
```

**Implicação matemática:** soma de P(Yes) de todos os members do grupo deveria estar próxima de 1.0. Desvios significativos = sinal.

Exemplo: o grupo "Best AI model end of May 2026" tem ~15 candidatos (Anthropic, Google, OpenAI, xAI, etc.). Cada um é um market binário separado com seu próprio token, mas todos têm o mesmo `negRiskMarketID`.

Esse é o **agrupador primário** do sistema. Sem regex, sem heurística textual.

### `series`
Markets recorrentes (mensais, trimestrais) compartilham um `series` array.

```json
"series": [{
  "id": "10030",
  "slug": "best-ai-company",
  "seriesType": "single",
  "recurrence": "monthly"
}]
```

Permite agrupar "toda a série Best AI Company ao longo do tempo". Será fundamental pro **Resolution Anchor Detector (Fase 2.5)**.

### `eventMetadata.context_description`
Texto editorial gerado pelo Polymarket explicando contexto do market (narrativa, principais players). Será o input principal do prompt do Claude na Fase 5.

## Foco de mercados monitorados

- AI/LLM: releases, benchmarks (Arena, MMLU), capabilities
- Big Tech: earnings, lançamentos, decisões regulatórias
- AI infrastructure: GPU, datacenter, NVIDIA deals
- AI safety/policy: AI Act EU, executive orders, restrições de chip

## Arquitetura

```
┌────────────────────────────────────────────────────┐
│  Railway (Node.js process único)                   │
│                                                    │
│  ┌──────────────┐    ┌──────────────────┐          │
│  │  Collector   │ →  │  Detector Runner │          │
│  │  Gamma API   │    │  (orquestra      │          │
│  │  (cron 3min) │    │   detectores)    │          │
│  └──────┬───────┘    │  (cron 5min)     │          │
│         │            └──────┬───────────┘          │
│         ▼                   ▼                      │
│  ┌──────────────────────────────────┐              │
│  │      Supabase (Postgres)         │              │
│  └──────────────────────────────────┘              │
│         │                   │                      │
│         ▼                   ▼                      │
│  ┌──────────────┐    ┌──────────────────┐          │
│  │ Telegram Bot │    │ Retention Job    │          │
│  │  (Fase 4)    │    │ (cron diário)    │          │
│  └──────────────┘    └──────────────────┘          │
└────────────────────────────────────────────────────┘
```

## Estado atual de implementação

### Fase 1 completa
- Collector roda a cada 3 min, filtra markets, persiste em `events` + `polymarket_snapshots`
- Categorizer com regex word-boundary
- Logger persiste em `system_logs`
- Schema Supabase com 6 tabelas
- Deploy: GitHub → Railway → Supabase
- Cross-Market Detector intra-market roda a cada 5 min — gera sinal raro porque domínio AI/Big Tech tem markets majoritariamente binários (Negative Risk)
- Detector Runner orquestrador
- Retention Job (snapshots 14d, logs 30d)
- Config helper com cache 60s

### Stubs criados (a implementar)
- `src/detectors/calendar-driven.ts`
- `src/detectors/hype-reality-gap.ts`
- `src/telegram/`
- `src/claude/`

### Próximo: Fase 1.5 — Cross-Market inter-market

## Detectores específicos pro domínio

### 1. Cross-Market Consistency Detector

**1a. Modo intra-market (Fase 1 — implementado)**
Múltiplos outcomes do mesmo market. No domínio AI/Big Tech gera sinal raro porque a maioria dos grupos é Negative Risk (markets binários separados).

**1b. Modo inter-market (Fase 1.5)**
Agrupa events por `negRiskMarketID`. Soma P(Yes) de todos os members. Aplica thresholds. Vai gerar sinal regular no domínio AI/Big Tech.

### 2. Calendar-Driven Detector (Fase 2)
Mercados com data conhecida. Compara movimento de preço com padrão histórico nos N dias antes do evento.

### 2.5. Resolution Anchor Detector (Fase 2.5)
**Pré-requisito:** observar pelo menos 2-3 ciclos de resolução de séries recorrentes com snapshots diários completos.

Lógica: usar outcomes de ciclos passados como ponto de calibração pra ciclos futuros da mesma série.

Sub-detector: **Resolution Pricing Convergence**. Markets binários pré-resolução tendem a convergir de forma previsível.

**Estado de dado de calibração:**
- 1 ciclo de resolução observado (abril 2026) — outcome conhecido mas sem histórico de snapshots no banco
- Ciclo de maio (resolução 31/05/2026): primeiro com histórico de snapshots completo
- Ciclo de junho (resolução 30/06/2026): segundo

Implementação: ~ semana 5-6.

### 3. Hype/Reality Gap Detector (Fase 3)
Cruza movimento de preço pós-anúncio com padrão histórico de "hype decay". Usa CLOB API pra orderbook profundo.

### 4. Benchmark divergence detector (futuro)

## Schema Supabase

### `events`

```sql
create table events (
  id uuid primary key default gen_random_uuid(),
  polymarket_id text not null unique,
  slug text,
  title text not null,
  category text,
  sub_category text,
  description text,
  outcomes jsonb,
  volume_total numeric,
  volume_24h numeric,
  liquidity numeric,
  end_date timestamptz,
  status text default 'active',
  resolved_outcome text,
  tracked boolean default true,
  -- Adicionados Fase 1.5:
  neg_risk_market_id text,
  series_id text,
  series_slug text,
  series_recurrence text,
  event_metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_events_status_volume on events(status, volume_24h desc);
create index idx_events_category on events(category) where tracked = true;
create index idx_events_neg_risk on events(neg_risk_market_id) where neg_risk_market_id is not null;
create index idx_events_series on events(series_id) where series_id is not null;
```

### `polymarket_snapshots`
Política de retenção: 14 dias.

### `detected_signals`
Tipos: `cross_market_intra` | `cross_market_inter` | `calendar_driven` | `hype_reality_gap` | `resolution_anchor`.

Sinais inter-market podem ter `event_id = null` (sinal sobre grupo) ou apontar pro líder do grupo. Metadata sempre contém `neg_risk_market_id` e lista de members.

### `my_bets`
Operações reais sincronizadas via /track no Telegram (Fase 4).

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
  cross_market_log_threshold numeric default 0.03,
  cross_market_high_confidence_threshold numeric default 0.08,
  cross_market_dedup_window_minutes integer default 30,
  -- Adicionados Fase 1.5:
  inter_market_min_members integer default 3,
  inter_market_min_total_volume_24h numeric default 10000,
  -- Retenção:
  snapshot_retention_days integer default 14,
  system_logs_retention_days integer default 30,
  updated_at timestamptz default now()
);
```

### `system_logs`
Política de retenção: 30 dias (preserva logs de `retention_job`).

## Estrutura de arquivos

```
prediction-radar/
├── src/
│   ├── collectors/
│   │   ├── polymarket.ts              ✅
│   │   └── categorizer.ts             ✅
│   ├── detectors/
│   │   ├── runner.ts                  ✅
│   │   ├── cross-market.ts            ✅ (intra-market)
│   │   ├── cross-market-inter.ts      🔴 Fase 1.5
│   │   ├── calendar-driven.ts         🟡
│   │   └── hype-reality-gap.ts        🟡
│   ├── jobs/
│   │   └── retention.ts               ✅
│   ├── telegram/                      🟡
│   ├── claude/                        🟡
│   ├── lib/
│   │   ├── supabase.ts                ✅
│   │   ├── polymarket-api.ts          ✅
│   │   ├── normalize.ts               ✅
│   │   ├── logger.ts                  ✅
│   │   ├── kelly.ts                   ✅
│   │   └── config.ts                  ✅
│   ├── types/index.ts                 ✅
│   └── index.ts                       ✅
├── supabase/migrations/
│   ├── 001_initial_schema.sql          ✅
│   ├── 002_cross_market_config.sql     ✅
│   └── 003_inter_market.sql            🔴 Fase 1.5
├── scripts/
│   ├── seed-categories.ts              ✅
│   ├── backfill.ts                     ✅
│   └── backfill-neg-risk-ids.ts        🔴 Fase 1.5
├── .env.example
├── package.json
├── tsconfig.json
└── railway.toml
```

## Roadmap

### Fase 1 — concluída
Cross-Market Detector intra-market + infra.

### Fase 1.5 — Cross-Market inter-market (atual)

### Fase 2 — Calendar-Driven (semana 2-3)

### Fase 2.5 — Resolution Anchor (semana 5-6)
Depois de pelo menos maio resolver com dado completo.

### Fase 3 — Hype/Reality Gap (semana 4-5)

### Fase 4 — Telegram Bot (semana 4)
Comandos: `/signals`, `/today`, `/track`, `/positions`, `/clv`, `/status`.

### Fase 5 — Claude API integration (semana 4-5)

### Fase 6 — Dashboard web (semana 5-6)

### Decisão honesta — semana 8

## Princípios de execução

1. Ferramenta amplifica edge, não cria edge
2. Tracking é não-negociável
3. Bankroll pequeno na fase de calibração
4. Detector e operação evoluem juntos
5. Estudo é trabalho de domínio, não hobby
6. Dado vence intuição
7. Aceitar "sem edge" é sucesso, não falha

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
