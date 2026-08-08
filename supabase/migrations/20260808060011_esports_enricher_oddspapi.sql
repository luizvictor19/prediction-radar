-- Enricher da OddsPapi — as duas colunas de config, e só elas.
--
-- Nenhuma tabela nova, nenhum dado migrado. A memoização da fixture mora em
-- `esports_matches.external_ids`, que já é jsonb e já existe desde a
-- 20260806183705 ("Ids de fontes que ainda nao temos") — as chaves
-- `oddspapi_fixture_id`, `oddspapi_aliases_a/b` e `oddspapi_missing_at` entram
-- lá sem alterar coluna nenhuma.
--
-- ---------------------------------------------------------------------------
-- Por que o default é `false`
-- ---------------------------------------------------------------------------
--
-- Terceiro componente do sistema a nascer desligado, e por uma razão que os dois
-- anteriores não tinham inteira: **o tier gratuito é cortesia**.
--
--   250 requisições billable por mês. `/v4/historical-odds` é declarado livre
--   pela doc, e é isso que torna o enricher viável — mas a descoberta
--   (`/v4/fixtures`) não é, e não existe contador observável: medido, o
--   `/v4/account` deles não traz cota no corpo nem em header. O orçamento que o
--   código mantém é ESTIMATIVA do processo, não leitura da fonte.
--
--   Acesso desse tipo some sem aviso. O cliente trata 401/402/403 como estado
--   (silêncio por 6h), não como erro de chamada — mas nada disso é motivo para o
--   componente se ligar sozinho num deploy e começar a gastar cortesia alheia.
--
-- Além desta flag, o enricher exige `ODDSPAPI_API_KEY` no ambiente. Sem ela,
-- ligar aqui não faz requisição nenhuma sair — só produz um aviso por hora. Duas
-- trancas, como na Liquipedia: a config diz "eu quero", o ambiente diz "eu posso".

alter table public.system_config
  add column if not exists esports_enricher_oddspapi_enabled boolean not null default false;

comment on column public.system_config.esports_enricher_oddspapi_enabled is
  'Liga o enricher oddspapi (linha das casas de aposta, para comparar com o preco do Polymarket). Default false: fonte externa, tier gratuito de cortesia com 250 req/mes billable e sem contador observavel, acesso cortavel sem aviso. Exige tambem ODDSPAPI_API_KEY no ambiente — sem ela, ligar aqui nao faz requisicao nenhuma sair.';

-- ---------------------------------------------------------------------------
-- As casas, e por que bet365 não está no default
-- ---------------------------------------------------------------------------
--
-- `/v4/historical-odds` aceita no máximo TRÊS casas por chamada. Então a lista
-- não é preferência, é orçamento de amostra — cada vaga gasta é um terço do que
-- se vai saber sobre a partida.
--
-- O que a sonda mediu numa fixture de CS2 (2026-08-08):
--
--   pinnacle    3.487 movimentos de linha, `limit` preenchido em 3487/3487
--   stake         102 movimentos, `limit` null em TUDO
--   bet365          0 movimentos — apesar de ENTITULADA no plano
--
-- bet365 fica de fora por essa medição, não por juízo sobre a casa: pedir quem
-- devolve zero é perder uma das três vagas. `ggbet` entra no lugar por ser
-- especialista em esports (costuma ter mercado onde a mainstream não tem), e
-- entra sem medição própria — se ela também vier vazia, o lugar dela é de quem
-- aparecer no `coverage` do fragmento.
--
-- A assimetria de densidade é dado, não defeito, e o enricher a trata assim:
-- casa ausente da resposta é NORMAL e vai para `coverage.absent`, nunca para
-- erro. O consenso é mediana SEM peso justamente porque só a Pinnacle reporta
-- `limit` — ponderar por ele produziria um número com cara de agregado que é
-- Pinnacle pura.

alter table public.system_config
  add column if not exists oddspapi_bookmakers text[] not null default '{pinnacle,stake,ggbet}';

comment on column public.system_config.oddspapi_bookmakers is
  'Casas pedidas ao /v4/historical-odds. A API aceita no maximo 3 por chamada; o que passar disso e ignorado pelo enricher. bet365 esta fora do default por medicao: devolveu zero movimento apesar de entitulada.';

-- ---------------------------------------------------------------------------
-- O mercado lido, e por que ele é config
-- ---------------------------------------------------------------------------
--
-- A resposta traz `bookmakers.{casa}.markets.{id}.outcomes.{id}.players.{id}[]`
-- — mapas encadeados, ids como chave, e NENHUM nome em nível nenhum (3.589
-- entradas medidas, zero com nome de outcome).
--
-- Medido numa fixture de CS2: a Pinnacle devolve 7 mercados (171, 173, 1725,
-- 1737, 1747, 1749, 1751), a Stake devolve 4. O `171` é o moneyline — o mais
-- denso (688+689 entradas) e o único comparável com o mercado do Polymarket.
-- Ler todos daria uma "linha" que é a última entrada de qualquer mercado,
-- handicap de mapa e total de rounds incluídos, comparada com o moneyline de
-- lá. Sem sentido, e sem sintoma.
--
-- É config e não constante porque a taxonomia é DELES e não está documentada:
-- `/v4/markets` não foi sondado. Se o número mudar, muda um UPDATE — e o
-- `coverage.marketsSeen` de cada fragmento é o que denuncia o dia em que mudar.

alter table public.system_config
  add column if not exists oddspapi_market_id text not null default '171';

comment on column public.system_config.oddspapi_market_id is
  'Mercado lido na taxonomia da OddsPapi. 171 = moneyline, por medicao (o mais denso e o unico comparavel com o mercado do Polymarket). A resposta traz 7 mercados por fixture de CS2 na Pinnacle; ler todos misturaria handicap de mapa com moneyline.';

-- ---------------------------------------------------------------------------
-- O que este enricher NÃO faz, e precisa estar registrado onde alguém veja
-- ---------------------------------------------------------------------------
--
-- `supportsPointInTime = false` — e aqui, ao contrário da Liquipedia, NÃO é por
-- defeito conhecido.
--
-- A Liquipedia é `false` porque a wiki é editada retroativamente por desenho.
-- A OddsPapi pode muito bem ser imutável: `/v4/historical-odds` traz `createdAt`
-- por entrada, que é exatamente o que uma série point-in-time precisa. O que
-- falta é GARANTIA de que o que está gravado naquele carimbo continua o mesmo
-- daqui a semanas. A doc não promete, e a pergunta feita no Discord deles não
-- voltou.
--
-- **A medição está pendente e já começou**: o snapshot de uma fixture encerrada
-- foi gravado com `npm run oddspapi:probe -- --fixture=<id> --snapshot`. O
-- `--compare` daqui a duas semanas responde com evidência própria. O critério
-- exato que vira a flag está em `specs/001-esports-vertical.md`, Parte D.
--
-- Enquanto isso, `false` é a direção segura do erro: um `true` errado faz o
-- backtest ler uma série que não é a de então e acertar por engano — sem
-- sintoma. Um `false` errado só custa cobertura.
--
-- Isso não bloqueia o enricher: ele coleta, grava e serve a análise em tempo
-- real normalmente. `false` o mantém fora de UMA coisa, o replay do eval.
--
-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   select esports_enricher_oddspapi_enabled, oddspapi_bookmakers, oddspapi_market_id
--     from system_config where id = 1;
--     -> false, {pinnacle,stake,ggbet}, 171
--
-- O código roda antes deste apply: sem as colunas, o fallback de
-- `src/lib/config.ts` desliga o enricher e repete os mesmos valores.
--
-- ---------------------------------------------------------------------------
-- Uma suposição, e onde ela está declarada
-- ---------------------------------------------------------------------------
--
-- Como a resposta não traz nome de time, o lado de cada cotação sai da ORDEM dos
-- ids de outcome: o menor é o `participant1` da fixture, o maior é o
-- `participant2`. Está medido que cada mercado tem 2 outcomes com ids
-- consecutivos e que os ids são globais (o 171 é o mesmo nas duas casas); NÃO
-- está medido que o menor é o participant1.
--
-- O fragmento declara isso em `payload.side_source = 'outcome_order'` e no
-- `summary`, para que nada a jusante confunda suposição com fato. Confirmar é
-- barato: `npm run oddspapi:probe -- --fixture=<id>` imprime a fixture crua com
-- `participant1Name`/`participant2Name`; basta uma partida de favorito claro.
