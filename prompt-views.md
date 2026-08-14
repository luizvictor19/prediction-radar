# Prompt — As views e o campo que destrava a medição

Duas coisas. A coleta ligou hoje (645 mercados, 95% de cobertura por ciclo) e
agora precisa de camada de leitura.

---

## PARTE 1 — As views

**O contrato entre banco e tela.** O Supabase expõe view via PostgREST
automaticamente, então isto substitui backend inteiro: ordenação, filtro e
paginação saem de graça.

### `v_radar` — a principal

Uma linha por mercado do roster (`radar_tracked = true`, ativo).

Colunas:

| coluna | de onde |
| --- | --- |
| id, pergunta, categoria, `radar_tema`, `radar_subject` | `events` |
| preço agora (bid, ask, mid, spread, profundidade) | último snapshot |
| **variação 1h / 24h / 7d** | snapshot de então contra agora |
| volume 24h, liquidez | `events` |
| fecha em, dias restantes | `events` |
| tamanho da `description` | `events` |
| tenho posição aberta? | `my_bet_legs` |
| minha última probabilidade e quando | `my_bets` |

### Regras que não podem ser quebradas

**Sem filtro de opinião dentro da view.** Nada de faixa de preço, volume mínimo,
tamanho de regra ou teto por assunto. A view **expõe**; quem filtra é a query da
tela. Trocar de tese tem que custar um `where`, não uma migration.

**`mid_price` nulo continua nulo.** Livro de um lado só é resposta legítima —
nunca preencher com 0,50 nem com o lado existente. A variação contra um mid nulo
também é nula, não zero.

**A janela de tempo é por TEMPO, não por número de linhas.** "1h atrás" é o
snapshot mais próximo de `now() - 1h` dentro de uma tolerância — não "4 fotos
atrás". Mercado com buraco na série daria salto errado, e buraco existe: a
cobertura medida é 95%, não 100%.

**Reporte a tolerância que usou** e quantos mercados ficam sem variação por
falta de snapshot na janela. Descarte que não é contado é cobertura perdida sem
ninguém saber.

### Desempenho — meça, não suponha

`polymarket_snapshots` é particionada por mês e vai a ~59 mil linhas/dia.
"Último snapshot por mercado" sobre isso é exatamente o tipo de query que fica
lenta em silêncio.

**Rode `EXPLAIN ANALYZE` e reporte:** o plano faz seq scan? Poda partição? Quanto
demora com o volume de hoje, e quanto demoraria com 30× isso?

Se precisar de índice, escreva a migration. Se a view precisar ser materializada
para não travar a tela, **diga isso e por quê** — mas prefira view comum
enquanto der, porque materializada tem que ser refrescada e isso é mais uma coisa
que pode parar sem avisar.

### `v_minhas_posicoes`

Posição aberta com preço atual, P&L não realizado e a tese que registrei.
`bankroll.ts` marca a mercado lendo `polymarket_snapshots` e cai no custo quando
não acha preço — **confira se isso ainda acontece** com o radar alimentando a
tabela, e reporte.

---

## PARTE 2 — O campo que destrava a medição

O `register.ts` pergunta **"Confiança 1-10"** e grava `confidence_self`.

Isso é sentimento, não afirmação. **Não dá para calcular Brier com ele** — a
conta é `(p − desfecho)²` e precisa de `p` na escala 0–1. Converter 8 → 0,8
depois seria eu inventando o mapa após ver o resultado.

E tem uma ironia no repositório: `lib/kelly.ts` já exige `probability` na
assinatura. **O dimensionamento foi construído esperando um número que o registro
nunca coletou.** As duas pontas nunca se encontraram.

### O que muda

1. **Pergunta nova no fluxo:** `"Sua probabilidade de isso acontecer, em %? (ex: 72)"`
   Grave em `prob_self`, **em 0–1**. Valide o intervalo.
2. **Mantenha `confidence_self`** — é dado histórico, não se apaga.
3. **Coluna `estrategia` em `my_bets`**, default `'legado'`. A estratégia nova
   grava `'saliencia'`.

O 3 importa: as apostas antigas são a **única evidência** sobre se meus acertos
lembrados são representativos ou viés de sobrevivência. Marcar coorte preserva
isso; apagar destruiria a resposta.

4. **Grave o preço de mercado no instante do registro**, se ainda não grava.
   Sem ele não há linha de base para comparar, e é o número que decide tudo.

Migration escrita, não aplicada.

---

## Limites

- Zero LLM. Migration escrita, nunca aplicada. Não commite.
- **Não construa tela** — o front é meu.
- Não mexa no coletor, que acabou de ligar e está saudável.
- Não apague `confidence_self` nem aposta antiga.
- Testes sem rede para a lógica de janela temporal e para o nulo do mid.

---

## Ao terminar, em quatro linhas

1. as views criadas e as colunas de cada uma
2. **o plano da `v_radar`**: seq scan? poda partição? quanto demora hoje e com 30×?
3. quantos mercados ficam sem variação 1h / 24h / 7d, e a tolerância que usou
4. o que mudou no registro de aposta, e se o preço de mercado no instante já era
   gravado ou não
