-- Semântica do desfecho em `esports_matches`, agora que alguém o escreve.
--
-- SÓ COMENTÁRIOS. Nenhuma coluna, constraint, índice ou dado é alterado. Pode
-- ser aplicada a qualquer momento, antes ou depois do backfill — o código não
-- depende dela para funcionar. O que ela registra é a LEITURA das colunas, que
-- até agora não tinha dono porque nada as preenchia.
--
-- ---------------------------------------------------------------------------
-- A lacuna que isto fecha
-- ---------------------------------------------------------------------------
--
-- `winner_team_id` e `resolved_at` existem desde a 20260806183705 e nunca foram
-- escritos: o auto-resolver (`resolved_detector`) é anterior à camada de
-- entidades e para em `events` — carimba `events.status = 'resolved'` e
-- `events.resolved_outcome`, o RÓTULO vencedor, e não traduz nada.
--
-- Medido em 2026-08-07: 106 de 106 partidas passadas com as duas colunas nulas.
-- Consequência a jusante, e o motivo de isto ter virado trabalho: o eval do
-- analista pontua comparando a probabilidade com `winner_team_id`. Com a coluna
-- vazia, 33 análises acumuladas e ZERO pontuáveis.
--
-- Quem escreve agora é `src/verticals/match-outcome.ts`, num passo próprio de
-- reconciliação (cron `5-59/10`), e não dentro do auto-resolver. O porquê está
-- inteiro naquele arquivo; em uma frase: o desfecho e o link chegam em ordens
-- diferentes, e escrita disparada por evento perde tudo o que chega fora de
-- ordem — que é exatamente como as 106 se acumularam.
--
-- ---------------------------------------------------------------------------
-- O par (winner_team_id, resolved_at) codifica TRÊS estados, não dois
-- ---------------------------------------------------------------------------
--
--   winner nulo    + resolved_at nulo      -> ainda não resolveu
--   winner nulo    + resolved_at PRESENTE  -> VOID: resolveu sem vencedor
--   winner presente + resolved_at presente -> resolvida, com vencedor
--
-- Não há coluna de status, e isto não é omissão: uma coluna nova precisaria ser
-- escrita em todo lugar que hoje escreve o par, e o par já distingue os três
-- casos sem ambiguidade. O custo é que a leitura precisa ser SEMPRE do par —
-- `winner_team_id is null` sozinho conta void como pendência, e uma partida void
-- ficaria para sempre parecendo uma amostra que um dia chega. É por isso que
-- `src/eval/dataset.ts` tem `partida_void` como exclusão separada de
-- `sem_desfecho`.
--
-- A quarta combinação (winner presente, resolved_at nulo) não é escrita por
-- ninguém e não tem leitura definida. Se aparecer, é bug de escrita.

comment on column public.esports_matches.winner_team_id is
  'Time que venceu a SERIE. Traduzido de events.resolved_outcome (um rotulo) pelo outcome_a_index do market moneyline daquela partida — nunca do child_moneyline, que decide um game e nao a serie. Nulo com resolved_at preenchido significa VOID; nulo com resolved_at nulo significa que ainda nao resolveu. Escrito por src/verticals/match-outcome.ts.';

comment on column public.esports_matches.resolved_at is
  'Instante em que o desfecho passou a existir, copiado de events.resolved_at do moneyline (o mais antigo, quando ha mais de um). E o carimbo TERMINAL: presente significa que nao ha mais o que esperar desta partida, com ou sem vencedor. Ler winner_team_id sem ler esta coluna confunde void com pendencia.';

-- ---------------------------------------------------------------------------
-- O que NÃO se escreve, e por quê
-- ---------------------------------------------------------------------------
--
-- Três casos não concluem, e nenhum deles vira palpite:
--
--   SEM `outcome_a_index` (estado B) — o link do moneyline não sabe qual outcome
--   é o time A, porque o registro de times ainda compara uma contração (`navi`)
--   com um nome ('Natus Vincere'). Nenhuma escrita: o recompute semanal do
--   resolver preenche o índice e a passada seguinte conclui sozinha. Marcar isso
--   para revisão seria pedir a um humano que digitasse o que a API entrega.
--
--   SEM moneyline linkado — a partida só tem markets derivados. Nada a fazer até
--   o link existir.
--
--   AMBÍGUO — o rótulo vencedor não está em `events.outcomes.values`, casa em
--   mais de um, ou dois moneylines da mesma partida discordam. Aí sim
--   `needs_review = true`: é contradição entre fontes que deveriam ser a mesma,
--   e nem mais dado nem regra nova desempatam.
--
-- A assimetria é a mesma da 20260806200435: `confidence` registra pobreza,
-- `needs_review` registra incerteza. Uma partida sem desfecho pontuável é uma
-- linha a menos no eval; uma partida com desfecho ERRADO inverte o sinal da
-- métrica e não se anuncia.

comment on column public.esports_matches.needs_review is
  'Estado A no nivel da partida: conflito entre o slug e teams[], vertical divergente, ou contradicao no desfecho — rotulo vencedor fora de outcomes.values, rotulo casando em mais de um outcome, ou dois moneylines apontando vencedores diferentes. Partida vinda so do slug (sem liga, stage ou tier) NAO e pendencia, e falta de outcome_a_index tambem nao: aquilo o recompute resolve.';
