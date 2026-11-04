# Prompt — Particionar antes de coletar, e tirar mercado de partida

Duas coisas pequenas, e as duas antes de ligar a coleta.

---

## Achado que muda a ordem: o fallback funciona, e o estado atual é o inseguro

`esports_slug_patterns()` tem `fallback := array['cs2-%','lol-%','dota2-%']`, e
ele só dispara com a lista **vazia**. A lista hoje é `{cs2-,lol-}` — então
**dota2 está sem proteção agora**, e esvaziar a lista é o que restaura.

Confirmado lendo a função. A migration de desligamento pode ser aplicada.

---

## PARTE 1 — Particionar `polymarket_snapshots`

Ela nasceu tabela comum na `001` e nunca foi convertida. `esports_snapshots` é
particionada — **use ela como molde**, é o mesmo problema já resolvido neste
repositório.

Por que agora e não depois:

- hoje são **96 mil linhas** — converter é trivial
- com teto 300 são ~10,5M/ano, e aí vira operação de risco em produção
- a série do radar é **isenta da retenção**: nada apaga, o B-tree só cresce
- o precedente: esta tabela já chegou a **2.087 MB, sendo 1.492 MB de um único
  índice** sobre 80 MB de dado

Escreva a migration. **Não aplique.** Diga no relatório:

1. a chave de partição escolhida e por quê
2. o que acontece com as 96k linhas existentes na conversão
3. se a conversão trava a tabela, e por quanto tempo
4. se a retenção e o `radar_tracked` continuam funcionando depois

O item 3 é o que decide se eu aplico de dia ou de madrugada.

---

## PARTE 2 — Tirar mercado de partida da coleta

Eu escrevi que o filtro de 180 dias eliminaria jogo sozinho. **Errado** — jogo
marcado para daqui a oito dias cai dentro da janela. Você mediu: 24 das 50 vagas
de esporte são jogo único.

`sportsMarketType` e `gameStartTime` são **propriedades estáveis** — um mercado é
de partida ou não é, e isso não muda na vida dele. Então o filtro cabe na coleta
sem violar o princípio de "só filtra na coleta o que não muda".

Exclua mercado de partida. Fica só temporada: título, artilheiro, rebaixamento,
Bola de Ouro, campeão de F1.

Reporte quantas vagas isso libera e o que entrou no lugar.

---

## PARTE 3 — Mostre o mapeamento de categoria

Isto ainda não foi conferido por ninguém e é onde eu mais desconfio. Já deu
sinal: 20 mercados de esports chegaram pela tag de tecnologia.

Para cada uma das 6 categorias, imprima em `probes/radar/categorias.md`:

- **10 exemplos que entraram** — pergunta e as tags que causaram a classificação
- **10 exemplos que ficaram de fora** e que estavam perto de entrar

O segundo é o que importa. Coletar lixo é barato — a view esconde. **Não coletar
o que interessa é o erro caro**, porque o histórico não se recupera.

---

## Limites

- Zero LLM. Migration escrita, nunca aplicada. Não commite.
- Não construa view, tela nem alerta.
- Não apague dado de esports.
- `--dry-run` que mostra o roster novo sem gravar.

---

## Ao terminar, em quatro linhas

1. a partição: chave, o que acontece com as 96k linhas, e se trava a tabela
2. quantas vagas o filtro de partida liberou, e o que entrou no lugar
3. com a tabela particionada, qual teto você propõe agora — e a conta
4. o mapeamento de categoria: onde você acha que ele erra
