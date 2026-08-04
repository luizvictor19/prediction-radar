# Prediction Radar

Node.js + TypeScript (ESM, roda via tsx). Supabase (Postgres) + Railway.
Coleta mercados do Polymarket, detecta sinais, notifica via Telegram.

## Regras inegociáveis
- NUNCA aplicar migrations. Escrever o .sql com `supabase migration new` e parar.
  Quem aplica é o dono do projeto.
- NUNCA rodar SQL contra o banco, nem leitura.
- Nunca ler .env.

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
