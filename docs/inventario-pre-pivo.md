# Inventário do que é de antes do pivô

Issue 65. O projeto pivotou em 13–14/08/2026 de prever para vigiar (ADR 0003,
`docs/context.md`). Este arquivo lista o que a direção antiga construiu e ainda
está no banco ou no repositório: tamanho, quem lê hoje (medido) e uma
recomendação. **Nada sai por causa deste arquivo.** Cada remoção é issue e PR
próprios, com o dado arquivado no Drive antes (regra 6 de `docs/context.md`).

Todo número aqui é medição de **12/11/2026, entre 07h55 e 08h10 UTC**, e
envelhece. Cada issue de remoção mede de novo antes de agir (regra "Afirmação
herdada não é medição", em `CLAUDE.md`).

## Como foi medido

- **Banco:** `supabase db query --linked`, só leitura.
  - Catálogo: `pg_class`, `pg_stats`, `pg_depend`, `pg_proc`.
  - `pg_stat_statements`: zerado em 04/11/2026 às 23h09 UTC, então a janela é
    de 7,4 dias, com `dealloc = 0` (nenhuma entrada descartada).
  - `count`, `min` e `max` só nas tabelas pequenas de antes do pivô (todas
    abaixo de 25 MB).
  - As duas queries sobre tabela grande, (a) e (b) abaixo, foram mostradas no
    plano da issue e rodaram depois do "aprovado". A (b) teve o plano conferido
    com `explain` antes: os dois `exists` viram hashed SubPlan, e ela levou
    8,6 s.
- **"Quem lê" no banco** é statement do `service_role`, que é o papel do
  processo, do bot e do proxy da `web/`. Os contadores de
  `pg_stat_user_tables` não servem: o delete da issue 63 inflou `seq_scan` pelas
  checagens de FK (`ai_analyses` tem 226.565 seq scans e 0 linhas).
- **Código:** `git grep` em `src/`, `scripts/` e `web/src/`, cadeia de imports
  e as linhas de cron de `src/index.ts`. Todos os arquivos versionados são texto
  (`git ls-files -z | xargs -0 file`), exceto o PNG do README; a busca vazia vale.
- **Banco hoje:** `pg_database_size` = **258 MB**.

## 1. Banco

| Objeto                                                                                                                           | Tamanho                                                                 | Linhas e última escrita                                              | Quem lê hoje (7,4 dias)                                                                                                                                                                                                                                                                     | Recomendação                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `detected_signals`                                                                                                               | 22 MB                                                                   | 31.187 linhas, de 03/05 a 05/08/2026, 0 inserts na janela            | Laço de notificação do bot: 10.604 leituras, ~1 por minuto (`src/bot/notify.ts:58-61`, `:140`). Limpeza do runner de detectores: 708 + 708 leituras, ~a cada 15 min, sem flag (`src/detectors/runner.ts:50`, `:88`). **44 das 58 `my_bets` apontam para ela** por `my_bets.signal_id` (FK). | Arquivar e dropar depois que o código que lê sair (issues B e D). A FK de `my_bets` se decide na issue D. |
| `market_match_links`                                                                                                             | 6,4 MB                                                                  | 24.990, de 06/08 a 13/08                                             | 0 statements, 0 referências no código                                                                                                                                                                                                                                                       | Arquivar e dropar (D)                                                                                     |
| `esports_matches`, `esports_analyses`, `analysis_claims`, `esports_teams`, `esports_tournaments`, `esports_leagues`, `verticals` | 2,8 MB juntas (1,4 MB, 552 kB, 408 kB, 232 kB, 72 kB, 64 kB, 32 kB)     | 2.870 / 453 / 824 / 527 / 16 / 14 / 3 linhas, todas de 06/08 a 13/08 | 0 statements. Código: só `src/eval/dataset.ts:161-325`, alcançado só pelo `npm run eval:analyst` manual                                                                                                                                                                                     | Arquivar e dropar como uma cadeia de FK (D), depois da decisão sobre `src/eval/` (E)                      |
| `esports_snapshots`                                                                                                              | 1,5 MB, **93 partições vazias** (p20260815 a p20261114, mais a default) | 0 linhas                                                             | `manage_esports_partitions`: 12 chamadas, diárias, por `src/jobs/esports-partitions.ts:122`, que criam uma partição vazia por dia. Único escritor: `src/lib/esports-snapshots.ts:80`, chamado pelos coletores desligados                                                                    | Dropar pai e partições, sem dado a arquivar, junto com a metade esports do job (C)                        |
| `ai_analyses`                                                                                                                    | 32 kB                                                                   | 0 linhas                                                             | 0 statements, 0 referências no código                                                                                                                                                                                                                                                       | Dropar (D)                                                                                                |
| `polymarket_snapshots_historico`                                                                                                 | 24 kB                                                                   | 0 linhas (de MINVALUE a 01/08/2026)                                  | Faz parte do pai do radar                                                                                                                                                                                                                                                                   | Manter: não pesa                                                                                          |

**Total de antes do pivô nas tabelas: ~34 MB dos 258 MB (~13%)**, ou ~7% da cota
de 0,5 GB da organização.

### O que essas tabelas ainda seguram em `events`

Query (b):

```sql
select count(*) from events e
 where not e.radar_tracked
   and (exists (select 1 from detected_signals s where s.event_id = e.id)
     or exists (select 1 from market_match_links m where m.event_id = e.id))
   and not exists (select 1 from my_bets b where b.event_id = e.id)
   and not exists (select 1 from my_bet_legs l where l.event_id = e.id)
   and not exists (select 1 from market_rule_digests d where d.event_id = e.id);
```

Resultado: **31.301 dos 35.178 `events`** (89%) estão fora do radar e só ficam no
banco porque `detected_signals` ou `market_match_links` apontam para eles.
Depois da issue D, eles entram no mesmo corte da issue 63.

Uma conta proporcional sobre os 73 MB de `events` dá algo perto de 60 MB. **É
estimativa, não medição**, porque o tamanho da linha varia com a `description`.
A issue D mede em bytes antes de prometer número.

### Colunas

**`system_config` (1 linha, ~0 byte de cota).** Dropar coluna não devolve
espaço; só tira ruído.

- **26 colunas sem nenhum leitor no código.** O grep exclui `src/lib/config.ts`
  (defaults), `src/types/index.ts` (tipo) e comentários:
  - `kelly_fraction`, `min_confidence_alert`, `drawdown_stop_pct`,
    `daily_report_hour`, `collect_only_prefixes`;
  - `esports_resolver_enabled`, `esports_resolver_batch_size`;
  - `esports_enricher_enabled`, `esports_enricher_lookahead_minutes`,
    `esports_enricher_lookbehind_minutes`,
    `esports_enricher_min_interval_minutes`, `esports_enricher_batch_size`,
    `esports_enricher_liquipedia_enabled`, `esports_enricher_oddspapi_enabled`;
  - `oddspapi_bookmakers`, `oddspapi_market_id`;
  - `esports_analyst_enabled` e os nove `analyst_*` (`analyst_model`,
    `analyst_prompt_version`, `analyst_effort`, `analyst_daily_budget_usd`,
    `analyst_checkpoints_minutes`, `analyst_min_liquidity_usd`,
    `analyst_max_spread`, `analyst_min_fragments`, `analyst_timeout_ms`).

  A issue 65 citava `esports_enricher_enabled` e `esports_analyst_enabled` como
  flags desligadas, mas nenhuma delas guarda nada hoje: o código que as lia saiu
  na PR 56.

- **Lidas só por código de antes do pivô** (saem junto com ele):
  - detectores: `cross_market_*`, `inter_market_*`, `min_expected_edge_pct`,
    `log_expected_edge_pct`, `signal_ttl_minutes`, `signal_cooldown_minutes`;
  - coletores: `volume_scan_enabled`, `excluded_categories`, `collector_min_*`,
    `early_markets_enabled`, `generic_detectors_enabled`,
    `discovery_lookback_minutes`, e os sete `watchlist_*`;
  - monitor de saúde: `health_stale_discovery_minutes`,
    `health_stale_watchlist_minutes`;
  - jobs: `esports_snapshot_retention_days`, `stale_cleanup_threshold_hours`;
  - bot: `notify_min_edge_pct`, `dismiss_stale_cutoff_minutes`,
    `max_stake_pct`, `cross_market_max_stake_pct`, `cash_usd`.
- **Caso misto:** `discovery_slug_prefixes` é da descoberta de esports, mas
  também é lido por `src/collectors/resolved-detector.ts:484`,
  `src/collectors/radar-selection.ts:206` e pela função
  `esports_slug_patterns()`. Sai só depois da issue C.

**`events` (35.178 linhas).** Pela `pg_stats` (avg_width × fração não nula), as
colunas antigas somam **menos de 1 MB** juntas. A tabela abaixo mostra quem lê
cada uma depois que os grupos A, B e F saírem. `src/lib/normalize.ts` é o
upsert do radar: ele **escreve** a coluna, não lê.

| Coluna                                          | Nulos    | Quem sobra depois de A, B e F                                                            |
| ----------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `sub_category`                                  | 100%     | `categorizer.ts`, `radar-collector.ts:596,614`, `normalize.ts:121`                       |
| `tracked`                                       | 0%       | `scripts/montar-lista-radar.ts:28,1519`, `normalize.ts:134`                              |
| `is_ai_tech`                                    | 0%       | só `normalize.ts:124`                                                                    |
| `is_new_market`                                 | 0%       | ninguém                                                                                  |
| `discovered_via`                                | 87%      | ninguém                                                                                  |
| `game_start_time`                               | 87%      | só `normalize.ts:131`                                                                    |
| `series_id`, `series_slug`, `series_recurrence` | 85%      | só `normalize.ts:139-141`                                                                |
| `event_metadata`                                | 80%      | só `normalize.ts:54,143`                                                                 |
| `neg_risk_market_id`                            | 92%      | só `normalize.ts:135`                                                                    |
| `polymarket_fee_rate`                           | 2%       | só `normalize.ts:123`                                                                    |
| `sports_market_type`, `line`                    | 55%, 83% | `src/bot/format.ts:29,236` e `positions.ts:602` (a origem de uma posição vinda de sinal) |
| `start_date`                                    | 23%      | `src/bot/format.ts:382`                                                                  |

Recomendação: manter por enquanto. Rever depois de A, B e F, quando a maioria
fica sem leitor nenhum.

### Funções

| Função                                                                                                     | Chamadas na janela | De onde                                             | Recomendação                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------- | ------------------------------------------- |
| `manage_esports_partitions`                                                                                | 12                 | `esports-partitions.ts:122`, diário                 | Dropar (C)                                  |
| `manage_polymarket_snapshot_partitions`                                                                    | 12                 | `esports-partitions.ts:231`, diário                 | Manter (radar); mudar o job de nome (C)     |
| `database_disk_usage`                                                                                      | 15                 | `retention.ts:48` e o monitor de tamanho do bot     | Manter                                      |
| `esports_legacy_snapshot_events`                                                                           | 0                  | `retention.ts:36`                                   | Dropar com a sonda (C)                      |
| `orphan_events_by_prefix`                                                                                  | 0                  | nada no código; lê `market_match_links`             | Dropar (C)                                  |
| `context_fragment_retention_days`                                                                          | 0                  | nada; a tabela `context_fragments` saiu na issue 63 | Dropar (C)                                  |
| `esports_event_ids`, `esports_slug_patterns`                                                               | 0 diretas          | dentro de `run_snapshot_retention_batch`            | Reescrever a retenção sem eles e dropar (C) |
| `run_snapshot_retention_batch`                                                                             | **0**              | `retention.ts:72`                                   | Manter; ver "Achado fora do escopo"         |
| `search_events_by_title`, `radar_event_ids`, `var_com_base`, `run_snapshot_retention`, `update_updated_at` | n/a                | `/register`, retenção, `v_radar`, trigger           | Manter                                      |

`run_snapshot_retention_batch` **protege `esports_event_ids()`**, que cai em
`cs2-%`, `lol-%` e `dota2-%` quando a config está vazia: é lógica de esports
dentro de uma função viva do radar.

## 2. Código

Linhas por `wc -l`, sem os testes.

| Grupo                                                                                                                                                                                                                                                                                                                                                                                                                 | Linhas                               | Roda hoje?                                                                                                                                   | Recomendação                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A.** Detectores genéricos (`src/detectors/*`, com `runner.ts`), `src/jobs/cleanup-stale-signals.ts`, scan de volume (`src/collectors/polymarket.ts`), coletores early-markets, discovery e watchlist, `src/lib/esports-snapshots.ts`, `src/lib/fees.ts`, `src/lib/kelly.ts` (0 importadores), `src/lib/signal-context.ts` (0 importadores), `src/claude/*` (0 importadores, com `claude-sonnet-4-5` fixo no código) | **4.590**                            | Cron `*/15`, `*/10`, `*/3` e a cada 5 s em `src/index.ts`, todos desligados por flag ou por lista vazia. Mesmo assim gravam log (query (a)). | Apagar o código e os crons. Tirar a descoberta e a watchlist de `MONITORED_COMPONENTS` (`src/bot/health-monitor.ts:68-78`).                                                  |
| **B.** Superfície de sinais do bot: `/signals`, `track`, `track_custom`, `dismiss`, `track_yes`/`track_no`, `view_origin`, `analyze_ai` (stub), o laço de notificação, `signal-queries.ts`, `notify-pause.ts`, e os formatadores de sinal em `format.ts` (~:155-628) e `keyboards.ts` (:23-90)                                                                                                                        | **1.294**, mais partes de 2 arquivos | Sim: o laço consulta a cada 60 s, e nada gera sinal desde 05/08                                                                              | Apagar. Ficam `/positions`, `/register`, `/edit`, `/status` (enxuto) e os monitores de saúde e de tamanho. `/cash` e `/config` (era de stake e Kelly) se decidem na issue B. |
| `src/jobs/esports-partitions.ts`                                                                                                                                                                                                                                                                                                                                                                                      | 247                                  | Diário. Metade esports, metade radar (`:231`)                                                                                                | Separar (C): a metade do radar fica com nome do radar                                                                                                                        |
| **E.** `src/eval/dataset.ts`, `src/eval/report.ts`, `scripts/eval-analyst.ts`                                                                                                                                                                                                                                                                                                                                         | **1.356**                            | Só manual (`eval:analyst`). Leem as tabelas do analista de esports                                                                           | Decidir na issue E. `src/eval/metrics.ts` (720, Brier e calibração genéricos) fica.                                                                                          |
| **F.** Scripts das hipóteses mortas: xtracker ×3 e `scripts/lib/calibration.ts`, `probe-polymarket-universe`, `probe-mercados-compostos`, `probe-lead-lag-spread`, `relacoes:*` ×3 e `src/relacoes/*`; `backfill.ts` e `seed-categories.ts` (sem npm script); 3 `backfill:*` de uma vez só                                                                                                                            | **~9.440**                           | Nunca em produção. São as hipóteses 5 a 8 de `docs/research-record.md`.                                                                      | Apagar o código e os npm scripts. Os relatórios `probes/*.md` ficam como registro.                                                                                           |
| `scripts/lib/market-pairing.ts`                                                                                                                                                                                                                                                                                                                                                                                       | 1.013                                | **Sim:** `src/collectors/radar-selection.ts:1` importa                                                                                       | Manter e mover para `src/lib/` (F): código de produção importando de `scripts/`                                                                                              |
| `src/types/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                  | 550                                  | Sim                                                                                                                                          | Tirar os exports sem uso (`SignalType`, `PolymarketSnapshot`, `MyBet`, `MyBetLeg`, `GammaSeries`, `GammaTeam`) e as chaves órfãs de `SystemConfig` junto com cada grupo      |

**~16,7 mil linhas** nos grupos acima.

### Log gravado por código desligado

Query (a), sobre `system_logs`:

```sql
select component, count(*) from system_logs
 where created_at > now() - interval '7 days' group by 1 order by 2 desc;
```

| Componente                                | Linhas em 7 dias | Antes do pivô? |
| ----------------------------------------- | ---------------- | -------------- |
| `discovery_collector`                     | 3.364            | sim, desligado |
| `resolved_detector`                       | 2.104            | não            |
| `detector_runner`                         | 1.344            | sim, desligado |
| `cleanup_stale_signals`                   | 672              | sim            |
| `radar_collector`                         | 669              | não            |
| `watchlist_collector`                     | 32               | sim, desligado |
| `early_markets_collector`                 | 31               | sim, desligado |
| `collector` (scan de volume)              | 31               | sim, desligado |
| `open_legs_collector`                     | 17               | não            |
| `retention_job`                           | 11               | não            |
| `esports_partitions`                      | 11               | misto          |
| `telegram_bot`, `bot_command`, `bankroll` | 4, 2, 1          | não            |

**5.474 de 8.293 linhas (66%) vêm de código desligado.** A maior fonte é a
descoberta: o ramo de "desligado" chama `logEvent` direto, sem o
`logDisabled` que limita a frequência (`src/collectors/discovery-collector.ts:457`),
e grava uma linha a cada 3 min, ~480 por dia. A watchlist, no mesmo ramo, usa
`logDisabled` (`watchlist-collector.ts:801`).

## 3. Estrutura, pasta por pasta

| Pasta ou arquivo                     | Para que serve depois do pivô                                                                                      | Peso morto                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `src/collectors/`                    | radar, pernas abertas e detector de resolvidos: vivos                                                              | scan de volume, early-markets, descoberta, watchlist (A)                                                      |
| `src/detectors/`                     | nada                                                                                                               | a pasta inteira (A)                                                                                           |
| `src/bot/`                           | posições, `/register` e `/edit` (`prob_self`), alertas de saúde e de tamanho                                       | a superfície de sinais (B)                                                                                    |
| `src/digest/`, `src/llm/`            | digestão das regras: vivos                                                                                         | nenhum                                                                                                        |
| `src/eval/`                          | as métricas genéricas                                                                                              | dataset e relatório do analista (E)                                                                           |
| `src/relacoes/`, `src/claude/`       | nada                                                                                                               | as duas pastas (A, F)                                                                                         |
| `src/jobs/`                          | retenção e partições                                                                                               | a metade esports (C)                                                                                          |
| `scripts/`                           | radar, digestão, `medir:*`, `arquivar:particao`                                                                    | sondas das hipóteses mortas e backfills de uma vez só (F)                                                     |
| `web/`                               | a tela Hoje / Regra / Operar: viva                                                                                 | nenhum encontrado                                                                                             |
| `supabase/migrations-adiadas/`       | nada: DDL da hipótese 6, nunca aplicado                                                                            | apagar, e tirar a menção em `.claude/skills/migration/SKILL.md` (F)                                           |
| `supabase/queries/health-checks.sql` | a seção 12 (tamanho) vale e é usada por `src/bot/database-size.ts:107`                                             | as checagens de descoberta, watchlist e `esports_snapshots` (:25, :74-89, :120, :137) (H)                     |
| `docs/` vivos                        | `context.md`, `commands.md`, `adr/`, `spec-tela-regra*.md`, `research-record.md`                                   | ver a lista abaixo                                                                                            |
| `docs/` históricos                   | `PROJECT.md`, `CONTEXTO-RADAR.md`, `specs/000` a `003`, `docs/prompts/` (16 arquivos, 2.161 linhas)                | ficam como registro, com aviso de "histórico" em cada um ou numa pasta `docs/historico/` (decidir na issue H) |
| `docs/GUIA-ANALISE.md`               | nada: diagnóstico do analista, sem nenhum link para ele, e consulta a `context_fragments` que já saiu (:265, :303) | apagar (H)                                                                                                    |

### Docs vivos que hoje dizem algo falso (issue H)

- **`docs/context.md:29-30` e a ADR 0003** dizem que `src/eval/` mede o Brier
  do dono contra o do mercado. **Nenhum arquivo de `src/eval/` lê `prob_self`.**
  Quem lê é a `web/`, o bot e `scripts/medicoes/serie-prob-self.ts`.
- **`docs/context.md:85-86`** diz que não se sabe como o bot sobe no Railway.
  Que ele roda em produção está medido: o laço de notificação fez 10.604
  consultas em 7,4 dias. O como continua fora do repositório.
- `docs/processos-automaticos.md`:
  - `:66-68` lista crons de esports que não existem mais;
  - `:222` diz foto a cada 15 min, e é 60 desde a issue 63.
- `README.md:61,72` também diz 15 min.
- `docs/comandos-do-bot.md:186,192` cita linhas de handler que mudaram de lugar.
- `docs/GLOSSARIO.md:75-127` traz o glossário do OddsPapi.
- `docs/commands.md:167` cita `npm run oddspapi:probe`, que não existe. A seção
  "Labels (planejadas, ainda não criadas)" do mesmo arquivo também é velha.
- `package.json:4` ainda diz "focused on AI and Big Tech markets".

## Issues de remoção propostas

Uma PR cada. O Luiz aprovou as oito em 12/11/2026, com o motivo: o projeto
enxuga para focar no que ele é, a leitura da diferença entre a regra e a
manchete do mercado. Abertas no mesmo dia: A é a issue 68, B a 69, C a 70, D
a 73, E a 71, F a 72, G a 74 e H a 75.

|     | Escopo                                                                                                                                                                                                                  | Toca                                             | Ordem           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------- |
| A   | Apagar coletores e detectores desligados, `lib` morto e os crons deles                                                                                                                                                  | processo de produção                             | 1               |
| B   | Apagar a superfície de sinais do bot e o laço de notificação                                                                                                                                                            | bot de produção                                  | 2               |
| C   | Partições de esports: separar o job, migration dropando `esports_snapshots`, `manage_esports_partitions` e as funções de esports, retenção sem a proteção de esports                                                    | banco (migration)                                | 3               |
| D   | Arquivar no Drive e dropar `detected_signals`, `market_match_links`, as tabelas de esports, `verticals` e `ai_analyses`; decidir a FK `my_bets.signal_id`; depois, cortar os 31.301 `events` que ficarem sem referência | banco (migration), ~34 MB mais parte de `events` | depois de B e E |
| E   | `src/eval/`: manter ou apagar o dataset e o relatório do analista                                                                                                                                                       | código                                           | qualquer hora   |
| F   | Apagar os scripts das hipóteses mortas e `src/relacoes/`; mover `market-pairing.ts` para `src/lib/`                                                                                                                     | código                                           | qualquer hora   |
| G   | Dropar as colunas de `system_config` sem leitor                                                                                                                                                                         | banco (migration)                                | depois de A a C |
| H   | Docs: a lista de falsos e velhos acima, mais o aviso ou a pasta de histórico                                                                                                                                            | docs                                             | qualquer hora   |

## Achado fora do escopo

`run_snapshot_retention_batch` e `esports_legacy_snapshot_events` não têm
**nenhum** statement em `pg_stat_statements` na janela de 7,4 dias, e o
`pg_stat_statements` não registra statement que falhou. Na mesma janela:

- `polymarket_snapshots_p202611` tem `n_tup_del = 0`;
- o ramo de log do mesmo job apagou 9.003 linhas de `system_logs`;
- o `retention_job` gravou 11 linhas de log (query (a)).

Então a chamada da retenção de snapshots ou não acontece, ou falha todo dia, e
o job segue, porque cada ramo devolve o erro em vez de abortar
(`src/jobs/retention.ts:54-65`). A série do radar está protegida nos dois
casos, então nada se perde hoje. Confirmar exige ler o `status` e a mensagem
das 11 linhas do `retention_job`. Aberto como issue 76.
