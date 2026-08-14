# Panorama dos processos automáticos — Prediction Radar

> Estado de **agosto/2026**. O que mudou desde a versão anterior deste arquivo:
> **esports saiu da coleta** (CS2, LoL e Dota — descoberta, watchlist, resolver,
> propagação de desfecho e enricher desligados por config, sem apagar dado), e
> entrou o **coletor do radar**, que nasce desligado. Antes disso: a varredura
> por volume, o early-markets e os 5 detectores genéricos já estavam desligados,
> o auto-resolver virou componente com cron próprio e a retenção ganhou dois
> caminhos (DELETE para o legado, DROP PARTITION para esports).
>
> Fonte de verdade sobre o que fazer adiante: `specs/`. Este arquivo descreve o
> que roda hoje, não a direção.

---

## Conceitos rápidos

**Snapshot** — foto do preço de um mercado num instante (bid, ask, mid, volume,
liquidez). Vão para duas tabelas: esports em `esports_snapshots` (particionada
por **dia**, porque a poda é DROP PARTITION diário) e o resto em
`polymarket_snapshots` (particionada por **mês** a partir da migration
`20260814014541`, porque ali nada é dropado — a série do radar é isenta da
retenção). A partição de mês não transforma a retenção em DROP: linha protegida
e linha descartável convivem no mesmo mês. O que ela faz é confinar o bloat de
índice ao mês corrente.

**Signal (sinal)** — quando um detector encontra oportunidade, cria um signal. É
a notificação que aparece no Telegram.

**TTL** — quanto tempo um signal vive antes de expirar.

**Cooldown** — espera após um signal ser dispensado, durante a qual o detector
NÃO cria outro pro mesmo mercado.

**Cron** — agendamento automático. "A cada X, faz Y."

**Flag** — coluna booleana em `system_config` que liga/desliga um componente sem
deploy. O cron continua disparando; o componente sai logo na primeira linha e
registra que está desligado.

**Faixa (banda)** — na watchlist, o quão perto a partida está (`live` / `soon` /
`far`). Cada faixa tem seu próprio intervalo de refresh.

**Watchlist** — a lista de mercados de esports ativos que o coletor refresca por
`id=` em lote, em vez de varrer o Polymarket inteiro atrás deles.

---

## Os dois processos

| Processo | Comando | O que roda |
|---|---|---|
| Motor | `npm start` (`src/index.ts`) | todos os coletores, detectores e jobs abaixo |
| Bot | `npm run bot` (`src/bot/index.ts`) | Telegram + loop de notificação (60s) |

---

## Tabela mestra — o que dispara, quando, e se está ligado

| Componente | Cron | Estado | Flag |
|---|---|---|---|
| `open_legs_collector` | `*/10 * * * * *` (10s) | **ligado** | — |
| `resolved_detector` | `*/5 * * * *` + start | **ligado** | — |
| `watchlist_collector` | `*/5 * * * * *` (5s) + start | **DESLIGADO** | `discovery_slug_prefixes` vazio |
| `discovery_collector` | `*/3 * * * *` + start | **DESLIGADO** | `discovery_slug_prefixes` vazio |
| `esports_resolver` (+ recompute + match_outcome) | `*/10 * * * *`, `0 4 * * 0`, `5-59/10 * * * *` | **DESLIGADO** | `esports_resolver_enabled = false` |
| `esports_enricher` | `*/5 * * * *` | **DESLIGADO** | `esports_enricher_enabled = false` |
| `esports_analyst` | `*/5 * * * *` | **DESLIGADO** | `esports_analyst_enabled = false` |
| `detector_runner` | `*/15 * * * *` | **ligado** (só manutenção) | `generic_detectors_enabled` |
| `retention_job` | `0 3 * * *` + start | **ligado** | — |
| `radar_collector` | `*/5 * * * *` | **DESLIGADO** | `radar_collector_enabled = false` |
| `esports_partitions` | `30 2 * * *` + start | **ligado** (poda a série antiga) | — |
| `collector` (varredura por volume) | `*/3 * * * *` + start | **DESLIGADO** | `volume_scan_enabled = false` |
| `early_markets_collector` | `*/10 * * * *` + start | **DESLIGADO** | `early_markets_enabled = false` |
| 5 detectores genéricos | dentro do runner, 15min | **DESLIGADOS** | `generic_detectors_enabled = false` |
| notify loop (Telegram) | `setInterval` 60s | **ligado** (processo do bot) | — |

"+ start" = também roda uma vez no boot, para um deploy no meio do intervalo não
deixar buraco.

Todos os crons são UTC. Sintaxe de 5 campos: `min hora dia mês dow`. Sintaxe de 6
campos (a que começa com `*/5` ou `*/10` e tem um campo a mais): o primeiro campo
é **segundo**.

---

## Os que estão ligados

### Watchlist collector — tick de 5s, cadência por faixa  *(DESLIGADO em ago/2026)*
> Desligado com a saída de esports (`discovery_slug_prefixes` vazio). A descrição
> abaixo é do comportamento quando ligado — o código continua no deploy.
- Refresca por `id=` em lote os mercados de esports ativos (até 1000, ordenados
  pelo horário da partida). Sem paginação, sem teto de offset.
- **O tick de 5s não é a cadência de coleta.** Quem decide o que é refrescado é a
  faixa de cada mercado, e a faixa sai da distância até `events.game_start_time`
  (o horário real do jogo, não o `end_date` — que cai ~6h depois da partida).

  | Estado | Mercado da série | Derivados |
  |---|---|---|
  | falta > 6h para o jogo | 5 min | 25 min |
  | falta < 6h | 1 min | 5 min |
  | partida rolando | **12 s** | 60 s |
  | passou de 6h rolando sem resolver | 5 min | 25 min |

- Derivado = tudo que não é o moneyline da série (handicap, total, por game,
  first blood). É o multiplicador que segura o volume: ~231k linhas/dia em vez de
  ~734k sem ele.
- Escreve em `esports_snapshots`. Não escreve em `events`.
- Código: `src/collectors/watchlist-collector.ts` — Logs: `watchlist_collector`
- Uma linha de log a cada 5 min, agregando os ~60 ciclos. Olhar em `metadata`:
  `occupancy_by_bucket` (quantos mercados em cada faixa agora),
  `null_game_start_time` (sem âncora = presos na faixa lenta), `anchor_column`.

### Discovery collector — a cada 3min  *(DESLIGADO em ago/2026)*
> Desligado com a saída de esports (`discovery_slug_prefixes` vazio).
- Pagina `order=startDate` desc e persiste o que bate os prefixos de slug.
  Encontra o mercado de esports no minuto em que ele abre, com volume 0 e
  liquidez ~US$ 17 — que é exatamente o que a varredura por volume nunca via.
- Carimba `discovered_via='discovery'` no que vê primeiro e `game_start_time`.
- 3min não é arbitrário: o teto de offset 2000 da Gamma cobre ~36min de criação
  de mercados. A cada 3min a janela é de ~5min, com folga de ~10x.
- Código: `src/collectors/discovery-collector.ts` — Logs: `discovery_collector`

### Open legs collector — a cada 10s
- Coleta preço APENAS dos mercados onde tu tem leg aberta, para `/positions` e
  `/status` nunca mostrarem preço velho.
- Escreve em `polymarket_snapshots` (não em `esports_snapshots`), porque é de lá
  que `signal-context`, `bankroll`, `positions` e o auto-resolver leem o preço
  das posições. Isso põe série de esports na tabela legada de propósito — e é a
  retenção que sabe não apagar (ver item 8 abaixo).
- Código: `src/collectors/open-legs-collector.ts` — Logs: `open_legs_collector`

### Auto-resolver (resolved_detector) — a cada 5min
- Fecha tua leg quando o mercado resolve no Polymarket: atualiza cash, registra
  PnL, marca o event como resolved.
- **Mudou:** antes era chamado no fim do `collectAll`. Virou componente próprio,
  com cron e lock próprios, justamente para não morrer junto com a varredura por
  volume. Candidatos restritos a esports e a mercados com aposta.
- Custo: ~2 requisições por 100 candidatos (lote por `id=`).
- Código: `src/collectors/resolved-detector.ts` — Logs: `resolved_detector`

### Detector runner — a cada 15min
- Hoje roda só a manutenção: `cleanup_stale_signals` e, no fim,
  `dismissStaleSignals`. Os 5 detectores estão atrás da flag.
- A manutenção fica FORA da flag de propósito: com os detectores parados, ninguém
  renova `last_seen_at`, então todo sinal genérico ainda ativo vence e precisa ser
  dispensado — senão a fila do bot fica com sinal morto para sempre.
- Código: `src/detectors/runner.ts` — Logs: `detector_runner`

### Esports partitions — 1x/dia às 02:30 UTC + no start
- **Cuida das DUAS tabelas particionadas**, apesar do nome: cria a partição de
  `esports_snapshots` dos próximos dias (e dropa as vencidas) e as de MÊS de
  `polymarket_snapshots` (e nunca dropa — lá a série do radar é isenta da
  retenção, e um drop levaria linha protegida junto). O nome do componente fica
  como está de propósito: renomear quebraria o histórico de `system_logs` e o
  alerta de saúde.
- Limpeza por DROP TABLE, do lado de esports: o índice vai junto, instantâneo e
  sem bloat.
- Retenção lida de `esports_snapshot_retention_days`, com piso de 30 dias
  embutido na função e teto de 16 drops por execução.
- Roda ANTES da retenção às 03:00 porque são coisas opostas: aqui DROP PARTITION,
  lá DELETE em lote.
- Código: `src/jobs/esports-partitions.ts` — Logs: `esports_partitions`
- Olhar: `default_rows_at_least` > 0 = linha caiu fora de qualquer partição de
  dia (o job ficou parado, ou chegou `captured_at` com data absurda).

### Retention job — 1x/dia às 03:00 UTC + no start
- Deleta de `polymarket_snapshots`: mais velho que `snapshot_retention_days`, e
  tudo de event finalizado (sem filtro de idade).
- Deleta `system_logs` mais velho que `system_logs_retention_days`.
- **Nunca apaga snapshot de esports.** A exclusão por prefixo de slug vive dentro
  da função SQL (`run_snapshot_retention_batch`), não neste job — assim protege o
  que qualquer produtor escrever, inclusive o `open_legs`.
- NÃO toca `esports_snapshots`: aquela tabela é do job de partições.
- Código: `src/jobs/retention.ts` — Logs: `retention_job`
- Olhar: `legacy_esports_events` > 0 = ainda há série de esports na tabela
  legada. Protegida, mas no lugar errado.

### Notify loop — a cada 60s (processo do bot)
- Envia signals com `alerted=false` pro Telegram, filtrando por
  `notify_min_edge_pct`. Marca `alerted=true` depois de enviar.
- Código: `src/bot/notify.ts` (`startNotifyLoop`)

---

## Os que estão desligados (e o que acontece se religar)

O cron continua disparando. O componente sai na primeira linha, escreve `[nome]
... desligado` no console a cada tick e grava UMA linha em `system_logs` a cada
6h — sem isso seriam milhares de linhas/dia dizendo a mesma coisa.

### `radar_collector_enabled = false` — coletor do radar
- Coleta BURRA: série de preço de tudo que é viável e estável, sem opinião
  dentro do coletor. O princípio é `filtra na coleta o que NÃO muda, filtra na
  view o que muda` — preço, volume e assunto são COLUNAS, não portas. O contexto
  é o pipeline de esports: construído em cima de uma tese, a tese morreu, e nada
  daquilo serviu para outra coisa.
- Critérios de coleta, e são só seis: aberto e ativo; livro dos dois lados;
  categoria na lista; resolve em até 180 dias (sem prazo mínimo); **não é mercado
  de partida** (`sportsMarketType` — jogo único resolve em 3h e não reage a
  manchete; `gameStartTime` NÃO serve, aparece em 104 mercados fora de esporte,
  entre eles o WTI Crude); teto por categoria cortando os menores em LIQUIDEZ
  (não volume — o mercado quieto de hoje é o que explode amanhã). O teto é 50
  hoje e vira 100 quando a partição for aplicada (migration `20260814021300`).
- Categorias: IA/tecnologia, Brasil, macro e mercados, geopolítica, eleições e
  política em geral, esporte de temporada. Mais largo que a tese de hoje de
  propósito: histórico não se recupera. O mapeamento tag→categoria é auditado por
  `npm run radar:categorias`, que escreve `probes/radar/categorias.md` — inclusive
  o que ficou FORA de todas as categorias, que é o erro caro.
- Dois passos: renova o roster a cada 6h (~40 chamadas à Gamma, com paginação
  ordenada por liquidez que se corrige sozinha) e fotografa a cada 15 min (3
  chamadas à Gamma + 2 à CLOB para 300 mercados). O tick de 5 min não é cadência.
- Escreve em `events` (`radar_tracked`, `radar_tema`, `radar_subject`) e em
  `polymarket_snapshots` — inclusive `bid_depth`/`ask_depth`, que nenhum outro
  coletor preenche. Uma linha por mercado, não duas: a do NO é `1 − YES`.
- **A série do radar nunca é apagada pela retenção** (migration 20260813210119),
  e por isso o coletor NUNCA desmarca `radar_tracked`: desmarcar quem resolveu
  devolveria a série ao ramo `finalized`, que apaga tudo sem olhar idade.
- Nasce desligado porque ligar é assumir armazenamento permanente: ~28,8k
  linhas/dia, ~10,5M/ano, numa tabela que **não é particionada**.
- Religar: `update system_config set radar_collector_enabled = true where id = 1;`
- Antes de religar: `npm run radar:coletor -- --dry-run --lista` mostra o roster
  e o custo de um ciclo sem gravar nada.
- Código: `src/collectors/radar-collector.ts` (regra em `radar-selection.ts`) —
  Logs: `radar_collector`

### `discovery_slug_prefixes = {}` — descoberta e watchlist de esports
- CS2, LoL e Dota saíram da coleta por decisão (migration `20260814000233`). Os
  dois componentes leem a mesma lista e saem na primeira linha quando ela está
  vazia; o resolver, a propagação de desfecho e o enricher saíram junto por
  `esports_resolver_enabled` e `esports_enricher_enabled`.
- **Nenhum dado foi apagado.** `esports_snapshots` continua com os 14,1M de
  linhas, e `esports_partitions` continua rodando para podar por idade.
- A proteção da série antiga NÃO caiu junto: `esports_slug_patterns()` devolve o
  fallback `{cs2-%,lol-%,dota2-%}` quando a config está vazia — foi escrito
  assim porque lista vazia autorizaria a retenção a apagar tudo.
- Religar: `update system_config set discovery_slug_prefixes = '{cs2-,lol-}',
  esports_resolver_enabled = true, esports_enricher_enabled = true where id = 1;`

### `volume_scan_enabled = false` — varredura por volume (`collector`)
- Era `GET /markets?order=volume24hr` paginado até o teto de offset 2000.
- Por que saiu: numa hora de produção trouxe 1 mercado de esports contra 60 da
  descoberta — e esse 1 era derivado de uma partida que a descoberta já tinha
  capturado 20min antes. Redundância cara. O que sobra do que ela traz é
  `crypto_fees_v2` e `weather_fees`, 61% das linhas de `events` e alvo da poda.
- Religar: `update system_config set volume_scan_enabled = true where id = 1;`
- Consequência de religar: volta a alimentar `events` e `polymarket_snapshots`
  com não-esports — ou seja, volta a encher o que a poda existe para esvaziar.

### `early_markets_enabled = false` — early-markets collector
- Nunca alcançava a própria janela de 24h (teto de offset), e o piso de liquidez
  de US$ 500 excluía por construção o mercado de esports recém-nascido (~US$ 17).
- **Efeito colateral que o nome da flag não diz:** ele é o único escritor de
  `events.is_new_market`, e só o detector `early_market` lê essa coluna. Com ele
  parado, aquele detector não tem entrada nova nem que seja religado sozinho.
- Religar: `update system_config set early_markets_enabled = true where id = 1;`

### `generic_detectors_enabled = false` — os 5 detectores genéricos
`cross_market_intra`, `cross_market_inter`, `calendar_driven`,
`hype_reality_gap`, `early_market`.
- Todos leem `events` + `polymarket_snapshots`. Com a varredura desligada, o lado
  não-esports dessas tabelas parou de receber dado novo: rodavam a cada 15min
  sobre uma foto congelada. A série que ainda cresce mora em `esports_snapshots`,
  e nenhum deles lê de lá.
- Uma flag para o grupo, não uma por detector — a direção é que saiam juntos.
- Religar: `update system_config set generic_detectors_enabled = true where id = 1;`
  Só faz sentido junto com `volume_scan_enabled`, senão continuam sem entrada.

### `discovery_slug_prefixes` vazio — descoberta + watchlist
- Não é booleano, mas é a chave de desligamento das duas: lista vazia = a
  vertical inteira para. Default: `{cs2-,lol-,dota2-}`.
- A retenção NÃO usa essa lista como autorização para apagar: se ela vier vazia,
  a função SQL cai numa lista embutida. Desligar a coleta não pode autorizar
  apagar o histórico dela.

---

## Cadeia de dependências (causa → efeito)

### Um mercado de esports, do nascimento à resolução
```
1. Partida entra no calendário; Polymarket cria ~7 mercados (1 série + derivados)
   ↓
2. Discovery (3min) acha por order=startDate, com volume 0 e liquidez ~US$ 17
   - grava em events com game_start_time (horário real do jogo)
   - primeiro ponto da série em esports_snapshots
   ↓
3. Watchlist assume o refresh, na faixa que o relógio manda:
   - > 6h para o jogo: 5 min
   - < 6h: 1 min
   - partida rolando: 12 s
   ↓
4. Partida acaba; Polymarket fecha o mercado
   ↓
5. Auto-resolver (5min) vê closed=true + UMA resolved:
   - fecha a leg se houver, ajusta cash, marca events.status=resolved
   ↓
6. Mercado sai da watchlist (status != active)
   ↓
7. A série fica em esports_snapshots por esports_snapshot_retention_days
```

### Quando tu opera uma posição
```
1. Track no Telegram → conversation pede stake
   ↓
2. INSERT em my_bets + my_bet_legs → UPDATE cash
   ↓
3. /positions mostra a leg imediatamente
   ↓
4. Open_legs_collector passa a coletar essa leg a cada 10s
   ↓
5. Auto-resolver passa a priorizar esse event
```

### Quando um signal é gerado
```
Hoje só sinais que já existiam continuam vivos — nenhum detector cria signal
novo enquanto generic_detectors_enabled = false. O runner de 15min roda a
manutenção (cleanup + dismissStale) e o notify loop segue enviando o que
estiver com alerted=false.
```

---

## Pontos de falha cascata

**Watchlist quebra:**
- A série de esports para. É o dado que o backtest e o agente analista vão usar,
  e o buraco não é recuperável depois — o preço passado não volta.
- `/positions` não é afetado (quem serve preço de posição é o open_legs).

**Discovery quebra:**
- Mercado novo de esports não entra em `events`, então a watchlist não o vê.
- O buraco é da janela em que ficou parado: o teto de offset só alcança ~36min
  para trás, então mais que isso não é recuperável na volta.

**Open legs collector quebra:**
- `/positions` e `/status` ficam com preço velho. Operações continuam.

**Auto-resolver quebra:**
- Legs continuam abertas mesmo após resolver. Cash não atualiza. Fechar via
  `/close`. Mercado resolvido também não sai da watchlist.

**Job de partições quebra:**
- Por 2 dias não dá nada (a folga cria partições à frente). Depois disso, todo
  snapshot cai na partição default — que nada esvazia, e onde o dado fica sem
  prazo. `default_rows_at_least` > 0 é o aviso.

**Retention quebra:**
- `polymarket_snapshots` e `system_logs` crescem. Foi o que inflou um índice para
  1492 MB sobre 80 MB de dado real.

**Notify loop quebra:**
- Signals criados mas não enviados. Dá para ver com `/signals`.

---

## Tempos típicos

```
Mercado de esports novo aparece no Polymarket
└─ Discovery pega em até 3min

Preço mexe num mercado de esports
└─ Partida rolando: até 12s (série) / 60s (derivado)
└─ Falta menos de 6h: até 1min
└─ Falta mais de 6h: até 5min

Preço mexe num mercado onde tu tem leg
└─ Até 10s, sempre

Mercado resolve no Polymarket
└─ Auto-resolver pega em até 5min

Tu muda config no banco
└─ Reflete em até 60s (cache)

Tu fecha posição via Telegram
└─ Resposta imediata (1-2s)
```

---

## Configs no banco (alteráveis sem deploy)

```sql
SELECT * FROM system_config WHERE id = 1;
```

Flags de liga/desliga:
```
volume_scan_enabled            (false — varredura por volume)
early_markets_enabled          (false — early-markets collector)
generic_detectors_enabled      (false — os 5 detectores genéricos)
discovery_slug_prefixes        ({cs2-,lol-,dota2-} — vazio desliga descoberta+watchlist)
```

Cadência da watchlist:
```
watchlist_interval_live_seconds        (12)
watchlist_interval_soon_seconds        (60)
watchlist_interval_far_seconds         (300)
watchlist_derived_interval_multiplier  (5  — quantas vezes mais lento o derivado)
watchlist_soon_window_minutes          (360 — quando a faixa de 1min começa)
watchlist_live_max_minutes             (360 — teto do ao vivo sem resolver)
watchlist_primary_market_types         ({moneyline} — o que é o mercado da série)
discovery_lookback_minutes             (20)
```

Retenção:
```
esports_snapshot_retention_days  (365 — DROP PARTITION; piso de 30 na função)
snapshot_retention_days          (1   — DELETE em polymarket_snapshots)
system_logs_retention_days       (30)
```

Sinais e operação (sem mudança):
```
max_stake_pct                 (3% do bankroll por trade)
cross_market_max_stake_pct    (10% pra basket)
min_confidence_alert          (0.75)
notify_min_edge_pct           (2.5%)
signal_ttl_minutes            (30min)
signal_cooldown_minutes       (60min)
dismiss_stale_cutoff_minutes  (15min)
stale_cleanup_threshold_hours (1h)
collector_min_volume_24h      (10k — só a varredura desligada usa)
collector_min_liquidity       (20k — idem)
```

Pra mudar:
```sql
UPDATE system_config SET <campo> = <valor> WHERE id = 1;
```
Cache de 60s.

---

## Crons em código (precisam deploy pra mudar)

Tudo em `src/index.ts`:

```typescript
cron.schedule('*/10 * * * * *', () => collectOpenLegMarkets());  // 10s
cron.schedule('*/5 * * * * *',  () => collectWatchlist());       // 5s (tick, não cadência)
cron.schedule('*/3 * * * *',    () => collectDiscovery());       // 3min
cron.schedule('*/3 * * * *',    () => collectAll());             // 3min — desligado por flag
cron.schedule('*/5 * * * *',    () => detectResolvedMarkets());  // 5min
cron.schedule('*/10 * * * *',   () => collectEarlyMarkets());    // 10min — desligado por flag
cron.schedule('*/15 * * * *',   () => runAllDetectors());        // 15min
cron.schedule('30 2 * * *',     () => runEsportsPartitionJob()); // 02:30 UTC
cron.schedule('0 3 * * *',      () => runRetentionJob());        // 03:00 UTC
```

No processo do bot: `setInterval` de 60s no notify loop (`src/bot/notify.ts`).

---

## Hardcodes no código (precisam deploy)

- `MAX_WATCHLIST = 1000` (watchlist-collector.ts) — teto do roster
- `ENDED_GRACE_MS = 24h` (watchlist-collector.ts) — quanto tempo depois do
  `end_date` o mercado ainda fica na watchlist
- `MAX_PER_CYCLE = 50`, `FETCH_TIMEOUT_MS = 8000` (resolved-detector.ts)
- `MAX_IDS_PER_REQUEST = 100` (polymarket-api.ts) — limite da Gamma
- `EVENTS_CHUNK_SIZE = 200`, `DEFAULT_CHUNK_SIZE = 500` (batch-write.ts)
- `CACHE_TTL_MS = 60000` (config.ts)
- `ELIMINATED_THRESHOLD = 0.01` (positions.ts)

---

## Migrations aplicadas à mão — como saber se já foram

O deploy do código é automático; a migration é aplicada por ti. No intervalo, o
código sobe e degrada em vez de quebrar. Onde isso aparece:

| Log | Campo | O que significa |
|---|---|---|
| `discovery_collector` | `snapshot_table = 'polymarket_snapshots'` | `esports_snapshots` ainda não existe — a série está indo para a tabela legada |
| `discovery_collector` | `stamped_game_start_time = false` | coluna `events.game_start_time` ainda não existe |
| `watchlist_collector` | `anchor_column = false` | idem — tudo cai na faixa lenta de 5min |
| `watchlist_collector` | `null_game_start_time` alto e estável | coluna existe, mas o backfill não rodou (`npm run backfill:game-start-time`) |
| `esports_partitions` | mensagem "manage_esports_partitions ainda não existe" | migration das partições não aplicada |
| `retention_job` | `legacy_esports_events = null` | função de sondagem do item 8 não aplicada |

---

## Dashboard rápido de saúde

```sql
-- Atividade dos últimos 30min
SELECT
  component,
  count(*) as execs,
  to_char(max(created_at), 'HH24:MI:SS') as ultima
FROM system_logs
WHERE created_at > NOW() - INTERVAL '30 minutes'
GROUP BY component
ORDER BY ultima DESC;
```

Esperado hoje: `watchlist_collector` (1 linha a cada 5min, agregada),
`discovery_collector`, `open_legs_collector`, `resolved_detector`,
`detector_runner`. Os desligados aparecem no máximo 1x a cada 6h.

```sql
-- Erros recentes
SELECT to_char(created_at, 'HH24:MI:SS') as quando, component, message
FROM system_logs
WHERE status = 'error'
  AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC LIMIT 10;
```

Esperado: 0 linhas.

```sql
-- A watchlist está mesmo pegando partida ao vivo?
SELECT to_char(created_at, 'HH24:MI') as quando,
       metadata->'occupancy_by_bucket' as ocupacao,
       metadata->>'null_game_start_time' as sem_ancora
FROM system_logs
WHERE component = 'watchlist_collector'
  AND created_at > NOW() - INTERVAL '2 hours'
ORDER BY created_at DESC;
```

`live:primary = 0` com partida rolando significa uma de duas coisas: o
`sports_market_type` não bate com `watchlist_primary_market_types`, ou o
`game_start_time` não foi carimbado.
