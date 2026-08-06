-- Spec 001, item 3 — semântica de `needs_review` depois do primeiro dry-run.
--
-- SÓ COMENTÁRIOS. Nenhuma coluna, constraint, índice ou dado é alterado. Pode
-- ser aplicada a qualquer momento, inclusive antes do backfill.
--
-- ---------------------------------------------------------------------------
-- O que a medição mostrou
-- ---------------------------------------------------------------------------
--
-- O dry-run de 2026-08-06 sobre 21.615 markets resolvidos:
--
--   caminho 1 (teams[])      446   0 outcomes não casados, 0 pendências
--   caminho 2 (slug)      21.169   e TODOS marcados para revisão
--
-- 21.169 linhas de fila é o mesmo que não ter fila — e uma fila que ninguém
-- quita não fica só inútil, ela esconde as pendências reais dentro dela.
--
-- O erro conceitual do desenho original: `needs_review` marcava POBREZA quando
-- deveria marcar INCERTEZA. O caminho 2 é pobre — código de time sem nome, sem
-- liga, sem stage, sem tier — e ao mesmo tempo determinístico: o parser deu 0
-- slugs fora do padrão em 464 medidos. Pobre não é duvidoso, e quem registra
-- pobreza é `confidence`, não uma fila de trabalho humano.
--
-- ---------------------------------------------------------------------------
-- Três estados, um destino cada
-- ---------------------------------------------------------------------------
--
--   A. `needs_review = true` — só onde um humano acrescenta o que nenhuma
--      máquina tem: conflito entre o slug e `teams[]`, casamento ambíguo (o
--      mesmo rótulo casou nos dois outcomes), `teams[]` sem `ordering`, e
--      outcome não casado NO CAMINHO 1 (onde a medição diz que deveria casar,
--      então falhar é anomalia).
--
--   B. RECOMPUTÁVEL — sem flag no banco, e de propósito. É o outcome não casado
--      do caminho 2, cuja causa é conhecida: compara-se uma contração (`navi`)
--      com um nome ('Natus Vincere'). A cura é `esports_teams.display_name`,
--      que o caminho 1 preenche para o mesmo `polymarket_code` — e aí uma
--      passada nova do resolver (`--recompute`) resolve sozinha. Marcar isso
--      como revisão seria pedir a um humano que digitasse o que a API entrega.
--
--   C. RELATÓRIO DE FAMÍLIA — sufixo sem papel mapeável. A pergunta não é sobre
--      a linha, é sobre a família: `gameN-round-total-X` sozinha eram 3.692
--      markets. Uma regra nova no código resolve todos de uma vez; 3.692
--      confirmações no Telegram não resolvem nenhum.
--
-- O que NÃO mudou: nada passou a ser adivinhado. `outcome_a_index` que não
-- casou continua `null`, papel desconhecido continua `unknown`, e
-- `esports_tournaments.tier` continua sem ser escrito pelo resolver.

comment on column public.market_match_links.needs_review is
  'Estado A: exige decisao humana — conflito entre slug e teams[], casamento ambiguo, teams[] sem ordering, ou outcome nao casado no caminho 1. NAO marca pobreza de dado: link vindo do slug e papel inferido de sufixo entram com confidence menor e sem fila. Spec 001, item 3.';

comment on column public.market_match_links.confidence is
  'Quanto do link e fato e quanto e inferencia. 1.0 = teams[] da API com outcome casado. 0.7 = identidade do slug, ou papel inferido do sufixo. 0.5 = outcome nao casado ou ambiguo. 0.3 = papel desconhecido. E aqui que a POBREZA do dado fica registrada — needs_review e so para incerteza.';

comment on column public.market_match_links.outcome_a_index is
  'Indice do team_a em events.outcomes.values, resolvido POR MARKET: medido, 19 de 79 eventos tem markets irmaos com outcomes em ordens diferentes (caso concreto: cs2-navi-vit-2026-05-03-map-handicap-home-2pt5, invertido em relacao aos irmaos). NULL tem duas leituras, e nenhuma e pendencia de revisao: market derivado sem lado de time (Over/Under), ou estado B — falta o display_name do time, e uma recomputacao resolve.';

comment on column public.esports_teams.needs_review is
  'Reservado para conflito de identidade encontrado por revisao humana. O resolver NUNCA marca true: time conhecido so pelo codigo do slug e pobre, nao duvidoso, e se identifica por display_name IS NULL — o nome canonico chega pelo caminho 1 quando o mesmo polymarket_code aparecer num evento recente, nao por digitacao.';

comment on column public.esports_matches.needs_review is
  'Estado A no nivel da partida: conflito entre o slug e teams[], ou vertical divergente. Partida vinda so do slug (sem liga, stage ou tier) NAO e pendencia.';
