# prompt-tela-radar.md

Instruções de execução no topo, especificação da tela abaixo. Ler o arquivo
inteiro antes de planejar.

---

## COMO EXECUTAR

**Entrar em plan mode antes de editar qualquer coisa.** A tela é grande o
bastante para valer revisar o plano em vez de revisar 30 arquivos prontos.

### Onde o código vai

A tela vai em `web/`, com `package.json`, `tsconfig.json` e `node_modules`
próprios.

```
prediction-radar/
├── src/            ← backend atual, tsx sem build — NÃO MEXER
├── scripts/
├── supabase/
└── web/            ← a tela
    ├── package.json
    ├── tsconfig.json
    ├── .env.local      ← nunca commitado
    └── src/
```

**Não mexer no `package.json` da raiz.** O backend roda em `tsx` sem build;
misturar Vite ali junta duas cadeias de ferramenta que não têm relação.

Acrescentar ao `.gitignore` da raiz:

```
web/node_modules/
web/.env.local
```

⚠️ **Isso é crítico.** No Vite a variável precisa do prefixo `VITE_` para chegar
ao navegador, então a service key vai viver num arquivo que, se vazar para o
git, entrega o banco inteiro.

### Reúso de código

Reusar `src/lib/prob-self.ts` por caminho relativo — é TypeScript puro, sem
dependência de Node. Se o Vite reclamar de arquivo fora da raiz do projeto,
mover o parser para uma pasta `shared/` que os dois importam.

**Em nenhuma hipótese escrever um segundo parser de probabilidade.**

### Subagente em paralelo (só leitura)

Spawnar um subagente **sem escrita, sem migration, sem chamada de modelo**, para
investigar e reportar:

1. **Por que as 2 digestões da segunda passada de nivelamento foram puladas na
   carga** com "já no banco". Especificamente: o `leitura_n` é calculado no
   **plano** ou na **carga**? Só o segundo é correto — calcular no plano faz uma
   leitura genuinamente nova colidir com chave existente e ser descartada em
   silêncio, que é a mesma família de defeito que já apareceu três vezes neste
   projeto (migration verde que falhou, dedup de 4 partes, filhas penduradas no
   pai errado).
2. **Confirmar se os 4 textos abaixo do mínimo de 3 leituras** são os mesmos que
   a trava de opinião recusa, e se a recusa é reprodutível neles.

### Anotado, NÃO fazer agora

- o caminho do artefato de nivelamento é fixo e a segunda corrida sobrescreveu a
  primeira — precisa de sufixo
- o `julgar()` emite veredito em n=2 sem trava de n mínimo, enquanto o
  `digerir-regras` tem. Uma parte do código implementa o princípio 8 do projeto
  e a outra não.

---

# A TELA

Objetivo único: **eu abrir, ler a regra, anotar minha probabilidade e operar.**
Se ela faz isso, está pronta. Tudo além é depois.

## O que ela é

Um app React + Vite + TypeScript que lê as views do Supabase pelo cliente
oficial. **Sem backend.** As views já são a API — o PostgREST expõe elas direto.

Fonte de dados: `v_radar` (preço e variação) e `digest_achados_por_mercado`
(a regra digerida), mais `digest_contradicoes` para o bloco de contradição.

---

## REGRA INEGOCIÁVEL — ordenar por fato, nunca por nota

Cada operação registrada é uma previsão medida: a probabilidade que eu escrevo
antes de entrar é o dado que, em alguns meses, vira o meu Brier contra o do
mercado. Se a tela me mostrar uma nota calculada pelo sistema ("oportunidade
8,4", "score de risco", "recomendado"), eu paro de ser o previsor e viro alguém
concordando com uma máquina — e a medição passa a medir o sistema comigo no
meio.

Então:

- **Pode ordenar e destacar por FATO**: prazo, variação de 24h e 7d, liquidez,
  spread, número de achados, `vezes_encontrado`, tem ou não contradição.
- **Não pode existir** nenhum número, cor, ícone ou ordenação derivada de juízo
  do sistema sobre o mercado ser bom, atraente, provável ou arriscado.
- **Nunca exibir probabilidade sugerida.** A digestão não produz uma; a tela
  também não inventa.

Se durante a implementação parecer útil "só um indicadorzinho" de qualidade da
oportunidade: **não**. Anota e reporta.

---

## As três abas

### 1. Hoje

Lista de mercados. Ordenação escolhida por mim num seletor explícito, nunca
"inteligente":

- vence em breve (padrão)
- maior variação em 24h
- maior variação em 7d
- tem contradição interna
- maior liquidez

Cada card mostra: título, tema, preço atual, variação 24h e 7d, spread,
liquidez, prazo, e quantos achados a regra tem. Se tiver contradição, um selo
factual — "contradição na regra", sem adjetivo.

Filtros: por tema, por faixa de prazo, "só com contradição". Todos são `where`,
todos explícitos.

### 2. A regra

Detalhe de um mercado. Nesta ordem:

1. **Contradições** primeiro, com as **duas passagens** lado a lado e as duas
   leituras. Se o achado for herdado, dizer isso — e as leituras vêm nulas,
   porque não existem para aquele mercado. Não preencher com a do vizinho.
2. Resolve SIM se / Resolve NÃO se / fonte / prazo / anula se.
3. Pegadinhas e ambiguidades, ordenadas por `vezes_encontrado` decrescente.

Cada achado carrega dois rótulos factuais:

- **`3/3`** — em quantas leituras daquele texto de regra ele apareceu. `3/3` é
  sólido; `1/44` apareceu uma vez. Os dois merecem estar na tela, com números
  diferentes na frente. **Isso é contagem, não opinião** — por isso é permitido,
  e por isso pode ordenar.
- **acusado / herdado** — se o modelo leu este mercado e apontou, ou se veio de
  um mercado irmão com o mesmo texto de regra.

Link para a página do mercado no Polymarket, sempre.

### 3. Operar

O momento da aposta. **A probabilidade é registrada ANTES de eu ir para a
Polymarket** — essa ordem é o requisito inteiro desta aba, e não é detalhe de
UX: número escrito depois de ver o resultado da entrada não vale como previsão.

Fluxo, a partir do card de um mercado:

1. **A minha probabilidade em %** — campo obrigatório, sem pular, sem valor
   padrão, sem sugestão.
2. **Resumo de confirmação antes de salvar**, mostrando o número interpretado —
   reusar `src/lib/prob-self.ts`, que já recusa entrada ambígua.
3. Salvar. **Só depois disso** o botão que abre o mercado na Polymarket fica
   disponível.
4. Opcional, depois de operar: registrar lado, preço de entrada e stake,
   reusando o que o bot já faz (`my_bets` / `my_bet_legs`). Se ficar grande,
   deixa para a v2 — o campo obrigatório é a probabilidade.

O preço do mercado no instante do registro é gravado junto (`preco_mercado`,
`preco_mercado_em`). Ele **não** é o preço de entrada: entrada tem taxa e
slippage dentro, e confundir os dois estraga a medição.

---

## Autenticação — decisão para a v1

A v1 **roda só na minha máquina**, em `npm run dev`. Usa a service key do
`.env.local`. Nada é publicado.

Isso evita construir Auth e políticas de RLS antes de a primeira operação
acontecer — e a primeira operação é o que começa a acumular dado.

**Proteção obrigatória, não opcional:** o app aborta na inicialização se
detectar build de produção (`import.meta.env.PROD`) com a service key presente.
Mensagem explícita. Service key em frontend publicado é vazamento total do
banco, e "eu lembro de não publicar" não é um mecanismo.

O produto público é outro app, com chave anônima e só dado público. Não misturar
os dois.

---

## Escopo da v1 — o que NÃO fazer agora

- notícias
- alertas
- qualquer coisa multiusuário
- deploy
- gráficos elaborados (a série de preço pode ser uma sparkline simples ou nada)
- tema escuro/claro, animação, polimento visual além do legível

Se sobrar tempo, o que vale mais é a aba **Operar** ficar rápida: da lista até a
probabilidade salva em poucos segundos, sem clique desnecessário.

---

## Critério de pronto

Eu abro, escolho uma ordenação, leio a regra de um mercado com contradição,
registro minha probabilidade, e vou operar — sem tocar no terminal. Nada além
disso é requisito.

Reportar ao final: quais views foram consumidas, quais colunas faltaram (se
faltou alguma, dizer — **não inventar cálculo no cliente para suprir**), e
quanto tempo leva na prática da lista até a probabilidade salva.
