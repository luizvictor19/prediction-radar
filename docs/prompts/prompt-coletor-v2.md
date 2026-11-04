# Prompt — Revisão do coletor: coleta burra, tese na view

O coletor já existe e funciona. Esta rodada **tira opinião de dentro dele**.

O princípio, e ele decide quase tudo sozinho:

> **Filtra na coleta o que NÃO muda. Filtra na view o que muda.**

Categoria de um mercado não muda. Preço muda o tempo todo. Filtrar por preço faz o
mercado sair do roster **exatamente quando se move** — que é o evento que eu quero
estudar. Foi o defeito que eu enfiei no prompt anterior.

O contexto que justifica: o pipeline de esports foi construído inteiro em cima de
uma tese, a tese morreu, e nada daquilo serviu pra outra coisa. Não repetir.

---

## PARTE 1 — Desligar a coleta de esports

Decidido: CS2, LoL e Dota saem.

- O `UPDATE` que esvazia `discovery_slug_prefixes` e `collect_only_prefixes` é
  **escrita — escreva a migration e pare.**
- Desligue por kill switch os jobs que ficariam rodando à toa (watchlist,
  resolver, match-outcome, discovery de esports). Diga quais e como confirmar.
- **Não apague nenhum dado já coletado**, e não mexa na retenção do que existe.

---

## PARTE 2 — Os critérios de coleta, revisados

### Fica na coleta

| # | critério | por quê |
| --- | --- | --- |
| 1 | aberto, ativo, não arquivado | viabilidade |
| 2 | **livro dos dois lados** | sem isso não há preço; livro vazio dá mid 0,50 por aritmética e já fabricou resultado falso aqui |
| 3 | **categoria** na lista abaixo | propriedade estável |
| 4 | resolve em até **~180 dias** | evita fotografar mercado de 2028 por dois anos |
| 5 | **teto por RANKING de liquidez** | ver abaixo — teto é custo, não tese |

**Categorias a coletar** (mais largo que a tese de hoje, de propósito — histórico
não se recupera):

- IA e tecnologia
- Brasil
- macro e mercados (Fed, juros, inflação, cripto)
- geopolítica e conflitos
- **eleições e política em geral**, inclusive as que eu não acompanho
- **esporte de temporada** — título, artilheiro, rebaixamento. O filtro de 180
  dias já elimina mercado de partida sozinho; **não construa exceção pra isso.**

### Teto por ranking, não por exclusão

Se estourar o teto, **corte pelos menores em liquidez**. Não use volume mínimo
como porta: o mercado quieto de hoje é o que explode amanhã com uma notícia, e
excluí-lo faz perder justamente as primeiras horas da reação — a renovação de 6h
só o traria depois que o interessante já passou.

### SAI da coleta e vira `where` na view

- faixa de preço 0,15–0,85
- volume mínimo
- tamanho da descrição
- teto por assunto

**Grave o grupo de assunto em cada mercado** — ele deixa de filtrar e passa a ser
coluna, para a medição agrupar depois (22 mercados sobre o Irã são 1 observação
na hora de medir, e 22 oportunidades na hora de operar).

---

## PARTE 3 — O teto sai de medição, não de chute

Eu chutei 150 e estava errado por dois lados: chutei o número, e chutei o custo
(supus uma chamada por mercado quando elas são em lote — mil mercados custam ~4k
chamadas/dia numa API gratuita).

Meça e reporte, antes de fixar qualquer teto:

1. **quantos mercados** passam nos critérios acima
2. **quantos tokens** a CLOB aceita por chamada, e quantas chamadas/dia isso dá
   para 150 / 500 / 1.000 mercados
3. **quantas linhas/dia** cada um desses tamanhos gera
4. **`polymarket_snapshots` está particionada?** A tabela já inchou para 2 GB
   uma vez, sendo 1,5 GB de índice, e a série do radar agora é **isenta da
   retenção** — ela cresce para sempre e nada apaga

Com esses quatro números, **proponha o teto e justifique**. Se a tabela não
estiver particionada, diga isso em destaque: sem partição, o índice incha antes
do disco.

---

## PARTE 4 — O que já está certo e não se mexe

- **Não desmarcar.** `radar_tracked` é marca de proteção e só cresce. Você
  recusou o que eu pedi e estava certo — desmarcar entregaria a série ao ramo
  `finalized` no instante em que o desfecho a torna valiosa.
- **Cadência 15 min / roster 6 h.** Justificada, aprovada.
- A migration `20260813224150` (retenção manual) segue escrita e não aplicada.

---

## Limites

- Zero LLM. Migration escrita, nunca aplicada. Não commite.
- Não construa view, tela nem alerta — outra rodada.
- `--dry-run` que mostra o roster e o custo sem gravar.
- Contadores de descarte por motivo, sempre.

---

## Ao terminar, em quatro linhas

1. quantos mercados o roster tem agora, por categoria, e o que caiu em cada filtro
2. os quatro números da Parte 3, e o teto que você propõe
3. `polymarket_snapshots` está particionada? Se não, o que isso custa em um ano
4. o que foi desligado no esports e como eu confirmo
