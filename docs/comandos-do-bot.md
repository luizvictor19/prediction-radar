# Comandos do bot do Telegram

Superfície de interação do bot: os comandos que o usuário digita e os botões
inline que disparam callback. É o que o operador alcança pelo Telegram, não o
que roda sozinho. Para o que roda por cron, ver `docs/processos-automaticos.md`.

Comandos e teclados conferidos contra `src/bot/index.ts` em 29/08/2026: **8 de
8** comandos registrados batem, e **12 de 12** callbacks registrados estão
documentados aqui.

---

## Comandos

### `/signals [filtro]`

Lista sinais ativos. Filtro opcional por título do evento, case-insensitive:
`/signals bitcoin`.

Filtros aplicados:

- `dismissed=false`, `acted_on=false`
- sinais de events com leg aberta são ocultos (já estão no portfólio)
- freshness: `last_seen_at` até 15 min atrás

Emojis dinâmicos nos botões de outcome: ✅/❌ Yes/No, ⬆️/⬇️ Over/Under, 🪙/🎲
empate, 👑/🐺 favorito/azarão. Rodapé traz o total de sinais exibidos.

### `/positions`

Lista posições abertas (`closed_at IS NULL`), agrupadas por `bet_id`.

- **Single-leg:** evento, outcome, stake, `entry_price`, shares (1 decimal),
  quanto paga se ganhar, e há quanto tempo está aberta. Botão
  `[Fechar posição]`.
- **Basket (2+ legs):** título, cada leg com detalhes, stake total. Botões
  `[Fechar tudo]` e `[Fechar leg específica]`.

Leg sem snapshot recente aparece como `~$0.00 (mercado eliminado)`. Rodapé traz
o total de legs agrupado por outcome.

### `/status`

Resumo do sistema:

- bankroll, com cash e portfolio separados (`$520.00 (cash $480 + portfolio $40)`)
- bets abertas: contagem de legs, stake comprometido, valor atual do portfolio
- bets fechadas nos últimos 7 dias: contagem, win rate por legs, PnL total
- último ciclo bem-sucedido do detector, em UTC e BRT lado a lado
- sinais ativos agora, com o filtro de freshness de 15 min
- alertas enviados nas últimas 24h

### `/cash`

Interativo. Mostra o cash atual e pede o novo valor absoluto. O bot exibe
`Cash atual: $47.08`, o usuário digita `117.42`, o cash passa a $117.42, e o
delta é calculado e exibido. `cancel` cancela. Substitui os antigos `/topup` e
`/withdraw`.

### `/config`

Somente leitura. Mostra cash disponível, stake máximo (%), edge mínimo para
listagem (%) e edge mínimo para notificação automática (%).

### `/register`

Registra uma bet feita fora do bot. Pergunta se é 1 leg ou basket e abre o
fluxo conversacional correspondente.

**Single-leg:**

1. título do evento, texto livre
2. event match pela RPC de trigrama `search_events_by_title`, com
   `similarity >= 0.15`: um match confirma automaticamente, dois ou mais abrem
   botões de escolha (ou "registrar manualmente")
3. categoria, se não houve match
4. outcome, texto livre; com event match, normalizado case-insensitive
5. stake em USD
6. to win em USD (o campo "to win" do Polymarket), de onde saem
   `entry_price = stake/to_win` e `shares = to_win`
7. confiança de 1 a 10, ou skip
8. tese curta, ou skip
9. resumo e confirmação

Resultado: `INSERT` em `my_bets` e `my_bet_legs`. Se houver signal ativo do
evento, ele é marcado `acted_on=true`.

**Basket:**

1. categoria
2. título da basket, para referência
3. número de legs
4. por leg: outcome, stake e `entry_price` decimal
5. tese (ou skip), resumo e confirmação

Resultado: `INSERT` em `my_bets` e N `my_bet_legs`.

### `/edit`

Lista legs abertas, cada uma com botão `[Editar leg]`. Ao clicar, abre fluxo
com os campos editáveis: to win (recalcula `entry_price` e shares), stake
(recalcula shares), outcome (normalizado por `normalizeOutcome()` se houver
`event_id`), notes (texto livre ou skip para null), e cancelar.

### `/help`

Lista os comandos agrupados: 📡 Sinais (`/signals`), 📈 Posições
(`/positions`, `/register`, `/edit`) e ⚙️ Sistema (`/status`, `/cash`,
`/config`, `/help`).

---

## Autocomplete

Os 8 comandos acima são registrados no Telegram por `bot.api.setMyCommands()`
no startup.

---

## Callbacks

Disparados por botão inline. Os doze registrados em `src/bot/index.ts`.

### `track:<signal_id>`

Botão `[Track basket]`. Entra em `basketTrack`: stake total da basket, o bot
exibe a execução (cada leg com outcome, stake, shares e `entry_price`), tese
curta ou skip, confirmação. Resultado: `INSERT` em `my_bets` e N
`my_bet_legs`, mais `adjustCash(-stakeTotal)`.

### `track_custom:<signal_id>`

Botão `[✏️ Tese própria]`. Entra em `customTrackConversation`. Para cada membro
do sinal, exibe `yes_price` e `no_price` com botões `[Yes] [No] [Pular]`; se
não pular, pede o stake, e `entry_price` é o preço escolhido com
`shares = stake/entry`. Depois tese curta ou skip, resumo e confirmação.
Resultado: `INSERT` em `my_bets` com as legs selecionadas, e `UPDATE` no signal
com `acted_on=true` e `user_action_type='tracked_custom'`.

### `track_yes:<signal_id>` e `track_no:<signal_id>`

Botões `[<emoji> Track <outcome>]`. `track_yes` pega `outcomes.values[0]` e
`track_no` pega `outcomes.values[1]`. Entram em `singleLegTrack` com o outcome
fixado: stake em USD (ou `ok` para o sugerido), to win em USD (de onde saem
`entry_price = stake/to_win` e `shares = to_win`), confiança de 1 a 10 ou skip,
tese curta ou skip, e confirmação. Resultado: `INSERT` em `my_bets` e
`my_bet_legs`, `acted_on=true`, `adjustCash(-stake)`.

### `analyze_ai:<signal_id>`

Botão `[🧠 Analisar]`. Stub: responde que a análise da IA ainda não está
implementada. A infraestrutura existe (`buildSignalContext(signalId)` em
`src/lib/signal-context.ts`).

### `dismiss:<signal_id>`

Botão `[Dismiss]`. `UPDATE` com `dismissed=true`, `user_dismissed_at=now()` e
`user_action_type='dismissed'`. Edita a mensagem original para
`❌ DISMISSED` seguido do texto original, e remove os botões.

### `close:<bet_id>`

Botões `[Fechar posição]` (single-leg) e `[Fechar tudo]` (basket). Entra em
`closePositionConversation`, que detecta o número de legs.

- Single-leg: preço de fechamento (decimal de 0 a 1) ou `resolved`, depois o
  resultado (win, loss ou anulado). Calcula o PnL, atualiza `my_bet_legs` e
  `my_bets` (`closed_at`), e faz `adjustCash(shares × closing_price)`.
- Basket: ou "resolveu (1 leg ganhou)", que pede a leg vencedora e marca as
  demais como loss, ou "fechar cada leg manualmente", que percorre leg a leg.

### `close_leg_select:<bet_id>`

Botão `[Fechar leg específica]`, em basket. Exibe lista inline com as legs
abertas do bet (título e stake por leg), mais um botão de cancelar. Ao
selecionar uma leg, dispara `close_single_leg:<leg_id>`.

### `close_single_leg:<leg_id>`

Entra em `closeSingleLegConversation`: preço de fechamento ou `resolved`,
resultado, cálculo do PnL e ajuste do cash.

### `close_leg_cancel`

Botão `[Cancelar]` da lista de `close_leg_select`
(`src/bot/index.ts:190,201`). Responde `Cancelado.` e edita a mensagem para
`Operação cancelada.`. Não recebe argumento.

### `view_origin:<bet_id>`

Botão `[🔔 Sinal de origem]`, montado em `src/bot/keyboards.ts:87,95` e
tratado em `src/bot/index.ts:212`. Chama `viewOriginSignalHandler` com o
`bet_id`, que mostra o sinal que originou aquela posição.

### `edit_leg:<leg_id>`

Botão `[Editar leg]`. Entra em `editConversation`, com os campos to win,
stake, outcome, notes e cancelar.
