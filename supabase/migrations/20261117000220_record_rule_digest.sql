-- One digest reading, written atomically and idempotently (issue 88, PR 1 of
-- issue 86).
--
-- Why: a reading is four parts (the rule text, the digest, its traps, its
-- ambiguities), and `scripts/carregar-digest.ts` writes them as separate
-- PostgREST calls with no transaction. A failure between them leaves a digest
-- without its children, and the five-column dedup key then treats the
-- half-written reading as done. The loader can only report that state
-- (`scripts/carregar-digest.ts:398-401`). The scheduled run of issue 86 is
-- unattended and retries, so it needs one call that is all-or-nothing and safe
-- to repeat.
--
-- PostgREST runs one statement per request and has no multi-statement
-- transaction. A function called by `rpc` runs inside the transaction of that
-- single request: an error in any insert below rolls back all of them.
--
-- Idempotency: the digest goes in with `on conflict do nothing` on the existing
-- unique `(event_id, description_sha256, model, prompt_version, leitura_n)`.
-- When nothing is inserted the reading was already there, and the function
-- answers 'duplicate' without touching the children. Under concurrency the
-- second insert waits on the unique index for the first transaction, then sees
-- its row and does nothing, so exactly one caller gets 'inserted'.
--
-- Unknown keys are an error, not ignored. `jsonb_populate_record` silently drops
-- a key that is not a column, while the direct PostgREST insert this replaces
-- refused it (PGRST204). The check keeps that refusal: a field added to
-- `buildDigestRows` (src/digest/rows.ts) without a column here fails loudly.
--
-- `security invoker`: the function has no rights of its own. The caller is the
-- service role (ADR 0001), which already writes these four tables directly.
-- Execute is revoked from public, anon and authenticated, like every other
-- object the radar exposes.
--
-- Adds no table, no column and no row. Measured on 2026-11-16 at 23:57 UTC,
-- read-only, from the PostgREST schema cache of the project: 15 rpc functions
-- exposed, none named `record_rule_digest`; 267 texts, 1264 digests, 3980 traps,
-- 3252 ambiguities.

create or replace function public.record_rule_digest (
  p_text jsonb,
  p_digest jsonb,
  p_pegadinhas jsonb default '[]'::jsonb,
  p_ambiguidades jsonb default '[]'::jsonb
)
  returns text
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $function$
declare
  v_unknown text[];
  v_digest_id uuid;
begin
  -- The column lists below are also the insert lists. A key outside them would
  -- be dropped by jsonb_populate_record, so it stops the call instead.
  select array_agg(distinct k order by k)
    into v_unknown
    from (
      select k
        from jsonb_object_keys(p_text) k
       where k <> all (array['description_sha256', 'description', 'guardado_por'])
      union all
      select k
        from jsonb_object_keys(p_digest) k
       where k <> all (array[
         'event_id', 'description_sha256', 'leitura_n', 'resolve_sim', 'resolve_nao',
         'fonte', 'prazo', 'anula_se', 'model', 'prompt_version', 'tokens_input',
         'tokens_output', 'tokens_cache_read', 'tokens_cache_write', 'cost_usd', 'latency_ms'
       ])
      union all
      select k
        from jsonb_array_elements(p_pegadinhas) e, jsonb_object_keys(e) k
       where k <> all (array['ordinal', 'texto', 'severidade', 'trecho', 'cenario'])
      union all
      select k
        from jsonb_array_elements(p_ambiguidades) e, jsonb_object_keys(e) k
       where k <> all (array[
         'ordinal', 'tipo', 'trecho', 'trecho_conflito', 'leitura_a', 'leitura_b'
       ])
    ) unknown_keys;

  if v_unknown is not null then
    raise exception 'record_rule_digest: chaves sem coluna no payload: %', v_unknown;
  end if;

  -- One reading, one text. The foreign key alone would accept a digest whose
  -- text was stored earlier under another hash, and the text sent here would
  -- then be written for nothing.
  if (p_text ->> 'description_sha256') is distinct from (p_digest ->> 'description_sha256') then
    raise exception 'record_rule_digest: hash do texto (%) difere do hash da digestao (%)',
      p_text ->> 'description_sha256', p_digest ->> 'description_sha256';
  end if;

  -- The text first: market_rule_digests_texto_guardado points at it. The same
  -- text shared by several markets is one row, so a conflict here is normal.
  insert into public.market_rule_texts (description_sha256, description, guardado_por)
  select t.description_sha256, t.description, t.guardado_por
    from jsonb_populate_record(null::public.market_rule_texts, p_text) t
  on conflict (description_sha256) do nothing;

  insert into public.market_rule_digests (
    event_id, description_sha256, leitura_n, resolve_sim, resolve_nao, fonte, prazo, anula_se,
    model, prompt_version, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
    cost_usd, latency_ms
  )
  select d.event_id, d.description_sha256, d.leitura_n, d.resolve_sim, d.resolve_nao, d.fonte,
         d.prazo, d.anula_se, d.model, d.prompt_version, d.tokens_input, d.tokens_output,
         d.tokens_cache_read, d.tokens_cache_write, d.cost_usd, d.latency_ms
    from jsonb_populate_record(null::public.market_rule_digests, p_digest) d
  on conflict on constraint market_rule_digests_one_per_text_model_and_reading do nothing
  returning id into v_digest_id;

  if v_digest_id is null then
    return 'duplicate';
  end if;

  insert into public.digest_pegadinhas (digest_id, ordinal, texto, severidade, trecho, cenario)
  select v_digest_id, p.ordinal, p.texto, p.severidade, p.trecho, p.cenario
    from jsonb_populate_recordset(null::public.digest_pegadinhas, p_pegadinhas) p;

  insert into public.digest_ambiguidades (
    digest_id, ordinal, tipo, trecho, trecho_conflito, leitura_a, leitura_b
  )
  select v_digest_id, a.ordinal, a.tipo, a.trecho, a.trecho_conflito, a.leitura_a, a.leitura_b
    from jsonb_populate_recordset(null::public.digest_ambiguidades, p_ambiguidades) a;

  return 'inserted';
end;
$function$;

comment on function public.record_rule_digest(jsonb, jsonb, jsonb, jsonb) is
  'One digest reading (text, digest, traps, ambiguities) in one transaction. Returns inserted, or duplicate when the five-column key already exists, in which case nothing is written. Unknown payload keys raise. Called by src/digest/persist.ts. Issue 88.';

revoke all on function public.record_rule_digest(jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;

grant execute on function public.record_rule_digest(jsonb, jsonb, jsonb, jsonb)
  to service_role;

notify pgrst, 'reload schema';

-- Check after apply (read-only):
--
--   select p.prosecdef, p.proconfig
--     from pg_proc p
--    where p.oid = 'public.record_rule_digest(jsonb, jsonb, jsonb, jsonb)'::regprocedure;
--   -- expected: prosecdef = false (security invoker), proconfig = {search_path=""}
--
--   select has_function_privilege('anon',
--            'public.record_rule_digest(jsonb, jsonb, jsonb, jsonb)', 'execute') as anon,
--          has_function_privilege('authenticated',
--            'public.record_rule_digest(jsonb, jsonb, jsonb, jsonb)', 'execute') as authenticated,
--          has_function_privilege('service_role',
--            'public.record_rule_digest(jsonb, jsonb, jsonb, jsonb)', 'execute') as service_role;
--   -- expected: false, false, true
