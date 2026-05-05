# Prediction Radar — Sistema Pessoal

> v6 — atualizado pós-sessão de cash/bankroll dinâmico, fixes do collector (snapshots de 2 outcomes), suporte a sports_market_type/line (spread, totals, map_handicap), refactor de bets pra modelo unificado (my_bets + my_bet_legs), 1ª trade real operada, comando /topup e /withdraw, /bankroll removido, fees zeradas (refletindo realidade observada). Próxima fase: validar com volume real (20-50 trades) antes de Fase 5 (IA).

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

**Objetivo de longo prazo:** gerar histórico documentado de operações com edge mensurável que possa eventualmente virar:
- Sistema vendável (código + metodologia)
- Base pra SaaS futuro (se regulação BR mudar)
- Track record pra captação de capital ou consultoria

**Princípio operacional:** o sistema NÃO toma decisões — apenas detecta sinais e organiza informação. Decisão final é minha.

## Realidade regulatória (Brasil, 2026)

CMN baniu prediction markets via Resolução 5.298 (vigente em 4 de maio de 2026). Polymarket bloqueado pela Anatel. Operação pessoal continua viável via VPN + USDC/Polygon, mas:
- Sistema é puramente pessoal, sem distribuição
- Sem comercialização enquanto regulação BR for desfavorável
- Tracking fiscal cuidadoso
- Capital alocado apenas o que posso perder sem afetar vida

## Salvaguardas inegociáveis

1. **Tracking obrigatório de TODA operação** — antes de executar, registro com tese articulada (1-3 frases) + categoria + domain_confidence (1-10).
2. **Bankroll inicial cash $86.19** (após depósito real no Polymarket). Não escalar até CLV positivo após 50+ operações.
3. **Cap de 3% do bankroll por operação** pra single-leg. Cap de 10% pra cross-market arb.
4. **Drawdown stop:** 20% do bankroll em 30 dias = pausa de 7 dias.
5. **Detector NÃO é alterado retrospectivamente** pra explicar operação ruim.
6. **Edge líquido após fees é critério, não desvio bruto.**

## Princípios estratégicos

### Onde edge pode aparecer

- **Edge informacional**: você sabe algo sobre o domínio que o mercado precificou errado. Forte em AI/Tech.
- **Edge estatístico**: padrão matemático que o mercado não corrigiu. Independente de domínio.
- **Cenário ouro**: ambos alinhados.

### Por que detector + decisão manual

Detector puro pode flagar ineficiência que **não é explorável**. Operador puro perde sinais que escapam à atenção. Combinação é robusta.

### Por que monitorar todas categorias

Em mai/2026, **fees são zero em todas categorias na prática** (Polymarket Internacional). Apenas 15-minute crypto markets cobram fee. Sistema atualizado pra refletir isso (v6).

### Realidade aprendida (v4-v6)

**Cross-market inter no Polymarket maduro raramente tem edge operável.** Maioria dos baskets tem edge < 1.5%.

**`direction='under'` em torneios é falso positivo sistemático.** Mercado precifica cláusula "Other/cancelado" implicitamente.

**Foco principal pra bankroll $86 cash inicial:** detectores calendar_driven (sinal de atenção, sem direção), value betting onde tenho domínio fundamental.

**Bug do collector (v6):** descoberto que collector salvava só 1 outcome por evento por ciclo. Corrigido — agora salva os 2 (primeiro com bestBid/bestAsk reais da Gamma, segundo derivado por complemento).

**Suporte a sports_market_type:** spread (Arsenal -1.5), totals (Over/Under 2.5), map_handicap (esports). Display enriquecido com sufixo (-X)/(+X).

## Stack técnica

- **Backend único**: Node.js + TypeScript (ESM, sem build step, executa via tsx)
- **Banco**: Supabase (Postgres) — Free tier
- **Hospedagem**: Railway — **2 services no mesmo repo** (start = coletor+detectores; bot = Telegram)
- **APIs**: Polymarket Gamma API
- **Análise**: Claude API (claude-sonnet-4-5) — Fase 5 (postergada)
- **Interface**: Telegram bot (grammy + @grammyjs/conversations)
- **Dashboard**: Next.js + Tailwind + shadcn/ui — Fase 6
- **VPN**: Mullvad ou ProtonVPN

## Estratégia de coleta — Gamma API only

A Gamma API retorna em uma única chamada paginada todos os dados que os detectores básicos precisam: `bestBid`, `bestAsk`, `spread`, `lastTradePrice`, `volume24hr`, `volumeNum`, `liquidityNum`, `outcomes`, `outcomePrices`, `negRiskMarketID`, `series`, `eventMetadata`, `feeType`, `events[0].slug`, `sportsMarketType`, `line`.

**Filtros aplicados pelo collector:**
- `active === true` e `closed === false`
- `liquidity > $20k` (sempre, exceto markets protegidos)
- `volume24hr > $10k` **só pra markets isolados** (não-negRisk)
- Resolução entre 7 e 90 dias
- `feeType` populado
- Categoria não está em `system_config.excluded_categories`
- **Markets com bets abertas SÃO PROTEGIDOS** — passam direto sem filtro de volume/liquidity (v6)

**Snapshots:** 2 por evento por ciclo — primeiro outcome com `bestBid`/`bestAsk` reais da Gamma, segundo derivado por complemento.

## Estado atual do sistema (v6)

### Tabelas
- `events` — markets do Polymarket, com sports_market_type e line
- `polymarket_snapshots` — preços ao longo do tempo, ambos outcomes
- `detected_signals` — sinais com flags alerted, acted_on, dismissed
- `my_bets` — guarda-chuva da decisão (signal_id, event_id nullable, thesis_type)
- `my_bet_legs` — detalhes operacionais (1 bet = 1+ legs)
- `system_config` — cash_usd (substitui bankroll_usd), thresholds, etc
- `system_logs` — debug

### Detectores ativos no runner
1. **calendar_driven** — sinal de atenção (mercado calmo + perto de resolver)
2. **cross_market_inter** — basket multi-outcome com soma ≠ 1.0
3. **cross_market_intra** — versão dentro do mesmo neg_risk_market
4. **hype_reality_gap** — STUB

### Comandos do bot
- `/signals` — sinais ativos
- `/positions` — bets abertas com "to win" exibido
- `/status` — bankroll dinâmico (cash + portfolio), bets fechadas, último detector com BRT
- `/topup <valor>` — adiciona ao cash
- `/withdraw <valor>` — retira do cash
- `/config` — thresholds atuais
- `/help` — ajuda
- `/register` — registrar bet manual (single-leg ou basket)
- `/edit` — editar preço/stake/outcome/notes de leg aberta

### Display calendar_driven
- Título enriquecido pra spreads (`(-1.5)/(+1.5)`)
- Encerramento UTC + BRT
- Trade-off com prefixo: 👑 favorito / 🐺 azarão / 🪙 🎲 equilibrado
- Botões dinâmicos: ✅❌ (Yes/No), ⬆️⬇️ (Up/Down, Over/Under), 👑🐺 (favorito/azarão), 🪙🎲 (equilibrado)
- Lado oposto explicitado

### Cash/Bankroll dinâmico (v6)
- `cash_usd` persistido em system_config (decremento/incremento automático)
- `portfolio_value_usd` calculado on-the-fly (snapshots × shares)
- `bankroll = cash + portfolio_value` calculado on-the-fly
- Sem cron, sem cache

### Outcome normalizer (v6)
- Helper `normalizeOutcome` em src/lib/outcome-normalizer.ts
- Match case-insensitive contra `events.outcomes.values`
- Aplicado em /register e /edit

### Track usa to_win (v6)
- Em vez de "preço de entrada", usuário informa "to win"
- Sistema calcula `shares = to_win` e `entry_price = stake / to_win`

## Roadmap

### Item 3 — Fix do coletor pra detectar resolved markets ⏳ PENDENTE
- Detectar quando event sai do feed `closed=false`
- Marcar `status='resolved'`, popular `resolved_outcome` e `resolved_at`
- Atualizar my_bets.closing_price/pnl_usd/clv automaticamente

### Fase 2.5 — Resolution Anchor Detector ⏳ PENDENTE

### Fase 3 — Hype/Reality Gap Detector ⏳ PENDENTE
Stub criado em `src/detectors/hype-reality-gap.ts`.

### Fase 5 — Claude API Integration ⏳ PENDENTE
Análise fundamentalista IA. Decidido pausar até validar baseline com 50+ trades reais.

### Fase 6 — Dashboard Web ⏳ PENDENTE
Next.js + Tailwind + shadcn/ui.

### Backlog menor
- Auto-update bankroll com PnL em /close
- Sync entre cash interno e saldo real do Polymarket
- Comando de relatório agregado (PnL por categoria, win rate, CLV)
- Filtragem inteligente IA (filtra sinais sem edge histórico)

## Decisão honesta — semana 8

Avaliar:
1. CLV agregado em 60-100 operações é positivo?
2. Em qual categoria do Polymarket tenho melhor performance?
3. Os detectores ajudam ou geram ruído?
4. Estou sustentando 2-3h de estudo diário?
5. Estou registrando 100% das operações?

## Próximo passo recomendado

**Operar volume real.** Sistema fechado funcionalmente. Validação real precisa de **dados próprios**.

20-50 trades nas próximas semanas. Mede:
- Win rate por categoria
- PnL agregado por signal_type
- CLV — entry vs preço de fechamento

Com dados, decide:
- Quais categorias/signal_types valem manter
- Calibrar thresholds
- Vale adicionar IA fundamentalista?
