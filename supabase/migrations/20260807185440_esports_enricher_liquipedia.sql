-- Enricher da Liquipedia — a flag, e só a flag.
--
-- Uma coluna em `system_config`. Nenhuma tabela nova, nenhum dado migrado,
-- nenhuma coluna alterada.
--
-- ---------------------------------------------------------------------------
-- Por que o default é `false`, ao contrário do resolver e do enricher
-- ---------------------------------------------------------------------------
--
-- `esports_resolver_enabled` e `esports_enricher_enabled` nasceram `true` porque
-- o pior caso deles é CPU: leem dado que já é nosso e não falam com ninguém.
--
-- Este é o segundo componente do sistema que nasce desligado, pelo mesmo tipo de
-- razão do `esports_analyst_enabled` — lá o custo do engano é fatura, aqui é
-- relação com terceiro:
--
--   1. A LiquipediaDB exige CHAVE, e a chave não é self-service: é pedida por
--      formulário e aprovada por gente (https://api.liquipedia.net).
--
--   2. A página de acesso diz que a chave NÃO é concedida a "betting-related
--      projects". Se este projeto cai nessa definição é decisão do dono — ele
--      detecta sinal em mercado de previsão e dimensiona aposta — e é decisão a
--      tomar ANTES de pedir a chave, não depois de o job estar rodando.
--
--   3. Os termos impõem no máximo 60 requisições por hora, User-Agent
--      identificável com contato, cache agressivo e atribuição CC BY-SA 3.0.
--      Tudo isso está implementado em `src/lib/liquipedia-api.ts`, mas nada
--      disso é motivo para o componente se ligar sozinho num deploy.
--
-- Além desta flag, o enricher exige DUAS variáveis de ambiente
-- (`LIQUIPEDIA_API_KEY` e `LIQUIPEDIA_USER_AGENT`). Sem elas, ligar a flag não
-- faz nenhuma requisição sair — só produz uma linha de aviso por hora. As duas
-- trancas são de propósito: a config diz "eu quero", o ambiente diz "eu posso".

alter table public.system_config
  add column if not exists esports_enricher_liquipedia_enabled boolean not null default false;

comment on column public.system_config.esports_enricher_liquipedia_enabled is
  'Liga o enricher liquipedia (roster, h2h, forma recente, formato de torneio). Default false: a fonte e externa, exige chave aprovada por humano, User-Agent identificavel e teto de 60 req/h, e o acesso e negado a projeto de aposta. Exige tambem LIQUIPEDIA_API_KEY e LIQUIPEDIA_USER_AGENT no ambiente — sem elas, ligar aqui nao faz requisicao nenhuma sair.';

-- ---------------------------------------------------------------------------
-- O que este enricher NÃO faz, e precisa estar registrado onde alguém veja
-- ---------------------------------------------------------------------------
--
-- `supportsPointInTime = false`. A LPDB entrega dado datado (`squadplayer` tem
-- `joindate`/`leavedate`, `match2` tem `date`), mas não entrega QUANDO o fato foi
-- registrado na wiki — e a wiki é editada retroativamente. Perguntar hoje "quem
-- estava no time em 1º de maio" devolve a resposta corrigida desde então, que
-- inclui o que ninguém sabia naquele dia.
--
-- A consequência é dura e é o ponto: `runEnrichers` recusa este enricher em
-- qualquer replay de eval. O valor dele acumula só para a frente — cada execução
-- em produção grava um fragmento com `observed_at` do servidor, e é dele que o
-- eval lê depois. As análises que já existem não melhoram retroativamente.
--
-- O caminho para virar `true` está documentado em
-- `src/verticals/enrichers/liquipedia.ts`: a API MediaWiki devolve a página como
-- ela ERA numa data, com carimbo de revisão — que é exatamente o "quando a
-- Liquipedia soube" que falta aqui. Custa parsear wikitext e 1 requisição a cada
-- 2 segundos, e só vale depois de este enricher provar que o dado ajuda.
