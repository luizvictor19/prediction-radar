# Prompt — Digerir as regras de resolução

Primeiro componente do produto, e o mesmo que serve para eu operar.

A chave do DeepSeek já está no `.env` como `DEEPSEEK_API_KEY` e a conta tem
saldo. **Não leia o `.env`** — use `process.env`.

---

## O que se está construindo

Mercado de previsão publica regra de resolução com mediana de **1.262
caracteres** de condição, cláusula de anulação, fonte nomeada e critério de
desempate. Preenchida em **100%** dos mercados. Quase ninguém lê.

Foram **mais de 1.150 mercados disputados em 2026**, já acima do ano inteiro de
2025 — e num caso de US$ 60 milhões a briga foi se "vendeu até 31 de maio"
significa a venda ou a divulgação.

Este componente transforma esse texto em campo estruturado.

---

## PARTE 1 — Ligar o DeepSeek

API compatível com o formato da OpenAI, então é adaptador e não reescrita.
`src/llm/client.ts` já tem interface fina de provedor — o modelo é valor de
config, não dependência de código. **Entre por ali.**

```
base URL: https://api.deepseek.com
modelos:  deepseek-v4-flash   (US$ 0,14 / 0,28 por milhão in/out)
          deepseek-v4-pro     (US$ 0,435 / 0,87)
```

**ATENÇÃO:** `deepseek-chat` e `deepseek-reasoner` **foram aposentados em
24/07/2026**. Se você escrever esses nomes de memória, falha. Use os de cima.

- telemetria por chamada igual à do analista: modelo, tokens, custo, latência
- **teto de gasto com parada dura**, no padrão de `analyst_daily_budget_usd`

---

## PARTE 2 — A saída

Tipo fechado, validado antes de gravar, no desenho de `analyst.ts`.

```
resolveSim:    string[]   condições que fazem resolver SIM
resolveNao:    string[]
fonte:         string     quem decide, nomeado
anulaSe:       string[]   condições de void
prazo:         string     data + FUSO
pegadinhas:    string[]   o que parece que conta e NÃO conta
ambiguidades:  string[]   onde a regra admite mais de uma leitura
```

**`pegadinhas` é o produto.** É literalmente a tese: "o time venceu três jogos"
parece que conta para "venceu a liga" e não conta. Se esse campo vier fraco, o
componente não serve.

**`ambiguidades` é o que vira produto pago depois** — embrião do sinal de risco
de disputa.

### A regra que não se quebra

**Nenhuma probabilidade. Nenhuma recomendação. Nenhum "isso parece barato".**

O modelo lê e estrutura. Ele não opina sobre desfecho.

Motivo, e é o experimento inteiro: vou anotar minha probabilidade nesses mercados
por dois meses para medir a MINHA calibração. Se a tela me mostrar um número da
IA antes, eu anco nele — todo mundo anora — e o que eu medir não responde nada.
E o projeto já mediu oito vezes que o modelo não bate o preço.

**Escreva um teste que falhe se a saída contiver probabilidade ou recomendação.**

---

## PARTE 3 — Guardar, e detectar mudança

Migration escrita e não aplicada: tabela de digestão ligada ao mercado.

**Regra não muda, então digere uma vez e reusa para sempre.** Mas guarde o
**hash da `description`**: se o Polymarket editar o texto, o hash muda e o
mercado volta para a fila. Sem isso a digestão envelhece em silêncio, que é o
defeito que este projeto mais pagou para aprender.

---

## PARTE 4 — A escada, e ela é obrigatória

**Não rode os 673 de uma vez.** Três degraus, e eu aprovo entre eles:

| # | o quê | custo estimado |
| --- | --- | --- |
| 1 | **10 mercados**, só `deepseek-v4-flash` | ~US$ 0,003 |
| 2 | **50 mercados**, Flash + Claude Sonnet lado a lado | ~US$ 1,46 |
| 3 | o resto, no vencedor | ~US$ 0,16 no Flash |

**Pare no degrau 1** e me mostre a saída. Só sigo depois de ler.

Amostra aleatória com **semente fixa** — não escolhida a dedo, não os mais
fáceis, e reprodutível.

No degrau 2, grave as saídas dos dois modelos **lado a lado num markdown
legível**, e reporte para cada um: custo total, custo por mercado, latência
mediana, taxa de saída inválida.

**Não julgue a qualidade você mesmo** — a comparação é minha.

Meu palpite, dito antes: empatam em extrair campo, e o Flash ganha por preço. O
Claude deve ser melhor em `pegadinhas` e `ambiguidades`, que exigem julgar se
uma coisa conta ou não. Dizer antes torna o teste real.

---

## Limites

- Migration escrita, nunca aplicada. Não commite. Não leia `.env`.
- **Não construa tela.** Não mexa no coletor.
- `--dry-run` que diz quantos mercados, quantas chamadas e quantos dólares antes
  de gastar qualquer coisa.
- **Nenhuma chamada paga antes de o `--dry-run` bater com o teto.**

---

## Ao terminar o degrau 1, em três linhas

1. custo real dos 10, e o quanto divergiu do estimado
2. taxa de saída inválida
3. onde está o arquivo com as 10 digestões para eu ler
