-- Prefixos coletados de propósito sem vertical habilitada, e o contador de
-- órfãos que continua medindo sem alertar.
--
-- ---------------------------------------------------------------------------
-- O que a detecção pegou, e por que ela sozinha estava errada
-- ---------------------------------------------------------------------------
--
-- O resolver passou a comparar `system_config.discovery_slug_prefixes` contra
-- `verticals.enabled` e a avisar quando um prefixo é coletado sem ninguém para
-- linkar. O caso que ela pegou — `lol-` e `dota2-` entrando em `events` sem
-- vertical — é REAL: aqueles mercados nascem órfãos e o varredor nem os enxerga.
--
-- Só que ele também é DECISÃO. `lol-` e `dota2-` são coletados de propósito,
-- para acumular série temporal desde já; a análise fica em `cs2-` porque é o
-- domínio que o dono consegue julgar. A expansão para LoL, Dota, futebol e
-- possivelmente outras categorias está no plano, então esse estado não é
-- transitório: ele se repete a cada vertical nova, e o intervalo entre "começar
-- a coletar" e "habilitar a vertical" é medido em meses, por escolha.
--
-- Um aviso que dispara para sempre por um estado esperado não informa nada. Pior
-- que isso: ele treina o leitor a ignorar a linha, e junto com ela some a
-- capacidade de notar o dia em que o prefixo NÃO era esperado — alguém acrescenta
-- `valorant-` à descoberta, esquece a vertical, e o aviso já não é lido.
--
-- Daí esta coluna. O detector continua existindo e continua sendo o único que
-- enxerga esse buraco; o que muda é que ele passa a ter como distinguir o
-- prefixo declarado do prefixo esquecido.
--
--   em discovery_slug_prefixes + vertical habilitada        -> normal
--   em discovery_slug_prefixes + declarado aqui             -> normal, contado
--   em discovery_slug_prefixes + nem habilitado nem aqui    -> AVISO, partial
--
-- A declaração é o ato explícito que separa os dois últimos. Custa um UPDATE de
-- uma linha e é exatamente a informação que o código não tem como inferir.

alter table system_config
  add column if not exists collect_only_prefixes text[] default '{lol-,dota2-}';

comment on column system_config.collect_only_prefixes is
  'Prefixos de slug coletados DE PROPOSITO sem vertical habilitada em verticals, para acumular serie temporal antes de analisar. O resolver conta os orfaos deles, mas nao avisa nem rebaixa o ciclo para partial. Prefixo coletado que nao esta aqui nem habilitado e esquecimento, e continua virando aviso.';

-- O default reproduz a decisão de hoje: `lol-` e `dota2-` são o seed de
-- `verticals` com `enabled = false` (20260806183705) e estão em
-- `discovery_slug_prefixes` desde a 20260804163956. Sem o default, aplicar esta
-- migration não silenciaria nada — a coluna nasceria vazia e o aviso continuaria
-- disparando até alguém rodar o UPDATE.
--
-- Habilitar a vertical depois NÃO exige tirar o prefixo daqui: a classificação
-- olha `verticals.enabled` primeiro, e prefixo habilitado nunca chega ao ramo do
-- aviso. A declaração fica obsoleta em silêncio, sem efeito.

-- ---------------------------------------------------------------------------
-- O contador de órfãos por prefixo
-- ---------------------------------------------------------------------------
--
-- Silenciar o aviso não pode significar parar de medir. O volume dos declarados
-- é justamente o que se quer ver acumulando — é a série que motivou coletá-los,
-- e é o número que dirá se habilitar a vertical vale o trabalho.
--
-- Órfão aqui é literal: event cujo slug casa o prefixo e que não tem linha em
-- `market_match_links`. Para prefixo sem vertical habilitada isso hoje é todo
-- event do prefixo, mas a definição não assume: uma vertical desligada depois de
-- ter rodado deixa links para trás, e um contador que os ignorasse mentiria
-- exatamente no caso em que o número mais importa.
--
-- ---------------------------------------------------------------------------
-- Por que uma função, e não um count pelo PostgREST
-- ---------------------------------------------------------------------------
--
-- Duas razões, e a segunda é a que pesa.
--
-- A primeira: o anti-join contra `market_match_links` não se expressa em
-- PostgREST. Um `count` de `events` por prefixo mediria "events do prefixo", que
-- só por acaso coincide com "órfãos".
--
-- A segunda é a lição da 20260807230005, e é o motivo do SQL dinâmico abaixo. A
-- otimização de prefixo do Postgres (`match_pattern_prefix`, que reescreve
-- `slug LIKE 'lol-%'` em `slug ~>=~ 'lol-' AND slug ~<~ 'lol.'`) SÓ dispara com
-- pattern constante. Com o pattern vindo de variável de plpgsql — Param no plano
-- cacheado — ela não dispara, `idx_events_slug_prefix (slug text_pattern_ops)`
-- fica sem uso, e o que sobra é seq scan dos 711 MB de `events` a cada chamada.
-- `format(%L)` é o que transforma a variável em Const e devolve o índice ao
-- planner. Um prefixo, um index range scan.
--
-- Injeção: os prefixos chegam do servidor, não de usuário, mas a função é
-- SECURITY DEFINER e `%L` sozinho não é argumento suficiente para uma função com
-- esse poder. Daí o CHECK de vocabulário explícito antes de formatar — o mesmo
-- `[a-z0-9_-]` que `safeSlugPrefixes` aplica do lado do Node (src/lib/
-- slug-prefixes.ts). Prefixo fora disso é bug ou ataque, e nos dois casos a
-- resposta certa é exceção, não contagem.
--
-- Direção do erro: a função levanta exceção em vez de devolver 0 ou pular. O
-- chamador trata falha como "não medi agora" e mantém a última contagem com o
-- carimbo de quando foi feita. Um zero inventado seria indistinguível de "parou
-- de acumular", que é a única leitura que este número não pode dar errada.

create or replace function public.orphan_events_by_prefix (prefixes text[])
  RETURNS TABLE (prefix text, orphans bigint)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $function$
DECLARE
  p text;
  n bigint;
BEGIN
  -- Teto de sanidade. A lista real tem 1 ou 2 elementos; dezenas significam
  -- config corrompida, e cada elemento é uma varredura de índice.
  IF coalesce(array_length(prefixes, 1), 0) > 20 THEN
    RAISE EXCEPTION 'orphan_events_by_prefix: % prefixos, esperado no maximo 20',
      array_length(prefixes, 1);
  END IF;

  FOREACH p IN ARRAY coalesce(prefixes, ARRAY[]::text[]) LOOP
    IF p !~ '^[a-z0-9_-]+$' THEN
      RAISE EXCEPTION 'orphan_events_by_prefix: prefixo fora de [a-z0-9_-]: %', p;
    END IF;

    -- `%L` sobre `p || '%'`: o pattern entra no plano como constante, que é o
    -- que mantém `idx_events_slug_prefix` em uso. Ver a nota acima.
    --
    -- O anti-join é sondagem de PK em `market_match_links` (event_id é a PK,
    -- 20260806183705) por linha do range — barato porque o range é pequeno: são
    -- os prefixos SEM vertical habilitada, nunca `cs2-`, que é onde estão os
    -- 21,6k events já linkados.
    EXECUTE format(
      'SELECT count(*)
         FROM public.events e
        WHERE e.slug LIKE %L
          AND NOT EXISTS (
                SELECT 1 FROM public.market_match_links l WHERE l.event_id = e.id
              )',
      p || '%'
    ) INTO n;

    prefix := p;
    orphans := n;
    RETURN NEXT;
  END LOOP;
END;
$function$;

comment on function public.orphan_events_by_prefix(text[]) is
  'Conta events por prefixo de slug sem linha em market_match_links. Chamada pelo esports_resolver para medir o volume dos prefixos coletados sem vertical habilitada — inclusive os declarados em system_config.collect_only_prefixes, que sao medidos sem virar alerta. SQL dinamico e deliberado: pattern constante e o que mantem idx_events_slug_prefix em uso (ver 20260807230005).';

revoke all on function public.orphan_events_by_prefix(text[]) from public, anon, authenticated;

grant execute on function public.orphan_events_by_prefix(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- Verificação depois do apply, antes de confiar
-- ---------------------------------------------------------------------------
--
--   select collect_only_prefixes from system_config where id = 1;
--     -> {lol-,dota2-}
--
--   explain (analyze, buffers) select * from public.orphan_events_by_prefix(
--     array['lol-','dota2-']);
--     -> no plano de cada EXECUTE tem que aparecer Index Scan ou Bitmap Index
--        Scan em idx_events_slug_prefix. Seq Scan em `events` significa que a
--        otimização de prefixo não disparou, e a função ficou cara o bastante
--        para valer a pena rever.
--
-- O código roda antes deste apply: sem a coluna, o fallback de src/lib/config.ts
-- declara os mesmos {lol-,dota2-}; sem a função, o resolver registra
-- `orphans_by_prefix: null` e segue — sem erro e sem rebaixar o ciclo.
