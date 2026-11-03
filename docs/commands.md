# Comandos do dia

Rodar da pasta principal `~/Projects/prediction-radar`, salvo quando o passo
disser outra coisa. As regras por trás destes comandos estão em `AGENTS.md` e
`CLAUDE.md`.

## Começar a issue NN

    git status --short                      # árvore limpa antes de trocar de branch
    git fetch origin && git pull --ff-only origin main
    git worktree add .claude/worktrees/<type>-NN-<scope> -b <type>/NN-<scope> origin/main
    cd .claude/worktrees/<type>-NN-<scope>
    npm install && npm install --prefix web # dois installs: a raiz e web/

`type` é `feat`, `fix`, `chore` ou `docs`. Abrir o Claude Code dentro da
worktree, para as regras do repositório valerem.

Os arquivos de ambiente não vão para o git e não são lidos pelo agente. Se a
worktree precisar rodar algo contra o banco, quem copia é o Luiz:

    cp .env .claude/worktrees/<type>-NN-<scope>/
    cp web/.env.local .claude/worktrees/<type>-NN-<scope>/web/

## Portão

O comando único (`npm run check`) entra com o PR de CI. Até lá, na ordem:

    npm run format:check
    npm run lint                            # eslint em src/ e scripts/
    npm run typecheck                       # tsc --noEmit na raiz
    npm test                                # tsx --test em src/, scripts/ e web/src/
    npm run typecheck --prefix web          # quando o PR toca web/

Testes que precisam de Postgres de verdade:

    npm run test:db                         # sobe o Supabase local e roda com RADAR_TEST_DB=required
    npm run test:db:stop                    # derruba a stack local, sem backup

## Abrir o PR

    git push -u origin <type>/NN-<scope>
    gh pr create --base main --title "<type>(<scope>): ..." --body-file /tmp/pr-NN.md

O corpo leva `Closes #NN`, o que mudou, o que difere do plano e como testar em
até 3 passos. `--fill` sozinho não fecha issue (ver `CLAUDE.md`).

## Antes de mergear: os dois canais de keyword

    gh api graphql -f query='{ repository(owner:"luizvictor19", name:"prediction-radar") {
      pullRequest(number:<N>) { closingIssuesReferences(first:20) { nodes { number state } } } } }'
    git log origin/main..HEAD --format='%B' | grep -niE '\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) +#[0-9]+'

O primeiro lê o corpo do PR; o segundo, o corpo dos commits. Os dois fecham
issue. Detalhe e incidente em `CLAUDE.md`.

## Mergear o PR NN e limpar (só quando o Luiz pedir)

Da pasta principal, nunca de dentro da worktree que vai ser removida:

    gh pr merge NN --merge
    git pull --ff-only origin main
    git worktree remove .claude/worktrees/<type>-NN-<scope>
    git branch -d <type>/NN-<scope>
    git push origin --delete <type>/NN-<scope>

Squash só se o Luiz pedir no mesmo pedido.

## Migrations

Escrever e parar:

    supabase migration new <nome>           # cria supabase/migrations/<timestamp>_<nome>.sql

Comentário `--` em inglês; `comment on` segue os vizinhos da mesma tabela.
Quem aplica é o Luiz, da worktree que tem o arquivo:

    supabase db push                        # só o Luiz

`db push`, `db reset`, `db pull`, `migration up` e `psql` estão na deny list
de `.claude/settings.json`.

## Rodar o sistema

    npm run dev                             # tsx watch src/index.ts (coletores e jobs)
    npm start                               # tsx src/index.ts, o que o Railway roda
    npm run bot                             # bot do Telegram (grammy)
    npm run dev --prefix web                # a tela; único jeito de ela rodar (proxy do Vite)

Polymarket exige VPN nesta máquina: `getent hosts gamma-api.polymarket.com`
tem que resolver antes.

## Scripts (`tsx scripts/...`)

Medições que refazem os números citados nos documentos:

    npm run medir:idioma                    # nomes em português por camada
    npm run medir:serie                     # série de prob_self em my_bets
    npm run medir:tela-regra                # corte do gate de boilerplate
    npm run medir:texto-perdido
    npm run medir:digest-nulo
    npm run medir-consistencia

Radar e digestão:

    npm run radar:lista
    npm run radar:coletor
    npm run radar:categorias
    npm run radar:conferir                  # confere as views do radar
    npm run digerir                         # digestão das regras (paga LLM)
    npm run carregar-digest
    npm run nivelar

Sondas e backfills (`*:probe`, `backfill:*`, `xtracker:*`, `leadlag:*`) são
pontuais. Antes de rodar, ler o cabeçalho do script: vários pagam API.
`npm run oddspapi:probe` está na deny list.

## Labels (planejadas, ainda não criadas)

Tipo:

- `feat`: comportamento novo.
- `fix`: defeito; o conserto começa com teste que falha.
- `chore`: manutenção, sem mudança de comportamento.
- `docs`: só documentação.
- `ops`: deploy, Railway, operação de produção.

Área:

- `collector`: coletores e roster (`src/collectors/`).
- `digest`: digestão das regras e leituras.
- `web`: a tela local.
- `bot`: o bot do Telegram.
- `eval`: medição, Brier, calibração.
- `infra`: repositório, CI e configuração.

Estado:

- `epic`: issue mãe com sub-issues.
- `needs-decision`: pergunta para o Luiz antes do plano.
- `blocked`: esperando algo fora do repositório.

`dependencies`, `javascript` e `security` continuam (Dependabot e a issue 33
usam). Os outros defaults do GitHub não são usados. Criar, quando o Luiz
decidir:

    gh label create <nome> --description "<descrição>" --color <hex>

## Quirks do `gh` (gh 2.46.0)

    gh issue view <N> --json number,title,body,state       # gh issue view puro quebra (Projects classic)
    gh api repos/{owner}/{repo}/issues/<N> -X PATCH -F body=@arquivo.md
    gh api repos/{owner}/{repo}/pulls/<N> -X PATCH -F body=@arquivo.md   # no lugar de gh pr edit
    gh issue list --state open

`gh pr edit` e `gh issue view` sem `--json` falham com erro de GraphQL sobre
Projects classic. `gh pr view --json closingIssuesReferences` não existe nesta
versão: usar o `gh api graphql` acima.

## Busca vazia

Antes de concluir que algo não existe no repositório:

    git ls-files -z | xargs -0 file | grep -v text

O que sobrar e não for imagem é arquivo que toda busca está pulando.

## Railway (só o Luiz)

`railway.toml`: builder nixpacks, restart `on_failure`, até 3 tentativas. O
comando de start é o `npm start`. Variáveis no painel, só por nome (lista em
`docs/context.md`, Segredos). Como o deploy é disparado e se o bot roda como
serviço separado não está no repositório: conferir no painel.
