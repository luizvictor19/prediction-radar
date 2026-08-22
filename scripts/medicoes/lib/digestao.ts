import { supabase } from '../../../src/lib/supabase.js';

/**
 * A digestão lida do banco e remontada em TypeScript.
 *
 * Existe porque a view `digest_achados_por_mercado` entrega `vezes_encontrado`
 * já agregado, e as medições da tela de Regra precisam do CONJUNTO de leituras
 * que apontaram cada trecho — a união da regra de dedup só se calcula com os
 * `digest_id` na mão.
 *
 * Réplica é dívida: duas implementações da mesma regra divergem em silêncio.
 * O pagamento é `conferirContraView`, que roda em toda medição e falha alto se
 * um único mercado discordar. É o mesmo desenho de `scripts/conferir-views.ts`:
 * duas implementações que concordam não provam que a regra está certa, mas duas
 * que discordam provam que uma está errada.
 *
 * **Só leitura.** Nada aqui escreve no banco.
 */

/** Limite de linhas por página do PostgREST. */
const PAGINA = 1000;

export async function paginar<T>(
  tabela: string,
  colunas: string,
  ordem: readonly string[],
): Promise<T[]> {
  const linhas: T[] = [];
  for (let de = 0; ; de += PAGINA) {
    let q = supabase.from(tabela).select(colunas);
    for (const c of ordem) q = q.order(c);
    const { data, error } = await q.range(de, de + PAGINA - 1);
    if (error) throw new Error(`${tabela}: ${error.message}`);
    const lote = (data ?? []) as T[];
    linhas.push(...lote);
    if (lote.length < PAGINA) return linhas;
  }
}

// ---------------------------------------------------------------------------
// As formas cruas
// ---------------------------------------------------------------------------

export type Digest = {
  id: string;
  event_id: string;
  description_sha256: string;
  created_at: string;
};

export type Pegadinha = {
  digest_id: string;
  texto: string;
  severidade: string | null;
  trecho: string | null;
  cenario: string | null;
};

export type Ambiguidade = {
  digest_id: string;
  tipo: string | null;
  trecho: string | null;
  trecho_conflito: string | null;
  leitura_a: string;
  leitura_b: string | null;
};

/** `digest_achados_por_mercado` sem o jsonb: só o que a conferência precisa. */
export type ContagemView = {
  event_id: string;
  description_sha256: string;
  achados_total: number;
  achados_acusados: number;
  achados_herdados: number;
};

export type Digestao = {
  digests: Digest[];
  pegadinhas: Pegadinha[];
  ambiguidades: Ambiguidade[];
  view: ContagemView[];
  /** Os `id` de `v_radar`: o roster que a lista da tela mostra. */
  roster: string[];
};

/**
 * As cinco leituras, em paralelo.
 *
 * Nenhuma toca `events`, `polymarket_snapshots`, `esports_snapshots` ou
 * `system_logs` diretamente. As duas esbarradas em `events` são o join por PK
 * dentro de `digest_achados_por_mercado` e a `v_radar`, e as duas são as mesmas
 * consultas que a lista da tela já roda a cada abertura — aqui pedindo menos
 * colunas do que ela.
 */
export async function lerDigestao(): Promise<Digestao> {
  const [digests, pegadinhas, ambiguidades, view, roster] = await Promise.all([
    paginar<Digest>('market_rule_digests', 'id, event_id, description_sha256, created_at', ['id']),
    paginar<Pegadinha>('digest_pegadinhas', 'digest_id, texto, severidade, trecho, cenario', [
      'digest_id',
      'ordinal',
    ]),
    paginar<Ambiguidade>(
      'digest_ambiguidades',
      'digest_id, tipo, trecho, trecho_conflito, leitura_a, leitura_b',
      ['digest_id', 'ordinal'],
    ),
    paginar<ContagemView>(
      'digest_achados_por_mercado',
      'event_id, description_sha256, achados_total, achados_acusados, achados_herdados',
      ['event_id', 'description_sha256'],
    ),
    paginar<{ id: string }>('v_radar', 'id', ['id']),
  ]);
  return { digests, pegadinhas, ambiguidades, view, roster: roster.map((r) => r.id) };
}

// ---------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------

/**
 * A mesma normalização do `achado_id` da view: btrim, colapso de espaço, lower.
 *
 * É o que decide identidade de achado. Mexer aqui muda o que o banco e a tela
 * consideram o mesmo trecho.
 */
export function normalizar(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

const MESES =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/g;

/**
 * Data e número virando marca, PARA AGRUPAR O GATE DE BOILERPLATE E MAIS NADA.
 *
 * O boilerplate da Polymarket é o mesmo texto com a data trocada:
 * `December 31, 2026, 11:59 PM ET` e `June 30, 2027, 11:59 PM ET` são a mesma
 * omissão de fuso e apareceriam como dois achados raros se a chave fosse o
 * trecho literal.
 *
 * **Nunca sai daqui para a tela.** O trecho exibido é o literal (P1 da spec:
 * citação não se traduz nem se reescreve), e a dedup da seção 4 opera sobre o
 * literal — mascarar ali fundiria dois prazos DIFERENTES do mesmo regulamento
 * num achado só, que é falsificar a regra em vez de limpá-la.
 */
export function mascararParaGate(s: string): string {
  return normalizar(s).replace(MESES, '<mes>').replace(/\d+/g, '#');
}

function temTexto(s: string | null): s is string {
  return s !== null && s.trim() !== '';
}

// ---------------------------------------------------------------------------
// A réplica da view
// ---------------------------------------------------------------------------

export type Classe = 'pegadinha' | 'ambiguidade' | 'contradicao';

/** Uma linha crua já classificada: o `achados` da view, antes do agrupamento. */
export type LinhaAchado = {
  digest_id: string;
  event_id: string;
  sha: string;
  digerido_em: string;
  classe: Classe;
  subtipo: string | null;
  trecho: string;
  trecho_conflito: string | null;
  descricao: string | null;
  cenario: string | null;
  leitura_a: string | null;
  leitura_b: string | null;
  chave: string;
};

/** Um achado do TEXTO: a linha de `achado_texto` na view. */
export type AchadoTexto = {
  sha: string;
  chave: string;
  classe: Classe;
  subtipos: string[];
  trecho: string;
  trechoNorm: string;
  /** Os digests que apontaram este achado. `vezes_encontrado` é o tamanho. */
  leituras: Set<string>;
};

/** Um achado como a TELA o vê: já propagado para um mercado. */
export type AchadoNoMercado = AchadoTexto & {
  event_id: string;
  origem: 'acusado' | 'herdado';
  descricao: string | null;
  cenario: string | null;
  leitura_a: string | null;
  leitura_b: string | null;
};

/**
 * As três classes num só fluxo, com a mesma chave de identidade da view.
 *
 * A chave é o texto normalizado e não o `md5` da view de propósito: o md5 do
 * Postgres depende da ordenação de collation no `least`/`greatest` das
 * contradições, e reproduzir isso em JS acrescentaria um jeito novo de divergir
 * sem acrescentar nenhuma garantia. O que importa é agrupar igual, não gerar o
 * mesmo hash — e `conferirContraView` prova o agrupamento.
 */
export function montarLinhas(d: Digestao): LinhaAchado[] {
  const porId = new Map(d.digests.map((x) => [x.id, x]));
  const linhas: LinhaAchado[] = [];

  for (const p of d.pegadinhas) {
    const dig = porId.get(p.digest_id);
    if (dig === undefined || !temTexto(p.trecho)) continue;
    linhas.push({
      digest_id: dig.id,
      event_id: dig.event_id,
      sha: dig.description_sha256,
      digerido_em: dig.created_at,
      classe: 'pegadinha',
      subtipo: p.severidade,
      trecho: p.trecho,
      trecho_conflito: null,
      descricao: p.texto,
      cenario: p.cenario,
      leitura_a: null,
      leitura_b: null,
      chave: `pegadinha||${normalizar(p.trecho)}`,
    });
  }

  for (const a of d.ambiguidades) {
    const dig = porId.get(a.digest_id);
    if (dig === undefined || !temTexto(a.trecho)) continue;

    if (a.tipo === 'contradicao_interna') {
      if (!temTexto(a.trecho_conflito)) continue;
      const x = normalizar(a.trecho);
      const y = normalizar(a.trecho_conflito);
      const [menor, maior] = x <= y ? [x, y] : [y, x];
      linhas.push({
        digest_id: dig.id,
        event_id: dig.event_id,
        sha: dig.description_sha256,
        digerido_em: dig.created_at,
        classe: 'contradicao',
        subtipo: a.tipo,
        trecho: a.trecho,
        trecho_conflito: a.trecho_conflito,
        descricao: null,
        cenario: null,
        leitura_a: a.leitura_a,
        leitura_b: a.leitura_b,
        chave: `${menor}||${maior}`,
      });
      continue;
    }

    linhas.push({
      digest_id: dig.id,
      event_id: dig.event_id,
      sha: dig.description_sha256,
      digerido_em: dig.created_at,
      classe: 'ambiguidade',
      subtipo: a.tipo,
      trecho: a.trecho,
      trecho_conflito: null,
      descricao: null,
      cenario: null,
      leitura_a: a.leitura_a,
      leitura_b: a.leitura_b,
      chave: `ambiguidade||${a.tipo ?? ''}||${normalizar(a.trecho)}`,
    });
  }

  return linhas;
}

/** O achado deixa de pertencer a um mercado e passa a pertencer a um texto. */
export function agruparPorTexto(linhas: readonly LinhaAchado[]): Map<string, AchadoTexto> {
  // Mais recente primeiro, desempate por digest_id: a mesma ordem que a view usa
  // para escolher a grafia do trecho entre variantes de espaço e caixa.
  const ordenadas = [...linhas].sort(
    (a, b) => b.digerido_em.localeCompare(a.digerido_em) || a.digest_id.localeCompare(b.digest_id),
  );
  const porChave = new Map<string, AchadoTexto>();
  for (const l of ordenadas) {
    const k = `${l.sha} ${l.chave}`;
    let at = porChave.get(k);
    if (at === undefined) {
      at = {
        sha: l.sha,
        chave: l.chave,
        classe: l.classe,
        subtipos: [],
        trecho: l.trecho,
        trechoNorm: normalizar(l.trecho),
        leituras: new Set(),
      };
      porChave.set(k, at);
    }
    at.leituras.add(l.digest_id);
    if (l.subtipo !== null && !at.subtipos.includes(l.subtipo)) at.subtipos.push(l.subtipo);
  }
  for (const at of porChave.values()) at.subtipos.sort();
  return porChave;
}

/**
 * A propagação: todo achado do texto × todo mercado que recebeu o texto.
 *
 * A chave do mapa é `"<event_id> <sha>"`, o mesmo grão da view — mercado com a
 * descrição editada e redigerida aparece duas vezes, e é o certo.
 */
export function propagar(
  d: Digestao,
  linhas: readonly LinhaAchado[],
  porTexto: Map<string, AchadoTexto>,
): Map<string, AchadoNoMercado[]> {
  const achadosDoTexto = new Map<string, AchadoTexto[]>();
  for (const at of porTexto.values()) {
    const lista = achadosDoTexto.get(at.sha);
    if (lista === undefined) achadosDoTexto.set(at.sha, [at]);
    else lista.push(at);
  }

  // A prosa de quem ACUSOU, a mais recente por (mercado, texto, achado).
  const proprio = new Map<string, LinhaAchado>();
  for (const l of linhas) {
    const k = `${l.event_id} ${l.sha} ${l.chave}`;
    const atual = proprio.get(k);
    if (
      atual === undefined ||
      l.digerido_em > atual.digerido_em ||
      (l.digerido_em === atual.digerido_em && l.digest_id > atual.digest_id)
    ) {
      proprio.set(k, l);
    }
  }

  const porMercado = new Map<string, AchadoNoMercado[]>();
  for (const dig of d.digests) {
    const k = `${dig.event_id} ${dig.description_sha256}`;
    if (porMercado.has(k)) continue;
    const lista: AchadoNoMercado[] = [];
    for (const at of achadosDoTexto.get(dig.description_sha256) ?? []) {
      const pr = proprio.get(`${dig.event_id} ${dig.description_sha256} ${at.chave}`);
      lista.push({
        ...at,
        event_id: dig.event_id,
        origem: pr === undefined ? 'herdado' : 'acusado',
        descricao: pr?.descricao ?? null,
        cenario: pr?.cenario ?? null,
        leitura_a: pr?.leitura_a ?? null,
        leitura_b: pr?.leitura_b ?? null,
      });
    }
    porMercado.set(k, lista);
  }
  return porMercado;
}

/**
 * O pagamento da dívida da réplica. Lança se um único mercado discordar.
 *
 * Falha DURA e não aviso: uma réplica que divergiu não está medindo a tela, e
 * um número medido sobre a coisa errada é pior que número nenhum.
 */
export function conferirContraView(
  d: Digestao,
  porMercado: Map<string, AchadoNoMercado[]>,
): { linhas: number; total: number; acusados: number; herdados: number } {
  const divergencias: string[] = [];
  let total = 0;
  let acusados = 0;
  let herdados = 0;

  for (const v of d.view) {
    const lista = porMercado.get(`${v.event_id} ${v.description_sha256}`) ?? [];
    const a = lista.filter((x) => x.origem === 'acusado').length;
    const h = lista.length - a;
    total += v.achados_total;
    acusados += v.achados_acusados;
    herdados += v.achados_herdados;
    if (lista.length !== v.achados_total || a !== v.achados_acusados || h !== v.achados_herdados) {
      if (divergencias.length < 5) {
        divergencias.push(
          `${v.event_id}: view ${v.achados_total}/${v.achados_acusados}/${v.achados_herdados}, réplica ${lista.length}/${a}/${h}`,
        );
      }
    }
  }

  if (divergencias.length > 0) {
    throw new Error(
      `a réplica divergiu da view em ${divergencias.length}+ linhas:\n  ${divergencias.join('\n  ')}`,
    );
  }
  return { linhas: d.view.length, total, acusados, herdados };
}

// ---------------------------------------------------------------------------
// A regra de dedup da seção 4 da spec
// ---------------------------------------------------------------------------

/** `menor` aparece inteiro dentro de `maior`, na sequência de tokens. */
export function contem(maior: readonly string[], menor: readonly string[]): boolean {
  if (menor.length > maior.length) return false;
  for (let i = 0; i + menor.length <= maior.length; i++) {
    let ok = true;
    for (let j = 0; j < menor.length; j++) {
      if (maior[i + j] !== menor[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}
