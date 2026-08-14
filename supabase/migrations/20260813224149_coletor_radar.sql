-- O coletor do radar: a flag que o liga, os critérios de COLETA e as duas
-- colunas que passaram a ser gravadas em vez de filtrar.
--
-- ---------------------------------------------------------------------------
-- O princípio, que decide quase tudo sozinho
-- ---------------------------------------------------------------------------
--
--   Filtra na COLETA o que NÃO muda. Filtra na VIEW o que muda.
--
-- Categoria de um mercado não muda. Preço muda o tempo todo — e filtrar por
-- preço faz o mercado sair do roster exatamente quando se move, que é o evento
-- que esta frente existe para estudar. Por isso a faixa de preço, o piso de
-- volume e o teto por assunto NÃO estão nesta migration: eles eram porta e
-- viraram `where` na view, que é outra rodada.
--
-- O contexto que justifica: o pipeline de esports foi construído inteiro em
-- cima de uma tese, a tese morreu, e nada daquilo serviu para outra coisa.
-- Série bruta sobrevive à morte da tese; série filtrada pela tese, não.
--
-- O código já está em `src/collectors/radar-collector.ts` e sobe antes deste
-- apply: sem estas colunas ele lê os fallbacks de `src/lib/config.ts`, e o
-- primeiro deles — `radar_collector_enabled = false` — o mantém parado. Ou
-- seja, deployar não liga nada, e aplicar esta migration também não.
--
-- ---------------------------------------------------------------------------
-- Por que a flag nasce `false`, e o que custa ligá-la
-- ---------------------------------------------------------------------------
--
-- Porque a série do radar é PERMANENTE. `radar_tracked` (migration
-- 20260813210119) isenta o mercado marcado dos dois ramos da retenção — nem por
-- idade, nem por resolução. Cada mercado que entra no roster vira armazenamento
-- que ninguém mais poda.
--
-- A ordem de grandeza, com os defaults abaixo (300 mercados, foto a cada 15
-- min): 28,8 mil linhas/dia, ~10,5 milhões/ano. `polymarket_snapshots` tem ~96
-- mil linhas hoje, e **não é particionada** — ver a seção do teto.
--
-- Isso não é argumento contra ligar: é o preço da frente, escolhido de olho
-- aberto. É argumento contra ligar por acidente. Ligar é:
--
--   update public.system_config set radar_collector_enabled = true where id = 1;
--
-- ---------------------------------------------------------------------------
-- 1. A flag
-- ---------------------------------------------------------------------------

alter table public.system_config
  add column if not exists radar_collector_enabled boolean not null default false;

comment on column public.system_config.radar_collector_enabled is
  'Liga o coletor do radar (src/collectors/radar-collector.ts). Nasce false: a serie dele e isenta da retencao, entao ligar e assumir armazenamento permanente. O cron continua ticando; o componente sai na primeira linha e registra que esta desligado.';

-- ---------------------------------------------------------------------------
-- 2. As CATEGORIAS — o filtro de coleta que sobrevive ao princípio
-- ---------------------------------------------------------------------------
--
-- Categoria é propriedade estável: um mercado sobre o Fed não vira mercado sobre
-- a Champions League. Por isso ela pode ser porta sem cometer o defeito.
--
-- A lista é deliberadamente MAIS LARGA que a tese de hoje, e a razão é que
-- histórico não se recupera: um mercado que só passa a interessar em novembro
-- precisa ter sido coletado desde agosto, e a API não devolve orderbook
-- histórico. O que se economiza estreitando é armazenamento; o que se perde é
-- irreversível.
--
--   ia-e-tecnologia          ai, tech
--   brasil                   brazil
--   macro-e-mercados         economy, finance, business, crypto
--   geopolitica-e-conflitos  geopolitics, world
--   eleicoes-e-politica      elections, politics   <- inclusive as que o dono não acompanha
--   esporte-de-temporada     sports                <- título, artilheiro, rebaixamento
--
-- O formato é `{"categoria": ["tag", ...]}` porque as duas pontas importam: a
-- categoria é vocabulário nosso (vai para `events.radar_tema` e para o
-- relatório); a tag é o que a Gamma entende.
--
-- Três armadilhas medidas em 2026-08-13, todas silenciosas:
--
--   1. `/markets` só entende `tag_id`. `tag_slug` ali é ACEITO E IGNORADO —
--      devolve a mesma página que a chamada sem filtro nenhum. O coletor
--      resolve slug -> id em `/tags/slug/{slug}` antes de paginar.
--   2. `volume_24hr_min` também é aceito e ignorado. Não faz falta: o piso de
--      volume saiu da coleta. `liquidity_num_min` funciona.
--   3. Sem `order=liquidityNum&ascending=false`, quatro das doze tags saturam o
--      teto de offset 2000 (crypto, elections, politics e sports devolvem 2100
--      markets na janela de 180 dias) — o universo vinha truncado numa ordem que
--      a Gamma não promete, e custava 155 chamadas / 107 MB por renovação. Com a
--      ordenação, a renovação inteira custa ~40 chamadas.
--
-- ESPORTS fica de fora, e é decisão desta rodada: CS2, LoL e Dota saíram da
-- coleta (ver a migration do desligamento). Nenhuma tag deles está aqui, e o
-- coletor ainda descarta por prefixo de slug — na medição isso pegou 16 markets
-- que chegaram por tag de tecnologia.

alter table public.system_config
  add column if not exists radar_temas jsonb not null default
    '{"ia-e-tecnologia": ["ai", "tech"],
      "brasil": ["brazil"],
      "macro-e-mercados": ["economy", "finance", "business", "crypto"],
      "geopolitica-e-conflitos": ["geopolitics", "world"],
      "eleicoes-e-politica": ["elections", "politics"],
      "esporte-de-temporada": ["sports"]}'::jsonb;

comment on column public.system_config.radar_temas is
  'Categorias que o radar coleta: {"categoria": ["tag da Gamma", ...]}. Categoria e propriedade estavel, e por isso e criterio de coleta; ela vai gravada em events.radar_tema. A lista e mais larga que a tese de hoje de proposito — historico nao se recupera. Tag desconhecida vira aviso no log, nao lista vazia em silencio.';

-- ---------------------------------------------------------------------------
-- 3. Os critérios de coleta que sobraram
-- ---------------------------------------------------------------------------
--
--   prazo até 180 dias   Evita fotografar por dois anos um mercado de 2028. NÃO
--                        existe prazo MÍNIMO, e a ausência é a decisão: o piso
--                        de 7 dias da versão anterior tirava do roster todo
--                        mercado na semana da resolução, que é quando a notícia
--                        decide o desfecho e o preço se mexe mais.
--
--   liquidez >= 500      Piso de DOWNLOAD, não critério de tese. Sem algum piso
--                        o universo baixado é o Polymarket inteiro. Ele só
--                        decidiria alguma coisa se o corte do teto encostasse
--                        nele — na medição de hoje o corte mais baixo é 36 mil,
--                        setenta vezes acima. O `--dry-run` imprime os dois
--                        números lado a lado justamente para isso.
--
--   não é mercado    `sportsMarketType` é propriedade ESTÁVEL — um mercado é de
--   de partida         partida ou não é, e isso não muda na vida dele —, então o
--                      filtro cabe na coleta sem violar o princípio. Ele existe porque o teto de 180 dias
--                      NÃO separa jogo de temporada: jogo marcado para daqui a
--                      oito dias cai dentro da janela, e medido, 24 das 50 vagas
--                      de esporte eram jogo único. Jogo resolve em três horas e
--                      não reage a manchete. Fica temporada: título, artilheiro,
--                      rebaixamento, Bola de Ouro, campeão de F1.
--                      `gameStartTime` NÃO entra no filtro, e isso é medição e
--                      não descuido: ele aparece 104 vezes fora de esporte (61
--                      no WTI Crude, 21 em política, 19 em geopolítica), enquanto
--                      `sportsMarketType` aparece ZERO vezes fora dela.
--                      Sem coluna de config: é regra de código
--                      (`ehMercadoDePartida`), e o que o `--dry-run` e o
--                      relatório de categorias mostram é quanto ela descarta.
--
-- Ficam de fora, e cada um por um motivo que é o mesmo princípio: preço, volume
-- 24h, tamanho da descrição e teto por assunto. Todos mudam com o tempo.

alter table public.system_config
  add column if not exists radar_horizon_max_days integer not null default 180,
  add column if not exists radar_min_liquidity numeric(14,2) not null default 500;

comment on column public.system_config.radar_min_liquidity is
  'Piso de liquidez do DOWNLOAD (Gamma liquidity_num_min), nao criterio de tese. Existe para nao baixar o Polymarket inteiro. So decide algo se o corte do teto encostar nele — comparar os dois no --dry-run.';

-- ---------------------------------------------------------------------------
-- 4. O teto — e por que ele é POR CATEGORIA
-- ---------------------------------------------------------------------------
--
-- Teto é custo, não tese. O que ele responde é "quanto disso cabe no disco e na
-- API", e a régua para cortar é liquidez: o mercado quieto de hoje é o que
-- explode amanhã com uma notícia, então cortar por VOLUME perderia justamente
-- as primeiras horas da reação (a renovação é de 6h — quando ele voltasse, o
-- interessante já teria passado). Liquidez diz que existe mercado ali, sem
-- dizer nada sobre o que aconteceu nas últimas 24h.
--
-- Por categoria, e isso saiu de medição. Com ranking GLOBAL de liquidez sobre o
-- universo de hoje, um teto de 400 devolve:
--
--   esporte 208 | eleições 92 | macro 48 | geopolítica 39 | brasil 18 | IA 15
--
-- O ranking global não é neutro: ele é uma opinião sobre qual categoria importa,
-- ditada pelo tamanho do livro médio de cada uma — e a opinião que ele expressa
-- é o contrário da lista de categorias acima. Aplicar a MESMA régua dentro de
-- cada categoria mantém o teto sendo custo.
--
-- Os quatro números que fixam o 50, medidos em 2026-08-13:
--
--   1. QUANTOS PASSAM. 1.465 mercados passam nos critérios entre os ~2.600
--      baixados (e o universo viável inteiro, sem o recorte de liquidez do
--      download, é de pelo menos 9,4 mil). Ou seja: o teto é o que decide o
--      tamanho, não a regra.
--
--   2. CUSTO DE API. O `POST /books` da CLOB aceita pelo menos 500 tokens por
--      chamada (medido: 1.284 KB, 850 ms) e o coletor usa 250 por margem. Uma
--      foto de 300 mercados custa 3 chamadas à Gamma + 2 à CLOB = 5. A 96 fotos
--      por dia são 480 chamadas, mais ~160 das quatro renovações. Para 1.000
--      mercados seriam 14 por foto, 1.344/dia — ainda longe de abusivo, mas o
--      gargalo não é este.
--
--   3. LINHAS POR DIA. 300 mercados x 96 fotos = 28,8 mil linhas/dia, 10,5
--      milhões/ano. Com 500 seriam 48 mil/dia (17,5 M/ano); com 1.000, 96
--      mil/dia (35 M/ano).
--
--   4. PARTIÇÃO. `polymarket_snapshots` **NÃO é particionada** — foi criada como
--      tabela comum na 001 e nenhuma migration a converteu. `esports_snapshots`
--      existe particionada (20260805142957) justamente porque esta não é.
--
-- É o número 4 que fixa o teto, e ele merece a letra maiúscula: esta tabela já
-- chegou a 2.087 MB, sendo 1.492 MB só do índice `idx_snapshots_event_time`
-- sobre 80 MB de dado. Índice B-tree não devolve espaço depois de DELETE, e a
-- série do radar nem chega a ser deletada — ela é isenta da retenção e cresce
-- para sempre. A ~200 bytes por linha (heap + PK + índice), 300 mercados custam
-- ~2 GB/ano; 1.000 custariam ~7 GB, mais que o banco inteiro já teve em toda a
-- sua história.
--
-- Então: 50 por categoria, 300 no total, e o caminho para dobrar isso passa por
-- particionar `polymarket_snapshots` ANTES, não depois.
--
-- [revisado em 20260814] A partição saiu (20260814014541) e o teto foi revisto
-- para 100 por categoria na 20260814020000. O raciocínio acima continua valendo
-- como o estado em que ESTA migration foi aplicada — é o registro de por que 50,
-- não uma recomendação viva.

alter table public.system_config
  add column if not exists radar_max_por_categoria integer not null default 50,
  add column if not exists radar_roster_max integer not null default 400;

comment on column public.system_config.radar_max_por_categoria is
  'Teto de mercados por CATEGORIA, cortando os menores em liquidez dentro dela. Por categoria e nao global porque o ranking global e uma opiniao sobre categoria: com teto global de 400 sobre o universo de hoje, esporte leva 208 vagas e IA leva 15.';

comment on column public.system_config.radar_roster_max is
  'Backstop global do roster, depois do teto por categoria. Existe para o dia em que alguem acrescentar dez categorias e a conta de armazenamento sair do orcamento sem ninguem ter decidido isso.';

-- ---------------------------------------------------------------------------
-- 5. As duas cadências (inalteradas nesta revisão)
-- ---------------------------------------------------------------------------
--
-- FOTO, 15 minutos. O número sai do uso, não de simetria com a watchlist de
-- esports — lá a cadência é ancorada em hora de partida, que aqui não existe:
-- notícia não tem horário publicado. O que se quer medir é o preço saltar,
-- exagerar e voltar em horas ou dias, com julgamento em lote no fim de semana.
-- Não há decisão dependendo do minuto, então cadência de segundos não compra
-- nada; o que compra é resolução para o RETORNO aparecer. Um exagero que se
-- desfaz em 3h rende 12 pontos a 15 min — o bastante para distinguir "voltou"
-- de "andou de lado". A 1h seriam 3 pontos, e um salto que nasce e morre entre
-- duas fotos não deixa rastro.
--
-- ROSTER, 6 horas. A janela de prazo é de até 180 dias: ninguém entra nem sai
-- dela em minutos. É o passo caro (~40 chamadas contra 5 da foto).
--
-- O tick do cron é de 5 min e não é a cadência de nada: ele só precisa ser mais
-- rápido que o menor dos dois intervalos. Mesmo desenho da watchlist.

alter table public.system_config
  add column if not exists radar_snapshot_interval_minutes integer not null default 15,
  add column if not exists radar_roster_interval_minutes integer not null default 360;

comment on column public.system_config.radar_snapshot_interval_minutes is
  'Intervalo entre fotos de preco do roster. 15 min: resolucao suficiente para um exagero de 3h aparecer como ida E volta, contra um custo de armazenamento que a retencao nao poda.';

comment on column public.system_config.radar_roster_interval_minutes is
  'Intervalo entre recalculos do roster. 6h: a janela e de ate 180 dias, e este e o passo caro (~40 chamadas contra 5 da foto).';

-- ---------------------------------------------------------------------------
-- 6. As duas colunas que eram filtro e viraram DADO
-- ---------------------------------------------------------------------------
--
-- Nenhuma das duas é recuperável depois, e é por isso que elas existem: a tag
-- que trouxe o mercado não fica em lugar nenhum da API, e o grupo de assunto
-- depende do conjunto que estava aberto no momento em que ele foi calculado.
-- Não gravar agora é não ter.
--
-- `radar_tema` é a categoria de coleta. `radar_subject` é o grupo de assunto —
-- 22 mercados sobre o Irã são UMA observação na hora de medir e 22
-- oportunidades na hora de operar, e essa distinção é da view. O rótulo vem do
-- agrupamento por entidade de `scripts/lib/market-pairing.ts`; o sufixo `*` no
-- valor marca grupo cuja chave dominante não está em todos os membros, que é
-- onde o agrupamento juntou perguntas de mesma FORMA e assunto possivelmente
-- diferente ("Bank of Japan (...) September Meeting" e "Bank of Russia (...)
-- September Meeting").
--
-- O rótulo NÃO é estável entre renovações — ele é recalculado sobre o roster do
-- momento, e um grupo pode ganhar membro e mudar de nome. Quem quiser série
-- estável de assunto agrupa pelo valor de uma renovação, não junta valores de
-- renovações diferentes como se fossem a mesma chave.

alter table public.events
  add column if not exists radar_tema text,
  add column if not exists radar_subject text;

comment on column public.events.radar_tema is
  'Categoria pela qual o radar coletou este mercado (chave de system_config.radar_temas). Nao e recuperavel depois: a tag que trouxe o mercado nao fica em lugar nenhum da API.';

comment on column public.events.radar_subject is
  'Grupo de assunto do mercado no radar, do agrupamento por entidade. Era teto (3 por assunto) e virou coluna: 22 mercados sobre o Ira sao uma observacao na hora de medir e 22 oportunidades na hora de operar. Sufixo * = grupo heterogeneo. NAO e estavel entre renovacoes.';

-- Índice parcial, no mesmo desenho de `idx_events_radar_tracked`: o conjunto
-- interessante é o marcado, não a tabela. Serve ao `group by radar_subject` que
-- a view vai fazer.
create index if not exists idx_events_radar_subject
  on public.events (radar_subject)
  where radar_tracked;

-- ---------------------------------------------------------------------------
-- 7. O limiar do alerta de coletor parado
-- ---------------------------------------------------------------------------
--
-- 20 minutos contra uma foto de 15: uma falta é atraso, duas são incidente.
--
-- Nasce vigiando (e não em 0, que é o desligamento) mesmo com o coletor
-- desligado, e não é contradição: o caminho do desligamento BATE — o componente
-- sai na primeira linha e carimba `collector_heartbeats` com sucesso. Parado por
-- config tem batimento fresco e não dispara alerta; o que o limiar pega é o
-- ciclo que morreu de verdade. Um monitor que nascesse desligado reproduziria o
-- problema que ele existe para resolver: silêncio que parece saúde, que é como
-- o collector geral ficou 48h travado sem ninguém notar.

alter table public.system_config
  add column if not exists health_stale_radar_minutes integer not null default 20;

comment on column public.system_config.health_stale_radar_minutes is
  'Minutos sem ciclo do radar_collector antes de avisar. 0 desliga a vigilancia dele. Vale mesmo com o coletor desligado — o caminho do desligamento bate, entao nao ha falso positivo.';

-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
--
-- 1. Não liga nada. Depois do apply o coletor continua parado até o UPDATE.
-- 2. Não marca nenhum event. `radar_tracked` continua `false` em toda a tabela;
--    quem marca é o coletor, na primeira renovação.
-- 3. Não cria tabela e não particiona nada. A série vai para
--    `polymarket_snapshots`, nas colunas que já existem desde a 001 — inclusive
--    `bid_depth` e `ask_depth`, que nunca foram preenchidas por coletor nenhum e
--    passam a ser (o livro vem do `POST /books` da CLOB).
--
-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- 1. as colunas existem e a flag está desligada
--   select radar_collector_enabled, radar_temas, radar_max_por_categoria,
--          radar_horizon_max_days, radar_snapshot_interval_minutes
--     from public.system_config where id = 1;
--
--   -- 2. o roster de hoje, sem gravar nada (nem com a flag ligada)
--   --    npm run radar:coletor -- --dry-run --lista
--
--   -- 3. depois de ligar, o primeiro ciclo aparece aqui em até 5 min
--   select status, message, metadata->'roster_size', metadata->'roster_por_tema'
--     from public.system_logs
--    where component = 'radar_collector'
--    order by created_at desc limit 5;
--
--   -- 4. e a série começa a existir, com assunto e categoria gravados
--   select e.radar_tema, count(distinct e.id) as mercados, count(s.id) as linhas
--     from public.events e
--     left join public.polymarket_snapshots s on s.event_id = e.id
--    where e.radar_tracked
--    group by 1 order by 3 desc;
