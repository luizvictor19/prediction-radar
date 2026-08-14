-- O buraco que sobrou na proteção do radar: a retenção SEM LOTE.
--
-- ---------------------------------------------------------------------------
-- O achado, em três linhas
-- ---------------------------------------------------------------------------
--
-- A migration 20260813210119 fechou o caminho que o job usa: ela reescreveu
-- `run_snapshot_retention_batch` para somar `radar_event_ids()` à proteção, e
-- `src/jobs/retention.ts` chama exatamente essa. Conferido em 2026-08-13:
-- `radar_event_ids()` responde (0 marcados), então o apply aconteceu.
--
-- O que ela NÃO tocou foi a irmã: `public.run_snapshot_retention(integer)`, a
-- versão sem lote criada na 20260806032316 "para uso manual". Ela continua
-- pulando SÓ o que casa `esports_slug_patterns()`. Um mercado do radar não casa
-- com `cs2-%` nem `lol-%`, então numa execução manual dessa função:
--
--   ramo `old`        apaga a série do radar mais velha que `retention_hours`,
--                     que o chamador passa como quiser (default 24h);
--   ramo `finalized`  apaga a série INTEIRA de todo mercado do radar que já
--                     resolveu, sem nenhuma condição de idade.
--
-- É o dano do README repetido com outro nome — "of 1,755 resolved matches
-- probed for recoverable history, zero have a usable price series" — e ele não
-- precisa de bug para acontecer: basta alguém rodar à mão a função que a própria
-- migration anterior descreve como útil à mão.
--
-- Nada em `src/` a chama (conferido por grep). O risco é humano, e é justamente
-- por isso que ele não se resolve com aviso: quem digita `select
-- run_snapshot_retention()` às duas da manhã não vai reler o comentário.
--
-- ---------------------------------------------------------------------------
-- Por que consertar em vez de dropar
-- ---------------------------------------------------------------------------
--
-- Dropar seria defensável — a 20260806032316 diz isso em voz alta, e um DELETE
-- sem LIMIT é o que travou o `retention_job` antes do item 1. Mas dropar é
-- decisão sobre uma ferramenta que o dono usa; consertar a proteção não é.
-- Uma função de apagar que conhece a regra pela metade é pior que não existir,
-- e é essa metade que esta migration completa. Se o dono quiser dropar depois,
-- a linha está no fim do arquivo, comentada.
--
-- A troca é literal: onde havia `NOT EXISTS (... slug LIKE ANY (esports))`
-- passa a haver a mesma condição OU `radar_tracked`. O corpo é o da
-- 20260806032316 sem nenhuma outra diferença.

create or replace function public.run_snapshot_retention (
  retention_hours integer DEFAULT 24
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $function$
DECLARE
  old_deleted int := 0;
  finalized_deleted int := 0;
  esports text[] := public.esports_slug_patterns();
  radar_protected int := 0;
BEGIN
  SELECT count(*) INTO radar_protected FROM public.events e WHERE e.radar_tracked;

  WITH deleted AS (
    DELETE FROM public.polymarket_snapshots s
     WHERE s.captured_at < NOW() - (retention_hours || ' hours')::interval
       AND NOT EXISTS (
         SELECT 1
           FROM public.events e
          WHERE e.id = s.event_id
            AND (e.slug LIKE ANY (esports) OR e.radar_tracked)
       )
    RETURNING 1
  )
  SELECT count(*) INTO old_deleted FROM deleted;

  WITH deleted AS (
    DELETE FROM public.polymarket_snapshots s
     WHERE s.event_id IN (
             SELECT e.id
               FROM public.events e
              WHERE e.status IN ('resolved', 'closed_manual', 'inactive')
                AND NOT (e.slug LIKE ANY (esports))
                AND NOT e.radar_tracked
           )
    RETURNING 1
  )
  SELECT count(*) INTO finalized_deleted FROM deleted;

  RETURN jsonb_build_object(
    'old_deleted', old_deleted,
    'finalized_deleted', finalized_deleted,
    'retention_hours', retention_hours,
    'esports_patterns', to_jsonb(esports),
    -- Sai no retorno, e não só no comentário: quem roda à mão vê quantas séries
    -- a proteção do radar segurou naquela execução.
    'radar_protected_events', radar_protected
  );
END;
$function$;

comment on function public.run_snapshot_retention(integer) is
  'Retencao sem lote de polymarket_snapshots, para uso manual. NUNCA apaga snapshot de esports (esports_slug_patterns) nem de event com radar_tracked. O job usa run_snapshot_retention_batch, que ganhou a mesma protecao na 20260813210119. Spec 000 item 8, mais a protecao do radar.';

-- ---------------------------------------------------------------------------
-- Diferença deliberada de forma em relação à versão em lote
-- ---------------------------------------------------------------------------
--
-- A versão em lote resolve `esports_event_ids() || radar_event_ids()` UMA vez e
-- compara por id, porque o `LIKE ANY` com pattern vindo de variável não usa
-- `idx_events_slug_prefix` e vira seq scan de 711 MB (a lição da 20260807230005,
-- que derrubou o banco). Aqui o `LIKE ANY` fica, e é consistente: esta função
-- já era assim, já é um DELETE sem LIMIT, e já é para base pequena e uso à mão.
-- Trocar a forma dela agora misturaria dois consertos num arquivo só — o de
-- proteção, que é urgente, com o de plano, que não é.
--
-- O que NÃO muda: `e.radar_tracked` é boolean NOT NULL DEFAULT false
-- (20260813210119), então `NOT e.radar_tracked` não tem armadilha de NULL.
--
-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- 1. o retorno agora informa quantos events estão protegidos pelo radar.
--   --    ATENÇÃO: esta função APAGA. Só rode em base que possa perder o que
--   --    não estiver protegido.
--   -- select public.run_snapshot_retention(24);
--
--   -- 2. sem apagar nada, a mesma pergunta que a função responde:
--   select count(*) filter (where e.radar_tracked) as protegidos_radar,
--          count(*) filter (where e.slug like any (public.esports_slug_patterns())) as protegidos_esports
--     from public.events e
--    where e.radar_tracked
--       or e.slug like any (public.esports_slug_patterns());
--
-- ---------------------------------------------------------------------------
-- Se o dono preferir eliminar a ferramenta em vez de consertá-la
-- ---------------------------------------------------------------------------
--
--   drop function if exists public.run_snapshot_retention(integer);
--
-- Não fica aqui como comando ativo: dropar função que alguém usa à mão é
-- decisão de quem usa, e este arquivo existe para tapar um buraco, não para
-- tomar essa decisão de contrabando.
