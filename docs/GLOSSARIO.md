# Glossário do Prediction Radar

Vocabulário para tocar o projeto sem travar em termo. Não é dicionário: cada
entrada diz **o que é** e **por que importa aqui**. Quando um termo tem
significado diferente do senso comum, isso está marcado.

Ordem: do mundo externo para dentro do sistema.

---

## 1. Mercado de previsão (Polymarket)

**Mercado de previsão (prediction market)**: mercado onde se compra e vende
contratos que pagam US$ 1 se um evento acontecer e US$ 0 se não. O preço vira,
na prática, a probabilidade que o mercado atribui ao evento. Contrato a US$ 0,63
= o mercado acha que tem ~63% de chance.

**Event**: o guarda-chuva. "NAVI x FaZe em 09/08". Um event agrupa vários
markets.

**Market**: a pergunta específica que se negocia. Dentro do mesmo event há o
market "quem vence a série", o "quem vence o mapa 2", o "total de mapas acima de
2,5". No seu banco, `events` guarda o guarda-chuva e cada market é uma linha
associada.

**Outcome**: o lado do market. Num moneyline há dois: time A e time B. O
`outcome_a_index` é qual posição na lista corresponde ao seu "time A", e é essa
correspondência que, se errar, faz o eval inteiro parecer descalibrado por
defeito de leitura, não de modelo.

**Moneyline**: o market de "quem vence", sem handicap. É o único que o seu
sistema usa como fonte de preço, porque é o único diretamente comparável com uma
probabilidade.

**`child_moneyline`**: o moneyline de um mapa individual dentro de uma série
BO3/BO5. Serve de insumo para checar consistência (o preço da série bate com o
implícito pelos mapas?), não gera fragmento próprio.

**Mercados derivados**: `totals` (total de mapas), `map_handicap`,
`kill_over_under_game`. Coletados, mas deliberadamente fora da análise: são
dezenas por partida, cada um com semântica própria.

**Slug**: o identificador em texto do market na URL, `cs2-navi-faze-2026-08-09`.
O seu resolver lê o slug para descobrir vertical, os dois códigos de time e a
data. É a espinha do casamento entre market e partida.

**Bid / Ask / Mid**: bid é o maior preço que alguém paga; ask é o menor que
alguém aceita receber; mid é a média dos dois. **Mid é o número que o sistema
trata como "o preço do mercado"** e é contra ele que o agente é medido.

**Spread**: a distância entre bid e ask. Spread largo = ninguém sabe precificar
= o preço não é uma opinião formada. Por isso spread alto é motivo de abstenção:
não há tese do mercado para discordar.

**Liquidez (liquidity)**: quanto dinheiro está parado nas ordens. Preço com
US$ 67 de liquidez não é sinal, é ruído de duas pessoas.

**Volume**: quanto já foi negociado. Diferente de liquidez: volume é passado,
liquidez é agora. Ordenar mercados por volume foi o erro que fez o sistema
enxergar 1 de 61 mercados relevantes: volume alto é popularidade, não é o que
está acontecendo agora.

**Snapshot**: a foto do market num instante (bid, ask, mid, volume, liquidez,
carimbados com `captured_at`). A sequência de snapshots é a **série temporal**, e
é o ativo real do projeto: ela não se recupera depois.

**Resolução (resolve)**: quando o event fecha e o resultado é conhecido.
`resolved_outcome` diz qual lado ganhou. É o **label** do dataset: sem ele não há
o que pontuar.

---

## 2. Casas de aposta e OddsPapi

**Bookmaker (casa)**: Pinnacle, Stake, bet365. Empresas que publicam odds com
dinheiro próprio em risco. A odd delas é uma segunda opinião independente do
Polymarket, e é por isso que serve de contraste.

**Fixture** (**o termo que mais confunde, e é simples**): é a partida no catálogo
*de outro provedor*. A sua partida é `esports_matches`; a fixture é o registro da
mesma partida dentro da OddsPapi, com o id **deles**. Não existe ponte de id
entre os dois mundos, então você tem que **casar** os dois por nome de time +
data. Sem casar, não há odds: o dado existe lá, você só não sabe qual linha é a
sua partida.

> Analogia: você tem o CPF de uma pessoa; a OddsPapi tem a matrícula dela. Ninguém
> publicou a tabela que liga CPF a matrícula. Você casa pelo nome e pela data de
> nascimento, e às vezes erra.

**Casamento (matching)**: o processo de achar a fixture certa. Uma vez achada,
fica memoizada em `esports_matches.external_ids.oddspapi_fixture_id`, para não
procurar de novo.

**Descoberta (discovery)**: a chamada que lista as fixtures de um esporte numa
janela de datas, para então casar. É a chamada **cara**: consome a cota mensal.

**Odd decimal**: formato `1,82`. Converte para probabilidade implícita com
`1 / odd`. 1,82 → 55%.

**Probabilidade implícita**: a probabilidade que a odd expressa. É o que torna a
linha da casa comparável com o mid do Polymarket.

**Vig / overround / margem**: as duas probabilidades implícitas de uma casa somam
mais de 100%; a sobra é a margem dela. Comparar com o Polymarket sem tirar a vig
compara maçã com laranja.

**`limit`**: o stake máximo que a casa aceita naquela linha. Funciona como **peso
de confiança**: casa que aceita muito dinheiro está confiante no número. Medido:
só a Pinnacle preenche; na Stake vem sempre nulo.

**`active: false` / suspensão**: a casa tirou a linha do ar. **Medido no seu
projeto:** é suspensão real (138 de 150 blocos reabrem em preço diferente), não
falha de feed. Sinal forte: a casa suspende quando viu algo que ainda não sabe
precificar. Cuidado medido: durante a suspensão o *preço* registrado não é
cotação (em 64 de 75 instantes na Pinnacle os dois lados aparecem trocados), então
o estado vem do último registro e o preço, da última entrada ativa.

**Endpoint billable vs livre**: `/v4/fixtures` (descoberta) consome da cota de
250/mês; `/v4/historical-odds` é declarado gratuito. Essa linha divide toda a
economia da integração, e foi ignorá-la num cache compartilhado que causou o bug
de 09/08.

**Cota (quota)**: o teto de chamadas do plano. 250/mês no Free, com uma reserva
interna de 40, então na prática 210 gastáveis.

**Cooldown**: espera mínima entre duas chamadas ao mesmo endpoint. Não consome
cota, consome tempo, e foi o que estourou o timeout do ciclo do enricher em
08/08 (5,5s × 40 partidas = 220s contra 240s de orçamento).

---

## 3. Probabilidade, avaliação e as armadilhas

**Previsão calibrada**: quando você diz 70% e, das vezes que disse 70%, ~70%
aconteceram. Calibração é sobre honestidade do número, não sobre acertar.

**Brier score**: a métrica principal. Média de `(previsto − aconteceu)²`. **Menor
é melhor.** 0 é perfeito, 0,25 é jogar moeda, 1 é convicção total no lado errado
toda vez. Um Brier de 0,13 sozinho não diz nada: só diz alguma coisa contra um
baseline.

**Baseline**: o número contra o qual você compara. Aqui são três: o **preço de
mercado**, a **moeda** (0,5 sempre) e, quando existir, as **odds das casas**.
Bater a moeda é fácil e irrelevante. Bater o mercado é a única coisa que importa.

**Skill score**: quanto você melhora sobre o baseline, em fração do erro dele.
`1 − (seu Brier / Brier do mercado)`. **Positivo = você é melhor.** O seu está em
−0,099: o agente erra ~10% mais que o preço. Skill ≤ 0 significa que o agente não
sabe nada que o preço já não diga.

**Edge**: vantagem real e mensurável sobre o mercado. Operacionalmente: skill
positivo com amostra suficiente. Sem isso, todo o resto é curiosidade.

**Viés (bias)**: média do previsto menos frequência do observado. Positivo =
você aposta no time A mais do que o time A ganha. O Brier esconde isso: dá para
somar +0,08 em toda previsão e ainda ter Brier aceitável.

**Reliability diagram / baldes**: agrupa as previsões por faixa (0,6–0,7,
0,7–0,8...) e compara previsto vs observado dentro de cada uma. É como se enxerga
viés que a média esconde.

**Decomposição de Murphy**: quebra o Brier em três, *confiabilidade* (menor é
melhor), *resolução* (maior é melhor) e *incerteza* (propriedade da amostra, não
sua). Existe para pegar **o modo de falha silencioso**: um agente que responde
~0,5 para tudo fica bem calibrado, tem Brier razoável e é inútil. Resolução perto
de zero denuncia isso.

**Abstenção (abstain)**: o agente responder "não tenho base para opinar". É
**funcionalidade, não falha**: analisar mercado sem preço formado polui o eval
com ruído. `abstain_reason` é o dataset que permite calibrar o critério depois.

**`n` (tamanho da amostra)**: quantas previsões pontuáveis você tem. No seu
código, `MIN_N_FOR_SIGNAL = 20` é onde o relatório para de marcar "amostra
curta". Seu critério pessoal para habilitar vertical é n ≥ 50. **São dois
números diferentes**: não confundir na hora de ler.

**Pontuável (scorable)**: a análise que tem desfecho conhecido *e* preço de
mercado gravado no mesmo instante. Análise sem uma das duas coisas não entra na
comparação.

**Amostra pareada (paired sample)**: só os pontos onde agente e mercado opinam.
Comparar o Brier do agente sobre 100 pontos com o do mercado sobre 80 não é
comparação: são duas amostras, e a diferença pode ser inteiramente composição.

### As armadilhas temporais: a parte que mais custa caro

**`as_of`**: **quando o fato era verdade**. "O roster era esse em 1º de maio."

**`observed_at`**: **quando nós ficamos sabendo**. "Descobrimos isso hoje."

Os dois são diferentes e a diferença é o projeto inteiro. Uma fonte que faz
backfill grava hoje (`observed_at` = hoje) um fato de ontem (`as_of` = ontem).

**Look-ahead bias (vazamento de futuro)**: usar, numa decisão simulada do
passado, informação que só existiu depois. É o jeito mais comum de um backtest
mentir, e mente **sem sintoma**: o número fica ótimo e errado. Filtrar o replay
por `as_of` em vez de `observed_at` é exatamente esse erro.

**Point-in-time**: a propriedade de uma fonte conseguir responder "o que se sabia
em T", e não só "o que se sabe agora". `supportsPointInTime` é a flag que marca
isso por enricher, e é a única coisa que separa um backtest de um número
inventado.

- `market-history` é point-in-time **por construção**: a tabela é append-only, a
  linha das 14h continua sendo a das 14h.
- `liquipedia` é `false` **por defeito conhecido**: a wiki é reescrita
  retroativamente.
- `oddspapi` é `false` **por ausência de garantia**: pode ser imutável, mas não
  há evidência ainda. A distinção importa: a primeira nunca muda, a segunda vira
  uma constante quando a medição chegar.

**Replay**: reexecutar o pipeline como ele teria rodado num instante do passado,
usando só o que se sabia então. Só participam enrichers point-in-time.

**Backtest**: avaliar a estratégia sobre o histórico. Vale exatamente o quanto o
replay for honesto.

---

## 4. A arquitetura do seu sistema

**Vertical**: um domínio (`cs2`, `lol`, `dota2`). Tem prefixo de slug próprio e
uma flag `enabled` que decide se vira entidade e análise.

**Coletor (collector)**: o que busca dados fora e grava. Você tem dois:
*discovery* (varre o Polymarket atrás de mercados novos) e *watchlist* (refresca
por id os mercados que já interessam, de 12s a 300s conforme a proximidade da
partida).

**Watchlist**: a lista de mercados ativos que se refresca por id em lote, em vez
de varrer tudo. **Faixa (banda)** é o quão perto a partida está (`live`, `soon`,
`far`) e cada faixa tem cadência própria.

**Resolver**: traduz mercado bruto em entidade. Descobre que
`cs2-navi-faze-2026-08-09` é a partida entre dois times conhecidos, e grava o
vínculo em `market_match_links`.

**Enricher**: busca contexto sobre a partida e grava `context_fragments`. Todos
obedecem ao mesmo contrato (`asOf` obrigatório, `supportsPointInTime` declarado).
Hoje: `market-history`, `polymarket-context`, `match-history`, `oddspapi`, e a
`liquipedia` inerte.

**Fragmento (context fragment)**: uma peça de contexto (um h2h, um movimento de
preço, uma linha de casa). Tem `kind`, `summary` (o que o LLM lê), `payload` (o
dado) e `confidence`.

**Analista (analyst)**: o agente LLM que lê os fragmentos e devolve uma
probabilidade, uma tese e as citações. É o único componente que gasta dinheiro
por ciclo, e por isso nasce desligado.

**Checkpoint**: o instante nominal da análise, **T-6h** e **T-1h** antes do
início. `checkpoint_minutes` é nominal; `as_of` é o instante real.

**Claim (afirmação)**: uma frase factual da tese, ligada ao fragmento que a
sustenta. É a associação que permite medir **fidelidade** depois: o agente citou
algo que existia, ou inventou?

**Outcome job**: propaga `events.resolved_outcome` (um rótulo) para
`esports_matches.winner_team_id` (uma entidade). Sem ele, 106 de 106 partidas
ficaram sem vencedor e o eval nunca teve amostra.

**Órfão**: mercado coletado sem entidade correspondente. Tem preço e snapshots,
mas o sistema não sabe que partida é. É o **estado esperado** de vertical
coletada e não habilitada (hoje: LoL e Dota).

**Estado A / Estado B**: dois jeitos de o resolver não concluir. **A** é
ambiguidade: as fontes se contradizem, precisa de gente. **B** é falta de
vocabulário: o slug diz `navi`, o mercado diz "Natus Vincere", e o registro ainda
não sabe que são a mesma coisa. B **se resolve sozinho** conforme os times
reaparecem, e o recompute semanal é quem colhe.

**Recompute**: a passada semanal (domingo 04:00) que reprocessa o histórico já
linkado, para colher os nomes aprendidos desde a última vez.

**Backfill**: rodar sobre o histórico o que normalmente roda sobre o presente.
Você tem o de desfechos (`backfill-match-outcomes`) e planeja o de odds.

**Retenção (retention)**: apagar dado velho por política. Foi onde um bug
apagava a série *no momento em que ela ficava completa*: features e label juntos,
sem condição de idade.

**Partição (partitioning)**: quebrar uma tabela grande em pedaços por data
(`esports_snapshots` é particionada por dia). Apagar vira `DROP PARTITION` em vez
de `DELETE`, o que resolve o inchaço de índice de uma vez.

**Migration**: um arquivo `.sql` que altera o schema. **Regra do projeto: o
agente escreve, o dono aplica.** Migration escrita não é migration aplicada.

**Flag**: coluna booleana em `system_config` que liga/desliga um componente sem
deploy. O cron continua disparando; o componente sai na primeira linha e registra
que está desligado.

**Heartbeat (batimento)**: o carimbo de "completei um ciclo". Existe porque
**componente travado é indistinguível de componente ocioso**: foi a lição do
coletor parado 48h sem gerar um único erro.

**Alerta de saúde**: o monitor que compara o heartbeat contra um limiar por
componente e avisa no Telegram. Roda no processo do **bot**, separado dos
coletores de propósito: monitor que cai junto com o que monitora não monitora
nada.

**Cooldown de alerta**: intervalo mínimo entre dois avisos do mesmo componente
ainda parado. Sem ele seria uma mensagem por minuto, e aí se aprende a ignorar o
canal.

---

## 5. Engenharia: os termos que aparecem nos bugs

**Cache**: guardar uma resposta para não pedir de novo.

**TTL (time to live)**: por quanto tempo a resposta guardada ainda vale.

**Evicção (eviction)**: jogar fora entradas quando o cache enche. **LRU** joga
fora a menos usada recentemente. `clear()` joga fora **tudo**, e foi isso que
fez o endpoint gratuito despejar o caro e queimar a cota de 09/08.

**Cache negativo**: guardar também o "não achei", para não reprocurar. O seu usa
24h para fixture não encontrada.

**Memoização**: guardar o resultado de um cálculo caro atrelado à sua chave.
`oddspapi_fixture_id` em `external_ids` é memoização.

**Estado em memória vs persistido**: estado em memória some a cada deploy. Já
apareceu três vezes no seu sistema (cursor do resolver, `lastAttemptAt` do
enricher, cache da OddsPapi) e o sintoma é sempre o mesmo: **o comportamento
pós-deploy diverge do comportamento em regime**.

**Idempotência**: rodar duas vezes tem o mesmo efeito que rodar uma. É o que
permite um cron ticar sem medo.

**Cursor**: onde uma varredura parou, para continuar dali. Em memória, um deploy
o zera e a varredura recomeça do início (caro, mas não incorreto).

**Timeout / AbortSignal**: teto de tempo para uma operação. Sem ele, um `fetch`
que **pendura** (em vez de falhar) nunca roda o `finally`, nunca solta o lock, e
o componente morre em silêncio. Foi exatamente o bug das 48h.

**Lock**: trava que impede dois ciclos de rodarem juntos. **Takeover por
obsolescência** é a saída: se o lock está velho demais, presume-se que o dono
morreu.

**Structured output**: forçar o LLM a responder num schema. Garante a **forma**
(chaves, tipos), não a **faixa**, por isso `probability` fora de [0,1] ainda
precisa de validação no código.

**RLS (row level security)**: política do Postgres sobre quem lê o quê. Nas suas
tabelas, ligada com acesso revogado para `anon`/`authenticated`: só o serviço
entra.

---

## Os cinco que valem decorar

1. **Fixture** = a mesma partida, no catálogo de outro provedor, com o id dele.
2. **`as_of` ≠ `observed_at`** = quando o fato valia ≠ quando você soube.
3. **Skill score** = quanto você bate o mercado. Negativo significa que não bate.
4. **Point-in-time** = a fonte sabe responder "o que se sabia em T". Sem isso, o
   backtest mente sem sintoma.
5. **Heartbeat** = a única coisa que distingue "travado" de "sem nada a dizer".
