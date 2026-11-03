# Item 5 — decisões de desenho da tela de Regra

Complemento da `spec-tela-regra.md`. Vale para o item 5 da ordem de execução. Escrito em português por convenção; branch, commit, PR e comentário de código continuam em inglês.

O desenho foi comparado em três direções antes de escolher. A escolhida é a de duas colunas, com a primeira dobra em largura inteira.

---

## 1. Navegação: as abas saem

**Hoje, Regra e Operar não são três lugares paralelos — são um fluxo.** Você lista, escolhe um mercado, e só então decide se opera. As abas fingiam três destinos independentes, e a aba Operar sempre soube de qual mercado se tratava; a aba só escondia isso.

Passa a ser:

- Cabeçalho da tela de Regra: **`← Hoje`** à esquerda, e à direita `Polymarket ↗` (secundário) e **`Operar neste mercado`** (primário).
- Um card no feed de Hoje abre a Regra daquele mercado.
- A aba Operar deixa de existir como destino solto. Operar é alcançado **a partir de** um mercado.

**Consequência de código, e é simplificação, não trabalho extra:** hoje a aba Operar lê o mercado selecionado de estado da aplicação. Virando destino a partir da Regra, o mercado passa a vir da rota. Isso mexe no `App.tsx` e provavelmente reduz estado global. Se a mudança crescer além do previsto, para e reporta antes de seguir — vira commit próprio.

**Um só botão primário por tela.** `Operar neste mercado` é o único azul cheio da página.

---

## 2. Layout

### Primeira dobra, largura inteira

Duas faixas atravessam a tela toda, acima das colunas:

1. **Manchete vs regra** — o veredito, com borda esquerda em `--alerta`. Carrega o selo de concordância da armadilha de onde saiu e a assinatura do modelo (`3 leituras · deepseek-v4-flash/v4`).
2. **Linha de números** — armadilhas que mudam o resultado, contradições, achados recolhidos, liquidez. Números em `tabular-nums`.

Elas resumem **o mercado**, não a coluna esquerda — por isso não podem morar dentro de uma coluna. É o que faz a tela servir aos dois momentos de uso: quem está varrendo lê as duas faixas e sai; quem veio estudar continua para baixo.

### Duas colunas: esquerda opera, direita prova

**Esquerda**, na ordem:

1. Armadilhas que mudam o resultado (só acusadas, ordenadas por concordância, teto de 5 visíveis)
2. Contradições internas acusadas
3. Dobras fechadas: *A regra, lida* · *Comuns a quase todos os regulamentos* · *Herdados do mesmo texto de regra* · *As 3 leituras, lado a lado*

**Direita**: o regulamento inteiro, em monoespaçada, com o trecho de cada achado **destacado dentro do texto** em vez de recortado.

Esse é o ponto do desenho. Recorte fora de contexto é exatamente como a manchete engana — mostrar a cláusula onde ela vive é o antídoto. A coluna direita fica `position: sticky` no topo: rolar as armadilhas não tira o regulamento da vista.

Legenda dos destaques, ao pé da coluna direita: tom quente forte = muda o resultado; tom quente claro = comum a quase todo regulamento.

### Abaixo de ~900px: empilha

As colunas viram uma. **O regulamento vai para baixo e entra recolhido por padrão** — no estreito, um paredão de texto em inglês logo abaixo do veredito enterra as armadilhas. O destaque continua valendo quando aberto.

---

## 3. Citação e interpretação

**Citação em monoespaçada, interpretação em sans.** A diferença tem que aparecer antes da leitura, sem legenda — é o mesmo princípio do estado não-comparável do item 3, que abandonou moldura e fonte tabular de propósito.

Vale para o trecho destacado dentro do regulamento e para qualquer trecho citado em bloco. **Nunca traduzido**, em nenhuma hipótese (P1).

---

## 4. A pendência do item 4, decidida: origem manda em tudo

**Contradição herdada desce para o bloco recolhido**, junto com o resto dos herdados. A seção de Contradições passa a conter apenas acusadas.

O motivo é consistência: o item 4 estabeleceu que origem é o eixo primário, e abrir exceção para contradição criaria um caso especial que alguém teria que lembrar. Um achado herdado não tem `leitura_a` nem `leitura_b` — uma contradição herdada é duas passagens sem as duas leituras que as opõem, ou seja, o achado menos acionável da tela travestido do mais grave.

**O estado vazio paga o preço, e paga explicitamente.** Quando não há contradição acusada mas existe alguma herdada, a seção diz:

> Nenhuma contradição apontada por uma leitura deste mercado. Há N herdadas de outros mercados com o mesmo texto — no bloco recolhido.

Nunca "nenhuma contradição". Isso seria falso, e é o mesmo tipo de afirmação velha que o `caa73b9` foi consertar.

E o cabeçalho do bloco recolhido nomeia o que carrega, incluindo contradições.

---

## 5. Estados vazios

Cada um diz uma coisa diferente e **nenhum pode ser omissão da seção**:

| Situação | O que a tela diz |
| --- | --- |
| Lido, nenhuma armadilha | *3 leituras, nenhuma armadilha que mude o resultado.* |
| Lido, nenhuma contradição acusada, N herdadas | o texto da seção 4 acima |
| Lido, nenhuma contradição de nenhum tipo | *Nenhuma contradição interna.* |
| Sem digestão | *Este mercado ainda não foi digerido.* — sem seções de achado |

"Lido e limpo" é informação diferente de "não lido". A distinção já existe no `somaDigest` retornando `null` em vez de `0`; a tela tem que honrar.

---

## 6. Critério 4 fecha aqui

O parágrafo que explica o mecanismo dos herdados aparece **uma vez**, no cabeçalho do bloco recolhido. Cada item leva só um selo curto.

Hoje ele se repete uma vez por item — dez vezes na mesma tela no mercado do Bolsonaro. É o critério 4 da spec, marcado como aberto desde o item 4, e é aqui que ele fecha.

O **N do cabeçalho é o tamanho do bloco**, nunca `ContagemDigest.achados_herdados` — aquele contador é a contagem de linhas da view, anterior à dedup do item 4. Quatro linhas herdadas que a absorção funde em duas anunciariam 4 e abririam para 2.

---

## 7. Frequência do gate

Sempre com denominador: *"aparece em 42% dos 267 regulamentos lidos"*, nunca *"42%"*. Fração sem denominador é a armadilha do `1/1` por outro caminho.

As três consultas disparam em paralelo com o carregamento do mercado. Enquanto o índice é `null`, tudo aparece e nada recolhe — o achado se mostra de qualquer jeito, só ainda não sabe se é padrão da casa.

---

## 8. Ordem de execução do item 5

Um commit por etapa, árvore limpa entre elas, mensagem escrita para o dono executar.

1. **Navegação** — `← Hoje`, `Operar neste mercado`, mercado vindo da rota. Se crescer, para e reporta.
2. **Primeira dobra** — as duas faixas em largura inteira, e a montagem do texto manchete-vs-regra a partir de `descricao` + `cenario` da pegadinha `muda_resultado` de maior concordância acusada.
3. **As duas colunas** — reordenação das seções, coluna direita com o regulamento e os destaques, sticky.
4. **Herdados e contradições** — bloco recolhido com parágrafo único, contradição herdada descendo, estados vazios da seção 5. Fecha o critério 4.
5. **Empilhamento abaixo de ~900px**, regulamento recolhido por padrão no estreito.

Onde couber função pura, teste vermelho antes e mutação — a montagem do texto do veredito (etapa 2) e a escolha do estado vazio (etapa 4) são as duas que cabem. O resto é componente, e o protocolo aceita "não deu para escrever vermelho sem banco, e aqui está o porquê" como resposta, desde que dito.

---

## 9. O que NÃO fazer

- Não traduzir trecho citado.
- Não apagar achado nenhum — recolher não é apagar.
- Não usar `ContagemDigest.achados_herdados` como N de cabeçalho.
- Não deixar estado vazio virar seção ausente.
- Não instalar dependência. Se algum item exigir, parar e perguntar.
- Não criar teste que não morde.

---

## 10. Direção descartada, guardada de propósito

Foi comparada uma terceira direção, **organizada por cláusula**: o regulamento como espinha, cada achado morando embaixo da cláusula que o gerou, sem seção de achados.

Ela resolvia duas coisas que a escolhida não resolve — a repetição sumia por construção, e a pendência das contradições herdadas fechava sozinha, porque a contradição moraria na cláusula e origem viraria só um selo.

Custou o que decidiu a escolha: sem seção de armadilhas, não dá para ver as três mais graves sem percorrer a regra inteira. Ruim para varredura, e varredura é metade do uso.

Fica registrada porque, se um dia a tela passar a servir só leitura profunda, ela é o desenho certo.
