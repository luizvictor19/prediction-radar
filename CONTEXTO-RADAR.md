# Contexto — onde o projeto está (14/08/2026)

Leia isto antes de qualquer coisa. Depois leia `CLAUDE.md` para as regras
inegociáveis.

---

## O que mudou: o projeto pivotou

O sistema **parou de tentar prever** e virou um **radar**: ele vigia preço de
mercados do Polymarket e o dono julga; o sistema não decide nada.

**Por quê:** oito hipóteses de edge foram medidas e todas deram negativo. A do
agente analista deu skill −0,029 sobre n=167 — ele não bate o preço. O README
tem a lista das oito com o número que matou cada uma.

**A tese nova:** *o mercado precifica a MANCHETE e resolve pela REGRA.* A
diferença entre as duas é onde o dono opera. Isso é **leitura**, não previsão —
não exige ser mais esperto que o mercado, exige ler o regulamento que quase
ninguém lê (mediana de 1.262 caracteres, preenchido em 100% dos mercados).

**O produto da fase atual:** série de preço acumulando, para o dono olhar no fim
de semana, anotar a probabilidade dele *antes* do desfecho, e em ~2 meses medir
o Brier dele contra o do mercado. A máquina de medição já existe (`src/eval/`) —
ela não liga se a previsão veio de um modelo ou de uma pessoa.

---

## Estado do sistema

**Desligado** (migrations aplicadas): analista, enricher da OddsPapi, descoberta
e watchlist de esports, resolver, enricher. `discovery_slug_prefixes = '{}'`.
Nada gasta e nada coleta hoje, fora heartbeat, alerta de saúde e bot.

**Aplicadas nesta virada:**

```
20260813210118  parar_analista_e_oddspapi
20260813210119  retencao_protege_radar        (coluna events.radar_tracked)
20260813224149  coletor_radar
20260813224150  retencao_manual_protege_radar
20260814000233  desligar_esports
20260814021300  partição de polymarket_snapshots + teto 600
```

**Dado preservado:** nada foi apagado. `esports_snapshots` tem ~14,26M linhas e
fica. `esports_slug_patterns()` devolve `{cs2-%,lol-%,dota2-%}` — o fallback
embutido protege o histórico mesmo com a lista de prefixos vazia.

**Próxima tarefa:** `prompt-livro-um-lado.md`.

---

## Princípios de desenho, decididos e não negociáveis

**1. Filtra na coleta o que NÃO muda; filtra na view o que muda.**
Categoria não muda → cabe na coleta. Preço muda → não cabe, senão o mercado sai
do roster exatamente quando se move, que é o evento a estudar. Mesma coisa para
volume mínimo e tamanho de descrição: viram `where` na view.

**2. `radar_tracked` é marca de proteção e SÓ CRESCE.**
Nunca desmarcar. Mercado sai do roster porque resolveu — e desmarcá-lo entrega a
série ao ramo `finalized` da retenção, que apaga sem condição de idade, no
instante em que o desfecho torna o dado valioso. É o dano dos 1.755 do README.

**3. Assunto é COLUNA, não filtro.**
22 mercados sobre o Irã são 22 oportunidades de operar e **1 observação** na hora
de medir. Agrupar é problema da medição, não da coleta.

**4. `mid_price` é NULO quando falta um lado do livro.**
Nunca 0,50, nunca o lado único repetido. Livro vazio com mid 0,50 já fabricou um
gap falso de +0,13 na frente do XTracker.

**5. Teto sai de medição, não de chute.**
O gargalo não é a API (chamadas são em lote, mil mercados custam ~1,3k/dia numa
API gratuita) — é disco.

**6. Código morto o git lembra; dado morto some pra sempre.**
Apagar código: livre. Apagar dado: nunca.

---

## Armadilhas que este projeto já pagou para aprender

- **Descarte silencioso** — todo filtro conta e reporta o que derrubou, com
  motivo. Já pegou 29% de linhas sumindo numa sonda e 10% de estrato numa outra.
- **Livro vazio = mid 0,50 por aritmética**, não por consenso.
- **Significado de campo** — `event.startDate` é data de criação; um `endDate`
  de outra API era exclusivo; `endDate` da Gamma é a data marcada do evento e
  não o instante da resolução. Conferir antes de filtrar por qualquer campo.
- **Retenção** — o ramo `finalized` apaga série de evento resolvido **sem
  condição de idade**. Foi contornado por exceção, nunca consertado.
- **Extrapolar de amostra pequena** — aconteceu quatro vezes, sempre para pior.
- **Inchaço de índice** — `polymarket_snapshots` já chegou a 2.087 MB sendo
  1.492 MB de um único índice sobre 80 MB de dado.

---

## A tela (`web/`) fala com o banco por um proxy local

Decidido em 19/08/2026, depois de a primeira tentativa falhar.

**Service key não funciona em navegador.** O Supabase detecta pelo User-Agent e
devolve 401 — é decisão do produto deles, não configuração que se ajuste. E a
chave anônima não é alternativa: as três views do radar têm
`revoke all from anon, authenticated` e nenhuma tabela tem policy de RLS
(`grep "create policy"` nas migrations volta zero linhas).

Sobra um intermediário. O desenho é o mais barato que existe: **o dev server do
Vite é o proxy.** `/sb` é encaminhado para o PostgREST com `apikey`,
`Authorization` e `User-Agent` sobrescritos — o User-Agent também, porque
repassar o do navegador reproduz o mesmo 401.

O efeito colateral é melhor que o desenho original: `SUPABASE_URL` e
`SUPABASE_SERVICE_KEY` ficam em `web/.env.local` **sem o prefixo `VITE_`**, e o
Vite só inlina o que tem prefixo. A chave nunca entra no bundle. Antes ela
viajava para o navegador e a única defesa era uma trava de runtime; agora não há
caminho. A trava continua lá (`web/src/lib/trava.ts`), aborta se alguma variável
`VITE_*` tiver cara de segredo, e cobre só o erro de reabrir o caminho à mão.

Consequência aceita: a tela **só roda em `npm run dev`**. Sem dev server não há
proxy. O produto público, se existir, é outro app — chave anônima, dado público,
views com grant para `anon`.

## Dívida conhecida, achada em auditoria (19/08/2026)

Levantada ao planejar a tela do radar. Nenhum destes está consertado.

**1. O Brier nunca teve consumidor.** `src/eval/` não lê `my_bets.prob_self` em
lugar nenhum — grep confirma: `prob_self` só aparece no parser
(`src/lib/prob-self.ts`), na escrita (`src/bot/handlers/register.ts:392,558`) e
nas migrations. O que `src/eval/` mede é o Brier do **agente analista**
(`eval/dataset.ts`) e a calibração do **mercado** (`eval/market-dataset.ts`).
`register.ts:131` promete "sem `prob_self` não há Brier", mas o outro lado nunca
foi escrito. Isso é ausência, não número errado — nada fabrica valor. Mas é o
trabalho que falta para a fase atual ter produto, e ele precisa nascer **sem
exigir leg**: resolver o desfecho por `event_id`, não por `entry_price`, senão
repete o erro de amarrar previsão a operação.

**2. `Math.max(0.5, …)` volta a escapar quando não há leg nenhuma.**
`src/bot/format.ts:52`, dentro de `calcStake`. A guarda `if (bankroll === null)`
da linha 50 cobre "leg aberta sem preço" — não cobre "carteira nunca
configurada": sem nenhuma leg aberta, `bankroll.ts:79-88,113` devolve o objeto
vazio com `bankroll = cash`, e `cash_usd` ausente vira `0` pelo `?? 0` da linha
77. Aí `calcStake(0, …)` devolve **$0,50 fabricado**, com cara de conta.
Importa agora porque a tela do radar grava previsão sem leg: "zero legs no
banco" deixa de ser estado excepcional e vira o normal. O irmão sem piso,
`calcCalendarDrivenStake` (`src/lib/format-helpers.ts:63-71`), devolve 0.

**3. `leitura_n` é decidido no PLANO, contra um snapshot congelado.**
`scripts/nivelar-leituras.ts:472` calcula `max + 1` sobre o índice lido em
`:761`, no início do `main`, e o número fica congelado no artefato por todo o
intervalo plano → chamadas (94 min na run 1) → escrita do arquivo → carga.
Qualquer linha que entre em `market_rule_digests` para a mesma chave de 4 partes
nesse intervalo faz o `n` do artefato colidir, e `carregar-digest.ts:607` o
descarta **em silêncio**, misturado no contador `já gravadas (puladas)`. Não há
`onConflict`: a colisão é evitada por filtro em memória, não pelo banco. O certo
é calcular na carga.

Não se materializou na run 2 — conferido por `SELECT`: as 2 digestões estão no
banco, `created_at` idêntico ao microssegundo (18/08 06:13:32), ou seja, foram
gravadas pelo insert em lote. O "já no banco" veio de `carregar-digest` rodado
uma segunda vez sobre o mesmo artefato (`:665`), que é a chave funcionando.
Estado hoje: 965 linhas, 191 textos, 4 abaixo do mínimo de 3 leituras
(`147357df` 2, `7d7c4253` 1, `c0c968b0` 2, `f857c8c4` 2) — dos quais 3 são
recusa da trava de opinião no mesmo termo (`\bprováve(l|is)\b`, vindo do próprio
regulamento) e 1 é timeout de rede. A recusa **não** é reprodutível: o mesmo
texto no mesmo mercado passou em `leitura_n=2` e foi recusado em `n=3`, e não há
`temperature`/`seed` no código.

## A série de dois meses não começou, e o que a bloqueia não é código (24/08/2026)

`npm run medir:serie`, medido em 24/08/2026:

```
my_bets, total de linhas:   58
com prob_self NÃO NULO:      0   (0,0%)
PONTUÁVEIS:                  0
```

A tela Operar existe desde **22/08** (`81ba010`) e o fluxo `/register` do bot
desde **14/08** (`20260814142957`). Entre os dois, **nenhuma probabilidade foi
registrada**. As 58 linhas de `my_bets` são todas `estrategia = 'legado'` — o
default que a migration deu ao que já estava lá — e a mais recente é de
**23/05/2026**, três meses atrás.

O zero foi conferido por três caminhos, porque zero é o resultado que uma query
errada também produz: o filtro invertido fecha (58 nulos + 0 não nulos = 58); a
coluna irmã `confidence_self` tem 57 preenchidas, então a tabela não está vazia
de dado, está vazia **desta** coluna; e `v_radar`, que lê por outro caminho,
concorda. A hipótese de a tela escrever noutro banco foi fechada: `web/.env.local`
e o `.env` da raiz apontam para o mesmo projeto.

**Isto não é issue, e é por isso que está aqui.** Não há bug a consertar, não há
código a escrever que faça a série começar. O `README` promete "accumulate two
months of series"; o dia 1 dessa contagem ainda não aconteceu. Todo trabalho de
eval do humano — o consumidor que lê `prob_self`, o Brier, a comparação contra o
preço — fica esperando um dado que só existe se alguém abrir a tela e registrar.

O número está num comando e não numa frase de propósito: `npm run medir:serie` o
refaz. Um zero datado numa issue envelhece até virar afirmação que ninguém
confere; um zero refazível não.

## Operacional

- **Migrations: escrever e parar.** Quem aplica é o dono (`supabase db push`).
- **Banco: leitura pode, escrita não.** `SELECT` para diagnóstico; nada de
  `INSERT`/`UPDATE`/`DELETE`/DDL na mão.
- **Nunca ler `.env`.**
- **Não commitar** sem pedido explícito.
- **DNS local**: esta máquina só resolve `polymarket.com` com VPN ligada. Teste:
  `getent hosts gamma-api.polymarket.com`. No Railway não acontece.
