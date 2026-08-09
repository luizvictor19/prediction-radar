# Guia de análise e diagnóstico

Como o sistema produz uma análise, como saber se ela presta, e como descobrir
quando o dado por trás dela está errado.

Escrito para consulta, não para leitura linear.

> Os números concretos deste guia (n=75, Brier, distribuição de citações) são a
> medida de **2026-08-09**. Eles envelhecem; o método, não. Ao reler, rode o eval
> antes de acreditar em qualquer número citado aqui.

---

## 1. O caminho de uma análise

Cada etapa alimenta a seguinte. Se uma falhar, a próxima não tem como reclamar —
ela só recebe menos dado e segue.

```
discovery      mercado novo aparece no Polymarket        3 min
   ↓
watchlist      preço vira série temporal                 12s ao vivo / 5 min longe
   ↓
resolver       slug vira partida, times, liga            10 min
   ↓
enricher       contexto vira fragmentos                  5 min
   ↓
analyst        fragmentos viram probabilidade + tese     T-6h e T-1h
   ↓
outcome        desfecho é gravado                        10 min
   ↓
eval           a análise é pontuada contra o desfecho    sob demanda
```

**O que o analista lê**, e é só isso:

| enricher | fragmentos | o que diz |
|---|---|---|
| `market-history` | odds, liquidity, series_consistency | como o preço se moveu, quanto book tem |
| `polymarket-context` | news | parágrafo gerado pela Polymarket (confiança 0,4) |
| `oddspapi` | bookmaker_odds, bookmaker_suspension | o que as casas pagam, e se suspenderam |
| `match-history` | h2h, form, market_calibration | confrontos, forma recente, acerto histórico do mercado |

Se um enricher não produz, o analista não sabe que faltou. Ele analisa com o que
chegou. **Por isso a distribuição de citações importa** — se 58% das afirmações
vêm da fonte mais fraca, é porque as outras não estavam lá.

---

## 2. Os conceitos, com os seus números

### Brier score

É o erro médio ao quadrado de uma previsão probabilística.

Você diz 0,70. Se acontece, o erro é (0,70 − 1)² = 0,09. Se não acontece,
(0,70 − 0)² = 0,49. O Brier é a média disso em todas as previsões.

**Menor é melhor. 0,25 é a moeda** — quem sempre diz 0,50 erra 0,25 toda vez,
independente do resultado.

Seus números com n=75:

```
agente    0,1391
mercado   0,1266
50/50     0,2500
```

Os dois batem a moeda com folga. Mas isso não diz nada — o interessante é que
**o agente perde do mercado**.

### Skill: por que o baseline é o preço, não a moeda

Skill é quanto você melhora sobre um baseline: `1 − (seu Brier ÷ Brier dele)`.

```
vs 50/50     +0,975   parece ótimo
vs mercado   −0,099   é o que importa
```

Bater a moeda é trivial: qualquer um sabe que Vitality ganha de time de tier 4.
**O preço de mercado já sabe disso.** Para o agente valer alguma coisa, ele
precisa saber algo que o preço não sabe.

Skill negativo contra o mercado significa: você teria feito melhor copiando o
preço e não pensando.

### Calibração × resolução

Duas qualidades diferentes, e a confusão entre elas é o erro mais comum.

**Calibração** — quando você diz 70%, acontece 70% das vezes?
**Resolução** — você chega a dizer 70%, ou fica sempre perto de 50%?

Um agente que responde 0,50 para tudo é **perfeitamente calibrado** (a taxa base
é ~50%) e completamente inútil. Brier aceitável, zero informação.

A decomposição de Murphy separa os três:

```
Brier = confiabilidade − resolução + incerteza

confiabilidade  0,0494   quanto você erra o alvo — menor é melhor
resolução       0,1508   quanto você se afasta da média acertando — maior é melhor
incerteza       0,2446   propriedade da amostra, não sua
```

Sua resolução é 0,1508, não zero. **O agente está discriminando** — ele não é
tímido, ele discorda. O problema é discordar na direção errada.

### O diagrama de confiabilidade

A tabela de baldes mostra onde ele erra:

```
balde      n   previsto  observado    gap
0.3–0.4    7      0,376      0,000   +0,376
0.4–0.5    6      0,471      0,833   −0,362
0.9–1.0   13      0,932      1,000   −0,068
```

Nos baldes onde ele concorda com o mercado (0.9–1.0), acerta bem. Nos baldes de
discordância (0.3–0.5), erra feio.

**Gap positivo** = disse mais do que aconteceu. **Negativo** = disse menos.

Cuidado: com n=6 num balde, o gap é ruído. Só olhe baldes com amostra.

### Quanto n é suficiente

```
n=12   agente 0,1017 vs mercado 0,1006   diferença é ruído
n=75   agente 0,1391 vs mercado 0,1266   diferença já é sinal
```

Com n=12 a conclusão foi "não dá para dizer". Com n=75, dá.

Não há número mágico, mas a regra prática: **se a diferença entre dois Brier é
menor que a variação que uma única partida causaria, não há conclusão.** O eval
avisa abaixo de 20.

### Point-in-time, e por que é a coisa mais fácil de quebrar

O eval reconstrói o passado: "às 14h daquele dia, o que se sabia?". Se o sistema
entregar informação que não existia naquele instante, o resultado fica bom e é
mentira.

Três defesas, todas no banco:

**`as_of` ≠ `observed_at`.** Quando o fato era verdade não é quando você soube.
O replay filtra por `observed_at`, nunca por `as_of` — fonte que faz backfill
grava hoje um fato de ontem, e cortar por `as_of` deixaria passar.

**`observed_at` não é forjável.** Um trigger carimba com o relógio do servidor.
Teste feito: mandar `2020-01-01` grava a data de hoje.

**Append-only, imposto pelo banco.** O mesmo trigger recusa `UPDATE` — o que pega
`UPSERT` junto, que é como o erro entraria sem ninguém notar.

E `supportsPointInTime` por enricher: fonte que não pode garantir fica de fora do
replay. A Liquipedia é `false` porque a wiki é reescrita retroativamente sem
carimbo de quando soube.

---

## 3. Como saber que o dado está ruim

Quatro categorias. A terceira e a quarta são as perigosas, porque não têm sintoma.

### Ausente — o mais fácil

O fragmento não existe. Aparece como recusa nomeada no log:

```sql
select metadata->'skips' from system_logs
where component = 'esports_enricher' order by created_at desc limit 1;
```

Toda saída de enricher tem nome. `sem motivo declarado` é bug do enricher, não
ausência de dado — significa que ele saiu sem se explicar.

**Exemplo real:** `oddspapi: sem fixture correspondente x26`. Diagnóstico:
cobertura de 54%, medida. Metade das partidas simplesmente não tem odds.

### Errado — dá para pegar comparando fontes

Duas fontes independentes discordando é o sinal. Uma fonte sozinha discordando de
si mesma é ainda melhor.

**Exemplo real:** o preço da linha suspensa vinha espelhado. Em 64 de 75
instantes com `active: false`, os dois lados trocavam de preço. O que denunciou:
na abertura, Pinnacle e Stake concordavam que aquele lado era o azarão; no
fechamento, as duas concordavam que virou favorito. **Só as entradas suspensas
discordavam — de si mesmas e da outra casa.**

Se tivesse passado, o fragmento diria 30% onde o certo é 70%. E ninguém notaria,
porque probabilidade invertida continua sendo probabilidade plausível.

### Velho — parece atual

Dado correto, mas de outro momento. Não tem sintoma nenhum.

**Exemplo real:** o cooldown de `/v4/fixtures` recebia o horário de início do
ciclo como se fosse "agora". A espera calculada crescia junto com o tempo
decorrido — "129s de cooldown" era na verdade "o ciclo está rodando há 129s".
Efeito: toda descoberta era recusada depois dos primeiros segundos.

**Como pegar:** desconfie de todo lugar onde um horário é passado adiante. Se a
função precisa saber "agora", ela deve perguntar ao relógio, não receber de quem
chamou.

### Vazado — o pior

Informação do futuro no dado do passado. O backtest fica bom e mente.

**Exemplo real:** o `h2h` do `match-history` precisava excluir a partida corrente
por id. Sem isso, um replay sobre partida já resolvida receberia o próprio
gabarito dentro do histórico de confrontos.

**Como pegar:** todo enricher que lê algo com data precisa de um filtro
explícito por `asOf`. Se você não consegue apontar a linha que faz o corte,
provavelmente não há corte.

---

## 4. O método de diagnóstico

Sempre nesta ordem. As três primeiras são baratas e eliminam a maioria dos casos.

### Passo 1 — Está vivo?

```sql
select component, last_status, last_detail,
       round(extract(epoch from (now() - last_cycle_at))) as seg_atras
from collector_heartbeats order by seg_atras desc;
```

`seg_atras` maior que o cron do componente = travado.

**Por que o heartbeat existe:** um componente que parou e um componente sem
trabalho produzem o mesmo silêncio no log. O heartbeat distingue — ele bate
quando o ciclo *completa*, mesmo sem ter feito nada.

Foi essa distinção que faltou quando o collector ficou 48 horas parado.

### Passo 2 — Está reclamando?

```sql
select component, status, left(message, 100) as msg, count(*)
from system_logs
where status in ('error','partial') and created_at > now() - interval '1 hour'
group by 1,2,3 order by 4 desc;
```

Olhe o **padrão**, não só o volume. A mesma mensagem centenas de vezes é log
dentro de loop — foi o que levou `system_logs` a 2,7 milhões de linhas.

### Passo 3 — O pipeline fecha?

```sql
select
  (select count(*) from events where slug ~ '^cs2-' and created_at > now() - interval '2 hours') as descobertos,
  (select count(*) from esports_snapshots where captured_at > now() - interval '1 hour') as snapshots,
  (select count(*) from context_fragments where observed_at > now() - interval '2 hours') as fragmentos,
  (select count(*) from esports_analyses where created_at > now() - interval '6 hours') as analises;
```

Zero em qualquer etapa quebra a cadeia. E a etapa seguinte **não tem como
reclamar** — ela recebe menos dado e segue normalmente.

### Passo 4 — A análise faz sentido?

```sql
select m.match_slug,
       round(a.probability::numeric,3) as agente,
       round(a.market_mid::numeric,3) as mercado,
       round(abs(a.probability - a.market_mid)::numeric,3) as diferenca,
       a.thesis
from esports_analyses a join esports_matches m on m.id = a.match_id
where a.status = 'analyzed' and a.market_mid is not null
order by abs(a.probability - a.market_mid) desc limit 5;
```

**Leia as discordâncias maiores, não as médias.** É onde o agente aposta contra o
mercado, e é onde ele ganha ou perde tudo.

O que procurar na tese:

- Cita fragmento específico, ou raciocina no vazio?
- Discorda por evidência positiva, ou por não achar explicação?
- Trata movimento de preço como informação ou como ruído?

**Padrão encontrado hoje:** *"houve queda abrupta, deve ser ruído, prefiro o
preço anterior"*. Foi assim que ele disse 0,840 onde o mercado dizia 0,145 — e o
mercado estava certo.

### Passo 5 — O que ele leu?

```sql
select f.enricher_id, f.kind, f.confidence, left(f.summary, 250) as summary
from analysis_claims c
join context_fragments f on f.id = c.fragment_id
join esports_analyses a on a.id = c.analysis_id
join esports_matches m on m.id = a.match_id
where m.match_slug = 'SLUG_AQUI';
```

Separa duas coisas que parecem iguais: **a informação não estava lá** (problema
de enricher) ou **estava e ele ignorou** (problema de prompt).

`fragment_id` é ponteiro vivo e vira NULL quando a retenção de 365 dias leva o
fragmento — o `join` acima descarta essas linhas em silêncio. Em análise antiga,
troque por `left join` e leia `c.fragment_enricher_id` / `c.fragment_kind`, que
sobrevivem.

---

## 5. Perguntas que valem repetir

**As citações estão equilibradas?**

```sql
select fragment_enricher_id, count(*),
       round(100.0 * count(*) / sum(count(*)) over (), 1) as pct
from analysis_claims group by 1 order by 2 desc;
```

Enricher que nunca aparece produz fragmento que ninguém lê — custo de coleta sem
retorno. Enricher que domina pode estar carregando a tese sozinho.

Hoje: `polymarket-context` 58,5% (confiança 0,4), `oddspapi` 5,4%.

**As abstenções fazem sentido?**

Se quase tudo abstém, o limiar está apertado e você não gera dado. Se nada
abstém, o portão não filtra nada. E abstenção do modelo em volume significa que
você está pagando para ele dizer o que uma condição já diria.

**O custo está onde deveria?**

```sql
select date(created_at) as dia, count(*), round(sum(cost_usd)::numeric,4) as custo
from esports_analyses where created_at > now() - interval '7 days'
group by 1 order by 1 desc;
```

---

## 6. Uma coisa por vez

O eval quebra por `prompt_version`, por modelo e por checkpoint justamente para
que uma mudança de cada vez seja mensurável.

Mudar o prompt e adicionar um enricher no mesmo dia produz um número que não diz
qual dos dois causou o quê. Isso é desperdiçar a única ferramenta que responde a
pergunta que importa.

**Sequência para qualquer mudança:**

1. Registre o número atual (rode o eval)
2. Mude uma coisa
3. Espere acumular amostra
4. Rode o eval e compare o recorte

O eval é o que transforma "acho que melhorou" em "melhorou 0,02 de Brier em 40
partidas".
