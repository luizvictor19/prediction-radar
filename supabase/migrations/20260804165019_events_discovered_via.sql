-- Spec 000, item 2a — quem viu o market primeiro.
--
-- Nullable e SEM default de propósito: com default, o ADD COLUMN reescreveria as
-- ~551k linhas de `events` (711 MB) de uma vez. Sem default é só metadado.
--
-- NULL não quer dizer "desconhecido para sempre": as linhas anteriores a esta
-- coluna são todas NULL, e a partir do deploy da descoberta a leitura é
--
--   created_at > <deploy>  and  discovered_via = 'discovery'  -> a descoberta chegou primeiro
--   created_at > <deploy>  and  discovered_via is null        -> a varredura por volume
--                                                                (ou o early-markets) chegou primeiro
--
-- Só a descoberta carimba. Os outros coletores não sabem se a linha é nova sem
-- uma leitura a mais por lote, e o custo não se paga: o complemento já é dado
-- pelo NULL com created_at posterior ao deploy.
alter table events
  add column if not exists discovered_via text;

comment on column events.discovered_via is
  'Coletor que persistiu esta linha primeiro. NULL = anterior a esta coluna, ou visto primeiro pela varredura por volume / early-markets. Ver spec 000, item 2a.';

-- Parcial: indexa só o que foi carimbado (dezenas por ciclo), não as 551k linhas
-- NULL. Fica pequeno e a escrita extra só acontece nas linhas da descoberta —
-- o oposto do events_title_trgm_idx, que paga GIN em todo insert.
create index if not exists idx_events_discovered_via
  on events (discovered_via, created_at desc)
  where discovered_via is not null;
