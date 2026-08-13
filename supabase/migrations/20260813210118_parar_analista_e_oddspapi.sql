-- Desliga o analista e o enricher da OddsPapi.
--
-- ---------------------------------------------------------------------------
-- Por que o analista para
-- ---------------------------------------------------------------------------
--
-- Skill medido em −0,029 sobre n=167. Não é "ainda não converge": é negativo, e
-- negativo com custo por ciclo significa pagar para perder. O componente é o
-- único do sistema cuja execução vira fatura, então o número que decide não é a
-- acurácia dele contra 0,5 — é o sinal do skill contra o preço de mercado, e
-- esse sinal está trocado.
--
-- Ele NÃO é apagado. O código de `src/jobs/esports-analyst.ts`, os prompts, o
-- dataset de avaliação e o histórico de sinais ficam onde estão: o que se
-- descobriu foi que a versão atual perde dinheiro, não que a pergunta era ruim.
-- Religar é `false` -> `true` nesta mesma coluna.
--
-- ---------------------------------------------------------------------------
-- Por que a OddsPapi para junto
-- ---------------------------------------------------------------------------
--
-- O enricher da OddsPapi existe para alimentar o analista com odds de casa de
-- aposta. Sem analista, ele grava `context_fragments` que ninguém lê — e gasta
-- para isso um tier gratuito de 250 requisições/mês que é cortesia de terceiro,
-- sem contador observável e cancelável sem aviso. Gastar orçamento de terceiro
-- para produzir contexto sem consumidor é o pior dos dois lados.
--
-- Os outros enrichers (`market-history`, `match-history`, `polymarket-context`)
-- seguem ligados: lêem o nosso próprio banco, não têm credencial para queimar, e
-- o que eles gravam continua sendo série que o backtest futuro vai querer.
-- `esports_enricher_enabled` fica `true` de propósito — desligar o orquestrador
-- inteiro derrubaria os três junto, e nenhum deles custa dinheiro.
--
-- ---------------------------------------------------------------------------
-- Como conferir que parou
-- ---------------------------------------------------------------------------
--
-- Os dois componentes desligam POR DENTRO — o cron de 5 min continua chamando,
-- e a função retorna cedo depois de registrar por que não fez nada. Então o
-- sintoma de "parou" não é ausência de log: é log de desligado.
--
--   select component, status, message, created_at
--     from system_logs
--    where component in ('esports_analyst', 'enricher:oddspapi')
--    order by created_at desc
--    limit 20;
--
-- Esperado depois do apply, dentro de 5 minutos: linhas do analista com
-- "Analista desligado: esports_analyst_enabled = false". Esperado da OddsPapi:
-- nenhuma requisição nova saindo — `oddspapi.ts` devolve vazio antes de tocar a
-- rede quando a flag é false.
--
-- E o que NÃO pode mudar: `health_alerts_enabled` segue `true`, o heartbeat
-- segue batendo e o bot segue respondendo. Desligar quem gasta não é desligar
-- quem vigia.

update public.system_config
   set esports_analyst_enabled = false,
       esports_enricher_oddspapi_enabled = false,
       updated_at = now()
 where id = 1;

comment on column public.system_config.esports_analyst_enabled is
  'Liga o agente analista. Desligado em 2026-08-13 por medicao: skill -0,029 sobre n=167 — paga para perder. Codigo preservado; religar e trocar este false por true.';

comment on column public.system_config.esports_enricher_oddspapi_enabled is
  'Liga o enricher da OddsPapi. Desligado em 2026-08-13 junto com o analista: sem ele o fragmento nao tem leitor, e a cota de 250 req/mes e cortesia de terceiro.';
