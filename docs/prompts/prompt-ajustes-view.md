# Prompt — Três ajustes na camada de leitura

Rodada pequena. As views estão aplicadas e conferidas (40/40 sem divergência).

O item 1 é o que importa agora, porque a tela vem a seguir.

---

## 1. Variação sem mid — recuperar 18,3% do radar

**123 de 673 mercados** têm livro de um lado só. Hoje eles saem sem preço e sem
variação, então **um quinto da tela viria em branco** na coluna que mais importa.

`mid_price` continua nulo — essa regra não se toca, ela já impediu um gap falso
de +0,13.

**Mas variação não precisa de mid.** Azarão com só venda que foi de 0,03 para
0,05 andou 2 centavos, e isso é real e informativo. Basta comparar **o mesmo lado
nas duas pontas da janela**.

- se há mid nas duas pontas → base `mid`
- senão, se há ask nas duas → base `ask`
- senão, se há bid nas duas → base `bid`
- senão → nulo, como hoje

**Coluna nova declarando a base de cada linha** (`var_1h_base` e irmãs). Sem
declaração isto vira número que parece comparável e não é — variação de ask e
variação de mid não são a mesma medida, e misturar as duas sem rótulo é
exatamente o tipo de coisa que fabrica achado neste projeto.

**Nunca misturar bases entre as pontas.** Ask agora contra mid de uma hora atrás
é ruído com cara de sinal.

Reporte quantos mercados passam a ter variação, por base.

---

## 2. Derivar o lado "No"

O coletor grava só `outcome = 'Yes'` — 27.204 linhas em 24h, um rótulo só. Leg
comprada no "No" nunca casa por rótulo.

**Não dobre a coleta.** Em mercado binário o outro lado é exato por aritmética:

```
mid_no = 1 − mid_yes
bid_no = 1 − ask_yes
ask_no = 1 − bid_yes
```

Faça na view. A profundidade **não** é simétrica dessa forma — declare o que dá
para derivar e o que não dá, numa coluna ou num comentário da view, em vez de
entregar um número que parece profundidade do "No" e não é.

Hoje isso não tem consumidor (zero legs abertas). É preparação para quando tiver.

---

## 3. `bankroll.ts` — nulo em vez de custo

Quando não acha preço, ele marca a posição **pelo custo**:

```ts
portfolio_value += Number(leg.stake_usd) || 0;
```

Isso faz posição sem marcação parecer estável, quando na verdade não está sendo
marcada. É falha silenciosa, que é o defeito que este projeto mais pagou para
aprender.

Medido: **100% das 61 legs históricas** caem nesse ramo — são mercados de partida
de esports, que o radar não coleta por decisão. A carteira antiga não tem
conserto e não é para tentar consertar.

Faça como a `v_minhas_posicoes` já faz: **valor e P&L nulos, com o motivo dito**.
E `BankrollState` passa a reportar quantas legs ficaram sem marcação — número
visível é o que impede a falha de ser silenciosa.

Cuidado: `bankroll` alimenta o Kelly. Se o valor da carteira virar nulo, o
dimensionamento tem que **recusar**, não tratar nulo como zero. Diga como
resolveu.

---

## Limites

- Zero LLM. Migration escrita, nunca aplicada. Não commite.
- Não construa tela.
- Não mexa no coletor.
- Testes sem rede para a escolha de base e para a derivação do "No".

---

## Ao terminar, em três linhas

1. quantos mercados ganharam variação, por base (`mid` / `ask` / `bid`)
2. o que dá e o que não dá para derivar do lado "No", e onde isso está declarado
3. como o Kelly passou a se comportar com carteira sem marcação
