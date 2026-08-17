-- `system_config` passa a dizer o que já está gravado: `deepseek-v4-flash`/`v4`.
--
-- ---------------------------------------------------------------------------
-- A divergência, e por que ela não era inofensiva
-- ---------------------------------------------------------------------------
--
-- Medido em 17/08/2026, antes desta migration:
--
--   system_config (id=1)          deepseek-v4-flash / v1
--   market_rule_digests (728/728) deepseek-v4-flash / v4
--
-- O modelo já batia. A versão do prompt não: a passada do degrau 3 rodou com
-- `--prompt=v4` no argumento e ninguém voltou para mexer na config. Ela ficou
-- apontando para a v1 — um prompt que não pede tipo de ambiguidade, não pede
-- severidade e não pede trecho, e cujas linhas o `digest_achados_por_mercado`
-- descarta por não terem âncora.
--
-- Config que discorda do que está gravado não erra sozinha: ela erra no
-- PRÓXIMO comando de quem confiar nela. `digerir-regras` lê
-- `digest_prompt_version` como default, então um `npm run digerir` sem
-- `--prompt=` rodaria a v1 sobre um banco inteiro de v4 — e, como
-- `prompt_version` está na chave, essas linhas entrariam LIMPAS, sem colidir
-- com nada, sob os mesmos textos. Ninguém veria erro nenhum.
--
-- Foi assim que este defeito apareceu: o `nivelar-leituras` foi escrito lendo a
-- config, o `--dry-run` imprimiu `prompt: v1`, e o que ia acontecer era reler em
-- v1 os textos que foram lidos em v4. O script foi consertado para perguntar às
-- LINHAS em vez de à config (ver `src/digest/leituras.ts`, campo
-- `combinacoes`). Esta migration conserta o outro lado: a config deixa de ser a
-- resposta errada.
--
-- ---------------------------------------------------------------------------
-- O que muda no comportamento
-- ---------------------------------------------------------------------------
--
-- Uma coisa só: o default de `npm run digerir` sem `--prompt=` passa a ser v4.
-- É o que se quer — a v4 é a versão corrente, e o argumento de linha de comando
-- deixa de ser obrigatório para acertar.
--
-- O que NÃO muda:
--
--   - as 728 linhas gravadas. `prompt_version` é gravado por linha, e linha
--     antiga continua dizendo com o que foi feita. Este UPDATE não as toca.
--   - o `nivelar-leituras`, que deriva modelo e versão das linhas e ignora esta
--     config de propósito. Ele continua ignorando depois desta migration — o
--     conserto aqui não substitui o de lá, porque a config volta a poder
--     divergir no dia em que existir uma v5.
--   - `digest_model`, que já era `deepseek-v4-flash`. Vai no UPDATE mesmo
--     assim: a migration declara o par inteiro, e um comando que só escreve
--     metade do estado esperado deixa a outra metade dependendo de história.
--
-- ---------------------------------------------------------------------------
-- Por que um bloco e não um UPDATE solto
-- ---------------------------------------------------------------------------
--
-- `update ... where id = 1` que não acha linha nenhuma SUCEDE. Zero linhas
-- afetadas não é erro em SQL, e um `db push` verde sobre uma config intocada é
-- exatamente o modo de falha que este projeto já viu duas vezes esta semana —
-- a migration que roda verde enquanto falha.
--
-- Aqui não dá para isso acontecer em silêncio: se o UPDATE não pegar
-- exatamente uma linha, a migration levanta exceção e o push para.

do $$
declare
  afetadas integer;
begin
  update public.system_config
     set digest_model          = 'deepseek-v4-flash',
         digest_prompt_version = 'v4'
   where id = 1;

  get diagnostics afetadas = row_count;

  if afetadas <> 1 then
    raise exception
      'system_config: esperava atualizar 1 linha (id=1), atualizou %. A config nao foi mudada.',
      afetadas;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- 1. a config diz v4
--   select id, digest_model, digest_prompt_version
--     from public.system_config where id = 1;
--
--   -- 2. e agora concorda com o que está gravado. As duas colunas desta
--   --    consulta têm que ser iguais às da consulta acima, e a contagem tem
--   --    que ser 728 numa linha só — mais de uma linha aqui significa que o
--   --    banco tem digestões de mais de uma versão, e aí a pergunta "com o que
--   --    o proximo comando roda" volta a ter mais de uma resposta razoável.
--   select model, prompt_version, count(*)
--     from public.market_rule_digests
--    group by model, prompt_version
--    order by count(*) desc;
--
--   -- 3. o dry-run do nivelamento para de imprimir a NOTA de divergência:
--   --      npm run nivelar -- --dry-run
