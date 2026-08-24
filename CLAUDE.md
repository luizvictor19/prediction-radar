# Prediction Radar

Node.js + TypeScript (ESM, roda via tsx). Supabase (Postgres) + Railway.
Coleta mercados do Polymarket, detecta sinais, notifica via Telegram.

## Regras inegociáveis
- NUNCA aplicar migrations. Escrever o .sql com `supabase migration new` e parar.
  Quem aplica é o dono do projeto.
- Banco: **leitura pode, escrita não.**
  - Permitido: `SELECT` para diagnóstico e medição.
  - Proibido: `INSERT`, `UPDATE`, `DELETE`, DDL e `supabase db push`.
  - Query NOVA sobre tabela grande: mostrar antes de rodar (ver abaixo).
- Nunca ler .env.
- Idioma: ver a seção abaixo. O eixo é o público, não a pasta.

### Idioma: o eixo é o público, não a pasta
O que sai do repositório é inglês. O que fica dentro fala a língua da spec que
implementa.

- **Inglês, sempre** — nome de branch, mensagem de commit, título e corpo de PR
  e de issue, e comentário de código. É o que um leitor externo alcança.
- **`src/`** — coletores, detectores, jobs: inglês, nomes inclusive.
- **`web/` e `scripts/`** — português. Eles implementam specs escritas em
  português e compartilham o vocabulário delas: `veredito`, `armadilha`,
  `trecho`, `origem`, `leitura`. O nome no código é a mesma palavra da spec e a
  mesma coluna do banco, e essa cadeia é o que se perde ao traduzir um dos elos.
- **Jargão de stack sem tradução** — `dedup`, `boilerplate`, `sha256`,
  `supabase`, `polymarket`: fica como está, nas duas camadas.
- **Documento interno** — specs, relatórios, este arquivo: português.
- **Texto que o dono lê operando** — mensagem de falha de asserção, saída de
  comando, relatório de medição: português, nas duas camadas. Não é comentário
  (ninguém lê rodando) nem nome (não é identificador): é interface de operação, e
  segue o idioma dos NOMES DE TESTE, que é a linha impressa colada nela.

**A quarta categoria também tem número.** Medido em 23/08/2026 sobre a saída da
própria suíte: dos **882** nomes de teste de primeiro nível, **692** trazem marca
inequívoca de português e **8** de inglês — os 180 restantes são curtos demais
para marcar (`usd / qtd`). E o desequilíbrio não é acidente de pasta: **722**
desses nomes estão em `src/`, cuja regra de nomes é inglês, e ainda assim são
escritos em português, porque título de teste é frase e não identificador.

Por isso a mensagem de falha segue o nome do teste, e não a pasta: as duas saem
juntas no mesmo vermelho, e um par com metade em cada idioma é pior que qualquer
lado puro.

A regra do comentário vale **na borda**, arquivo a arquivo, quando alguém
encostar: comentário novo em inglês, o resto do arquivo fica como está.
Normalizar arquivo inteiro é chore separado, nunca carona num fix.

Arquivo NOVO nasce com todo **comentário** em inglês — não há borda a respeitar
num arquivo que ninguém escreveu antes. Os **nomes** continuam seguindo a pasta:
`src/` inglês, `web/` e `scripts/` português. As duas metades da frase têm
sujeitos diferentes, e é por isso que ela precisa de duas.

**Isto descreve o código que já existe, e o número é medido.** Em 22/08/2026,
por `npm run medir:idioma`: `src/` tem 61 de 723 nomes em português (**8,4%**),
`scripts/` 33 de 115 (**28,7%**) e `web/` 65 de 88 (**73,9%**). As frações vêm
com denominador porque sem ele são opinião, e o comando as refaz quando o código
andar.

**A alternativa foi avaliada e descartada com número.** A regra candidata era
"nome que espelha o banco mantém a grafia do banco, o resto é inglês". Medida
sobre `web/` e `scripts/`, ela tocaria **75 dos 107** nomes em português — só 26
espelham de fato uma tabela, coluna ou valor. E **57% dos 75 são verbos**
(`lerAchados`, `separarHerdados`, `montarLinhas`), então o conteúdo real da
regra não era "espelhar o banco": era "verbo vira inglês", que é outra decisão e
teria que se justificar sozinha. Reescrever três quartos dos nomes da camada do
operador cortaria o código do vocabulário das specs que ele existe para
implementar.

### Leitura pesada não é inofensiva só por ser leitura
Query NOVA sobre tabela grande — `events`, `polymarket_snapshots`,
`esports_snapshots`, `system_logs` — deve ser MOSTRADA antes de rodar.

O `retention_job` já derrubou o banco com uma query mal planejada: um `LIKE ANY`
com pattern vindo de variável não usava `idx_events_slug_prefix`, e o que sobrava
era seq scan dos 711 MB de `events` (ver `20260807230005_retention_old_branch_plan.sql`).
`events` tem ~551k linhas e o timeout do PostgREST é de 8s — um `SELECT` sem
índice ali é incidente de produção, não consulta.

Na dúvida sobre o plano, mostrar a query e esperar.

## Teste que afirma só o estado final não prova a transição
Quando o caminho até o valor tem mais de um passo, outra regra do caminho
costuma produzir aquele mesmo valor no fim — e a asserção passa sem nunca ter
alcançado a regra que ela existia para travar.

Afirmar a SEQUÊNCIA, não o destino: capturar o valor a cada passo e comparar a
lista inteira.

Quem descobre isso é a mutação, e ela vale nos dois sentidos. Asserção que não
cai quando a regra é invertida não está testando a regra; mutação que não
derruba teste nenhum pode ser mutação morta, e aí se confere primeiro se ela
chega a ser executada.

Três vezes até agora:
- `f1ff37c` — a guarda lia a coluna declarada de um fixture onde ela não
  existia. O lookup dava `undefined`, a asserção era pulada, e trocar o extrator
  deixava tudo verde.
- `f644879` (`spec-tela-regra.md` §4) — a primeira mutação do eixo de absorção
  não derrubou teste nenhum, e o defeito era a mutação: no array ordenado do
  mais longo para o mais curto, o ramo que ela acrescentava nunca era alcançado.
- `763f3f3` — o teste do cronômetro afirmava só o começo final e sobreviveu às
  três mutações, porque sair de Hoje reinicia o relógio de qualquer jeito.
  Passou a afirmar o `null` do meio da sequência.

## Issue fecha pela mensagem de commit, não pelo corpo do PR
`gh pr create --fill` monta o PR a partir dos commits, e num PR de mais de um
commit ele lista só os ASSUNTOS. O corpo de cada commit não entra. Então a linha
`Closes #N`, que mora no corpo, nunca chega ao corpo do PR — e fecha a issue
assim mesmo, porque o GitHub também lê a mensagem dos commits que entram na
branch padrão. É por aí que a issue fecha. O PR não fechou nenhuma.

Três PRs em 23/08/2026, dois commits cada, todos com `--fill`, todos com corpo
de PR igual a duas linhas de assunto:
- `1631d69` carrega `Closes #7.` — PR #15 mergeado 19:09:42Z, issue #7 fechada
  **19:09:43Z**.
- `2b1b8c8` carrega `Closes #6.` — PR #16 mergeado 19:33:53Z, issue #6 fechada
  **19:33:54Z**.
- `3909986` e `1ec5ef6` não carregam nenhuma — PR #17 mergeado 20:28:37Z com
  todo o trabalho da #9 dentro, e a #9 continuou aberta. Fechada na mão às
  22:27:49Z, **1h59 depois**, por alguém que lembrou.

Um segundo separa as duas primeiras do merge que as fechou. A terceira levou
uma hora e cinquenta e nove minutos e uma pessoa se lembrando dela, pela única
diferença de uma linha faltando numa mensagem de commit.

Ou o commit carrega `Closes #N`, ou o PR ganha corpo próprio (`--body`, `-F`)
em vez de `--fill`. `--fill` sozinho não fecha issue nenhuma.

Os três entraram por merge commit, que é o que faz a mensagem de cada commit
chegar à main inteira. Trocar a estratégia de merge mexe justamente no texto
que o GitHub lê, então é conferir de novo, não supor.

## Paralelizar tem teto em quem revisa, não em quantos agentes cabem
Uma worktree por frente (`claude --worktree <nome>`), nunca duas sessões no
mesmo diretório. Cada worktree quer o próprio `npm install` — dois, na verdade:
a raiz e `web/`, que tem `package.json` e `node_modules` separados.

**Três frentes é o teto.** O gargalo não são os agentes, é quem lê cada
mensagem de commit e roda cada comando. Acima de três, a atenção que faz a
revisão valer vira despacho.

Só paraleliza o que não disputa o mesmo trecho. Em 23/08/2026 as três frentes
foram investigação de relatório (#15), infraestrutura de teste (#16) e banco
(#17), e o único conflito do dia foi um import em `web/src/lib/dados.ts` —
linha vizinha, posicional e não semântico.

**"Não compartilha arquivo" é forte demais, e a medição do dia diz isso.** Das
três frentes, quatro arquivos foram tocados por mais de uma: `package.json`
pelas três, `CLAUDE.md`, `scripts/digerir-regras.ts` e `web/src/lib/dados.ts`
por duas. Nenhum desses quatro conflitou. O que não colidiu foram as REGIÕES —
os três acréscimos ao `package.json` caíram em três blocos de script
diferentes. O corte é por trecho e por comportamento, não por caminho: duas
issues que mexem no mesmo comportamento são uma branch, não duas.

E antes de trocar de branch ou puxar a main, conferir que a árvore está limpa.
Um `git checkout main` com trabalho não commitado leva as modificações junto
para a branch errada — aconteceu em 23/08/2026.

## Onde está o quê
- Schema atual: `supabase/migrations/20260804054445_remote_schema.sql` (baseline).
  As migrations 001-004 são anteriores e já aplicadas.
- Trabalho corrente: `specs/000-contencao.md`. Respeitar a Parte E (divisão
  humano/agente) antes de executar qualquer item.
- `specs/001-esports-vertical.md` vem depois. Não começar antes da 000 terminar.

## PROJECT.md está desatualizado
É registro histórico (v7, maio/2026). Serve para entender o sistema como está
construído — tabelas, detectores, coletores, comandos do bot.
NÃO serve como direção: a estratégia mudou. As specs em `specs/` são a fonte
de verdade sobre o que fazer agora.

## Direção atual (resumida)
- Foco estreitando para esports (CS2 primeiro, depois LoL e futebol).
- Detectores genéricos serão desligados, não expandidos.
- Objetivo: acumular série temporal de qualidade para backtest e, depois,
  um agente analista.
