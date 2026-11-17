# A tela do radar

Abrir, ler a regra, anotar a minha probabilidade, ir operar. É isso.

Next.js 16 + React + TypeScript (ADR 0013). O navegador fala só com as rotas
de `/api`, atrás de senha; quem fala com o banco é o servidor, com a service
role.

## Antes de rodar

Criar `web/.env.local` (não é commitado) com quatro linhas:

```
SUPABASE_URL=<a mesma SUPABASE_URL do .env da raiz>
SUPABASE_SERVICE_KEY=<a mesma SUPABASE_SERVICE_KEY do .env da raiz>
RADAR_SENHA=<a senha da tela, 24 caracteres ou mais>
RADAR_SEGREDO_DE_SESSAO=<saída de `openssl rand -base64 48`>
```

**Nenhuma com prefixo `NEXT_PUBLIC_`.** Esse prefixo manda o valor para o
navegador. Sem ele, as variáveis ficam no servidor: a chave é lida só por
`src/lib/servidor/banco.ts`, na hora do pedido.

Faltando `RADAR_SENHA` ou `RADAR_SEGREDO_DE_SESSAO`, ou com senha de menos de
24 caracteres, a tela inteira responde 503. É de propósito: sem configuração
ela fecha, não abre.

A tela só responde nos hosts que conhece: `127.0.0.1` e `localhost` fora da
Vercel, e lá os hosts que a própria Vercel informa (`VERCEL_URL`,
`VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`). Domínio próprio entra
em `RADAR_HOSTS`, separado por vírgula. Host fora da lista recebe 421.

Uma variável `NEXT_PUBLIC_*` com cara de segredo (no nome ou no valor) faz
`next build` e `next dev` pararem (`src/lib/trava-publica.ts`).

## Como a tela fala com o banco

- `src/proxy.ts` confere o cookie de sessão antes de qualquer página ou rota.
  Sem ele, página vai para `/entrar` e API responde 401.
- Cada rota em `src/app/api` roda uma consulta só, de
  `src/lib/servidor/consultas.ts`, e confere a sessão de novo (`comSessao`).
  Não existe rota que repasse um pedido qualquer ao PostgREST.
- Os dois inserts (`/api/previsoes`, `/api/legs`) montam a linha a partir de
  uma lista fechada de campos validados (`src/lib/servidor/entrada.ts`).
- `src/app/api/rotas.test.ts` acha as rotas no disco e chama cada uma sem
  cookie: rota nova sem `comSessao` derruba o teste.
- O CI faz o build com canários no lugar dos segredos e varre
  `.next/static` byte a byte (`npm run conferir:bundle` na raiz).

Consultar o banco a partir da tela agora quer dizer escrever uma rota e o
teste dela. Esse atrito é o ponto.

## Rodar

```
npm install
npm run dev          # http://127.0.0.1:5173, só nesta máquina
npm run typecheck    # next typegen + tsc
npm run build        # next build
```

Os testes rodam da raiz, em `npm test`, junto com o resto da suíte.

## Dependência do banco

A aba **Operar** grava em `my_bets` as colunas `preco_mercado`,
`preco_mercado_em` e `preco_mercado_outcome`, que vêm da migration
`supabase/migrations/20260819051905_prob_sem_leg.sql`.

**Ela está aplicada**: as três colunas existem em `my_bets`, conferido em
27/08/2026 contra o schema que o banco publica. Quem aplica continua sendo o
dono do projeto, e esta já foi. Se um insert ainda encontrar coluna faltando, a
tela mostra a mensagem do banco em vez de fingir que gravou.

## O que a tela não faz, de propósito

Não existe nota, score, "oportunidade 8,4" nem probabilidade sugerida. Ordenação
e destaque saem de **fato**: prazo, variação, liquidez, spread, contagem de
achados, tem ou não contradição. Um número calculado pelo sistema sobre o
mercado ser bom transformaria o dono em alguém concordando com uma máquina, e a
medição passaria a medir o sistema com ele no meio.

`3/3` e `vezes_encontrado` **são** contagem, não juízo. Por isso aparecem e por
isso podem ordenar.
