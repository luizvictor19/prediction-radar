# Haiku 5.5 contra DeepSeek na digestão (issue #58)

- **rodou em:** 2026-11-16T20:07:46.744Z
- **modelo:** `claude-haiku-5-5`, effort padrão (medium), prompt `v4`
- **base:** `deepseek-v4-flash` `v4`, leituras de agosto em `market_rule_digests`, sem chamada nova
- **amostra:** 100 textos (semente 20261105), 2 leituras cada
- **chamadas:** 200, barradas pelo teto: 0
- **custo real:** US$ 0.4647 (estimado: US$ 1.3780 pelos tokens de agosto)
- **textos com as 2 leituras válidas:** 98
- **par DeepSeek do mesmo mercado:** 54 de 100

## Digestões nulas, por causa

DeepSeek: sem artefato informado (`--artefato-deepseek`); o banco só guarda o que passou.

| causa | claude-haiku-5-5 (3 de 200) | deepseek-v4-flash |
| --- | ---: | ---: |
| trava de opinião disparou | 3 | n/a |
| a resposta não chegou inteira | 0 | n/a |
| o modelo recusou | 0 | n/a |
| bateu no teto de tokens | 0 | n/a |
| a saída não obedeceu ao contrato | 0 | n/a |
| a corrida foi mal configurada | 0 | n/a |

## JSON válido contra o schema

Saídas que não eram JSON ou não obedeceram ao contrato: 0 de 200.

## Consistência: achados que aparecem nas duas leituras

Contado dos dois lados e somado por contagem. "Mesmo achado" é mesma classe e um trecho
dentro do outro na borda de palavra (`contemTrecho`, a régua da tela); ambiguidade
também precisa do mesmo tipo.

| medida | total | pegadinhas | ambiguidades | contradições |
| --- | ---: | ---: | ---: | ---: |
| claude-haiku-5-5 | 62.3% (696/1117) | 73.5% | 52.0% | 22.2% |
| deepseek-v4-flash (2 primeiras leituras) | 71.0% (830/1169) | 73.8% | 68.4% | 20.0% |

## Concordância entre os modelos

União das 2 leituras de cada lado, nos mesmos textos.

| medida | total | pegadinhas | ambiguidades | contradições |
| --- | ---: | ---: | ---: | ---: |
| achados do Haiku que o DeepSeek também achou | 64.7% (497/768) | 81.8% | 50.8% | 37.5% |
| achados do DeepSeek que o Haiku também achou | 64.6% (486/752) | 68.4% | 60.9% | 33.3% |

## Custo por digestão

| medida | claude-haiku-5-5 | deepseek-v4-flash |
| --- | ---: | ---: |
| custo mediano por chamada | US$ 0.00231 | US$ 0.00345 |
| custo médio por chamada | US$ 0.00232 | US$ 0.00355 |
| tokens de saída, mediana (pensamento incluído) | 3.243 | 11.963 |
| latência mediana | 14.938 ms | n/a |

O custo do Haiku vem do `usage` de cada chamada, inclusive das que falharam na
validação: elas foram cobradas. O do DeepSeek é `cost_usd` das leituras de agosto
desses mesmos textos (todas, não só o par).

As saídas brutas e o `usage` de cada chamada estão em `probes/digest/haiku-vs-deepseek.json`.
Nada foi gravado no banco.
