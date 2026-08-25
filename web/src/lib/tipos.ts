/**
 * As formas que o banco devolve. Escritas à mão porque não há tipos gerados —
 * e escritas com `| null` onde o banco permite nulo, que aqui não é detalhe:
 * `mid_price` nulo é resposta legítima (livro de um lado só) e tratá-lo como
 * zero já fabricou um gap falso de +0,13 neste projeto.
 */

/** Uma linha de `v_radar`. Uma por mercado do roster ativo. */
export type MercadoRadar = {
  id: string;
  /** Slug do MERCADO (`events.slug`). Sozinho NÃO monta URL de `/event/`. */
  slug: string | null;
  /**
   * Slug do EVENTO pai (`events.event_group_slug`). Opcional porque `v_radar`
   * ainda não expõe a coluna — a migration
   * `20260825024030_v_radar_expoe_event_group_slug.sql` está escrita e não
   * aplicada. Enquanto isso ele chega `undefined`, e `urlPolymarket` cai no
   * fallback. Quando a migration entrar, o campo passa a vir e o tipo perde o
   * `?` — nenhum código de tela muda.
   */
  event_group_slug?: string | null;
  pergunta: string;
  categoria: string | null;
  tema: string | null;
  assunto: string | null;
  /** De que lado é o preço abaixo. Nem sempre é o "Yes" da pergunta. */
  outcome: string | null;
  best_bid: number | null;
  best_ask: number | null;
  mid_price: number | null;
  spread: number | null;
  preco_em: string | null;
  preco_idade_min: number | null;
  var_24h: number | null;
  /** Em que lado a variação foi medida: 'mid' | 'ask' | 'bid'. */
  var_24h_base: string | null;
  var_7d: number | null;
  var_7d_base: string | null;
  liquidez: number | null;
  fecha_em: string | null;
  dias_restantes: number | null;
  tamanho_regra: number | null;
  prob_self: number | null;
  prob_self_em: string | null;
  prob_self_estrategia: string | null;
};

/** `digest_achados_por_mercado` sem o jsonb — só as contagens, para a lista. */
export type ContagemDigest = {
  event_id: string;
  description_sha256: string;
  leituras_do_texto: number;
  mercados_do_texto: number;
  achados_total: number;
  achados_acusados: number;
  achados_herdados: number;
  pegadinhas: number;
  ambiguidades: number;
  contradicoes: number;
  pegadinhas_muda_resultado: number;
  confirmacao_maxima: number;
};

/** Um item de `digest_achados_por_mercado.achados[]`. */
export type Achado = {
  achado_id: string;
  classe: 'pegadinha' | 'ambiguidade' | 'contradicao';
  /**
   * 'acusado' = o modelo leu ESTE mercado e apontou.
   * 'herdado' = veio de um mercado irmão com o mesmo texto de regra — e nesse
   * caso `descricao`, `cenario`, `leitura_a` e `leitura_b` são NULAS. Preencher
   * com a do vizinho é erro: elas não existem para este mercado.
   */
  origem: 'acusado' | 'herdado';
  subtipos: string[] | null;
  vezes_encontrado: number;
  leituras_do_texto: number;
  trecho: string | null;
  trecho_conflito: string | null;
  descricao: string | null;
  cenario: string | null;
  leitura_a: string | null;
  leitura_b: string | null;
};

export type LinhaAchados = ContagemDigest & {
  slug: string | null;
  title: string | null;
  achados: Achado[];
};

/** Uma linha de `market_rule_digests`: UMA leitura de um texto de regra. */
export type LeituraRegra = {
  id: string;
  event_id: string;
  description_sha256: string;
  leitura_n: number;
  resolve_sim: string[];
  resolve_nao: string[];
  /** NULO significa "a regra não nomeia fonte" — que é achado, não falta de dado. */
  fonte: string | null;
  prazo: string | null;
  anula_se: string[];
  model: string;
  prompt_version: string;
  created_at: string;
};

/** Uma linha de `digest_contradicoes`: um DEFEITO de texto, não um mercado. */
export type Contradicao = {
  defeito_id: string;
  mercados_atingidos: number;
  mercados_acusados: number;
  mercados_herdados: number;
  textos_de_regra: number;
  liquidez_total: number | null;
  trecho: string;
  trecho_conflito: string;
};

/**
 * O que a tela mostra numa linha da lista: o radar + a digestão, se houver.
 *
 * `digests` é LISTA porque a granularidade de `digest_achados_por_mercado` é
 * (mercado, texto de regra) — o `group by` da view inclui `description_sha256`
 * (`20260817040920_...sql:432`). Um mercado cuja descrição foi editada tem duas
 * linhas, e um campo singular faria a segunda apagar a primeira em silêncio.
 *
 * Lista VAZIA é "não digerido": 20 dos 942 mercados do roster, medido em
 * 22/08/2026 por `npm run medir:tela-regra`.
 */
export type MercadoNaLista = MercadoRadar & {
  digests: ContagemDigest[];
};
