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

Uma vez por clone, para o `git blame` pular o commit de formatação:

    git config blame.ignoreRevsFile .git-blame-ignore-revs

## Portão

O comando único (`npm run check`) entra com o PR de CI. Até lá, na ordem:

    npm run format:check
    npm run lint                            # eslint em src/ e scripts/
    npm run typecheck                       # tsc --noEmit na raiz
    npm test                                # tsx --test em src/, scripts/ e web/src/
    npm run typecheck --prefix web          # quando o PR toca web/
    npm run build:web                       # next build de web/, quando o PR toca web/

Testes que precisam de Postgres de verdade:

    npm run test:db                         # sobe o Supabase local e roda com RADAR_TEST_DB=required
    npm run test:db:stop                    # derruba a stack local, sem backup

Se outra stack ocupa a porta 54321, os testes de banco pulam com "não é a deste
projeto" (ou falham, com `RADAR_TEST_DB=required`) antes de qualquer escrita.

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

## Trazer a main para a branch da issue

Quando a branch ficou para trás ou o PR tem conflito. Merge, nunca rebase: o
histórico fica e não precisa de force push.

    git -C <worktree> fetch origin
    git -C <worktree> merge origin/main

Depois, o portão de novo na worktree. O hook `.claude/hooks/guard-main.sh`
recusa qualquer outro merge (de outra branch, `--squash`, `-X`) e qualquer
merge na `main`; aceita só `--no-edit`, `--no-ff` e `-m <msg>` junto, ou
`--abort` e `--continue` sozinhos. `git rebase`, `git reset --hard` e force
push estão na deny list.

## Mergear o PR NN e limpar

O Claude mergeia quando valem as cinco condições de "Merge" no `AGENTS.md`;
faltou uma, para e diz qual. O Luiz também pode pedir, nomeando o número.

    gh pr checks NN --watch --fail-fast     # condição 2: CI verde
    # condição 5: os dois canais de keyword (seção acima)
    gh pr merge NN --merge

Depois, da pasta principal, nunca de dentro da worktree que vai ser removida:

    git pull --ff-only origin main
    git worktree remove .claude/worktrees/<type>-NN-<scope>
    git branch -d <type>/NN-<scope>
    gh api -X DELETE repos/luizvictor19/prediction-radar/git/refs/heads/<type>/NN-<scope>

A branch remota sai pela API: o hook recusa todo push feito da `main`,
inclusive o `git push origin --delete` que só apaga uma branch.

Squash só se o Luiz pedir no mesmo pedido.

## Migrations

Escrever:

    supabase migration new <nome>           # cria supabase/migrations/<timestamp>_<nome>.sql

Comentário `--` em inglês; `comment on` segue os vizinhos da mesma tabela.

Aplicar é do Claude, logo antes do merge do PR que traz o arquivo, depois do
code-review, e sempre da worktree da issue: o hook recusa `supabase db push`
da pasta principal, de uma worktree na `main` e de fora do repositório.
Migration que apaga linhas só é aplicada com a aprovação explícita do Luiz,
por nome, no PR.

    cd .claude/worktrees/<type>-NN-<scope>
    supabase link --project-ref "$(cat ../../../supabase/.temp/project-ref)"   # uma vez por worktree
    B=~/backups/prediction-radar/$(date +%F)-<nome>
    mkdir -p "$B"
    git fetch -q origin && git rev-parse origin/main > "$B/commit"   # o que a produção roda antes do push
    supabase db dump --linked --role-only -f "$B/roles.sql"
    supabase db dump --linked -f "$B/schema.sql"
    supabase db dump --linked --data-only --use-copy -f "$B/data.sql"
    supabase db push --dry-run              # tem que listar só as migrations deste PR
    supabase db push
    supabase db query --linked "select version from supabase_migrations.schema_migrations order by version desc limit 5" -o json

A versão nova tem que aparecer na última query; só então mergear. Se o
dry-run listar qualquer outra migration, parar e dizer qual. Depois do push,
avisar o Luiz: qual migration, o que o dry-run listou e onde está o backup.

O backup vai para disco, fora do repositório e nunca para dentro do banco (a
cota do Free é de 0,5 GB para a organização inteira, issue 63). O dump de
dados lê o banco inteiro: é leitura pesada (ver `CLAUDE.md`), e tabela grande
que a migration não toca pode sair com `-x public.<tabela>`. Se o `link`, o
`dump` ou o `push` pedir a senha do banco, parar e perguntar ao Luiz onde ela
fica; ela nunca entra no repositório nem num chat.

`db reset`, `db pull`, `migration up` e `psql` continuam na deny list de
`.claude/settings.json`.

## Arquivar o mês (todo mês, a partir do dia 9)

No plano Free a cota de banco é de 0,5 GB para a organização inteira (issue
63), e a série do radar cresce ~2,5 MB/dia com a foto a cada 60 min. Cada mês fechado sai do banco para o
Google Drive (issue 60). Se ninguém arquivar, o bot avisa no Telegram quando o
banco passar de `system_config.database_alert_bytes` (450 MB).

Uma vez só, por máquina: `rclone` em `~/.local/bin` e o remote `gdrive`.

    ~/.local/bin/rclone config create gdrive drive scope=drive.file   # abre o navegador

Todo mês, a partir do dia 9 do mês seguinte:

1.  Issue curta ("Archive radar month YYYY-MM") e branch `chore/NN-archive-YYYYMM`.
2.  Da checkout principal (a que está linkada ao projeto):

        npm run arquivar:particao -- 2026-11

    Conta as linhas no banco (seq scan do mês fechado, ~170 MB, aprovado na
    issue 60), faz o dump só daquela partição sem as linhas de `setval`, confere
    as linhas, sobe para `gdrive:prediction-radar-arquivo-frio/radar-YYYY-MM/`,
    confere com `rclone check --download` e escreve a migration do drop. Não
    apaga nem sobrescreve nada: pasta ou arquivo que já existe faz parar.

3.  Copiar a migration gerada para a branch e abrir o PR. O DROP apaga dado
    do banco: só é aplicado (Migrations, acima) com a aprovação do Luiz, por
    nome, no PR. O DROP devolve o disco na hora, sem VACUUM.

A cópia local fica em `~/arquivo-frio-radar/radar-YYYY-MM/`.

### Restaurar um mês

    # 1. a partição default não pode ter linha do mês, senão o create falha
    select count(*) from public.polymarket_snapshots_default
     where captured_at >= '2026-09-01' and captured_at < '2026-10-01';
    # 2. recriar a partição
    create table public.polymarket_snapshots_p202609 partition of public.polymarket_snapshots
      for values from ('2026-09-01 00:00:00+00') to ('2026-10-01 00:00:00+00');
    # 3. carregar SEM as linhas de setval
    gunzip -c ARQUIVO.sql.gz | grep -v '^SELECT pg_catalog.setval(' | psql <db-url>

O `grep -v` é obrigatório nos arquivos das issues 54 e 59 (`2026-11-04/` e
`2026-11-12/`): o `pg_dump --data-only` gravou `setval` de toda sequência do
schema, e carregar sem filtro volta `system_logs_id_seq` e
`polymarket_snapshots_id_seq` para valores antigos. O próximo insert colide.
Os arquivos do script (`radar-YYYY-MM/`) já saem sem `setval`. A receita no
cabeçalho das migrations `20261104221251` e `20261112041338` não tem o filtro;
elas estão aplicadas e ficam como estão, e vale a desta seção.

## Rodar o sistema

    npm run dev                             # tsx watch src/index.ts (coletores e jobs)
    npm start                               # tsx src/index.ts, o que o Railway roda
    npm run bot                             # bot do Telegram (grammy)
    npm run dev --prefix web                # a tela, em http://127.0.0.1:5173, pede a senha

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

O backfill `backfill:texto-da-regra` é pontual. Antes de rodar, ler o
cabeçalho do script: sem `--confirmar` ele só planeja e não escreve.

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
- `web`: a tela (`web/`).
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
