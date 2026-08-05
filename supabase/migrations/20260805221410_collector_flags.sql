-- Spec 000, item 4 — desligar a varredura por volume sem apagar código.
--
-- Flag em config, e não `git rm`, por três razões: a varredura é o único caminho
-- que já existe para varrer fora de esports, religá-la é um UPDATE em vez de um
-- deploy, e o critério do item 4 é explícito ("via system_config, sem apagar
-- código").
--
-- O que a varredura por volume era: `GET /markets?order=volume24hr` paginado até
-- o teto de offset 2000 da Gamma. Medido em 2026-08-04, numa hora de produção,
-- ela trouxe 1 market de esports contra 60 da descoberta — e esse 1 era derivado
-- de uma partida que a descoberta já tinha capturado 20 min antes. Não é
-- cobertura complementar, é redundância cara: `pg_stat_statements` atribuía a ela
-- dezenas de milhões de round-trips, e o que sobra do que ela traz é
-- crypto_fees_v2 e weather_fees — 61% das linhas de `events`, alvo da poda do
-- item 5.
--
-- O mercado de esports nasce com volume 0 e liquidez ~US$ 17: fica no fundo da
-- ordenação por volume, muito além da posição 2000. A varredura nunca alcançou o
-- que interessa agora, e nenhum ajuste de filtro a faria alcançar.

alter table public.system_config
  add column if not exists volume_scan_enabled boolean default false,
  add column if not exists early_markets_enabled boolean default false;

comment on column public.system_config.volume_scan_enabled is
  'Liga a varredura por volume (collectAll, src/collectors/polymarket.ts). false desde a spec 000 item 4: substituida por descoberta (2a) + watchlist (2b). Religar e UPDATE, sem deploy.';

-- `early_markets_enabled` desligado pelo mesmo motivo, mais um próprio.
--
-- O early-markets pagina `order=startDate` atrás de uma janela de 24h — mas o
-- teto de offset 2000 da Gamma cobre ~36 min de criação de markets. Ele nunca
-- alcançou a própria janela: bate no 422, marca `pagination_failed` e fecha em
-- `partial`. Cobre, na prática, os mesmos ~36 min que a descoberta cobre a cada
-- 3 min, e com um piso de liquidez de US$ 500 que exclui por construção o
-- mercado de esports recém-nascido (~US$ 17).
--
-- O que sobra de exclusivo dele é market novo NÃO-esports com liquidez >= 500,
-- que é a entrada da categoria que o item 5 vai podar. Manter ligado seria
-- alimentar e podar a mesma tabela no mesmo dia.
--
-- Efeito colateral a conhecer: `is_new_market` só é escrito por este coletor, e
-- só o detector `early_market` lê essa coluna. Com o coletor parado, a coluna
-- para de receber `true` e o detector deixa de ter entrada nova — o que está
-- alinhado com o desligamento dos detectores genéricos, mas é a consequência que
-- não aparece no nome da flag.
comment on column public.system_config.early_markets_enabled is
  'Liga o early-markets-collector. false desde a spec 000 item 4: a descoberta por startDate cobre a mesma janela sem piso de liquidez. Unico escritor de events.is_new_market.';
