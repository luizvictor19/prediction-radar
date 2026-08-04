-- Spec 000, item 2a — descoberta por startDate.
--
-- Os prefixos de vertical ficam em config, não no código, para religar ou
-- acrescentar uma vertical sem deploy. O coletor tem os mesmos valores como
-- fallback (src/lib/config.ts), então ele funciona antes desta migration ser
-- aplicada — aplicá-la é o que passa a permitir mudar sem deploy.

alter table system_config
  add column if not exists discovery_slug_prefixes text[] default '{cs2-,lol-,dota2-}',
  add column if not exists discovery_lookback_minutes integer default 20;

-- Janela de lookback: o teto de offset da Gamma (2000) cobre só ~36 min de
-- criação de markets (medido em 2026-08-04, com rajadas de ~300/min). Passar
-- muito de 20 min faz a descoberta bater no teto antes de alcançar o horizonte.
comment on column system_config.discovery_lookback_minutes is
  'Quanto a descoberta olha para tras em um ciclo frio. Limitado pelo teto de offset 2000 da Gamma (~36 min de markets).';
