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
-- Order inside the function: check the payload, then look the key up, then
-- write. Nothing is written before the answer is known.
--
-- 1. The payload. Every object must carry exactly the keys listed below: an
--    unknown key raises (`jsonb_populate_record` would drop it silently, where
--    the direct PostgREST insert this replaces refused it with PGRST204), and so
--    does a missing one (it would become NULL, not the column default, and for
--    `leitura_n` a default would pick the reading index without a word).
--    `buildDigestRows` (src/digest/rows.ts) always sends every key.
--    The text must hash to its own `description_sha256`, computed as
--    `hashDescription` does in src/digest/digest.ts: sha256 of the UTF-8 bytes of
--    the string as sent, no trim (the caller trims once, before hashing). The
--    table's CHECK `market_rule_texts_hash_confere` would refuse a lying text on
--    insert, but a duplicate never reaches the insert, so the check is here too.
-- 2. The key `(event_id, description_sha256, model, prompt_version, leitura_n)`.
--    When it exists the function writes nothing and answers 'duplicate', or
--    'incomplete' when the payload carries traps or ambiguities and the stored
--    reading has none of that kind: the state the manual loader leaves when it
--    dies between inserts (it inserts each child table in one statement, so a
--    table is either complete or empty). 'incomplete' is not repaired here:
--    repairing stored data is the owner's decision.
-- 3. The writes. The text with `on conflict do nothing` (one text serves many
--    markets), the digest with `on conflict do nothing` on the unique key, then
--    the children. Two callers with the same key both miss in step 2; the second
--    insert waits on the unique index for the first transaction, then does
--    nothing, and the function looks the key up again, now committed, and
--    answers as in step 2. Exactly one caller gets 'inserted'.
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
  v_missing text[];
  v_text public.market_rule_texts;
  v_digest public.market_rule_digests;
  v_digest_id uuid;
begin
  -- Each table's columns are written three times below: in this key list, in
  -- the insert column list and in the select list of its insert. The three
  -- change together; a column left out of one of them is the silent drop this
  -- check exists to prevent.
  with expected (part, keys) as (
    values
      ('p_text', array['description_sha256', 'description', 'guardado_por']),
      ('p_digest', array[
        'event_id', 'description_sha256', 'leitura_n', 'resolve_sim', 'resolve_nao',
        'fonte', 'prazo', 'anula_se', 'model', 'prompt_version', 'tokens_input',
        'tokens_output', 'tokens_cache_read', 'tokens_cache_write', 'cost_usd', 'latency_ms'
      ]),
      ('p_pegadinhas', array['ordinal', 'texto', 'severidade', 'trecho', 'cenario']),
      ('p_ambiguidades', array[
        'ordinal', 'tipo', 'trecho', 'trecho_conflito', 'leitura_a', 'leitura_b'
      ])
  ),
  objects (part, obj) as (
    select 'p_text', p_text
    union all
    select 'p_digest', p_digest
    union all
    select 'p_pegadinhas', e from jsonb_array_elements(p_pegadinhas) e
    union all
    select 'p_ambiguidades', e from jsonb_array_elements(p_ambiguidades) e
  )
  select
    (select array_agg(distinct o.part || '.' || k order by o.part || '.' || k)
       from objects o
       join expected x using (part)
       cross join lateral jsonb_object_keys(o.obj) k
      where k <> all (x.keys)),
    (select array_agg(distinct o.part || '.' || k order by o.part || '.' || k)
       from objects o
       join expected x using (part)
       cross join lateral unnest(x.keys) k
      where not (o.obj ? k))
    into v_unknown, v_missing;

  if v_unknown is not null then
    raise exception 'record_rule_digest: chaves sem coluna no payload: %', v_unknown;
  end if;
  if v_missing is not null then
    raise exception 'record_rule_digest: chaves ausentes no payload: %', v_missing;
  end if;

  v_text := jsonb_populate_record(null::public.market_rule_texts, p_text);
  v_digest := jsonb_populate_record(null::public.market_rule_digests, p_digest);

  -- One reading, one text.
  if v_text.description_sha256 is distinct from v_digest.description_sha256 then
    raise exception 'record_rule_digest: hash do texto (%) difere do hash da digestao (%)',
      v_text.description_sha256, v_digest.description_sha256;
  end if;
  if encode(sha256(convert_to(v_text.description, 'UTF8')), 'hex')
       is distinct from v_text.description_sha256 then
    raise exception 'record_rule_digest: descricao nao bate com o hash %',
      v_text.description_sha256;
  end if;

  select d.id
    into v_digest_id
    from public.market_rule_digests d
   where d.event_id = v_digest.event_id
     and d.description_sha256 = v_digest.description_sha256
     and d.model = v_digest.model
     and d.prompt_version = v_digest.prompt_version
     and d.leitura_n = v_digest.leitura_n;

  if v_digest_id is null then
    -- The text first: market_rule_digests_texto_guardado points at it.
    insert into public.market_rule_texts (description_sha256, description, guardado_por)
    values (v_text.description_sha256, v_text.description, v_text.guardado_por)
    on conflict (description_sha256) do nothing;

    insert into public.market_rule_digests (
      event_id, description_sha256, leitura_n, resolve_sim, resolve_nao, fonte, prazo, anula_se,
      model, prompt_version, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
      cost_usd, latency_ms
    )
    values (
      v_digest.event_id, v_digest.description_sha256, v_digest.leitura_n, v_digest.resolve_sim,
      v_digest.resolve_nao, v_digest.fonte, v_digest.prazo, v_digest.anula_se, v_digest.model,
      v_digest.prompt_version, v_digest.tokens_input, v_digest.tokens_output,
      v_digest.tokens_cache_read, v_digest.tokens_cache_write, v_digest.cost_usd,
      v_digest.latency_ms
    )
    on conflict on constraint market_rule_digests_one_per_text_model_and_reading do nothing
    returning id into v_digest_id;

    if v_digest_id is not null then
      insert into public.digest_pegadinhas (digest_id, ordinal, texto, severidade, trecho, cenario)
      select v_digest_id, p.ordinal, p.texto, p.severidade, p.trecho, p.cenario
        from jsonb_populate_recordset(null::public.digest_pegadinhas, p_pegadinhas) p;

      insert into public.digest_ambiguidades (
        digest_id, ordinal, tipo, trecho, trecho_conflito, leitura_a, leitura_b
      )
      select v_digest_id, a.ordinal, a.tipo, a.trecho, a.trecho_conflito, a.leitura_a,
             a.leitura_b
        from jsonb_populate_recordset(null::public.digest_ambiguidades, p_ambiguidades) a;

      return 'inserted';
    end if;

    -- Lost the race: another transaction committed the same key while this one
    -- waited on the unique index. A new statement sees its row.
    select d.id
      into v_digest_id
      from public.market_rule_digests d
     where d.event_id = v_digest.event_id
       and d.description_sha256 = v_digest.description_sha256
       and d.model = v_digest.model
       and d.prompt_version = v_digest.prompt_version
       and d.leitura_n = v_digest.leitura_n;

    if v_digest_id is null then
      raise exception 'record_rule_digest: a chave conflitou e sumiu antes de ser lida';
    end if;
  end if;

  if (jsonb_array_length(p_pegadinhas) > 0
        and not exists (select 1 from public.digest_pegadinhas p where p.digest_id = v_digest_id))
     or (jsonb_array_length(p_ambiguidades) > 0
        and not exists (select 1 from public.digest_ambiguidades a where a.digest_id = v_digest_id))
  then
    return 'incomplete';
  end if;

  return 'duplicate';
end;
$function$;

comment on function public.record_rule_digest(jsonb, jsonb, jsonb, jsonb) is
  'One digest reading (text, digest, traps, ambiguities) in one transaction. Returns inserted; duplicate when the five-column key already exists; incomplete when it exists without the traps or ambiguities the payload carries. Only inserted writes anything. Missing or unknown payload keys raise, and so does a text that does not hash to its description_sha256. Called by src/digest/persist.ts. Issue 88.';

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
