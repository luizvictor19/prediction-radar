# Contexto

O que um plano precisa saber antes de mexer em qualquer coisa. As decisões
daqui estão tomadas; mudar uma é pergunta de arquitetura para o Luiz, e a
decisão nova vira ADR em `docs/adr/`.

Escrito em 03/11/2026 a partir de `CONTEXTO-RADAR.md` (14/08 a 24/08/2026) e
da direção que morava no `CLAUDE.md`. Número com data é medição daquela data,
não estado de hoje: conferir antes de usar como justificativa (regra
"Afirmação herdada não é medição", em `CLAUDE.md`).

## O produto

- Ferramenta pessoal do Luiz, um usuário só. Coleta mercados do Polymarket,
  guarda série de preço, notifica pelo Telegram e mostra uma tela local.
- **O projeto pivotou em 13–14/08/2026: parou de tentar prever e virou um
  radar** (ADR 0003). Ele vigia preço e o dono julga; o sistema não decide
  nada.
- **Por quê:** oito hipóteses de edge foram medidas e todas deram negativo. A
  do agente analista deu skill −0,029 sobre n=167: ele não bate o preço. O
  `README.md` tem as oito, com o número que matou cada uma, e
  `docs/research-record.md` o registro.
- **A tese:** o mercado precifica a MANCHETE e resolve pela REGRA. A diferença
  entre as duas é onde o dono opera. Isso é leitura, não previsão: exige ler o
  regulamento que quase ninguém lê (mediana de 1.262 caracteres, preenchido
  em 100% dos mercados, medido em agosto de 2026).
- **O produto da fase atual:** série de preço acumulando, o dono anotando a
  probabilidade dele (`my_bets.prob_self`) ANTES do desfecho, e em cerca de
  dois meses o Brier dele medido contra o do mercado. A máquina de medição
  existe em `src/eval/`.
- **A série ainda não começou.** Em 24/08/2026, `npm run medir:serie` deu 0 de
  58 linhas de `my_bets` com `prob_self` preenchido. Não é bug: ninguém
  registrou. O comando refaz o número; rodar antes de citar.

## Direção atual

- O foco é o radar: roster de mercados (`radar_tracked`), digestão das regras
  (`market_rule_digests`) e a tela de Regra em `web/`.
- Detectores genéricos e o pipeline de esports estão **desligados por flag**,
  não apagados. Desligar é o caminho; expandir, não.
- O objetivo de médio prazo continua: série temporal de qualidade para medir,
  e só depois um agente analista, se a medição justificar.
- Fonte do que fazer agora: as issues abertas, `specs/` e este arquivo.
  `PROJECT.md` é registro histórico de maio/2026 (ADR 0011).

### Histórico da direção (para não confundir)

O `CLAUDE.md` de 04/08/2026 dizia: foco estreitando para esports (CS2, depois
LoL e futebol), trabalho corrente na `specs/000-contencao.md` (respeitando a
Parte E, divisão humano/agente) e a `specs/001-esports-vertical.md` só depois
da 000. Isso foi executado e depois **superado pelo pivô de 14/08**: a
migration `20260814000233_desligar_esports` desligou descoberta e watchlist de
esports. As specs 000 a 003 ficam como registro de como o sistema chegou aqui.

## Onde está o quê

- Schema: `supabase/migrations/20260804054445_remote_schema.sql` é a
  baseline; as migrations 001 a 004 são anteriores e já aplicadas. O resto
  são migrations datadas, todas escritas aqui e aplicadas pelo Luiz.
- Specs numeradas: `specs/000` a `003`. Spec da tela de Regra:
  `docs/spec-tela-regra.md` e `docs/spec-tela-regra-item5.md`.
- Processos agendados e cron: `docs/processos-automaticos.md`. Comandos do
  bot: `docs/comandos-do-bot.md`. Termos: `docs/GLOSSARIO.md`.
- Prompts de sessões passadas: `docs/prompts/prompt-*.md`.

## Ambientes

- **Um banco só.** O projeto Supabase remoto é produção; não há staging.
  `web/.env.local` e o `.env` da raiz apontam para o mesmo projeto (conferido
  em 24/08/2026). Toda migration e toda escrita é mudança de produção.
- **Supabase local** existe só para teste: `npm run test:db` sobe a stack e
  roda os testes com `RADAR_TEST_DB=required`.
- **Railway** roda o processo Node (`railway.toml`: nixpacks, restart
  `on_failure` com até 3 tentativas). `npm start` é `tsx src/index.ts`, que
  agenda os coletores e jobs com `node-cron`. O bot é outro ponto de entrada
  (`npm run bot`, `src/bot/index.ts`); como ele sobe no Railway não está no
  repositório: conferir no painel antes de afirmar.
- **`web/`** só roda em `npm run dev`, na máquina do Luiz (ver "A tela"
  abaixo). Não tem deploy.
- **DNS local:** esta máquina só resolve `polymarket.com` com VPN ligada.
  Teste: `getent hosts gamma-api.polymarket.com`. No Railway não acontece.

## Segredos

- `.env` e `web/.env.local` nunca são lidos, impressos, resumidos nem
  commitados. Carregar variável para um processo rodar é normal; ler o
  arquivo, não.
- Variáveis, só pelo nome:
  - Banco: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (raiz e `web/.env.local`);
    `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_KEY` para os testes de banco.
  - Polymarket: `POLYMARKET_GAMMA_URL`, `POLYMARKET_CLOB_URL` (têm default no
    código).
  - Telegram: `TELEGRAM_BOT_TOKEN`. O `chat_id` vem de `system_config`.
  - LLM: `ANTHROPIC_API_KEY` (lido pelo SDK, sem nome no código),
    `DEEPSEEK_API_KEY`.
  - Esports, hoje desligado: `ODDSPAPI_API_KEY`, `LIQUIPEDIA_API_KEY`,
    `LIQUIPEDIA_API_URL`, `LIQUIPEDIA_USER_AGENT`.
- A service role passa por cima de tudo. Ela fica no processo Node e no dev
  server do Vite, nunca no bundle do navegador (ADR 0008).

## Regras de banco

- DDL só por migration em `supabase/migrations`, escrita com
  `supabase migration new` e aplicada pelo Luiz.
- Leitura pode, escrita não. Query nova sobre `events`, `polymarket_snapshots`,
  `esports_snapshots` ou `system_logs` é mostrada antes de rodar: `events`
  tinha ~551k linhas e 711 MB, e o timeout do PostgREST é de 8s.
- RLS está ligado em várias tabelas sem nenhuma policy (`create policy` nas
  migrations volta zero linhas). O acesso é só pela service role (ADR 0001).
  As views do radar têm `revoke all from anon, authenticated`, e
  `20260829001257_revoke_legacy_grants_from_anon.sql` fecha o resto.
- Partição não é alcançável pelo PostgREST (404 `PGRST205`, com ou sem grant),
  ao contrário do que três migrations aplicadas afirmam.
- `events.slug` é slug de MARKET. Link de evento no Polymarket usa
  `event_group_slug` (`/event/<event_group_slug>`).

## Princípios de desenho

Decididos em agosto de 2026 e não negociáveis sem ADR nova.

1. **Filtra na coleta o que NÃO muda; filtra na view o que muda** (ADR 0004).
   Categoria cabe na coleta. Preço, volume mínimo e tamanho de descrição viram
   `where` na view, senão o mercado sai do roster exatamente quando se move.
2. **`radar_tracked` só cresce** (ADR 0005). Desmarcar entrega a série ao ramo
   `finalized` da retenção, que apaga sem condição de idade, no instante em
   que o desfecho torna o dado valioso. Das 1.755 partidas resolvidas sondadas,
   zero tinham série utilizável (`docs/research-record.md`).
3. **Assunto é COLUNA, não filtro.** 22 mercados sobre o Irã são 22
   oportunidades de operar e 1 observação na hora de medir. Agrupar é problema
   da medição, não da coleta.
4. **`mid_price` é NULO quando falta um lado do livro.** Nunca 0,50, nunca o
   lado único repetido. Livro vazio com mid 0,50 já fabricou um gap falso de
   +0,13.
5. **Teto sai de medição, não de chute.** O gargalo não é a API, é disco.
6. **Código morto o git lembra; dado morto some para sempre.** Apagar código:
   livre. Apagar dado: nunca. Tirar do banco não é apagar quando o dado fica
   guardado fora dele, com contagem de linhas conferida contra o banco e
   sha256 de cada arquivo (decidido em 04/11/2026, issue 54). É o caso das
   partições de agosto de `esports_snapshots` (14,26M linhas) e da
   `polymarket_snapshots_legado`: arquivadas e conferidas em 04/11 no bucket
   `arquivo-frio`, pasta `2026-11-04/`, com `manifest.json`, e numa cópia
   local do dono. Saem do banco quando o dono aplicar a migration
   `20261104221251_drop_archived_cold_tables`.

## A tela (`web/`)

- Vite + React, com `package.json` próprio. Abas Hoje, Regra e Operar.
- **Fala com o banco por um proxy local** (ADR 0008, decidido em 19/08/2026).
  Service key em navegador leva 401 do Supabase (detecção por User-Agent), e
  a chave anônima não serve (views com revoke, nenhuma policy). O dev server
  do Vite encaminha `/sb` para o PostgREST com `apikey`, `Authorization` e
  `User-Agent` sobrescritos.
- `SUPABASE_URL` e `SUPABASE_SERVICE_KEY` ficam em `web/.env.local` **sem o
  prefixo `VITE_`**, e o Vite só inlina o que tem prefixo. A trava
  `web/src/lib/trava.ts` aborta se alguma `VITE_*` tiver cara de segredo.
- Consequência aceita: sem `npm run dev` não há tela. Um produto público, se
  existir, é outro app.
- O proxy não tem autenticação própria (PR 23): quem alcança a porta do dev
  server alcança o banco com a service role. O Vite escuta só em `localhost`
  por padrão, e `web/vite.config.ts` não muda isso; não expor com `--host`.

## Armadilhas que o projeto já pagou para aprender

- **Descarte silencioso.** Todo filtro conta e reporta o que derrubou, com
  motivo. Já pegou 29% de linhas sumindo numa sonda e 10% de estrato noutra.
- **Livro vazio = mid 0,50 por aritmética**, não por consenso.
- **Significado de campo.** `event.startDate` é data de criação; `endDate` da
  Gamma é a data marcada do evento, não o instante da resolução. Conferir
  antes de filtrar por qualquer campo.
- **Retenção.** O ramo `finalized` apaga série de evento resolvido sem
  condição de idade. Foi contornado por exceção (`radar_tracked`), nunca
  consertado.
- **Plano de query.** O `retention_job` já derrubou o banco com um `LIKE ANY`
  que não usava `idx_events_slug_prefix`
  (`20260807230005_retention_old_branch_plan.sql`).
- **Inchaço de índice.** `polymarket_snapshots` já chegou a 2.087 MB, sendo
  1.492 MB de um único índice sobre 80 MB de dado.
- **Extrapolar de amostra pequena.** Aconteceu quatro vezes, sempre para pior.
- **`probes/` versiona só relatório `.md` e `probes/compostos/rotulos.json`**
  (issues 33 e 45). O resto é gerado por script e fica local: num clone novo,
  rodar o produtor antes de um script que reusa cache (`radar:lista -- --reuse`,
  `medir-relacoes`). Não abrir
  nem reescrever os arquivos de lá sem necessidade.

## Dívida conhecida

Levantada em auditoria em 19/08/2026; texto completo, com arquivo e linha, em
`CONTEXTO-RADAR.md`. Conferir se continua verdade antes de usar: o código
andou depois (PR 40 mexeu em `julgar()` e em `prob_self`).

1. O Brier do humano não tinha consumidor: `src/eval/` não lia `prob_self`.
2. `Math.max(0.5, …)` em `calcStake` (`src/bot/format.ts`) fabrica $0,50
   quando a carteira nunca foi configurada.
3. `leitura_n` é decidido no plano contra um snapshot congelado
   (`scripts/nivelar-leituras.ts`), e a colisão é descartada em silêncio na
   carga (`scripts/carregar-digest.ts`).

As issues abertas são a fila viva: `gh issue list --state open`.
