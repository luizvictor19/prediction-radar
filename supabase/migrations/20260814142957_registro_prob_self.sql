-- O registro passa a coletar PROBABILIDADE. E guarda o preço de mercado do
-- instante, que nunca foi guardado.
--
-- ---------------------------------------------------------------------------
-- Por que `confidence_self` não serve para medir nada
-- ---------------------------------------------------------------------------
--
-- `/register` pergunta "Confiança 1-10" desde a 001 e grava em
-- `confidence_self`. Isso é sentimento numa escala sem unidade: não existe
-- desfecho contra o qual comparar um 8. A conta que a fase atual existe para
-- fazer é o Brier — `(p − desfecho)²` — e ela exige `p` na escala 0–1, com o
-- significado "a chance de isso acontecer".
--
-- Converter 8 → 0,8 depois seria escolher o mapa DEPOIS de ver o resultado.
-- Com 10 níveis e liberdade para escolher a curva, dá para fazer o Brier sair
-- quase onde se quiser. Um número inventado assim mede o inventor, não o
-- previsor. Por isso a coluna é NOVA e a antiga fica onde está.
--
-- A ironia que fechou a decisão: `src/lib/kelly.ts` exige `probability` na
-- assinatura desde sempre. O dimensionamento foi construído esperando um número
-- que o registro nunca coletou — as duas pontas do sistema nunca se encontraram.
--
-- ---------------------------------------------------------------------------
-- 1. `prob_self` — a afirmação, em 0–1
-- ---------------------------------------------------------------------------
--
-- Em 0–1 e não em 0–100 porque é a escala que `kelly()` e `src/eval/metrics.ts`
-- já falam, e porque preço de mercado também vive em 0–1: as duas colunas que
-- vão ser subtraídas uma da outra precisam ter a mesma unidade, ou a subtração
-- vira bug de fator 100 esperando acontecer.
--
-- `numeric(4,3)`: três casas decimais, o mesmo grão que 0,1% de probabilidade.
-- A pergunta do bot é em % inteiro, então três casas sobram — e sobrar é de
-- graça, enquanto faltar exigiria migration.

alter table public.my_bets
  add column if not exists prob_self numeric(4,3);

comment on column public.my_bets.prob_self is
  'Minha probabilidade declarada para o desfecho da aposta, em 0-1, dita ANTES do resultado. E o unico campo com que da para calcular Brier: (prob_self - desfecho)^2. Nao confundir com confidence_self, que e sentimento 1-10 e nao tem unidade.';

-- O intervalo é validado no banco e não só no bot porque o bot não é o único
-- caminho de escrita — backfill, script e correção manual entram pela mesma
-- porta. `[0,1]` inclusive: 0 e 1 são afirmações legítimas (e o Brier pune uma
-- certeza errada com o máximo possível, que é exatamente o comportamento certo).
-- Restringir mais seria opinião sobre o que o dono pode achar.
--
-- `do` block porque `add constraint if not exists` não existe no Postgres, e uma
-- migration que quebra no reapply é uma migration que ninguém roda duas vezes.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.my_bets'::regclass
       and conname = 'my_bets_prob_self_intervalo'
  ) then
    alter table public.my_bets
      add constraint my_bets_prob_self_intervalo
      check (prob_self is null or (prob_self >= 0 and prob_self <= 1));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. `confidence_self` FICA
-- ---------------------------------------------------------------------------
--
-- Nada aqui a apaga, e nada aqui a preenche a partir de `prob_self`. São duas
-- perguntas diferentes respondidas por caminhos diferentes, e o valor de manter
-- as duas lado a lado nas apostas novas é justamente poder medir, com dado, se
-- o "8/10" do dono tem alguma relação estável com o "0,72" dele. Se tiver, a
-- coorte antiga ganha uma ponte defensável — construída com evidência, não com
-- chute retroativo.

comment on column public.my_bets.confidence_self is
  'Sentimento 1-10, coletado desde a 001. Mantido como dado historico: nao serve para Brier (nao tem unidade) e NAO deve ser convertido em prob_self. Ver prob_self.';

-- ---------------------------------------------------------------------------
-- 3. `estrategia` — a marca de coorte
-- ---------------------------------------------------------------------------
--
-- Esta é a coluna que preserva a única evidência existente sobre se os acertos
-- lembrados do dono são representativos ou viés de sobrevivência: as 58 apostas
-- antigas. Sem marca de coorte, medir a estratégia nova contra o histórico
-- misturaria dois regimes num número só e o resultado não responderia nada.
--
-- `not null default 'legado'`: toda linha que já existe recebe 'legado' no
-- apply, sem update manual e sem linha órfã de coorte. Quem grava 'saliencia' é
-- o `/register` novo, explicitamente.
--
-- Sem CHECK de valores permitidos, de propósito. A lista de estratégias vai
-- mudar — ela é a própria tese, e tese morre. Um CHECK aqui transformaria
-- "testar uma ideia nova" em "escrever uma migration", que é exatamente o custo
-- que o desenho das views existe para eliminar.

alter table public.my_bets
  add column if not exists estrategia text not null default 'legado';

comment on column public.my_bets.estrategia is
  'Coorte da aposta. legado = tudo que foi registrado antes de 20260814, quando o registro nao coletava probabilidade. saliencia = a estrategia atual (o mercado precifica a manchete e resolve pela regra). Sem CHECK: a lista muda e trocar de tese nao pode custar migration.';

-- ---------------------------------------------------------------------------
-- 4. O preço de mercado no instante do registro
-- ---------------------------------------------------------------------------
--
-- Não era gravado. O que existe é `my_bet_legs.entry_price`, e ele é outra
-- coisa: no fluxo de uma perna ele sai de `stake / to_win`, ou seja é o preço
-- EXECUTADO, já com taxa e slippage embutidos. Comparar `prob_self` contra ele
-- mediria a corretagem junto com a leitura.
--
-- A linha de base para "eu vi o que o mercado não viu" é o mid do livro no
-- instante em que a opinião foi dita. Sem ela não há contra o que medir, e
-- reconstruir depois seria escolher a foto que favorece o resultado.
--
-- Fica em `my_bet_legs` e não em `my_bets` porque preço é por MERCADO: uma
-- basket tem N mercados e um preço só não significaria nada nela.
--
-- Duas colunas e não uma:
--
--   `preco_mercado`     o mid.
--   `preco_mercado_em`  o `captured_at` da foto usada — NÃO o instante do
--                       registro.
--
-- A segunda existe porque a foto pode estar velha: a cadência do radar é de 15
-- min, então o preço gravado tem até 15 min de atraso, e um mercado fora do
-- roster não tem foto nenhuma. Guardar só o preço esconderia isso; guardar o
-- carimbo transforma "quão velha era a base" em coluna, e a decisão de
-- descartar por idade vira `where` de quem mede.
--
-- `preco_mercado` é NULO quando não há foto — nunca `entry_price` no lugar.
-- Preencher com o preço executado faria a diferença dar zero, e "sem linha de
-- base" viraria "edge zero" em silêncio, que é o pior desfecho possível para
-- uma medição.

alter table public.my_bet_legs
  add column if not exists preco_mercado    numeric(5,4),
  add column if not exists preco_mercado_em timestamptz;

comment on column public.my_bet_legs.preco_mercado is
  'Mid do livro (polymarket_snapshots.mid_price) no instante do registro, a linha de base contra a qual prob_self e medida. NULO quando nao ha foto do mercado, ou quando o livro tinha um lado so. Nunca preenchido com entry_price: entry_price e o preco EXECUTADO (stake/to_win), com taxa e slippage dentro.';

comment on column public.my_bet_legs.preco_mercado_em is
  'captured_at da foto usada em preco_mercado, NAO o instante do registro. Existe para a idade da base ser mensuravel: a cadencia do radar e de 15 min.';
