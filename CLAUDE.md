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
- Idioma: inglês em nome de branch, mensagem de commit, título e corpo de PR e
  de issue, e comentário de código. Documentos internos — specs, relatórios,
  este arquivo — seguem em português.
  A regra do comentário vale **na borda**, arquivo a arquivo, quando alguém
  encostar: comentário novo em inglês, o resto do arquivo fica como está.
  Normalizar arquivo inteiro é chore separado, nunca carona num fix.

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

## Onde está o quê
- Schema atual: `supabase/migrations/20260804054445_remote_schema.sql` (baseline).
  As migrations 001-004 são anteriores e já aplicadas.
- Trabalho corrente: `specs/000-contencao.md`. Respeitar a Parte E (divisão
  humano/agente) antes de executar qualquer item.
- `specs/001-esports-verticals.md` vem depois. Não começar antes da 000 terminar.

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
