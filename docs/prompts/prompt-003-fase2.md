# Prompt — Spec 003, fase 2: o extrator e a medição de precisão

Leia `specs/003-relacoes.md` — **Partes B, D, E e H** — antes de escrever
qualquer linha. A Parte C foi reescrita depois da fase 1 e tem os números reais.

A fase 1 já entregou o gerador (`scripts/lib/market-pairing.ts`) e a sondagem do
universo (`scripts/probe-polymarket-universe.ts`). Esta rodada escreve o extrator
e mede se ele acerta.

**O número que esta fase produz é a precisão.** Abaixo de 90% a frente inteira
morre, e isso está escrito na spec antes de qualquer resultado.

---

## O que esta fase NÃO faz

- **Não varre o universo aberto.** Os 133.543 mercados custam ~US$ 733 e a Parte
  C reprovou isso. A fase 2 roda **só nos grupos inteiramente resolvidos**.
- **Não decide filtro de mercado** (liquidez, prazo, ter irmão). É H6, humano, e
  depende de a precisão existir primeiro.
- **Não religa o `cross-market-inter`.** Está fora de propósito (Parte F).
- **Não opera nada.** A saída é candidato com justificativa, nunca ordem.

---

## PARTE 1 — O extrator

`src/relacoes/extrator.ts` (ou onde o desenho pedir — decida e justifique em uma
linha).

Copie o desenho de `src/verticals/analyst.ts`, porque ele já resolveu os
problemas certos:

- **saída estruturada, tipo fechado, validada antes de gravar**
- **rótulos curtos** (`M1`, `M2`, ...) no prompt, e **relação que cite rótulo não
  entregue invalida a resposta inteira** — é a regra do `parseAnalysis` que
  segurou 584/584 de fidelidade
- **telemetria por chamada**: modelo, versão de prompt, esforço, tokens de
  entrada e saída, custo, latência
- **prompt versionado**, escolhido por config, do jeito do `analyst_prompt_version`

Cada relação carrega, obrigatoriamente:

| campo | regra |
| --- | --- |
| `tipo` | da lista fechada da Parte B — `implica`, `exclui`, `particiona`, `equivale`, `conjuncao`, `nenhuma` |
| `mercados` | por rótulo, e o rótulo tem que ter sido entregue |
| `confianca` | número em [0,1] |
| `justificativa` | uma frase **citando o trecho** das perguntas que sustenta |
| `ressalvaDeResolucao` | `string \| null` |

**`ressalvaDeResolucao` não é enfeite.** O prompt tem que deixar explícito que
`null` significa "li as regras de resolução das duas pontas e não vi diferença",
**não** "não olhei". A fase 1 mediu: `description` vem preenchida em 100,0% dos
mercados, mediana 1.262 caracteres — o texto está lá, o agente tem o que ler.
`resolutionSource` como campo vem vazio em 38%; quando faltar em uma das pontas,
isso por si é motivo de ressalva, não de `null`.

**Abster-se é barato e incentivado.** Ao contrário do analista, aqui `nenhuma` na
dúvida é o comportamento desejado. A assimetria está na Parte E: relação falsa
custa dinheiro, relação perdida custa zero.

### Entrada do grupo

Do gerador: id, pergunta, regras de resolução, data de fechamento, preços. Em
grupo resolvido os preços não importam para a relação — mas **traga o desfecho
separado do que vai no prompt**.

> **Isto é a armadilha central desta fase.** Se o desfecho vazar para dentro do
> prompt, o agente deduz a relação do resultado em vez de ler as perguntas, e a
> precisão medida vira ficção. O desfecho é do corretor, não do aluno. Escreva um
> teste que falhe se qualquer string do desfecho aparecer no prompt montado.

---

## PARTE 2 — A fila, e ela tem que ser retomável

Antes de gastar um centavo.

1. **Embaralhe os grupos com semente fixa** (`--seed`, padrão fixo no código).
   Reprodutível: mesma semente, mesma fila, sempre.
2. **`--limite N` processa os N primeiros da fila**, não N sorteados na hora.
3. **Grave o resultado com o id do grupo.** Tabela nova, ou `probes/relacoes/` —
   decida, mas se for tabela, a migration é **escrita e não aplicada** (H4).
4. **Retomada:** a rodada seguinte lê o que já tem resultado, tira da fila, e
   continua. Queda no meio não perde nem duplica.

Uso pretendido:

```
npm run relacoes:extrair -- --limite 100    # ~US$ 2,90
npm run relacoes:extrair -- --limite 300    # faz só os 200 que faltam
npm run relacoes:extrair                    # faz o resto dos 754
```

**Semente fixa não é conveniência, é correção da medição.** Fila ordenada por
tamanho, data ou qualquer outra coisa faz "os primeiros 100" medirem aquele
pedaço, não a ferramenta — mesmo defeito de medir só as relações mais confiantes
(Parte H).

### Teto de gasto com parada dura

Como o `analyst_daily_budget_usd`. `--teto-usd`, padrão conservador, e o processo
**para**, não avisa e continua. Reporte quanto gastou de verdade contra o
estimado — a fase 1 estimou US$ 0,029 por chamada e esse número pode estar
errado para um prompt de grupo, que é maior.

`--dry-run` que imprime quantos grupos, quantas chamadas e quantos dólares
**antes** de chamar qualquer coisa.

---

## PARTE 3 — O harness de precisão

`scripts/medir-relacoes.ts`.

Para cada relação proposta em grupo resolvido, confira contra o desfecho:

| tipo | o desfecho tem que respeitar |
| --- | --- |
| `implica` | A=SIM ⇒ B=SIM |
| `exclui` | não pode A=SIM e B=SIM |
| `particiona` | exatamente um do conjunto deu SIM |
| `equivale` | A e B deram o mesmo |
| `conjuncao` | C=SIM ⇔ A=SIM e B=SIM |

Três resultados por relação, não dois:

- **refutada** — o desfecho viola a restrição. Objetivo, sem opinião.
- **compatível** — o desfecho respeita a restrição.
- **não testável** — o antecedente nunca disparou. `A implica B` com A=NÃO não
  diz nada sobre a relação.

**Compatível não é o mesmo que correta.** Duas perguntas sem relação nenhuma
cujos desfechos calharam de não se contradizer aparecem como compatíveis. Este é
o limite do gabarito automático e tem que estar no relatório, não numa nota de
rodapé.

Por isso o número principal é o de baixo:

- **taxa de refutação** = refutadas ÷ (refutadas + compatíveis) — este é o que
  mata ou libera
- taxa de **não testáveis** — quanto do gabarito ficou em branco
- ambos **por tipo de relação**
- ambos **por faixa de `confianca`** — se a confiança não separa refutada de
  compatível, o campo é decoração e sai

Intervalo de confiança em tudo. Com ~750 grupos e mediana de 7 mercados, a
contagem de relações pode ser alta ou baixa demais — reporte o n real antes de
qualquer porcentagem.

### A amostra humana continua existindo

Sorteie **30 relações compatíveis ao acaso** (não as mais confiantes) e grave num
CSV/markdown pronto para rotular à mão: as duas perguntas, o tipo proposto, a
justificativa, a ressalva. É H1, é trabalho humano, e é o que separa "compatível"
de "correta". Não rotule você.

---

## Limites

- **Nenhuma escrita no banco.** `SELECT` para diagnóstico, migration escrita e
  não aplicada.
- Nenhuma chamada à OddsPapi.
- Não toque em `src/verticals/`, `src/jobs/`, `src/eval/`. Leia para copiar
  desenho, não para editar.
- Testes sem rede para o parser, para a validação de rótulo, para as cinco
  restrições da Parte 3 e para o vazamento de desfecho.
- Nenhum `.env` lido.
- Não commite.
- **Nada de chamada real ao modelo até o `--dry-run` bater com o teto.**

---

## Ao terminar, em cinco linhas

1. quantas chamadas, quanto custou de verdade, e o quanto isso divergiu de US$
   0,029 por chamada
2. quantas relações propostas, por tipo, e quantos grupos vieram com `nenhuma`
3. **taxa de refutação, com intervalo de confiança** — e ela passa ou não dos 10%
   que o critério de morte tolera
4. quanto do gabarito ficou "não testável", e a confiança separa refutada de
   compatível?
5. o que você mediria a seguir, e o que **não** dá para concluir daqui

A 3 é o número que decide a spec. E lembre do que a Parte H declara: a amostra
resolvida é **teto otimista** — se nem aqui passa, no mercado aberto não passa.
