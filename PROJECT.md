# Prediction Radar — Sistema Pessoal

> ⚠️ **Este documento descreve o estado de maio/2026 (v7). Está desatualizado como
> direção.** A Spec 000 (contenção, agosto/2026) mudou três coisas que atravessam
> quase tudo abaixo:
>
> - **Coleta** — a varredura por volume e o early-markets estão desligados por
>   flag em `system_config`. Quem coleta hoje é a descoberta por `startDate` mais
>   a watchlist de esports, com cadência por proximidade da partida.
> - **Detectores** — os cinco genéricos (`cross_market_intra`,
>   `cross_market_inter`, `calendar_driven`, `hype_reality_gap`, `early_market`)
>   estão desligados por flag. Serão desligados de vez, não expandidos.
> - **Retenção** — a série de esports vive em `esports_snapshots`, particionada
>   por dia, limpa por DROP PARTITION e nunca apagada pela retenção antiga.
>
> O foco estreitou para esports (CS2 primeiro, depois LoL e futebol), com o
> objetivo de acumular série temporal de qualidade para backtest e, depois, um
> agente analista.
>
> **Fonte de verdade sobre o que fazer agora: `specs/`.** Este arquivo continua
> valendo como registro histórico — para entender como o sistema foi construído
> (tabelas, detectores, coletores, comandos do bot), salvaguardas de operação e
> as decisões que levaram até aqui. Para o que roda hoje e com que cron, ver
> `docs/processos-automaticos.md`. Para a superfície de comandos do bot no
> Telegram, ver `docs/comandos-do-bot.md`.

> v7 — atualizado pós-sessão de bugs do auto-resolver, cleanup truncation, fix de cauda no early_market, padronização de formato de data, refactor de hardcodes pra config-driven, open_legs collector de 30s pra 10s, validações reais em produção (Bitcoin May 7, Aston Villa, Forest, Braga). Sistema agora rodando sólido. Próxima fase: validar com volume real (30+ trades) antes de Fase 5 (IA).

## Contexto e propósito

Sistema **pessoal e privado** pra detectar oportunidades em prediction markets do Polymarket. Sem produto público, sem clientes, sem marca. Apenas eu (Luiz) usando.

**Modelo operacional:** instrumentação ampla, decisão filtrada.
- Sistema monitora **todas as categorias** com volume e liquidez relevantes
- Detectores trabalham em qualquer market, agnósticos a categoria
- Sinais são ranqueados por **edge líquido** (em mai/2026 fees são zero na prática, então edge bruto = edge líquido)
- **Eu decido manualmente** quais sinais operar, com base em:
  1. Força do sinal (edge ou setup informacional)
  2. Tese fundamental (quando tenho conhecimento de domínio)
  3. Combinação dos dois (cenário ouro)
- Tracking registra `domain_confidence` por operação pra analytics futuros

**Domínio com vantagem informacional:** AI/LLM e Big Tech (acompanho LMSYS Arena, releases, benchmarks). Mas não é filtro de descarte.

**Princípio operacional:** o sistema NÃO toma decisões — apenas detecta sinais e organiza informação. Decisão final é minha.

## Realidade regulatória (Brasil, 2026)

CMN baniu prediction markets via Resolução 5.298. Polymarket bloqueado pela Anatel. Operação pessoal continua viável via VPN + USDC/Polygon, mas:
- Sistema é puramente pessoal, sem distribuição
- Sem comercialização enquanto regulação BR for desfavorável
- Tracking fiscal cuidadoso
- Capital alocado apenas o que posso perder sem afetar vida

## Salvaguardas inegociáveis

1. **Tracking obrigatório de TODA operação** — antes de executar, registro com tese articulada (1-3 frases) + categoria + domain_confidence (1-10).
2. **Bankroll atual:** cash $47.08 + portfolio ~$253 = bankroll ~$300. Não escalar até CLV positivo após 30+ operações.
3. **Cap de 3% do bankroll por operação** pra single-leg. Cap de 10% pra cross-market arb.
4. **Drawdown stop:** 20% do bankroll em 30 dias = pausa de 7 dias.
5. **Detector NÃO é alterado retrospectivamente** pra explicar operação ruim.
6. **Edge líquido após fees é critério, não desvio bruto.**

## Stack técnica

- **Backend único**: Node.js + TypeScript (ESM, sem build step, executa via tsx)
- **Banco**: Supabase (Postgres) — Pro plan + Micro compute (8GB)
- **Hospedagem**: Railway — **2 services no mesmo repo** (`prediction-radar` = coletores+detectores; `telegram-bot` = bot)
- **APIs**: Polymarket Gamma API + CLOB
- **Análise**: Claude API (postergada pra Fase 5)
- **Interface**: Telegram bot (grammy + @grammyjs/conversations)
- **Dashboard**: Next.js + Tailwind + shadcn/ui — Fase 6
- **VPN**: Mullvad ou ProtonVPN

## Estado atual do sistema (v7)

### Tabelas
- `events` — markets do Polymarket, com `sports_market_type`, `line`, `is_new_market`, `start_date`, `resolved_at`
- `polymarket_snapshots` — preços ao longo do tempo, ambos outcomes
- `detected_signals` — sinais com flags `alerted`, `acted_on`, `dismissed`, `user_dismissed_at`, `user_action_type`
- `my_bets` — guarda-chuva da decisão (signal_id, event_id nullable, thesis_type)
- `my_bet_legs` — detalhes operacionais (1 bet = 1+ legs)
- `system_config` — cash_usd, thresholds, e agora 4 novos campos configuráveis (`signal_ttl_minutes`, `signal_cooldown_minutes`, `stale_cleanup_threshold_hours`, `dismiss_stale_cutoff_minutes`)
- `system_logs` — debug com retention de 30 dias
- `ai_analyses` — infra IA pronta (vazia, Fase 5)

### Detectores ativos (6)
1. **calendar_driven** — sinal de atenção (mercado calmo + perto de resolver)
2. **cross_market_inter** — basket multi-outcome com soma ≠ 1.0
3. **cross_market_intra** — versão dentro do mesmo neg_risk_market (raramente flagged em produção)
4. **hype_reality_gap** — momentum + liquidity, com filtro de cauda
5. **early_market** — mercados recém-abertos (<24h) com smart money calibrando, filtro de cauda 5%-95%
6. **cleanup_stale_signals** — manutenção interna

### Coletores ativos
- **collector geral** (3min) — todos os markets ativos do Polymarket (~46k → ~1300 persistidos)
- **open_legs_collector** (10s) — preços frescos das legs abertas
- **early_markets_collector** (5min) — mercados recém-abertos
- **resolved_detector** (no fim do collector geral) — auto-fecha legs quando UMA resolve

### Comandos do bot
- `/signals [filtro]` — sinais ativos
- `/positions` — bets abertas com "to win", valor atual, mercado eliminado mostra ~$0.00
- `/status` — bankroll dinâmico, bets fechadas, último detector com BRT
- `/cash` — interativo (substitui /topup e /withdraw)
- `/config` — thresholds atuais
- `/register` — bet manual
- `/edit` — editar leg aberta
- `/help` — ajuda

### Botões em /positions
- **Single leg:** "Fechar posição"
- **Basket:** "Fechar tudo" + "Fechar leg específica" (NOVO)

### Botões em /signals
- **calendar_driven:** Track Yes / Track No / 🧠 Analisar / Dismiss
- **cross_market_inter:** Track basket / ✏️ Tese própria / 🧠 Analisar / Dismiss
- **hype_reality_gap, early_market:** Track Yes / Track No / 🧠 Analisar / Dismiss

### Auto-resolver (validado em produção)

Detecta quando event sai do feed do Polymarket OU events com leg aberta, fetcha API direto, fecha legs se UMA confirmou resolução. Valida em 3 cenários:
- ✅ Win com payout (Bitcoin May 7 = +$10.44)
- ✅ Loss sem payout (Forest UEFA = -$5.22)
- ✅ Win com payout (Braga UEFA = +$0.40)

Ajusta cash automaticamente, marca event como `resolved`, leg como `closed_at` preenchido.

### Cash/Bankroll dinâmico
- `cash_usd` persistido em system_config (decremento/incremento automático)
- `portfolio_value_usd` calculado on-the-fly (snapshots × shares)
- `bankroll = cash + portfolio_value` calculado on-the-fly

### Schema usa numeric (precisão exata)
- Banco em `numeric(10,2)` pra dinheiro, `numeric(5,4)` pra preços
- Float em memória mas banco coage pra numeric ao salvar
- Sem acúmulo de erro de centavos

## Configuração system_config atual

```
cash_usd                              $47.08
max_stake_pct                         0.030 (3%)
cross_market_max_stake_pct            0.10 (10%)
kelly_fraction                        0.25
min_confidence_alert                  0.75
drawdown_stop_pct                     0.20
cross_market_log_threshold            0.03
cross_market_high_confidence_threshold 0.08
cross_market_dedup_window_minutes     60
inter_market_min_members              3
inter_market_min_total_volume_24h     10000
snapshot_retention_days               1
system_logs_retention_days            30
min_expected_edge_pct                 1.5
notify_min_edge_pct                   2.5
log_expected_edge_pct                 0.5
collector_min_volume_24h              10000
collector_min_liquidity               20000

# Configuráveis novos (v7)
signal_ttl_minutes                    30
signal_cooldown_minutes               60
stale_cleanup_threshold_hours         1
dismiss_stale_cutoff_minutes          15
```

Cache de 60s. Mudanças refletem em ~1min sem deploy.

## Resumo da sessão anterior (8/maio)

### Bugs corrigidos
1. **Auto-resolver — closed=true em seenPolymarketIds**: collector geral marcava markets fechados como "vistos", auto-resolver ignorava. Fix: só marca como visto markets com `closed=false`.
2. **Auto-resolver — limit 500 sem priorização**: events com leg aberta podiam ficar fora dos 500 candidatos. Fix: busca em 2 etapas, prioritários sempre incluídos.
3. **Cleanup truncation — Supabase limita 1000 rows**: query buscava todos snapshots da última 1h, batia limit, dispensava 70% dos signals erroneamente. Fix: verificação por event individual em batches paralelos.
4. **Filtro de cauda no early_market**: detector gerava sinais pra mercados em cauda extrema. Fix: filtro 5%-95%.
5. **Cross_market_intra — Invalid time value**: campo `cross_market_dedup_window_minutes` ausente em system_config. Fix: migration + fallback.

### Features novas
- Botão "Fechar leg específica" em basket
- Mercado eliminado mostra "~$0.00 (mercado eliminado)" no /positions
- Padronização do formato de data no early_market (`Aberto há 8h 19min · UTC (BRT)`)

### Refactors
- Retention usa `snapshot_retention_days` do banco (era hardcoded 24h)
- Defaults sincronizados com banco
- 4 hardcodes (TTL, cooldown, thresholds) viraram configuráveis no banco
- Open_legs_collector de 30s pra 10s (preços mais frescos)
- Limpeza histórica do banco (DELETE em signals dismissed > 7 dias)

### Estado operacional pós-sessão
- Spam de notificações duplicadas: parou
- Detectores: 6 ativos, ratio dispensados 0% (era 70%)
- Auto-resolver: validado em produção em 3 cenários
- Sistema reconciliado com Polymarket (gap $0.55 = arredondamento)

## Roadmap

### 🚀 Em standby — refactor futuro
- **Migrar valores monetários pra inteiros em centavos**: padrão da indústria, imunidade total a imprecisão. Mas refactor pesado (~20-30 arquivos). Hoje sistema usa numeric, está protegido. Aplicar quando volume crescer ou tiver tempo livre.

### 🧪 Pendentes — esperando acontecer
- Acompanhar early_market detector ao longo de dias (validar qualidade dos sinais)

### 📋 Pendentes — depende de operar
- **Operar volume real**: 30+ trades pra baseline estatística com variedade de signal_types

### 🔧 Pequenos itens cosméticos
- Comando `/report` agregado (PnL/win-rate por categoria, signal_type, CLV) — vale só com 30+ trades
- Investigar `daily_report_hour` (campo no banco mas possivelmente sem uso no código)

### ⏳ Futuro próximo
- **Camada IA real (Fase 5)** — implementar callback "Analisar com IA" usando `buildSignalContext`. Fundações em `src/lib/signal-context.ts` prontas.
- **Sync Polymarket pra yields** — Polymarket paga ~4% APR sobre cash, sistema não conta hoje
- **cash_ledger** — auditoria de cada ajuste de cash
- **Dashboard web (Fase 6)** — Next.js + Tailwind + shadcn/ui

## Decisão honesta — semana 8

Avaliar:
1. CLV agregado em 30-50 operações é positivo?
2. Em qual categoria do Polymarket tenho melhor performance?
3. Os detectores ajudam ou geram ruído?
4. Estou sustentando estudo + análise diária?
5. Estou registrando 100% das operações?

## Próximo passo recomendado

**Operar volume real.** Sistema sólido após sessão de fixes. Próximo ganho está em dados próprios.

30+ trades nas próximas semanas, com variedade de signal_types (não só Bitcoin/UEFA). Mede:
- Win rate por categoria
- PnL agregado por signal_type
- CLV — entry vs preço de fechamento

Com dados, decide:
- Quais categorias/signal_types valem manter
- Calibrar thresholds
- Vale adicionar IA fundamentalista?
