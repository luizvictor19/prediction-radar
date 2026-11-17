# Prediction Radar · acordo de trabalho

Leia isto antes de escrever código neste repositório. As regras medidas que só
valem aqui estão em `CLAUDE.md`; o contexto do produto, em `docs/context.md`;
os comandos do dia, em `docs/commands.md`; as decisões, em `docs/adr/`.

## Stack

- Node 24 + TypeScript em modo estrito (ESM). Roda direto por `tsx`, sem passo
  de build. `.nvmrc` ainda diz 20: a troca para 24 (com `engines`) entra no
  PR de CI, decidida em 03/11/2026.
- Supabase (Postgres). O processo Node e os scripts falam com o banco pela
  service role (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`). Não há Auth de
  usuário (ADR 0001).
- Railway hospeda o processo (`railway.toml`, nixpacks) (ADR 0010).
- `web/`: a tela em Next.js 16 (App Router) + React, com `package.json` e
  `node_modules` próprios. O navegador só fala com as rotas de `/api`, atrás
  de senha; quem fala com o banco é o servidor (ADR 0013).
- Bot do Telegram em `grammy` (`src/bot/`) (ADR 0009).
- Dados de mercado: Polymarket Gamma e CLOB (ADR 0002).

## Idioma

O eixo é o público, não a pasta. A regra completa, com os números medidos, está
em `CLAUDE.md`. Resumo:

- **Inglês:** nome de branch, mensagem de commit, título e corpo de PR e de
  issue, comentário de código, nomes em `src/`, ADRs em `docs/adr/`.
- **Português:** nomes em `web/` e `scripts/` (o vocabulário das specs),
  documentos internos (specs, `docs/context.md`, `docs/commands.md`, este
  arquivo), nomes de teste e mensagens que o dono lê operando.
- Jargão de stack fica como está nas duas camadas.
- Nada de travessão longo em texto do projeto.

## Regras inegociáveis

- **Migration o Claude aplica, só no ritual.** Escrever o `.sql` com
  `supabase migration new`. Aplicar da worktree da issue, logo antes do merge:
  backup lógico fora do repositório, `supabase db push --dry-run`,
  `supabase db push`, uma query de leitura que confirma, e avisar o Luiz
  (comandos em `docs/commands.md`). O hook recusa `db push` fora de uma
  worktree de issue.
- **Apagar dado precisa do Luiz, por nome, no PR.** Migration ou script que
  apaga linhas só roda com a aprovação explícita dele no PR, nomeando o que
  sai. O ritual acima não cobre isso.
- **Banco: leitura pode, escrita não**, fora a migration do ritual. `SELECT`
  para diagnóstico e medição. Nada de `INSERT`, `UPDATE`, `DELETE` ou DDL fora
  de migration. Query nova sobre tabela grande é mostrada antes de rodar (ver
  `CLAUDE.md`).
- **Nunca ler `.env`**, nem `web/.env.local`. Variável de ambiente se cita só
  pelo nome.
- **Nunca commitar em `main`.** Commit, push e PR só dentro do fluxo abaixo.
- **Mergear só quando valem as condições de "Merge"** (abaixo). Faltou uma:
  parar e dizer qual.
- **Rodada paga de modelo:** estimar antes com dry-run. Até US$ 2 estimados,
  roda sem perguntar; acima disso, pergunta ao Luiz. O resultado é gravado à
  medida que chega (JSONL, em modo append), para uma queda no meio não jogar
  fora o que já foi pago.
- Bug começa com teste que falha.
- Código morto o git lembra; dado morto some para sempre. Apagar código é
  livre; apagar dado, nunca. Sair do banco não é apagar quando há cópia
  conferida fora dele (ver `docs/context.md`, regra 6).

## Fluxo

### Toda mudança começa com uma issue

- Nada muda no repositório sem uma issue aberta antes.
- O corpo da issue tem quatro partes: **What happens**, **What was expected**,
  **Evidence** (log, query, link, número medido) e **Done when**.
- Uma issue por PR. Trabalho grande vira issue mãe com sub-issues, e cada uma
  passa pelo fluxo inteiro.

### As quatro etapas

1. **Entender.** Ler a issue, o código e os documentos envolvidos. Todo plano
   lê `docs/context.md` primeiro. Sem branch, sem código. Faltou informação:
   perguntar na própria issue.
2. **Plano, como comentário na issue.** Arquivos que mudam, passos, testes,
   riscos e o que fica de fora. Só vira **pergunta** o que muda produção, o
   banco (migration, função, dado gravado) ou a arquitetura. O resto é
   **decisão**, com uma linha de motivo. Plano com pergunta para depois de
   postado.
3. **Implementar quando o plano deixa.** Plano só com decisões é implementado
   logo depois de postado, sem esperar. Plano com pergunta espera o "aprovado"
   do Luiz. Nos dois casos o plano cobre aquela issue e autoriza a branch, os
   commits, o push e o PR dela. Branch a partir da `main` atualizada, numa
   worktree, com nome `type/NN-scope`.
4. **PR, e merge quando "Merge" deixa.** Corpo com `Closes #NN`, o que mudou,
   o que difere do plano e como testar em no máximo 3 passos. Portão verde.
   Faltou uma condição de "Merge": parar ali e dizer qual.

### No caminho

- **Problema achado fora do escopo vira issue nova**, com as quatro partes, e
  não é consertado no mesmo PR. Citar o número no relatório.
- **Plano que muda durante a implementação:** atualizar o comentário do plano
  na issue. Se a mudança toca produção, banco ou arquitetura, parar e esperar
  nova aprovação.

### Merge

- O Claude mergeia (`gh pr merge NN --merge`) quando todas estas valem:
  1. o plano foi aprovado pelo Luiz, ou só tinha decisões;
  2. o CI está verde: `gh pr checks NN --watch --fail-fast`;
  3. o code-review rodou, quando "Onde vai o rigor" pede;
  4. a migration do PR, se houver, está aplicada e conferida por uma query de
     leitura;
  5. os dois canais de keyword de fechamento foram conferidos (comandos em
     `CLAUDE.md`).

  Faltou uma: parar e dizer qual. O Luiz também pode pedir um merge, nomeando
  o número do PR. Depois do merge, da pasta principal (nunca de dentro da
  worktree que vai sair): pull, remover a worktree, apagar a branch local e a
  remota (`docs/commands.md`).

- **Merge é deploy.** Como o Railway dispara o deploy mora no painel
  (ADR 0010), então todo merge conta como deploy. O corpo do PR diz o que cada
  uma das cinco condições conferiu.
- **PR com migration:** o Claude roda `supabase db push` da worktree da issue
  logo antes do merge, depois do code-review, com o backup e o dry-run antes, e
  avisa o Luiz. Não mergeia antes de a query de leitura mostrar a migration
  aplicada.
- **`git rebase`, reset hard e force push continuam bloqueados.** `git merge`
  só roda para trazer `origin/main` para a branch da issue; o hook recusa
  qualquer outro merge e qualquer merge na `main`. Trazer a `main` por merge
  guarda o histórico e não pede force push.
- Este fluxo vale a partir do merge do PR da issue 84, que o próprio Luiz
  mergeia: uma regra não autoriza o próprio merge.

### Quem faz o quê

- **Luiz:** abre ou aprova issues e responde as perguntas de um plano. Guarda
  as contas e chaves (Supabase, Railway, AWS, Vercel), as decisões de produto e
  de gasto, e a aprovação de todo apagamento de dado. Pode pedir qualquer
  merge.
- **Claude Code (terminal):** lê o GitHub, roda comandos, escreve planos,
  implementa e abre PRs. Traz `origin/main` para as branches de issue, aplica
  migrations e mergeia, nas condições de "Merge". Abre issue quando o Luiz pede
  ou quando acha problema fora do escopo.
- **Guia da semana:** fica fora do repositório (decidido em 03/11/2026). Não
  procurar por ele aqui.

## Onde vai o rigor

- **Alto, onde o erro fica escondido:** coletores, tudo que é gravado no
  banco, migrations, retenção e tudo que apaga, a guarda da digestão, chamadas
  pagas.
- **Baixo, onde a tela mostra o erro na hora:** layout, texto de tela, docs. O
  portão e uma olhada bastam: decidir e seguir.
- **Code-review:** uma vez por entrega, sobre o diff inteiro, e só na coluna
  alta. Nunca para layout, texto de tela ou docs.

## Git

- Branch: `type/NN-scope`, com `type` em `feat`, `fix`, `chore` ou `docs` e NN
  o número da issue. Exemplo: `fix/32-roster-upsert-status`.
- Conventional Commits em inglês, por exemplo
  `fix(collector): keep resolved status on upsert`. O histórico anterior mistura formatos; vale daqui para a frente,
  sem reescrever nada.
- Um commit por unidade lógica. Sem amend: um segundo commit no lugar.
- Antes do primeiro commit, conferir a branch atual. Em `main`, criar a branch
  antes.
- Corpo de PR num arquivo e `gh pr create --body-file`. `--fill` sozinho não
  leva o corpo dos commits ao PR (ver `CLAUDE.md`).
- Merge padrão mantém os commits (`--merge`). Squash só quando o Luiz pedir no
  mesmo pedido.
- Antes de mergear, conferir os dois canais de keyword de fechamento (comandos
  em `CLAUDE.md`).

## Trabalho em paralelo

- Uma frente é uma branch, uma worktree, uma sessão do Claude Code.
- Teto de três frentes: o gargalo é quem revisa (ver `CLAUDE.md`).
- Cada worktree quer dois `npm install`: a raiz e `web/`.

## Portão

O alvo, que entra com o PR de CI, é um comando só, na ordem do CI, parando na
primeira falha:

```bash
npm run check   # format:check, lint, typecheck, test
```

Até ele existir, rodar as partes:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run typecheck --prefix web   # quando o PR toca web/
npm run build:web                # quando o PR toca web/
```

`npm run check` já termina com `typecheck:web` e `build:web`. O CI ainda
confere, com `npm run conferir:bundle`, que nenhum segredo chegou ao bundle
do navegador.

`npm run test:db` sobe o Supabase local e roda os testes que precisam de
Postgres de verdade (`RADAR_TEST_DB=required`). O processo roda por `tsx`,
sem build; só a tela (`web/`) tem build.
