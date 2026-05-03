# Prediction Radar — Sistema Pessoal

> v4 — atualizado pós-correção crítica da fórmula de edge, calendar-driven detector implementado, bot Telegram completo, bankroll ajustado pra $100, migrations aplicadas.

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

**Domínio com vantagem informacional:** AI/LLM e Big Tech (acompanho LMSYS Arena, releases, benchmarks). Mas não é filtro de descarte — é uma dimensão de análise entre outras.

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
2. **Bankroll fixo de US$ 100 nas primeiras 8 semanas.** (Reduzido de $500 na v3 — ajuste pra realidade atual de capital disponível.) Não escalar até CLV positivo após 50+ operações.
3. **Cap de 3% do bankroll por operação** pra single-leg (US$ 3 max em US$ 100). Cap de 10% pra cross-market arb (matematicamente garantido). Sem exceção.
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

### Realidade aprendida (v4)

**Cross-market inter no Polymarket maduro raramente tem edge operável.** Após correção da fórmula de edge (que estava reportando ROI ~5x inflado por interpretar desvio absoluto como percentual sobre capital investido), sinais reais ficam quase sempre entre 0% e 0.5%. Sinais com edge >2% reportados anteriormente eram artefato de bug.

Pra cross-market arb fazer sentido em valor absoluto precisa bankroll $2000+ (capital por trade que absorva spread bid/ask + Polymarket exige $1 mínimo por ordem, então basket de N legs precisa $N+ só pra atender mínimo, e stake/leg ≥ $5 é o realmente viável).

**Foco principal pra bankroll $100:** detectores single-leg (calendar_driven, hype_reality_gap futuro) executáveis com $1-3 stake, value betting onde tenho domínio fundamental.

## Stack técnica

- **Backend único**: Node.js + TypeScript (ESM, sem build step, executa via tsx em runtime)
- **Banco**: Supabase (Postgres) — Free tier (500 MB, atual ~25MB)
- **Hospedagem**: Railway — **2 services no mesmo repo** (start = coletor+detectores; bot = Telegram long-polling)
- **APIs**: Polymarket Gamma API (CLOB API reservada pra detectores futuros)
- **Análise**: Claude API (claude-sonnet-4-5) — Fase 5
- **Interface**: Telegram bot (grammy + @grammyjs/conversations) — implementado
- **Dashboard**: Next.js + Tailwind + shadcn/ui — Fase 6
- **VPN**: Mullvad ou ProtonVPN

## Estratégia de coleta — Gamma API only, agnóstico a categoria

A Gamma API retorna em uma única chamada paginada todos os dados que os detectores básicos precisam: `bestBid`, `bestAsk`, `spread`, `lastTradePrice`, `volume24hr`, `volumeNum`, `liquidityNum`, `outcomes`, `outcomePrices`, `negRiskMarketID`, `series`, `eventMetadata`, `feeType` (categoria do Polymarket), `events[0].slug` (slug do grupo).

**Filtros aplicados pelo collector (atualizados v4):**
- `active === true` e `closed === false`
- `liquidity > $20k` (sempre)
- `volume24hr > $10k` **só pra markets isolados** (não-negRisk). Markets negRisk são persistidos mesmo com volume baixo pra preservar cobertura de grupo no detector inter
- Resolução entre 7 e 90 dias
- `feeType` populado (descarta markets sem categoria identificável)
- Categoria não está em `system_config.excluded_categories` (default vazio)

**O que MUDOU na v4:**
- Coletor não filtra negRisk por volume (preserva grupo completo)
- `event_group_slug` capturado de `market.events[0].slug` pra URLs corretas no Polymarket

## Descobertas críticas da Gamma API

### `negRiskMarketID`
Polymarket organiza conjuntos de markets binários relacionados em "Negative Risk" groups, onde no máximo 1 dos members pode resolver Yes. Soma de P(Yes) deveria ser ~1.0. Agrupador primário do detector inter-market.

**Importante (descoberto na v4):** Gamma API **não suporta filtro server-side** por `negRiskMarketID` em nenhum endpoint (`/markets`, `/events`). Coverage check do detector inter virou DB-vs-DB local, sem dependência de filtro da API.

### `series`
Markets recorrentes (mensais, trimestrais) compartilham um `series` array. Fundamental pro Resolution Anchor Detector (Fase 2.5).

### `eventMetadata.context_description`
Texto editorial gerado pelo Polymarket. Será input principal do prompt do Claude na Fase 5.

### `feeType` + `feeSchedule.rate`
Define fee rate aplicável direto da API. Substituiu tabela hardcoded.

### `events[0].slug`
Slug do event-group da Polymarket (ex: `harvey-weinstein-prison-time`). Diferente do slug do market individual (ex: `will-harvey-weinstein-be-sentenced-to-no-prison-time`). É esse slug que monta URL correta no Polymarket: `polymarket.com/event/{event_group_slug}`.

## Fee structure do Polymarket (referência)

Tabela hardcoded em `src/lib/fees.ts` com fallback. Priorizamos `feeSchedule.rate` direto da API.

| Categoria Polymarket | Taker Fee Rate |
|---------------------|----------------|
| Geopolitics | 0% |
| Sports | 3% |
| Finance / Politics / Mentions / Tech | 4% |
| Economics / Culture / Weather / General | 5% |
| Crypto | 7.2% |

Fórmula de fee USDC: `fee = shares × feeRate × p × (1 - p)`

Fee é simétrica em torno de 50% — trade a 30¢ tem mesmo fee que trade a 70¢.

## Fórmula de edge corrigida (v4)

A fórmula original (v3) interpretava desvio absoluto como ROI percentual, reportando edges ~5x inflados. Correção crítica aplicada:

**Para overpriced (direction='over', basket comprar No):**
```
no_side_pool = group_size - priceSum
gross_roi = (priceSum - 1) / no_side_pool
edge_pct = (gross_roi - fee_cost) × 100
```

**Para underpriced (direction='under', basket comprar Yes):**
```
yes_side_pool = priceSum
gross_roi = (1 - priceSum) / yes_side_pool
edge_pct = (gross_roi - fee_cost) × 100
```

**Filtro adicional:** descarta sinais com `direction='under' && priceSum < 0.7` (sintoma de cobertura incompleta — fantasmas).

**Validação:** Eurovision (35 legs, soma 1.038) — edge antes 3.85%, edge real ~0.1%. NBA Eastern (7 legs, soma 1.029) — edge antes 2.51%, edge real ~0.045%.

## Arquitetura

```
Railway — 2 services no mesmo repo

Service 1: start
  Collector (cron 3min, todas categorias)
    ↓
  Detector Runner (cron 5min)
    cross_market_intra + cross_market_inter + calendar_driven
    ↓
  Supabase (Postgres)
    events com event_group_slug + neg_risk_market_id
    + polymarket_category + is_ai_tech

Service 2: bot
  Telegram long-polling (grammy)
  + notify loop (60s, alerta sinais novos)
  + comandos /signals, /track, /positions, /status, /bankroll, /config

Retention Job (no service 1, snapshots 7d, logs 30d)
```

## Estado atual

### Fase 1 + 1.5 + 1.6 — concluídas
- Collector roda a cada 3min, filtra markets, persiste em `events` + `polymarket_snapshots`
- Categorizer regex (AI/Tech) — flag secundária `is_ai_tech`
- Logger persiste em `system_logs`
- Schema Supabase com 6 tabelas
- Cross-Market Detector intra-market roda (gera sinal raro)
- Cross-Market Detector inter-market roda com fórmula corrigida (gera sinais reais 0-0.5% — raramente operáveis)
- Detector Runner orquestrador
- Retention Job (snapshots 7d, logs 30d)
- Config helper com cache 60s
- ~700 events ativos

### Fase 2 parcial — concluída na v4 (calendar-driven detector)
- Markets com `end_date` nos próximos 7 dias
- Volatilidade dos preços de Yes nas últimas 24h < 0.5pp (stddev < 0.005)
- Volume mínimo aplicado
- `confidence_score` escalado pela volatilidade
- `suggested_outcome = null` — sistema não decide direção
- Bot mostra setup; usuário decide com base em tese fundamental (Track YES / Track NO)

### Fase 4 — concluída (Telegram bot)
- 2º service no Railway, long-polling com grammy
- Comandos: `/signals`, `/positions`, `/status`, `/bankroll`, `/config`
- Notificações automáticas a cada 60s pra sinais com edge ≥ `notify_min_edge_pct`
- Fluxo conversacional `/track` (stake → entry_price → confidence → thesis → confirm)
- Cap de stake por signal_type (10% cross-market, 3% demais)
- URLs corretas Polymarket via `event_group_slug`

### Stubs criados
- `src/detectors/hype-reality-gap.ts`
- `src/claude/`

## Detectores

### 1. Cross-Market Consistency Detector

**1a. Intra-market (Fase 1):** múltiplos outcomes do mesmo market.

**1b. Inter-market (Fase 1.5 + correção v4):** agrupa events por `negRiskMarketID`. Soma P(Yes). Calcula ROI sobre capital investido (não desvio absoluto).

**1c. Coverage check (v4):** baseado em DB-vs-DB local, não usa Gamma API filter (que confirmamos não funcionar).

### 2. Calendar-Driven Detector (Fase 2 — implementado v4)
Markets com `end_date` < 7 dias e volatilidade 24h < 0.5pp. Sinaliza setup, não direção. Usuário escolhe Track YES ou Track NO baseado em opinião fundamental.

### 2.5. Resolution Anchor Detector (Fase 2.5 — pendente)
Pré-requisito: 2-3 ciclos de resolução de séries recorrentes com snapshots completos.

### 3. Hype/Reality Gap Detector (Fase 3 — pendente)
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
  category text,
  sub_category text,
  is_ai_tech boolean default false,
  polymarket_category text,
  polymarket_fee_rate numeric,
  description text,
  outcomes jsonb,
  volume_total numeric,
  volume_24h numeric,
  liquidity numeric,
  end_date timestamptz,
  status text default 'active',
  resolved_outcome text,
  tracked boolean default true,
  neg_risk_market_id text,
  series_id text,
  series_slug text,
  series_recurrence text,
  event_group_slug text,                        -- NOVO v4
  event_metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### `polymarket_snapshots`
Política de retenção: 7 dias. Inclui `idx_snapshots_event_captured(event_id, captured_at DESC)` pra performance do calendar-driven detector.

### `detected_signals`
Tipos: `cross_market_intra` | `cross_market_inter` | `calendar_driven` | `hype_reality_gap` | `resolution_anchor`.

Metadata pra inter-market:
```json
{
  "neg_risk_market_id": "...",
  "polymarket_category": "tech_fees",
  "fee_rate": 0.04,
  "group_size": 7,
  "price_sum": 1.029,
  "deviation_gross": 0.029,
  "estimated_fee_cost": 0.0044,
  "deviation_net": 0.0246,
  "expected_edge_pct": 0.045,
  "direction": "over",
  "coverage_ratio": 1.0,
  "total_volume_24h": 65651,
  "members": [...],
  "detection_count": 1,
  "last_seen_at": "..."
}
```

Metadata pra calendar-driven:
```json
{
  "end_date": "2026-05-08T...",
  "days_until_resolution": 5.2,
  "current_yes_price": 0.42,
  "volatility_24h": 0.003,
  "snapshot_count": 480,
  "volume_24h": 45000,
  "polymarket_category": "tech_fees",
  "is_ai_tech": true,
  "detection_count": 1,
  "last_seen_at": "..."
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
  thesis_type text,
  domain_confidence integer,
  polymarket_category text,
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
1 row única (id=1). Lida com cache 60s.

```sql
create table system_config (
  id integer primary key,
  bankroll_usd numeric not null default 100,                   -- ATUALIZADO v4 (era 500)
  max_stake_pct numeric not null default 0.03,
  cross_market_max_stake_pct numeric not null default 0.10,    -- NOVO v4
  kelly_fraction numeric not null default 0.25,
  min_confidence_alert numeric not null default 0.70,
  drawdown_stop_pct numeric not null default 0.20,
  telegram_chat_id text,
  daily_report_hour integer default 9,
  cross_market_log_threshold numeric default 0.03,
  cross_market_high_confidence_threshold numeric default 0.08,
  cross_market_dedup_window_minutes integer default 30,
  inter_market_min_members integer default 3,
  inter_market_min_total_volume_24h numeric default 10000,
  min_expected_edge_pct numeric default 1.5,
  notify_min_edge_pct numeric default 2.5,                     -- ATUALIZADO v4 (era 2.0)
  log_expected_edge_pct numeric default 0.5,
  excluded_categories text[] default '{}',
  collector_min_volume_24h numeric default 10000,
  collector_min_liquidity numeric default 20000,
  snapshot_retention_days integer default 7,
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
│   │   ├── polymarket.ts              ✅ (v4: filtra negRisk diferente)
│   │   └── categorizer.ts             ✅ (flag is_ai_tech)
│   ├── detectors/
│   │   ├── runner.ts                  ✅ (3 detectors ativos)
│   │   ├── cross-market.ts            ✅
│   │   ├── cross-market-inter.ts      ✅ (v4: coverage DB-vs-DB)
│   │   ├── calendar-driven.ts         ✅ NOVO v4
│   │   └── hype-reality-gap.ts        🟡 stub
│   ├── jobs/
│   │   └── retention.ts               ✅
│   ├── bot/                           ✅ NOVO v4
│   │   ├── index.ts
│   │   ├── auth.ts
│   │   ├── format.ts
│   │   ├── keyboards.ts
│   │   ├── notify.ts
│   │   └── handlers/
│   │       ├── signals.ts
│   │       ├── track.ts
│   │       ├── positions.ts
│   │       ├── status.ts
│   │       ├── bankroll.ts
│   │       └── config_cmd.ts
│   ├── claude/                        🟡 stub (Fase 5)
│   ├── lib/
│   │   ├── supabase.ts                ✅
│   │   ├── polymarket-api.ts          ✅ (fetchMarketsByNegRiskId @deprecated)
│   │   ├── normalize.ts               ✅ (v4: extrai event_group_slug)
│   │   ├── logger.ts                  ✅
│   │   ├── kelly.ts                   ✅
│   │   ├── config.ts                  ✅
│   │   └── fees.ts                    ✅ (v4: fórmula corrigida)
│   ├── types/index.ts                 ✅
│   └── index.ts                       ✅
├── package.json                       (script "bot": "tsx src/bot/index.ts")
├── tsconfig.json
└── railway.toml
```

## Roadmap

### Fase 1, 1.5, 1.6, 2 (parcial), 4 — concluídas
Cross-Market intra + inter, instrumentação ampla, calendar-driven detector, Telegram bot completo.

### Fase 2.5 — Resolution Anchor (pendente)
Após 2-3 ciclos de resolução observados.

### Fase 3 — Hype/Reality Gap (pendente)
Precisa CLOB API + integração com fonte de notícias.

### Fase 5 — Claude API integration (pendente)
Relatório diário com `eventMetadata.context_description` como input.

### Fase 6 — Dashboard web (pendente)

### Decisão honesta — semana 8
Avaliar:
1. CLV agregado em 60-100 operações é positivo?
2. Em qual categoria do Polymarket tenho melhor performance? Em qual `domain_confidence`?
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
8. Edge líquido > desvio bruto
9. Fee da categoria importa tanto quanto o desvio
10. **Calendar-driven é setup, não recomendação** — sem tese fundamental, ignorar (v4)

## Variáveis de ambiente

```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
POLYMARKET_CLOB_URL=https://clob.polymarket.com
ANTHROPIC_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_AUTHORIZED_CHAT_ID=8299632096
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

## Bugs corrigidos na sessão atual (referência histórica v4)

1. **fees.ts original calculava edge errado.** `Math.abs(priceSum - 1)` ignorava direção. Refatorado pra retornar `{ edgePct, direction }` separando buy-no/buy-yes.

2. **Coverage guard quebrado.** Tentamos usar `fetchMarketsByNegRiskId` da Gamma — confirmado via curl que API não suporta filtro server-side por `negRiskMarketID`. Função marcada `@deprecated`. Coverage check virou DB-vs-DB local.

3. **Coletor filtrava negRisk de baixo volume.** Criava grupos com cobertura incompleta. Fix: persiste todos negRisk; só filtra markets isolados.

4. **Filtro adicional `direction='under' && priceSum < 0.7`** pra descartar fantasmas residuais.

5. **Bug crítico de magnitude na fórmula de edge.** `calculateExpectedEdgePct` reportava ROI ~5x inflado (interpretava desvio absoluto como percentual sobre capital investido). Corrigida pra dividir pelo capital efetivamente investido (`no_side_pool` ou `yes_side_pool`). Edges caíram dramaticamente — Eurovision 3.85% → ~0.1%, NBA Eastern 2.5% → ~0.045%.

6. **URLs do Polymarket quebradas.** Bot usava `polymarket_id` numérico ou slug do market individual. Fix: capturar `event_group_slug` de `market.events[0].slug` no coletor; bot busca via lookup no DB.

## Configuração atual relevante (system_config id=1)

```
bankroll_usd: 100
max_stake_pct: 0.03
cross_market_max_stake_pct: 0.10
min_expected_edge_pct: 1.5
notify_min_edge_pct: 2.5
log_expected_edge_pct: 0.5
collector_min_volume_24h: 10000
collector_min_liquidity: 20000
inter_market_min_members: 3
inter_market_min_total_volume_24h: 10000
cross_market_dedup_window_minutes: 30
telegram_chat_id: 8299632096
```

## Migrations já aplicadas (v4)

```sql
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_group_slug text;

ALTER TABLE system_config ADD COLUMN IF NOT EXISTS notify_min_edge_pct numeric NOT NULL DEFAULT 2.5;

ALTER TABLE system_config ADD COLUMN IF NOT EXISTS cross_market_max_stake_pct numeric NOT NULL DEFAULT 0.10;

CREATE INDEX IF NOT EXISTS idx_snapshots_event_captured 
  ON polymarket_snapshots(event_id, captured_at DESC);

UPDATE system_config SET bankroll_usd = 100.00 WHERE id = 1;
```
