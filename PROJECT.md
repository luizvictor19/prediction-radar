# Prediction Radar — Sistema Pessoal (Foco AI + Big Tech)

## Contexto e propósito

Sistema **pessoal e privado** pra detectar oportunidades em mercados Polymarket relacionados a AI e Big Tech. Sem produto público, sem clientes, sem marca. Apenas eu (Luiz) usando.

**Domínio escolhido:** AI/LLM (releases, benchmarks, capabilities) + Big Tech (earnings, lançamentos, decisões regulatórias).

**Objetivo de longo prazo:** gerar histórico documentado de operações com edge mensurável, que possa eventualmente virar:
- Sistema vendável (código + metodologia)
- Base pra SaaS futuro (se regulação BR mudar)
- Track record pra captação de capital ou consultoria

**Princípio operacional:** o sistema NÃO toma decisões — apenas detecta sinais e organiza informação. Decisão final é minha, baseada em análise fundamental + sinal técnico.

## Realidade regulatória (Brasil, abril 2026)

CMN baniu prediction markets via Resolução 5.298 (vigente em 4 de maio de 2026). Polymarket bloqueado pela Anatel. Operação pessoal continua viável via VPN + USDC/Polygon, mas:

- Sistema é puramente pessoal, sem distribuição
- Sem comercialização enquanto regulação BR for desfavorável
- Tracking fiscal cuidadoso (operações em cripto têm obrigação de declaração)
- Capital alocado apenas o que posso perder sem afetar vida

## Salvaguardas inegociáveis

1. **Tracking obrigatório de TODA operação** — antes de executar, registro em planilha completa com tese articulada (1-3 frases). Se tese não cabe em 3 frases coerentes, não opera.

2. **Bankroll fixo de US$ 500 nas primeiras 8 semanas.** Não escalar até ter dado de CLV positivo após 50+ operações.

3. **Cap de 3% do bankroll por operação** (US$ 15 max em US$ 500). Sem exceção, independente de convicção.

4. **Drawdown stop:** se perder 20% do bankroll em 30 dias, pausa total de 7 dias. Revisão obrigatória das operações antes de retomar.

5. **Detector NÃO é alterado retrospectivamente** pra explicar operação ruim. Mudanças no código só por hipótese geral, documentada em commit.

## Abordagem: paralela

Construção do sistema + estudo de domínio + operação manual acontecem **em paralelo**, alimentando-se mutuamente:

- Sistema gera dados que aprofundam estudo
- Estudo informa quais detectores construir
- Operação manual testa hipóteses geradas pelos dois

## Stack técnica

- **Backend único**: Node.js + TypeScript (monolito)
- **Banco**: Supabase (Postgres + pg_cron pra schedules)
- **Hospedagem**: Railway (MVP) → Fly.io ou VPS Hetzner ($4-5/mês) quando estourar free tier
- **APIs externas**: Polymarket CLOB API (gratuita) + Polymarket Gamma API (metadados)
- **Análise/relatórios**: Claude API (claude-sonnet-4-5)
- **Interface principal**: Telegram bot (alertas + comandos)
- **Dashboard secundário**: Next.js + Tailwind + shadcn/ui (consulta detalhada)
- **VPN**: Mullvad ou ProtonVPN (operação manual no Polymarket)

## Foco de mercados monitorados

**Categorias prioritárias:**
- AI/LLM: releases (GPT, Claude, Gemini, Llama), benchmarks (Arena, MMLU, GPQA), capabilities específicas
- Big Tech: earnings (Apple, Microsoft, Google, Meta, Amazon, Nvidia), lançamentos de produto, decisões regulatórias (DoJ, FTC, EU)
- AI infrastructure: GPU shortage, deals NVIDIA, expansões de datacenter
- AI safety/policy: AI Act EU, executive orders, restrições de chip

**Filtros do coletor:**
- Volume_24h > $5k (liquidez mínima)
- Resolução entre 7 dias e 90 dias (sweet spot operacional)
- Categoria identificada como AI/Tech via keywords + manual tagging

## Arquitetura

```
┌────────────────────────────────────────────────────┐
│  Railway (Node.js process único)                   │
│                                                     │
│  ┌──────────────┐    ┌──────────────┐              │
│  │  Collector   │ →  │  Detectors   │              │
│  │  Polymarket  │    │  (3 inicial) │              │
│  │  (cron 3min) │    │  (cron 5min) │              │
│  └──────┬───────┘    └──────┬───────┘              │
│         │                    │                      │
│         ▼                    ▼                      │
│  ┌──────────────────────────────────┐              │
│  │      Supabase (Postgres)         │              │
│  └──────────────────────────────────┘              │
│         │                    │                      │
│         ▼                    ▼                      │
│  ┌──────────────┐    ┌──────────────┐              │
│  │ Telegram Bot │    │  Web Dashboard│             │
│  │  (alertas)   │    │  (consulta)   │             │
│  └──────────────┘    └──────────────┘              │
└────────────────────────────────────────────────────┘
```

## Detectores específicos pro domínio

### 1. Hype/Reality Gap detector
Identifica mercados onde preço move forte após notícia de release/anúncio MAS:
- Benchmarks específicos ainda não publicados
- Capabilities reais não verificáveis
- Histórico mostra que hype inicial tipicamente decai 20-40% após benchmarks reais saírem

Exemplo: "Modelo X anunciado, mercado subiu pra 80% que vai liderar Arena. Histórico mostra que 70% dos modelos anunciados não chegam ao top 3 nos benchmarks finais."

### 2. Calendar-driven detector
Mercados sobre eventos com data conhecida (earnings, conferences, releases anunciados). Detecta:
- Mercados ainda mal precificados X dias antes do evento
- Movimento típico de preço pré-evento vs pós-evento
- Oportunidades de entrada baseadas em padrão histórico

Exemplo: "Apple earnings em 3 dias, mercado em 0.55. Histórico mostra que mercados sobre earnings movem média de 15% nos 24h pré-anúncio."

### 3. Cross-market consistency detector
Identifica mercados correlatos com probabilidades inconsistentes matematicamente.

Exemplo: "P(GPT-5 lança até junho) = 60%. P(GPT-5 lança até dezembro) = 65%. Inconsistência: probabilidade até dezembro deveria ser ≥ até junho. Arbitragem implícita."

### 4. (Futuro, semana 6+) Benchmark divergence detector
Pra mercados específicos de "modelo X vai ranquear top N em benchmark Y", compara expectativa de mercado com análise técnica do modelo (parâmetros, training data, capabilities reportadas).

## Schema Supabase

```sql
-- Mercados Polymarket monitorados
create table events (
  id uuid primary key default gen_random_uuid(),
  polymarket_id text not null unique,
  slug text,
  title text not null,
  category text,             -- 'ai_llm' | 'big_tech' | 'ai_infra' | 'ai_policy' | 'other'
  sub_category text,         -- 'model_release' | 'benchmark' | 'earnings' | 'regulation' | etc
  description text,
  outcomes jsonb,
  volume_total numeric,
  volume_24h numeric,
  liquidity numeric,
  end_date timestamptz,
  status text default 'active',
  resolved_outcome text,
  tracked boolean default true,    -- se vou monitorar ativamente
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_events_status_volume on events(status, volume_24h desc);
create index idx_events_category on events(category) where tracked = true;

-- Snapshots de orderbook
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

-- Sinais detectados
create table detected_signals (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  signal_type text not null,          -- 'hype_reality_gap' | 'calendar_driven' | 'cross_market'
  confidence_score numeric(3,2),
  reasoning text,
  metadata jsonb,
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

-- Operações manuais (sincronizadas com planilha externa)
create table my_bets (
  id uuid primary key default gen_random_uuid(),
  external_id text,              -- ID da planilha (rastreabilidade)
  event_id uuid references events(id),
  signal_id uuid references detected_signals(id),
  outcome text not null,
  entry_price numeric(5,4) not null,
  closing_price numeric(5,4),
  resolution_price numeric(5,4),
  stake_usd numeric(10,2) not null,
  shares numeric(10,4),
  thesis text,                    -- a tese registrada
  thesis_type text,               -- 'fundamental' | 'technical' | 'mixed' | 'gut'
  confidence_self numeric(3,1),   -- 1-10
  result text,
  pnl_usd numeric(10,2),
  clv numeric(5,4),
  notes text,
  placed_at timestamptz default now(),
  closed_at timestamptz
);

-- Configuração
create table system_config (
  id int primary key default 1,
  bankroll_usd numeric(10,2) not null default 500,
  max_stake_pct numeric(4,3) default 0.03,
  kelly_fraction numeric(3,2) default 0.25,
  min_confidence_alert numeric(3,2) default 0.75,
  drawdown_stop_pct numeric(4,3) default 0.20,
  telegram_chat_id text,
  daily_report_hour int default 9,
  updated_at timestamptz default now()
);

-- Logs
create table system_logs (
  id bigserial primary key,
  component text not null,
  status text not null,
  message text,
  metadata jsonb,
  created_at timestamptz default now()
);
```

## Estrutura de pastas

```
prediction-radar/
├── src/
│   ├── collectors/
│   │   ├── polymarket.ts
│   │   └── categorizer.ts        # auto-categorize markets em ai/tech vs other
│   ├── detectors/
│   │   ├── hype-reality-gap.ts
│   │   ├── calendar-driven.ts
│   │   └── cross-market.ts
│   ├── telegram/
│   │   ├── bot.ts
│   │   ├── commands/
│   │   └── alerts.ts
│   ├── claude/
│   │   ├── report.ts
│   │   └── prompts.ts
│   ├── lib/
│   │   ├── supabase.ts
│   │   ├── polymarket-api.ts
│   │   ├── kelly.ts
│   │   └── normalize.ts
│   ├── types/
│   │   └── index.ts
│   └── index.ts
├── app/                          # Next.js dashboard (opcional, fase 2)
├── supabase/
│   └── migrations/
├── scripts/
│   ├── seed-categories.ts        # tag inicial de mercados ai/tech
│   └── backfill.ts
├── .env.example
├── package.json
├── tsconfig.json
└── railway.toml
```

## Roadmap (8 semanas, 3 tracks paralelas)

### Semanas 1-2 — Fundação técnica + setup de estudo

**Track A (Técnico, 4-5h/dia):**
- Setup repo + TypeScript + ESLint
- Supabase projeto + schema inicial via migration
- Coletor Polymarket: Gamma + CLOB APIs
- Categorização inicial de mercados (filtro AI/tech)
- Deploy Railway + cron rodando

**Track B (Estudo, 2-3h/dia):**
- Setup ferramentas: Twitter list privada (Tier 1+2), assinaturas de newsletters
- Criar Thesis Tracker (Notion ou Google Doc)
- Calendar de earnings/eventos próximos 6 meses
- Ler 5 papers fundamentais (lista no Currículo)

**Track C (Operação, contínua):**
- Configurar planilha de tracking (Google Sheets)
- Bankroll US$ 500 alocado
- Operações pequenas (max US$ 15) em mercados AI/tech, todas registradas

**Critério de sucesso semana 2:** sistema coletando dados, primeiras 5-10 operações registradas, hábito de estudo estabelecido.

### Semanas 3-4 — Primeiro detector + aprofundamento

**Track A:**
- Implementar **Calendar-driven detector** primeiro (mais simples, base de dado mais sólida)
- Backtest com dados coletados nas semanas 1-2
- Calibrar thresholds

**Track B:**
- Estudo focado em padrões de release de big labs
- Documentar no Thesis Tracker: opinião sobre próximos 3-6 meses
- Acompanhar Twitter Tier 1+2 diariamente

**Track C:**
- 15-25 operações totais registradas
- Primeira retrospectiva: qual sub-categoria funcionou melhor?

**Critério de sucesso semana 4:** detector gerando sinais úteis, 30+ operações trackadas, tese sobre setor mais clara.

### Semanas 5-6 — Telegram + segundo detector

**Track A:**
- Telegram bot setup + comandos básicos
- Sistema de alertas push pra sinais high-confidence
- Implementar **Cross-market consistency detector**
- Comando `/today` retorna sinais ativos

**Track B:**
- Continuar estudo, ler 1 paper completo por semana
- Atualizar Thesis Tracker com calibração: o que acertei, o que errei

**Track C:**
- 40-60 operações totais
- Calcular CLV agregado: positivo? negativo? neutro?
- Identificar viés sistemático nas próprias operações

**Critério de sucesso semana 6:** telegram operacional, sinais sendo gerados e operados (ou descartados conscientemente), CLV mensurável.

### Semanas 7-8 — Hype/Reality gap + Claude integration

**Track A:**
- Implementar **Hype/Reality Gap detector** (mais complexo, exige histórico)
- Integração Claude API pro relatório diário
- Comando `/today` melhorado com análise contextual

**Track B:**
- Avaliação de progresso de estudo: estou mais informado que mercado médio?
- Refinar Thesis Tracker como ferramenta de operação

**Track C:**
- 60-100 operações totais
- **Avaliação honesta de meio-prazo:**
  - CLV agregado positivo?
  - Detectores estão gerando sinais que viraram operações lucrativas?
  - Estudo está se traduzindo em melhor calibração?

**Critério de sucesso semana 8:** sistema completo funcional, dados suficientes pra primeira decisão estratégica.

### Semana 8 — Decisão honesta

Olho a planilha e respondo com dado:
1. Meu CLV agregado em 60-100 operações é positivo?
2. Em qual sub-categoria (AI release vs big tech earnings vs benchmarks) tenho melhor performance?
3. Os detectores estão me ajudando ou só gerando ruído?
4. Estou sustentando 2-3h de estudo diário ou caiu pra menos?
5. Estou registrando 100% das operações ou já comecei a "esquecer" as ruins?

**Cenários:**
- **CLV positivo + disciplina mantida:** continuar, aumentar bankroll gradualmente, refinar
- **CLV neutro + disciplina mantida:** ajustar foco, talvez sub-especializar mais
- **CLV negativo:** pausa de 7 dias, análise profunda do que está dando errado
- **Disciplina caiu:** problema não é o sistema — é execução. Reset.

## Currículo de estudo (referência)

Material completo está em documento separado: `STUDY_CURRICULUM.md` (a ser criado).

Inclui:
- 20+ pessoas pra seguir no Twitter (3 tiers)
- 7 newsletters obrigatórias
- Papers fundamentais
- Benchmarks pra acompanhar
- Canais YouTube
- Calendário mental de releases e earnings

## Métricas de sucesso (3 meses)

- 100+ operações registradas com tracking completo
- CLV médio mensurável (objetivo: positivo)
- Bankroll preservado ou crescido (objetivo: drawdown máximo < 30%)
- 3 detectores funcionais em produção
- Thesis Tracker com 8+ semanas de evolução documentada
- Decisão informada sobre escalar ou pivotar

## Princípios de execução

1. **Ferramenta amplifica edge, não cria edge** — disciplina e estudo vêm primeiro, sempre
2. **Tracking é não-negociável** — sem exceções, sem "depois eu coloco"
3. **Bankroll pequeno na fase de calibração** — protege capital E protege psicológico
4. **Detector e operação evoluem juntos** — mas sem retrofit pra esconder erro
5. **Estudo é trabalho de domínio, não hobby** — 2-3h diárias, todos os dias, mesmo finais de semana parciais
6. **Dado vence intuição** — quando planilha contradiz sua opinião, planilha está certa
7. **Aceitar "sem edge" é sucesso, não falha** — descobrir em 8 semanas que tech não é seu domínio é US$ 50k de tempo poupado

## Variáveis de ambiente (.env)

```
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# Polymarket
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
POLYMARKET_CLOB_URL=https://clob.polymarket.com

# Anthropic
ANTHROPIC_API_KEY=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_AUTHORIZED_CHAT_ID=

# App
NODE_ENV=production
LOG_LEVEL=info
```

## Próximos passos imediatos

### Hoje:
1. Criar planilha "Polymarket Operations Log" no Google Sheets com estrutura definida
2. Confirmar bankroll de US$ 500 alocado
3. Criar Twitter list privada com pessoas Tier 1
4. Assinar 3 newsletters mínimas: Interconnects, Import AI, Pragmatic Engineer

### Amanhã:
1. Criar repo `prediction-radar` privado no GitHub
2. `npm init` + setup TypeScript
3. Conta Supabase + criar projeto
4. Conta Railway + ligar com GitHub
5. Bot Telegram via @BotFather, salvar token

### Semana 1:
1. Levar PROJECT.md pro Claude Code, executar setup técnico inicial
2. Coletor Polymarket rodando 24h/dia
3. Primeira operação registrada na planilha (com tese articulada)
4. 2h de estudo diário começa imediatamente

## Notas de segurança

- Repo privado no GitHub
- Telegram bot autorizado só pro meu chat ID
- API keys via env vars, nunca commitadas
- Backup semanal do Supabase pra storage local
- Operação manual no Polymarket sempre via VPN
- Planilha de operações em conta privada, não compartilhada
