# Prediction Radar — Sistema Pessoal (Foco AI + Big Tech)

## Contexto e propósito

Sistema **pessoal e privado** pra detectar oportunidades em mercados Polymarket relacionados a AI e Big Tech. Sem produto público, sem clientes, sem marca. Apenas eu (Luiz) usando.

**Domínio escolhido:** AI/LLM (releases, benchmarks, capabilities) + Big Tech (earnings, lançamentos, decisões regulatórias).

**Objetivo de longo prazo:** gerar histórico documentado de operações com edge mensurável, que possa eventualmente virar:
- Sistema vendável (código + metodologia)
- Base pra SaaS futuro (se regulação BR mudar)
- Track record pra captação de capital ou consultoria

**Princípio operacional:** o sistema NÃO toma decisões — apenas detecta sinais e organiza informação. Decisão final é minha, baseada em análise fundamental + sinal técnico.

## Realidade regulatória (Brasil, 2026)

CMN baniu prediction markets via Resolução 5.298 (vigente em 4 de maio de 2026). Polymarket bloqueado pela Anatel. Operação pessoal continua viável via VPN + USDC/Polygon, mas:

- Sistema é puramente pessoal, sem distribuição
- Sem comercialização enquanto regulação BR for desfavorável
- Tracking fiscal cuidadoso (operações em cripto têm obrigação de declaração)
- Capital alocado apenas o que posso perder sem afetar vida

## Salvaguardas inegociáveis

1. **Tracking obrigatório de TODA operação** — antes de executar, registro completo com tese articulada (1-3 frases). Se tese não cabe em 3 frases coerentes, não opera.

2. **Bankroll fixo de US$ 500 nas primeiras 8 semanas.** Não escalar até ter dado de CLV positivo após 50+ operações.

3. **Cap de 3% do bankroll por operação** (US$ 15 max em US$ 500). Sem exceção, independente de convicção.

4. **Drawdown stop:** se perder 20% do bankroll em 30 dias, pausa total de 7 dias. Revisão obrigatória das operações antes de retomar.

5. **Detector NÃO é alterado retrospectivamente** pra explicar operação ruim. Mudanças no código só por hipótese geral, documentada em commit.

## Stack técnica

- **Backend único**: Node.js + TypeScript (monolito)
- **Banco**: Supabase (Postgres) — Free tier inicial (500 MB)
- **Hospedagem**: Railway (deploy automático via push)
- **APIs externas**: Polymarket Gamma API (metadados + preços agregados) — CLOB API reservada pra detectores futuros que precisem de orderbook profundo
- **Análise/relatórios**: Claude API (claude-sonnet-4-5) — Fase 5
- **Interface principal**: Telegram bot (alertas + comandos) — Fase 4
- **Dashboard secundário**: Next.js + Tailwind + shadcn/ui — Fase 6
- **VPN**: Mullvad ou ProtonVPN (operação manual no Polymarket)

## Estratégia de coleta — Gamma API only

Descoberta importante na fase inicial: a Gamma API do Polymarket já retorna em uma única chamada paginada **todos os dados que os detectores básicos precisam**:
- `bestBid`, `bestAsk`, `spread`, `lastTradePrice`
- `volume24hr`, `volumeNum`, `liquidityNum`
- `outcomes` (string JSON com array de nomes)
- `outcomePrices` (string JSON com array de preços)

Isso significa que **uma única request a cada 3 minutos** com `limit=500` cobre todos os ~50 markets monitorados. CLOB API só é chamada por detectores específicos que precisem de profundidade de orderbook (Hype/Reality Gap, pré-execução).

**Filtros aplicados pelo collector:**
- `active === true` e `closed === false`
- `volume24hr > $5k` (liquidez mínima)
- Resolução entre 7 e 90 dias (sweet spot operacional)
- Categoria identificada como AI/Tech via categorizer (regex word-boundary)

## Foco de mercados monitorados

**Categorias prioritárias:**
- AI/LLM: releases (GPT, Claude, Gemini, Llama), benchmarks (Arena, MMLU, GPQA), capabilities específicas
- Big Tech: earnings (Apple, Microsoft, Google, Meta, Amazon, Nvidia), lançamentos de produto, decisões regulatórias (DoJ, FTC, EU)
- AI infrastructure: GPU shortage, deals NVIDIA, expansões de datacenter
- AI safety/policy: AI Act EU, executive orders, restrições de chip

## Arquitetura

```
┌────────────────────────────────────────────────────┐
│  Railway (Node.js process único)                   │
│                                                     │
│  ┌──────────────┐    ┌──────────────────┐          │
│  │  Collector   │ →  │  Detector Runner │          │
│  │  Gamma API   │    │  (orquestra      │          │
│  │  (cron 3min) │    │   todos detect.) │          │
│  └──────┬───────┘    │  (cron 5min)     │          │
│         │            └──────┬───────────┘          │
│         │                    │                      │
│         ▼                    ▼                      │
│  ┌──────────────────────────────────┐              │
│  │      Supabase (Postgres)         │              │
│  └──────────────────────────────────┘              │
│         │                    │                      │
│         ▼                    ▼                      │
│  ┌──────────────┐    ┌──────────────────┐          │
│  │ Telegram Bot │    │ Retention Job    │          │
│  │  (Fase 4)    │    │ (cron diário)    │          │
│  └──────────────┘    └──────────────────┘          │
└────────────────────────────────────────────────────┘
```

## Estado atual de implementação

### ✅ Implementado e operacional
- **Collector**: roda a cada 3 min via Railway, coleta ~48k markets, filtra, persiste em `events` + `polymarket_snapshots`
- **Categorizer**: regex word-boundary, classifica em `ai_llm` / `ai_policy` / `ai_infra` / `big_tech` / `other`
- **Logger**: persiste cada execução em `system_logs` com metadata estruturada
- **Schema Supabase**: 6 tabelas criadas (`events`, `polymarket_snapshots`, `detected_signals`, `my_bets`, `system_config`, `system_logs`)
- **Deploy**: GitHub → Railway → Supabase, env vars configuradas
- **Normalização**: `gammaToEvent` mapeia campos Gamma (`question` → `title`, parse de strings JSON, etc.)

### 🟡 Stubs criados (estrutura existe, lógica não implementada)
- `src/detectors/cross-market.ts`
- `src/detectors/calendar-driven.ts`
- `src/detectors/hype-reality-gap.ts`
- `src/telegram/bot.ts` + commands
- `src/claude/report.ts` + prompts

### 🔴 Não criado ainda
- Detector runner (orquestrador)
- Retention job (limpeza automática)
- Trigger de `updated_at` em `system_config`

## Detectores específicos pro domínio

### 1. Cross-Market Consistency Detector (Fase 1 — atual)
Identifica grupos de outcomes correlacionados com probabilidades matematicamente inconsistentes.

**Modo intra-market (Fase 1):** múltiplos outcomes do mesmo market do Polymarket. Soma de outcomePrices deveria ser ~1.00 (após considerar spread bid/ask). Desvios significativos = sinal.

Exemplo: market "Which company has best AI model end of June?" com outcomes (Anthropic 69%, Google 23%, OpenAI 6%, xAI 2%, Meta 1%) soma 101% — dentro do esperado. Se somar 108%, é sinal de alta confiança.

**Modo inter-market (Fase 1.5 — semana 2):** markets diferentes mas matematicamente relacionados. Ex: P("GPT-5 by June") ≤ P("GPT-5 by December"). Inconsistência = arbitragem implícita.

### 2. Calendar-Driven Detector (Fase 2)
Mercados sobre eventos com data conhecida (earnings, conferences, releases anunciados). Detecta:
- Mercados ainda mal precificados X dias antes do evento
- Movimento típico de preço pré-evento vs pós-evento
- Oportunidades de entrada baseadas em padrão histórico

### 3. Hype/Reality Gap Detector (Fase 3)
Identifica mercados onde preço move forte após notícia de release/anúncio MAS:
- Benchmarks específicos ainda não publicados
- Capabilities reais não verificáveis
- Histórico mostra que hype inicial tipicamente decai 20-40% após benchmarks reais saírem

### 4. (Futuro) Benchmark divergence detector
Pra mercados específicos de "modelo X vai ranquear top N em benchmark Y", compara expectativa de mercado com análise técnica do modelo (parâmetros, training data, capabilities reportadas).

## Schema Supabase

### `events`
Mercados Polymarket monitorados.

```sql
create table events (
  id uuid primary key default gen_random_uuid(),
  polymarket_id text not null unique,
  slug text,
  title text not null,                  -- vem de gamma.question
  category text,                         -- 'ai_llm' | 'big_tech' | 'ai_infra' | 'ai_policy' | 'other'
  sub_category text,
  description text,
  outcomes jsonb,                        -- { values: ['Yes', 'No'], prices: ['0.57', '0.43'] }
  volume_total numeric,
  volume_24h numeric,
  liquidity numeric,
  end_date timestamptz,
  status text default 'active',          -- 'active' | 'inactive' | 'resolved'
  resolved_outcome text,
  tracked boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_events_status_volume on events(status, volume_24h desc);
create index idx_events_category on events(category) where tracked = true;
```

### `polymarket_snapshots`
Snapshots de preços/orderbook.

```sql
create table polymarket_snapshots (
  id bigserial primary key,
  event_id uuid references events(id) on delete cascade,
  outcome text not null,
  best_bid numeric(5,4),
  best_ask numeric(5,4),
  mid_price numeric(5,4),
  spread numeric(5,4),
  bid_depth numeric(14,2),
  ask_depth numeric(14,2),
  volume_24h numeric(14,2),
  captured_at timestamptz default now()
);

create index idx_snapshots_event_time on polymarket_snapshots(event_id, captured_at desc);
```

**Política de retenção:** 14 dias. Job diário deleta snapshots mais antigos (configurável via `system_config.snapshot_retention_days`).

### `detected_signals`
Sinais detectados pelos detectores.

```sql
create table detected_signals (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  signal_type text not null,             -- 'cross_market_intra' | 'cross_market_inter' | 'calendar_driven' | 'hype_reality_gap'
  confidence_score numeric(3,2),         -- 0.00 a 1.00
  reasoning text,                         -- explicação humana
  metadata jsonb,                         -- dados estruturados específicos do detector
  suggested_outcome text,
  suggested_stake_pct numeric(4,3),
  expires_at timestamptz,
  alerted boolean default false,
  acted_on boolean default false,
  dismissed boolean default false,
  created_at timestamptz default now()
);

create index idx_signals_active on detected_signals(created_at desc) 
  where dismissed = false and acted_on = false;
```

### `my_bets`
Operações reais (sincronizadas via /track no Telegram, Fase 4).

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
  confidence_self numeric(3,1),           -- 1-10
  result text,
  pnl_usd numeric(10,2),
  clv numeric(5,4),
  notes text,
  placed_at timestamptz default now(),
  closed_at timestamptz
);
```

### `system_config`
Configuração runtime (1 linha única, lida a cada execução de detector/scheduler).

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
  -- Cross-Market Detector
  cross_market_log_threshold numeric default 0.03,         -- soma fora de 97-103% gera log
  cross_market_high_confidence_threshold numeric default 0.08,  -- fora de 92-108% gera alta confiança
  cross_market_dedup_window_minutes integer default 30,
  -- Retenção de dados (free tier 500MB)
  snapshot_retention_days integer default 14,
  system_logs_retention_days integer default 30,
  updated_at timestamptz default now()
);

-- Trigger pra atualizar updated_at automaticamente
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger system_config_updated_at
  before update on system_config
  for each row execute function update_updated_at();
```

### `system_logs`
Auditoria de execuções.

```sql
create table system_logs (
  id bigserial primary key,
  component text not null,                -- 'collector' | 'categorizer' | 'detector_runner' | 'cross_market_detector' | etc
  status text not null,                   -- 'success' | 'error' | 'partial'
  message text,
  metadata jsonb,
  created_at timestamptz default now()
);

create index idx_logs_component_time on system_logs(component, created_at desc);
```

**Política de retenção:** 30 dias. Job diário deleta logs mais antigos (configurável via `system_config.system_logs_retention_days`).

## Estrutura de arquivos

```
prediction-radar/
├── src/
│   ├── collectors/
│   │   ├── polymarket.ts              ✅ implementado
│   │   └── categorizer.ts             ✅ implementado
│   ├── detectors/
│   │   ├── runner.ts                  🔴 a implementar (Fase 1)
│   │   ├── cross-market.ts            🟡 stub → implementar (Fase 1)
│   │   ├── calendar-driven.ts         🟡 stub
│   │   └── hype-reality-gap.ts        🟡 stub
│   ├── jobs/
│   │   └── retention.ts               🔴 a implementar (Fase 1)
│   ├── telegram/                      🟡 stub
│   │   ├── bot.ts
│   │   ├── commands/
│   │   └── alerts.ts
│   ├── claude/                        🟡 stub
│   │   ├── report.ts
│   │   └── prompts.ts
│   ├── lib/
│   │   ├── supabase.ts                ✅
│   │   ├── polymarket-api.ts          ✅
│   │   ├── normalize.ts               ✅
│   │   ├── logger.ts                  ✅
│   │   ├── kelly.ts                   ✅ (utilitário)
│   │   └── config.ts                  🔴 a implementar (Fase 1) — leitura de system_config
│   ├── types/
│   │   └── index.ts                   ✅
│   └── index.ts                        ✅ (precisa adicionar detector runner e retention job)
├── supabase/
│   └── migrations/
│       ├── 001_initial_schema.sql      ✅
│       └── 002_cross_market_config.sql 🔴 a criar (Fase 1)
├── scripts/
│   ├── seed-categories.ts              ✅
│   └── backfill.ts                     ✅
├── .env.example
├── package.json
├── tsconfig.json
└── railway.toml
```

## Roadmap revisado

### Fase 1 — Cross-Market Detector intra-market + retenção (atual)

**Entregáveis:**
- Migration `002_cross_market_config.sql` (colunas em system_config + trigger updated_at)
- Seed inicial de `system_config` com valores default
- `src/lib/config.ts` (helper pra ler config do banco com cache curto)
- `src/detectors/cross-market.ts` (lógica do detector)
- `src/detectors/runner.ts` (orquestrador — chama todos os detectores ativos)
- `src/jobs/retention.ts` (limpeza diária de snapshots e logs)
- Atualização de `src/index.ts` (cron de 5 min pro runner, cron diário pra retention)
- Logs estruturados de cada execução do detector
- Dedup com janela configurável (30 min default)

**Critério de sucesso:**
- Detector roda a cada 5 min sem erro
- Sinais aparecem em `detected_signals` quando soma de outcomes desvia do esperado
- Logs em `system_logs` mostram quantos grupos foram avaliados, quantos sinalizaram, quantos foram dedup
- Retenção rodando 1x/dia mantém banco abaixo de 200 MB

### Fase 1.5 — Cross-Market inter-market (semana 2)

Estende o detector pra agrupar markets diferentes mas correlacionados (mesma tema, datas relacionadas), aplicando lógicas de coerência matemática (ex: P(X até junho) ≤ P(X até dezembro)).

### Fase 2 — Calendar-Driven Detector (semana 2-3)

Markets com data conhecida próxima. Compara movimento de preço com padrão histórico nos últimos N dias antes do evento.

### Fase 3 — Hype/Reality Gap Detector (semana 3-4)

Cruza movimento de preço pós-anúncio com padrão histórico de "hype decay". Aqui sim começa a usar CLOB API pra orderbook profundo (avaliar se movimento é real ou só uma ordem pequena que moveu o bestBid).

### Fase 4 — Telegram Bot completo (semana 4)

Comandos: `/signals`, `/today`, `/track`, `/positions`, `/clv`, `/status`. Push automático pra sinais com `confidence_score >= min_confidence_alert`. Validação de `chat_id`.

### Fase 5 — Claude API integration (semana 4-5)

`/today` dispara endpoint que monta contexto (sinais ativos das últimas 24h + estado dos markets relevantes), manda pra Claude Sonnet 4.5, retorna análise estruturada em JSON formatado pro Telegram.

### Fase 6 — Dashboard web (semana 5-6, opcional)

Next.js + shadcn/ui. Páginas: overview, signals (com gráficos), positions, performance (CLV agregado, sub-categoria com melhor edge).

### Decisão honesta — semana 8

Olho a planilha/banco e respondo com dado:
1. Meu CLV agregado em 60-100 operações é positivo?
2. Em qual sub-categoria tenho melhor performance?
3. Os detectores estão me ajudando ou só gerando ruído?
4. Estou sustentando 2-3h de estudo diário ou caiu pra menos?
5. Estou registrando 100% das operações?

**Cenários:**
- CLV positivo + disciplina mantida → continuar, aumentar bankroll gradualmente, refinar
- CLV neutro + disciplina mantida → ajustar foco, sub-especializar
- CLV negativo → pausa de 7 dias, análise profunda
- Disciplina caiu → problema é execução, não sistema. Reset.

## Princípios de execução

1. **Ferramenta amplifica edge, não cria edge** — disciplina e estudo vêm primeiro
2. **Tracking é não-negociável** — sem exceções
3. **Bankroll pequeno na fase de calibração** — protege capital E psicológico
4. **Detector e operação evoluem juntos** — mas sem retrofit pra esconder erro
5. **Estudo é trabalho de domínio, não hobby** — 2-3h diárias
6. **Dado vence intuição** — quando dado contradiz opinião, dado está certo
7. **Aceitar "sem edge" é sucesso, não falha** — descobrir em 8 semanas que tech não é seu domínio é poupar tempo

## Variáveis de ambiente (.env)

```
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# Polymarket
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
POLYMARKET_CLOB_URL=https://clob.polymarket.com

# Anthropic (Fase 5)
ANTHROPIC_API_KEY=

# Telegram (Fase 4)
TELEGRAM_BOT_TOKEN=
TELEGRAM_AUTHORIZED_CHAT_ID=

# App
NODE_ENV=production
LOG_LEVEL=info
```

## Notas de segurança

- Repo privado no GitHub
- Telegram bot autorizado só pro meu chat ID (validação no código)
- API keys via env vars, nunca commitadas
- Free tier sem backup automático — fazer dump manual semanal via `supabase db dump` enquanto não migrar pro Pro
- Operação manual no Polymarket sempre via VPN
- Capital em USDC/Polygon, declarado fiscalmente
