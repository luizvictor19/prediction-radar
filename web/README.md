# A tela do radar

Abrir, ler a regra, anotar a minha probabilidade, ir operar. É isso.

React + Vite + TypeScript, lendo as views do Supabase direto pelo cliente
oficial. **Sem backend** — as views já são a API.

## Antes de rodar

Criar `web/.env.local` (não é commitado) com duas linhas:

```
SUPABASE_URL=<a mesma SUPABASE_URL do .env da raiz>
SUPABASE_SERVICE_KEY=<a mesma SUPABASE_SERVICE_KEY do .env da raiz>
```

**Sem o prefixo `VITE_`, e isso é o ponto.** O Vite só inlina no bundle o que
tem esse prefixo. Sem ele, a chave é lida pelo `loadEnv` no `vite.config.ts`,
fica no processo do Node e nunca chega ao navegador.

## Por que existe um proxy

O Supabase **recusa a service key vinda de navegador** — detecta pelo
User-Agent e devolve 401. E a chave anônima não resolve: as três views do radar
têm `revoke all from anon, authenticated` e nenhuma tabela tem policy de RLS.

Então a tela fala com `/sb`, que o dev server encaminha para o PostgREST
trocando `apikey`, `Authorization` e `User-Agent` (`vite.config.ts`). O cliente
manda uma chave placeholder; o proxy a descarta. Leituras e escritas passam pelo
mesmo caminho.

Consequência: **esta tela só funciona em `npm run dev`.** Sem dev server não há
proxy, e sem proxy não há banco. Um build publicado não funcionaria — e se
funcionasse, seria porque a chave vazou.

`src/lib/trava.ts` aborta a inicialização se qualquer variável `VITE_*` tiver
cara de chave secreta (`sb_secret_`, JWT com `role: service_role`). Ela não é
mais a única defesa — o desenho já tirou o caminho — mas ficou barata e cobre o
erro humano de reabrir esse caminho "porque não estava funcionando".

## Rodar

```
npm install
npm run dev          # http://localhost:5173
npm run typecheck
```

## Dependência do banco

A aba **Operar** grava em `my_bets` as colunas `preco_mercado`,
`preco_mercado_em` e `preco_mercado_outcome`, que vêm da migration
`supabase/migrations/20260819051905_prob_sem_leg.sql`.

**Ela está escrita e NÃO aplicada** — quem aplica é o dono do projeto. Até lá o
insert falha com "column does not exist", e a tela mostra a mensagem do banco em
vez de fingir que gravou.

## O que a tela não faz, de propósito

Não existe nota, score, "oportunidade 8,4" nem probabilidade sugerida. Ordenação
e destaque saem de **fato** — prazo, variação, liquidez, spread, contagem de
achados, tem ou não contradição. Um número calculado pelo sistema sobre o
mercado ser bom transformaria o dono em alguém concordando com uma máquina, e a
medição passaria a medir o sistema com ele no meio.

`3/3` e `vezes_encontrado` **são** contagem, não juízo — por isso aparecem e por
isso podem ordenar.
