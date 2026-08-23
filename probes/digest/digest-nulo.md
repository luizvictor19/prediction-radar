# Chamadas de digestão que voltaram sem digest

Refeito por `npm run medir:digest-nulo` sobre `probes/digest/degrau-3-v4.json`.
Nenhuma chamada ao modelo, nenhuma leitura do banco: só os artefatos em disco.

## A rodada

| medida | valor |
| --- | --- |
| artefato | `degrau-3-v4.json` |
| quando rodou | **2026-08-22T05:39:43.872Z** — mtime do arquivo, não carimbo da corrida |
| mercados | 1054 |
| modelos | `deepseek-v4-flash` |
| prompt | `v4` |
| chamadas | 320 |
| amostra | aleatória, semente fixa `20260815` (reprodutível: mesma semente, mesma lista) |
| custo estimado antes de rodar | US$ 1.2131 |
| custo real | US$ 1.0824 (-10.8% sobre o estimado) |
| chamadas no artefato | 320 |

> A corrida não carimbou a própria data — este artefato é anterior ao carimbo.
> O mtime data o ARQUIVO, e um arquivo copiado ou restaurado carrega mtime novo.
> Vale como aproximação, e está dito que é uma.

## Quantas, e de que causa

**21 de 320 chamadas (6.6%) voltaram sem digest.**

| causa | n | % das chamadas | % das falhas | resposta |
| --- | ---: | ---: | ---: | --- |
| trava de opinião disparou | 17 | 5.3% | 81.0% | problema de extração/prompt — ver a quebra por termo e campo abaixo |
| a resposta não chegou inteira | 3 | 0.9% | 14.3% | problema de retry |
| o modelo recusou | 0 | 0.0% | 0.0% | problema de prompt |
| bateu no teto de tokens | 0 | 0.0% | 0.0% | problema de max_tokens |
| a saída não obedeceu ao contrato | 1 | 0.3% | 4.8% | problema de prompt |
| a corrida foi mal configurada | 0 | 0.0% | 0.0% | problema de configuração — não deveria alcançar uma corrida real |

Por código bruto, para a tabela acima poder ser conferida:

| código | n |
| --- | ---: |
| `opiniao` | 17 |
| `not_json` | 2 |
| `api_error` | 1 |
| `tipo_invalido` | 1 |

## Dentro da trava de opinião

17 de 21 falhas. A trava existe para barrar opinião sobre DESFECHO; a quebra abaixo separa o termo que a REGRA fornece do termo que o MODELO acrescenta.

| campo | termo | n | leitura |
| --- | --- | ---: | --- |
| `resolve_nao` | `provável` | 5 | vocabulário da regra |
| `pegadinhas` | `provável` | 5 | vocabulário da regra |
| `ambiguidades` | `provavelmente` | 3 | hedge do modelo |
| `resolve_nao` | `chance` | 1 | vocabulário da regra |
| `pegadinhas` | `provavelmente` | 1 | hedge do modelo |
| `resolve_sim` | `oportunidade` | 1 | vocabulário da regra |
| `ambiguidades` | `chance` | 1 | hedge do modelo |

**Vocabulário da regra: 12 de 17. Hedge do modelo: 5 de 17.** A separação é heurística, está justificada em `lib/digest-nulo.ts`, e a evidência de cada uma vem abaixo.

**Mesmo texto de regra, mais de uma vez:**

- 8 mercados com a mesma regra, byte a byte:
  - `us-announces-end-of-iranian-blockade-by-september-21-2026`
  - `us-announces-end-of-iranian-blockade-by-august-14-2026`
  - `us-announces-end-of-iranian-blockade-by-december-31-2026-20260727171803489-375-949-645-919-269-157-255-857`
  - `us-announces-end-of-iranian-blockade-by-august-22-2026`
  - `us-announces-end-of-iranian-blockade-by-august-31-2026-20260713152715084-642-513-584-641-939-632-729`
  - `us-announces-end-of-iranian-blockade-by-september-30-2026-20260727171615364-722-649-646-561-213-644-414-831`
  - `us-announces-end-of-iranian-blockade-by-august-15-2026-20260713152715083-347-987-697-628-574-676`
  - `us-announces-end-of-iranian-blockade-by-september-7-2026`

## Uma resposta por causa

### Vocabulário da regra na trava de opinião — 12 de 320 (3.8%)

**Estreitar a trava.** `detectarOpiniao` já deixa `trecho` e `trecho_conflito` de fora da
varredura, e a justificativa escrita lá é exatamente esta: são cópia literal da regra, e
recusar por causa do texto que se está extraindo não é a trava funcionando. O que o
levantamento mostra é que a mesma coisa acontece um campo adiante — a condição de resolução
não tem como ser escrita sem a palavra que a regra usa para excluí-la.

Não é "afrouxar": a trava continua barrando opinião sobre desfecho, que é o que ela existe
para barrar. O termo que aparece porque a REGRA o usa não é opinião de ninguém.

### Hedge do modelo na trava de opinião — 5 de 320 (1.6%)

**Aceitar, e a razão já estava escrita.** O comentário de `OPINIAO` diz que `provável` e
`dificilmente` entram na lista mesmo aparecendo em leitura de regra, e que o erro é para o
lado seguro de propósito: um falso positivo custa uma chamada de fração de centavo, um
número que passa custa o experimento. A decisão não muda — o que muda é que agora ela tem
preço medido: 1.6% das chamadas, e não uma estimativa.

### A resposta não chegou inteira — 3 de 320 (0.9%)

**Um retry, e só para estes códigos.** Hoje não há nenhum, e a razão está em `deepseek.ts`
e em `runDigest`: retry multiplica o prazo pelo número de tentativas. Vale para a chamada
que responde devagar; não vale para a que não respondeu. Repetir só `api_error` e
`not_json` multiplica o prazo de 3 chamadas em 320, não das 320.

Nenhuma das duas `not_json` veio com `finish_reason: length` — se tivesse, o código seria
`truncated`. Não foi teto de tokens: o corpo chegou vazio ou pela metade.

### A saída não obedeceu ao contrato — 1 de 320 (0.3%)

**Aceitar por ora.** Uma grafia inventada de um valor da lista fechada. É o candidato mais
barato a entrar no retry acima se ele existir, porque é o tipo de erro que uma segunda
chamada não repete — mas 0.3% não paga mudança de prompt sozinho.

### O modelo recusou — 0 de 320 (0.0%)

**Nada a fazer, e o zero é o achado.** A issue listava recusa como uma das três causas
plausíveis. O código `refusal` existe, está ligado ao `content_filter` do fornecedor
(`deepseek.ts`), e não disparou uma vez.

### Falha de validação verbatim — 0, e por construção

A terceira causa da issue não pode produzir digest nulo. A conferência do `trecho` não
lança: ela PODA o item e soma em `descartes` (`trechoInexistente`, `trechoRepetido`,
`trechoCurto`). Uma digestão com todas as pegadinhas podadas volta válida e vazia, não
nula. Zero aqui é propriedade do código, não sorte desta rodada.

## As falhas, uma a uma

O trecho de cada uma é a mensagem que a PRÓPRIA corrida gravou — não uma releitura.

### 1. `will-oliver-bearman-be-the-2026-f1-drivers-champion`

*Will Oliver Bearman be the 2026 F1 Drivers' Champion?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em resolve_nao ("chance de"): ...r matematicamente eliminado de qualquer chance de título, conforme as regras da F1....

### 2. `us-announces-end-of-iranian-blockade-by-september-21-2026`

*US announces end of Iranian blockade by September 21, 2026?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em resolve_nao ("provável"): ...descrevam fim prospectivo, contingente, provável ou condicional, em vez de posição presente e decidi...

### 3. `will-russia-enter-dobropillia-by-december-31-756-874`

*Will Russia enter Dobropillia by December 31?*

- **causa:** a resposta não chegou inteira
- **código:** `api_error`
- **trecho da corrida:** fetch failed

### 4. `will-pablo-maral-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election`

*Will Pablo Marçal finish in third place in the first round of the 2026 Brazilian presidential election?*

- **causa:** a resposta não chegou inteira
- **código:** `not_json`
- **trecho da corrida:** resposta não é JSON: SyntaxError: Unexpected end of JSON input

### 5. `us-announces-end-of-iranian-blockade-by-august-14-2026`

*US announces end of Iranian blockade by August 14, 2026?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em pegadinhas ("provável"): ...Declarações prospectivas, contingentes, prováveis ou condicionais não contam; é preciso uma decisão ...

### 6. `will-tarcisio-de-freitas-win-the-first-round-of-the-2026-brazilian-presidential-election`

*Will Tarcisio de Freitas win the first round of the 2026 Brazilian presidential election?*

- **causa:** trava de opinião disparou — hedge do modelo
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em ambiguidades ("provavelmente"): ...ou EDT (UTC-4). Como a data é em junho, provavelmente é EDT, mas há ambiguidade....

### 7. `us-iran-60-day-negotiation-period-extended-20260624044855448`

*US-Iran 60 day negotiation period extended?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em pegadinhas ("provável"): ...Declarações sobre extensão futura, provável ou condicional não contam — é preciso anunciar uma ...

### 8. `will-there-be-no-change-in-fed-interest-rates-after-the-january-2027-meeting-20260729233815505`

*Will there be no change in Fed interest rates after the January 2027 meeting?*

- **causa:** trava de opinião disparou — hedge do modelo
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em ambiguidades ("provavelmente"): ... reunião seguinte à de janeiro de 2027 (provavelmente a de março de 2027), conforme o calendário do ...

### 9. `israel-military-action-against-greater-beirut-by-august-31-20260708214159403`

*Israel military action against Greater Beirut by August 31?*

- **causa:** a saída não obedeceu ao contrato
- **código:** `tipo_invalido`
- **trecho da corrida:** tipo fora da lista (contradicao_interna | precedencia_de_fonte | criterio_discricionario | fonte_vaga | fuso_ausente | momento_ambiguo | data_ambigua | janela_inclusiva | escopo_de_entidade | limiar_de_borda | formato_do_mercado | outro): "criterio_discricionary"

### 10. `us-announces-end-of-iranian-blockade-by-december-31-2026-20260727171803489-375-949-645-919-269-157-255-857`

*US announces end of Iranian blockade by December 31, 2026?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em pegadinhas ("provável"): ...clarações prospectivas, condicionais ou prováveis não contam; é preciso posição presente e decidida....

### 11. `us-announces-end-of-iranian-blockade-by-august-22-2026`

*US announces end of Iranian blockade by August 22, 2026?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em resolve_nao ("provável"): ...descrevam fim prospectivo, contingente, provável ou condicional; declarações incidentais ou informai...

### 12. `us-announces-end-of-iranian-blockade-by-august-31-2026-20260713152715084-642-513-584-641-939-632-729`

*US announces end of Iranian blockade by August 31, 2026?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em resolve_nao ("provável"): ...rações de fim prospectivo, contingente, provável ou condicional em vez de posição presente e decidid...

### 13. `will-james-fishback-win-more-than-30-of-votes-in-the-florida-republican-governor-primary-20260701154239345`

*Will James Fishback at least 30% of votes in the Florida Republican Governor primary?*

- **causa:** a resposta não chegou inteira
- **código:** `not_json`
- **trecho da corrida:** resposta não é JSON: SyntaxError: Unexpected end of JSON input

### 14. `will-wti-reach-150-in-august-2026`

*Will WTI Crude Oil (WTI) hit (HIGH) $150 in August?*

- **causa:** trava de opinião disparou — hedge do modelo
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em pegadinhas ("provavelmente"): ...e em agosto de 2026 é outro vencimento (provavelmente setembro), não o contrato que vence em agosto....

### 15. `us-announces-end-of-iranian-blockade-by-september-30-2026-20260727171615364-722-649-646-561-213-644-414-831`

*US announces end of Iranian blockade by September 30, 2026?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em pegadinhas ("provável"): ...Anúncios de fim futuro, condicional, provável ou contingente não qualificam; é preciso uma posiçã...

### 16. `us-announces-end-of-iranian-blockade-by-august-15-2026-20260713152715083-347-987-697-628-574-676`

*US announces end of Iranian blockade by August 15, 2026?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em resolve_nao ("provável"): ...rações de fim prospectivo, contingente, provável ou condicional....

### 17. `will-the-next-diplomatic-us-iran-meeting-be-in-switzerland-by-september-30-2026-20260622185050768`

*Will the next diplomatic US-Iran meeting be in Switzerland by September 30, 2026?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em resolve_sim ("oportunidade"): ...o é cumprimento breve, encontro casual, oportunidade de foto ou aparição cerimoniosa; é presencial; ...

### 18. `us-announces-end-of-iranian-blockade-by-september-7-2026`

*US announces end of Iranian blockade by September 7, 2026?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em resolve_nao ("provável"): ...descrevam fim prospectivo, contingente, provável ou condicional, não qualificam....

### 19. `will-nvidia-be-the-third-largest-company-in-the-world-by-market-cap-on-september-30-20260729225254988`

*Will NVIDIA be the third-largest company in the world by market cap on September 30?*

- **causa:** trava de opinião disparou — hedge do modelo
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em ambiguidades ("provavelmente"): ...to da bolsa onde a NVIDIA está listada (provavelmente NASDAQ, nos EUA)....

### 20. `will-there-be-at-least-3000-measles-cases-in-the-us-in-2026-346`

*Will there be at least 3000 measles cases in the U.S. in 2026?*

- **causa:** trava de opinião disparou — vocabulário da regra
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em pegadinhas ("provável"): ... casos confirmados contam; suspeitos ou prováveis não entram....

### 21. `will-joao-rodrigues-win-the-governor-of-santa-catarina-election-20260609164311693`

*Will João Rodrigues win the Governor of Santa Catarina election?*

- **causa:** trava de opinião disparou — hedge do modelo
- **código:** `opiniao`
- **trecho da corrida:** saída contém opinião sobre desfecho em ambiguidades ("chance de"): ...ção clara) é 'ambiguidade'; uma simples chance de erro não aciona o TSE....

