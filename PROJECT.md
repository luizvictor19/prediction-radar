# Prediction Radar — Sistema Pessoal

> v5 — atualizado pós-sessão de hardening: filtro de staleness em ambos detectors, dedup sem janela temporal, expires_at baseado em end_date, auto-cleanup de sinais mortos, sendLongMessage pra mensagens grandes, fix do crash-loop 409 do bot, logEvent do bot completo. Próxima fase: my_bet_legs + track expandido.

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
2. **Bankroll fixo de US$ 100 nas primeiras 8 semanas.** Não escalar até CLV positivo após 50+ operações.
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

### Realidade aprendida (v4-v5)

**Cross-market inter no Polymarket maduro raramente tem edge operável.** Após correção da fórmula de edge (que estava reportando ROI ~5x inflado por interpretar desvio absoluto como percentual sobre capital investido), sinais reais ficam quase sempre entre 0% e 0.5%. Sinais com edge >2% reportados anteriormente eram artefato de bug.

Pra cross-market arb fazer sentido em valor absoluto precisa bankroll $2000+ (capital por trade que absorva spread bid/ask + Polymarket exige $1 mínimo por ordem, então basket de N legs precisa $N+ só pra atender mínimo, e stake/leg ≥ $5 é o realmente viável).

**`direction='under'` em torneios é falso positivo sistemático (descoberto v5).** Mercado precifica cláusula "Other/cancelado" implicitamente — soma legítima de Yes em torneios fica abaixo de 1.0 sem que isso seja edge real. Detector mantém flagging mas requer filtro manual baseado em domínio.

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

**Filtros aplicados pelo collector:**
- `active === true` e `closed === false`
- `liquidity > $20k` (sempre)
- `volume24hr > $10k` **só pra markets isolados** (não-negRisk). Markets negRisk são persistidos mesmo com volume baixo pra preservar cobertura de grupo no detector inter
- Resolução entre 7 e 90 dias
- `feeType` populado (descarta markets sem categoria identificável)
- Categoria não está em `system_config.excluded_categories` (default vazio)

## Descobertas críticas da Gamma API

### `negRiskMarketID`
Polymarket organiza conjuntos de markets binários relacionados em "Negative Risk" groups, onde no máximo 1 dos members pode resolver Yes. Soma de P(Yes) deveria ser ~1.0. Agrupador primário do detector inter-market.

**Importante:** Gamma API **não suporta filtro server-side** por `negRiskMarketID` em nenhum endpoint (`/markets`, `/events`). Coverage check do detector inter virou DB-vs-DB local, sem dependência de filtro da API.

### `series`
Markets recorrentes (mensais, trimestrais) compartilham um `series` array. Fundamental pro Resolution Anchor Detector (Fase 2.5).

### `eventMetadata.context_description`
Texto editorial gerado pelo Polymarket. Será input principal do prompt do Claude na Fase 5.

### `feeType` + `feeSchedule.rate`
Define fee rate aplicável direto da API. Substituiu tabela hardcoded.

### `events[0].slug`
Slug do event-group da Polymarket (ex: `harvey-weinstein-prison-time`). Diferente do slug do market individual (ex: `will-harvey-weinstein-be-sentenced-to-no-prison-time`). É esse slug que monta URL correta no Polymarket: `polymarket.com/event/{event_group_slug}`.

### Markets que "somem" do feed quando resolvem (descoberto v5)
Quando market resolve, Polymarket muda `closed=true` na API e o market sai do feed `closed=false`. Coletor para de salvar snapshots. **Mas `events.status` no banco continua 'active' indefinidamente** — não há mecanismo automático pra marcar resolved. Isso justifica o detector `cleanup_stale_signals` (auto-dismiss sinais sem snapshot >1h) e o fix futuro do coletor pra detectar resolved markets explicitamente.

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
    cross_market_intra + cross_market_inter + calendar_driven + cleanup_stale_signals
    ↓
  Supabase (Postgres)
    events com event_group_slug + neg_risk_market_id
    + polymarket_category + is_ai_tech
    + trigger BEFORE UPDATE em events.updated_at

Service 2: bot
  Telegram long-polling (grammy)
  + delay 60s no startup pra evitar 409 conflict
  + notify loop (60s, alerta sinais novos)
  + comandos /signals, /track, /positions, /status, /bankroll, /config
  + sendLongMessage / replyLongMessage pra mensagens >3800 chars
  + logEvent funcionando (bot_command, bot_notify, bot_error, telegram_bot)

Retention Job (no service 1, snapshots 7d, logs 30d)
```

## Estado atual

### Fase 1 + 1.5 + 1.6 — concluídas
- Collector roda a cada 3min, filtra markets, persiste em `events` + `polymarket_snapshots`
- Categorizer regex (AI/Tech) — flag secundária `is_ai_tech`
- Logger persiste em `system_logs` (com try/catch interno pra não derrubar serviços)
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
- **v5:** filtro de outcomes dinâmico (lê `event.outcomes.values[0]` em vez de 'Yes' fixo, captura 95% dos markets antes ignorados)

### Fase 4 — concluída (Telegram bot)
- 2º service no Railway, long-polling com grammy
- Comandos: `/signals`, `/positions`, `/status`, `/bankroll`, `/config`
- Notificações automáticas a cada 60s pra sinais com edge ≥ `notify_min_edge_pct`
- Fluxo conversacional `/track` (stake → entry_price → confidence → thesis → confirm)
- Cap de stake por signal_type (10% cross-market, 3% demais)
- URLs corretas Polymarket via `event_group_slug`

### Hardening v5 — concluído
- **Trigger `events.updated_at`** no Supabase (BEFORE UPDATE)
- **Filtro de staleness** em ambos detectors: ignora events sem snapshot < 30min (markets resolvidos somem do feed e param de receber snapshots)
- **Dedup sem janela temporal**: detector atualiza sinal existente em vez de criar novo a cada 30min. Removeu `created_at >= dedupCutoff` da query
- **expires_at baseado em end_date**: calendar_driven usa `event.end_date`, cross_market_inter usa end_date mais cedo dos members. INSERT e UPDATE atualizados.
- **Auto-cleanup de sinais mortos**: novo job `cleanup_stale_signals` roda a cada 5min como parte do detector_runner, dismissa sinais com snapshot >1h. Cross-market basket é dismissado se QUALQUER member estiver stale.
- **Filtro de expires_at removido** no `/signals` e `notify`. Sinais aparecem se não-dismissed e não-acted_on, ignorando expires_at.
- **sendLongMessage / replyLongMessage** pra mensagens >3800 chars:
  - Divisão em boundary semântica (parágrafos)
  - 2ª+ mensagens como `reply_to_message_id` da 1ª (forma thread no Telegram)
  - Botões só na ÚLTIMA parte
  - Validado com sinal Sinner French Open (40 jogadores, 6000+ chars)
- **Bot delay 60s no startup**: `bot.start()` espera 60s pra evitar crash-loop 409 (Telegram não esquece instância antiga em <30s)
- **logEvent do bot completo**: bot_command (cada /signals), bot_notify (cada sinal enviado), bot_error (cada falha), telegram_bot (startup). try/catch interno em logEvent pra não derrubar bot se Supabase travar.
- **Mensagens redesenhadas** pros 2 detectors:
  - calendar_driven: confiança em ★, variação descritiva, preços com nomes reais, 🐺 azarão / 👑 favorito, trade-off pros 2 lados, 3 leituras (consenso firme/preguiçoso/espera), stake confidence-based, viabilidade
  - cross_market_inter: cenários completos com prob/payoff/lucro/prejuízo, prob de lucro total, viabilidade A/B/C, bankroll mínimo necessário, composição com lista pronta pra colar
- **Botões Track com nomes reais**: market binário com nomes (UFC Strickland vs Chimaev) → `Track Yes Strickland` / `Track Yes Chimaev`. Tese (values=["Yes","No"]) → `Track Yes` / `Track No` literal.

### Stubs criados
- `src/detectors/hype-reality-gap.ts`
- `src/claude/`

## Detectores

### 1. Cross-Market Consistency Detector

**1a. Intra-market (Fase 1):** múltiplos outcomes do mesmo market.

**1b. Inter-market (Fase 1.5 + correção v4):** agrupa events por `negRiskMarketID`. Soma P(Yes). Calcula ROI sobre capital investido (não desvio absoluto).

**1c. Coverage check (v4):** baseado em DB-vs-DB local, não usa Gamma API filter (que confirmamos não funcionar).

### 2. Calendar-Driven Detector (Fase 2 — implementado v4, hardened v5)
Markets com `end_date` < 7 dias e volatilidade 24h < 0.5pp. Sinaliza setup, não direção. Usuário escolhe Track YES ou Track NO baseado em opinião fundamental.

### 2.5. Resolution Anchor Detector (Fase 2.5 — pendente)
Pré-requisito: 2-3 ciclos de resolução de séries recorrentes com snapshots completos.

### 3. Hype/Reality Gap Detector (Fase 3 — pendente)
Movimento pós-anúncio cruzado com padrão histórico de "hype decay". Usa CLOB API.

### 4. Benchmark divergence detector (futuro)

### 5. Cleanup Stale Signals (job, não detector — adicionado v5)
Roda a cada 5min como parte do detector_runner. Para cada sinal não-dismissed/não-acted_on, verifica `MAX(snapshot.captured_at)` do event. Se >1h atrás, marca `dismissed=true`. Cross-market multi-event: dismissa basket se QUALQUER member stale.

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
  event_group_slug text,
  event_metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Trigger BEFORE UPDATE (NOVO v5)
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_updated_at BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### `polymarket_snapshots`
Política de retenção: 7 dias. Inclui `idx_snapshots_event_captured(event_id, captured_at DESC)` pra performance do calendar-driven detector e cleanup.

### `detected_signals`
Tipos: `cross_market_intra` | `cross_market_inter` | `calendar_driven` | `hype_reality_gap` | `resolution_anchor`.

**Mudança v5:** `expires_at` agora reflete end_date do market, não tempo decorrido após criação.

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

### `my_bet_legs` (PENDENTE — próximo prompt)

```sql
create table my_bet_legs (
  id uuid primary key default gen_random_uuid(),
  bet_id uuid not null references my_bets(id) on delete cascade,
  event_id uuid not null references events(id),
  outcome text not null,
  entry_price numeric not null,
  stake_usd numeric not null,
  shares numeric not null,
  closing_price numeric,
  pnl_usd numeric,
  clv numeric,
  created_at timestamptz default now(),
  closed_at timestamptz
);
```

Pra cross-market basket: 1 row em `my_bets` (mãe) + N rows em `my_bet_legs` (filhas). Pra calendar_driven single-leg: só `my_bets`, sem legs filhas.

### `system_config`
1 row única (id=1). Lida com cache 60s.

```sql
create table system_config (
  id integer primary key,
  bankroll_usd numeric not null default 100,
  max_stake_pct numeric not null default 0.03,
  cross_market_max_stake_pct numeric not null default 0.10,
  kelly_fraction numeric not null default 0.25,
  min_confidence_alert numeric not null default 0.70,
  drawdown_stop_pct numeric not null default 0.20,
  telegram_chat_id text,
  daily_report_hour integer default 9,
  cross_market_log_threshold numeric default 0.03,
  cross_market_high_confidence_threshold numeric default 0.08,
  cross_market_dedup_window_minutes integer default 30,  -- NÃO MAIS USADO após v5 (dedup sem janela)
  inter_market_min_members integer default 3,
  inter_market_min_total_volume_24h numeric default 10000,
  min_expected_edge_pct numeric default 1.5,
  notify_min_edge_pct numeric default 2.5,
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

**Components ativos (v5):**
- `collector` — coletor a cada 3min
- `detector_runner` — orquestrador
- `cross_market_intra`, `cross_market_inter`, `calendar_driven_detector` — detectores
- `cleanup_stale_signals` — job de auto-cleanup
- `telegram_bot` — startup do bot
- `bot_command` — comando recebido
- `bot_notify` — sinal enviado pelo bot
- `bot_error` — falha em handler do bot

## Estrutura de arquivos

```
prediction-radar/
├── src/
│   ├── collectors/
│   │   ├── polymarket.ts              ✅
│   │   └── categorizer.ts             ✅ (flag is_ai_tech)
│   ├── detectors/
│   │   ├── runner.ts                  ✅ (4 detectors ativos: 3 + cleanup)
│   │   ├── cross-market.ts            ✅
│   │   ├── cross-market-inter.ts      ✅ (v5: staleness + dedup sem janela + expires_at)
│   │   ├── calendar-driven.ts         ✅ (v5: outcomes dinâmico + staleness + expires_at)
│   │   └── hype-reality-gap.ts        🟡 stub
│   ├── jobs/
│   │   ├── retention.ts               ✅
│   │   └── cleanup-stale-signals.ts   ✅ NOVO v5
│   ├── bot/                           ✅
│   │   ├── index.ts                   ✅ (v5: delay 60s startup + logEvent startup)
│   │   ├── auth.ts
│   │   ├── format.ts                  ✅ (v5: mensagens redesenhadas)
│   │   ├── keyboards.ts               ✅ (v5: botões com nomes reais)
│   │   ├── message-utils.ts           ✅ NOVO v5 (sendLongMessage, replyLongMessage, splitTextIntoChunks)
│   │   ├── notify.ts                  ✅ (v5: sendLongMessage + bot_notify log)
│   │   └── handlers/
│   │       ├── signals.ts             ✅ (v5: try/catch por iteração + replyLongMessage + bot_notify)
│   │       ├── track.ts
│   │       ├── positions.ts
│   │       ├── status.ts
│   │       ├── bankroll.ts
│   │       └── config_cmd.ts
│   ├── claude/                        🟡 stub (Fase 5)
│   ├── lib/
│   │   ├── supabase.ts                ✅
│   │   ├── polymarket-api.ts          ✅
│   │   ├── normalize.ts               ✅
│   │   ├── logger.ts                  ✅ (v5: try/catch interno)
│   │   ├── kelly.ts                   ✅
│   │   ├── config.ts                  ✅
│   │   ├── format-helpers.ts          ✅ NOVO v5 (truncate, confidenceStars, describeVolatility, calcCalendarDrivenStake, calcMinBankroll)
│   │   └── fees.ts                    ✅
│   ├── types/index.ts                 ✅
│   └── index.ts                       ✅
├── package.json                       (script "bot": "tsx src/bot/index.ts")
├── tsconfig.json
└── railway.toml
```

## Roadmap

### Fase 1, 1.5, 1.6, 2 (parcial), 4 — concluídas
Cross-Market intra + inter, instrumentação ampla, calendar-driven detector, Telegram bot completo, hardening v5.

### Próximos passos imediatos (em ordem)

#### 1. Migration `my_bet_legs` + track expandido (opção 3)
- Criar tabela `my_bet_legs` (FK pra `my_bets`)
- Atualizar `src/bot/handlers/track.ts`:
  - calendar_driven: salva outcome com nome real (values[0] ou values[1] do callback), 1 linha em my_bets, sem legs filhas
  - cross_market_inter: pergunta stake total, divide proporcional, insere mãe em my_bets + N filhas em my_bet_legs com signal_id igual
- Mostra composição detalhada na confirmação ("Pra executar:" lista cada leg pronta pra colar)

#### 2. Positions e close adaptados pra basket
- `/positions`: mostra basket como linha-mãe expandível com legs
- Close conversation: detectar se é basket, oferecer "fechar tudo" ou "fechar leg X"
- Atualizar closing_price, pnl_usd, clv por leg

#### 3. Fix do coletor pra detectar resolved markets
- Detectar quando event sai do feed `closed=false` da Gamma API (comparar event_ids do ciclo atual vs banco)
- Confirmar resolução via fetch individual `?id={id}` (verificar `closed=true` + `resolved=true`)
- Re-coletar 2-3 ciclos antes de marcar como resolved (evita falso positivo)
- Marcar `status='resolved'` no banco, popular `resolved_outcome` e `resolved_at` (a adicionar)
- NÃO dismissar sinais relacionados (deixar pra track record futuro)
- Atualizar `my_bets.closing_price` / `pnl_usd` / `clv` automaticamente quando resolved

#### 4. Operar 1ª trade real
- Quando aparecer sinal calendar_driven em AI/Tech ou outro com domínio
- Stake $1-3, single-leg
- Validar fluxo /track + /positions + /close

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

## Backlog (não-urgente)

- **Shares com 1 casa decimal** em vez de 2 (cosmético): "1.5 shares" deveria ser "1.50 shares"
- **Truncate dinâmico de mensagens muito longas**: hoje sendLongMessage divide em N chunks. Se 1 sinal precisar de 4+ chunks, considerar truncar lista (top 15 cenários + "X cenários omitidos")
- **`cross_market_dedup_window_minutes`** em system_config não é mais usado — pode ser removido em migration futura

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
11. **Sinais "morrem" quando market para de receber snapshots, não por tempo decorrido** (v5)

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

## Bugs corrigidos na sessão atual (referência histórica v5)

1. **Filtro de outcomes hardcoded como 'Yes'.** Detector calendar_driven usava `.eq('outcome', 'Yes')` mas coletor salva com nome real do competidor. Resultado: 95% dos markets ignorados. Fix: lê dinamicamente `event.outcomes.values[0]`.

2. **Detector estava criando duplicatas a cada 30min.** Query de dedup tinha `.gte('created_at', dedupCutoff)`. Sinal criado às 11:25, próximo ciclo às 12:00 considerado fora da janela → criava novo. Fix: removido filtro de created_at. Enquanto sinal está `dismissed=false AND acted_on=false`, detector apenas atualiza o existente.

3. **expires_at hardcoded em now+30min.** Sinais expiravam por tempo, não por estado real do market. Fix: calendar_driven usa `event.end_date`, cross_market_inter usa end_date mais cedo dos members. Aplicado em INSERT e UPDATE.

4. **Markets resolvidos não eram detectados.** Quando market resolve, sai do feed `closed=false` mas `events.status` continua 'active'. Detectores reavaliavam infinitamente. Fix parcial v5: filtro de staleness ignora events sem snapshot <30min. Fix completo: pendente (item #3 do roadmap).

5. **Mensagens >4096 chars eram silenciosamente recusadas pelo Telegram.** Sinal Sinner French Open (40 jogadores, ~6000 chars) nunca chegava. Fix: `sendLongMessage` divide em chunks de até 3800 chars em boundaries semânticas, 2ª+ como reply da 1ª.

6. **Bot em crash-loop por erro 409.** Quando Railway restartava, nova instância subia em segundos mas Telegram demora 30-60s pra esquecer instância antiga. Resultado: nova conflita com ghost da antiga, crasha, restart, loop infinito. Fix: delay de 60s em `bot.start()`.

7. **logEvent do bot quase nunca gravava em system_logs.** 1 log na vida toda. Sem visibilidade pra debug. Fix: try/catch interno em logEvent + chamadas em pontos críticos (startup, comando, sinal enviado, erro).

8. **URLs do Polymarket quebradas.** Bot usava `polymarket_id` numérico ou slug do market individual. Fix: capturar `event_group_slug` de `market.events[0].slug` no coletor; bot busca via lookup no DB.

## Configuração atual relevante (system_config id=1)

```
bankroll_usd: 101.59
max_stake_pct: 0.03
cross_market_max_stake_pct: 0.10
min_expected_edge_pct: 1.5
notify_min_edge_pct: 2.5
log_expected_edge_pct: 0.5
collector_min_volume_24h: 10000
collector_min_liquidity: 20000
inter_market_min_members: 3
inter_market_min_total_volume_24h: 10000
cross_market_dedup_window_minutes: 30  -- não mais usado
telegram_chat_id: 8299632096
```

## Migrations já aplicadas (v4 + v5)

```sql
-- v4
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_group_slug text;

ALTER TABLE system_config ADD COLUMN IF NOT EXISTS notify_min_edge_pct numeric NOT NULL DEFAULT 2.5;

ALTER TABLE system_config ADD COLUMN IF NOT EXISTS cross_market_max_stake_pct numeric NOT NULL DEFAULT 0.10;

CREATE INDEX IF NOT EXISTS idx_snapshots_event_captured 
  ON polymarket_snapshots(event_id, captured_at DESC);

UPDATE system_config SET bankroll_usd = 100.00 WHERE id = 1;

-- v5
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_updated_at ON events;
CREATE TRIGGER events_updated_at BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

## Migrations pendentes (próximo prompt)

```sql
-- my_bet_legs (item #1 do roadmap)
CREATE TABLE my_bet_legs (
  id uuid primary key default gen_random_uuid(),
  bet_id uuid not null references my_bets(id) on delete cascade,
  event_id uuid not null references events(id),
  outcome text not null,
  entry_price numeric not null,
  stake_usd numeric not null,
  shares numeric not null,
  closing_price numeric,
  pnl_usd numeric,
  clv numeric,
  created_at timestamptz default now(),
  closed_at timestamptz
);

CREATE INDEX idx_my_bet_legs_bet_id ON my_bet_legs(bet_id);
CREATE INDEX idx_my_bet_legs_event_id ON my_bet_legs(event_id);

-- resolved_at em events (item #3 do roadmap)
ALTER TABLE events ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
```
