-- O teto do radar depois da partição: 50 -> 100 por categoria.
--
-- Aplicar DEPOIS de `20260814014541_particionar_polymarket_snapshots.sql`. Fora
-- dessa ordem este arquivo dobra a escrita numa tabela que ainda tem um índice
-- único crescendo — que é exatamente o problema que a partição existe para
-- resolver.
--
-- ---------------------------------------------------------------------------
-- Por que 50 antes e 100 agora
-- ---------------------------------------------------------------------------
--
-- O 50 da 20260813224149 não foi escolhido por cobertura: foi escolhido pelo
-- índice. `polymarket_snapshots` não era particionada, a série do radar é isenta
-- da retenção, e o precedente da própria tabela era 1.492 MB de um índice só
-- sobre 80 MB de dado. Nesse desenho, cada mercado a mais no roster empurrava um
-- objeto único que nunca encolhe.
--
-- Com partição de mês esse argumento acaba. O DELETE em ciclo passa a tocar só
-- a partição corrente; cada mês fechado carrega um índice compacto que ninguém
-- mais mexe. Não existe mais o objeto que incha — existe disco, que é linear,
-- previsível e agora tem saída (partição velha se DETACHa e se dumpa sem tocar
-- a tabela viva).
--
-- A conta, com foto a cada 15 min (96 por dia):
--
--   por categoria   roster   linhas/dia   linhas/ano   disco/ano   por partição
--   ------------   ------   ----------   ----------   ---------   ------------
--        50           300      28,8 mil     10,5 M       ~2 GB        ~170 MB
--       100           600      57,6 mil       21 M       ~4 GB        ~340 MB
--       200         1.200     115,2 mil       42 M       ~8 GB        ~680 MB
--
-- (~200 bytes por linha somando heap, PK e o índice de série.)
--
-- 100 é onde a coleta compra cobertura de verdade sem a conta virar decisão de
-- infraestrutura. O que ele destrava, medido em 2026-08-14 com o teto em 50: a
-- liquidez do corte por categoria era 36k no Brasil, 51k em IA, 99k em macro,
-- 153k em eleições. Dobrar o teto empurra cada um desses cortes para baixo — ou
-- seja, entra mercado MENOR, que é justamente onde a notícia mexe mais e onde a
-- série não existe se não for coletada agora.
--
-- 200 fica de fora por um motivo que não é o disco: a 8 GB/ano a conversa passa
-- a ser sobre plano de banco, e isso é decisão de orçamento, não de coletor.
--
-- ---------------------------------------------------------------------------
-- O custo de API, para o registro
-- ---------------------------------------------------------------------------
--
-- Uma foto de 600 mercados custa 6 chamadas à Gamma (lotes de 100 por id) + 3 à
-- CLOB (lotes de 250 tokens no `POST /books`) = 9. A 96 fotos por dia são 864,
-- mais ~160 das quatro renovações: ~1.000 chamadas/dia contra uma API pública e
-- gratuita, espaçadas em 250 ms. O gargalo nunca foi este.
--
-- ---------------------------------------------------------------------------
-- O que continua doendo, e não é consertado aqui
-- ---------------------------------------------------------------------------
--
-- O ramo `old` da retenção varre todas as partições toda noite procurando linha
-- desprotegida, e a essa altura quase tudo é protegido. A varredura cresce com o
-- histórico e não encontra nada — trabalho puro. A partição não conserta isso; o
-- conserto é separar os regimes NA CHAVE (protegido x descartável), descrito na
-- 20260814014541. Dobrar o teto dobra essa varredura, e é o motivo de este
-- arquivo dizer isso em voz alta em vez de deixar a conta chegar sozinha.

update public.system_config
   set radar_max_por_categoria = 100,
       radar_roster_max = 800
 where id = 1;

-- O default da coluna vai junto: `system_config` tem uma linha só, mas um
-- default que discorda do valor corrente é uma armadilha para quem um dia
-- recriar a linha.
alter table public.system_config
  alter column radar_max_por_categoria set default 100,
  alter column radar_roster_max set default 800;

comment on column public.system_config.radar_max_por_categoria is
  'Teto de mercados por CATEGORIA, cortando os menores em liquidez dentro dela. 100 desde 20260814, quando polymarket_snapshots virou particionada — antes era 50, e o limite era o indice unico que nao encolhe, nao o disco.';

-- ---------------------------------------------------------------------------
-- Verificação depois do apply
-- ---------------------------------------------------------------------------
--
--   -- 1. o valor está lá
--   select radar_max_por_categoria, radar_roster_max from public.system_config where id = 1;
--
--   -- 2. o roster novo, sem gravar nada (mesmo com a flag ligada)
--   --    npm run radar:coletor -- --dry-run
--   --    espera: 600 no roster, e a liquidez do corte de cada categoria mais
--   --    baixa que a da rodada anterior — é isso que o teto maior compra.
--
--   -- 3. depois de ligar, a escrita cai na partição do mês corrente
--   select tableoid::regclass as particao, count(*)
--     from public.polymarket_snapshots
--    where captured_at > now() - interval '1 hour'
--    group by 1;
