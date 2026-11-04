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
- `web/`: tela local em Vite + React, com `package.json` e `node_modules`
  próprios. Fala com o banco pelo proxy do dev server, nunca direto (ADR 0008).
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

- **Nunca aplicar migration.** Escrever o `.sql` com `supabase migration new` e
  parar. Quem aplica é o Luiz (`supabase db push`).
- **Banco: leitura pode, escrita não.** `SELECT` para diagnóstico e medição.
  Nada de `INSERT`, `UPDATE`, `DELETE`, DDL ou `supabase db push`. Query nova
  sobre tabela grande é mostrada antes de rodar (ver `CLAUDE.md`).
- **Nunca ler `.env`**, nem `web/.env.local`. Variável de ambiente se cita só
  pelo nome.
- **Nunca commitar em `main`.** Commit, push e PR só dentro do fluxo abaixo.
- **Nunca mergear** sem o Luiz pedir, nomeando o número do PR.
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
   **decisão**, com uma linha de motivo. Depois de postar o plano, parar.
3. **Implementar só depois do "aprovado" do Luiz.** A aprovação cobre aquela
   issue e autoriza a branch, os commits, o push e o PR dela. Branch a partir
   da `main` atualizada, numa worktree, com nome `type/NN-scope`.
4. **PR, e parar.** Corpo com `Closes #NN`, o que mudou, o que difere do plano
   e como testar em no máximo 3 passos. Portão verde. Não mergear.

### No caminho

- **Problema achado fora do escopo vira issue nova**, com as quatro partes, e
  não é consertado no mesmo PR. Citar o número no relatório.
- **Plano que muda durante a implementação:** atualizar o comentário do plano
  na issue. Se a mudança toca produção, banco ou arquitetura, parar e esperar
  nova aprovação.

### Quem faz o quê

- **Luiz:** abre ou aprova issues, aprova planos, pede merges, aplica
  migrations e faz deploy.
- **Claude Code (terminal):** lê o GitHub, roda comandos, escreve planos,
  implementa e abre PRs. Abre issue quando o Luiz pede ou quando acha problema
  fora do escopo.
- **Guia da semana:** fica fora do repositório (decidido em 03/11/2026). Não
  procurar por ele aqui.

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
```

`npm run test:db` sobe o Supabase local e roda os testes que precisam de
Postgres de verdade (`RADAR_TEST_DB=required`). Não há build: o processo roda
por `tsx`, e a tela só existe em `npm run dev`.
