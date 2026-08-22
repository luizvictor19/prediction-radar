import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  agruparPorTexto,
  conferirContraView,
  contem,
  lerDigestao,
  mascararParaGate,
  montarLinhas,
  normalizar,
  propagar,
  type AchadoNoMercado,
} from './lib/digestao.js';

/**
 * As medições M1–M4 da spec da tela de Regra (`spec-tela-regra.md`, seção 3).
 *
 * Tudo é `SELECT` e nada é gravado. Roda quantas vezes quiser:
 *
 *   npm run medir:tela-regra
 *
 * Escreve `probes/digest/medicoes-tela-regra.md`. O relatório é o produto — os
 * números da spec saem daqui, e quando o corpus crescer é este script que diz
 * quanto eles envelheceram. Em 22/08/2026 o corpus foi de 191 para 267 textos
 * em três dias, então nenhum número medido pode entrar na spec ou no código sem
 * a data ao lado.
 */

const SAIDA = 'probes/digest/medicoes-tela-regra.md';

// ---------------------------------------------------------------------------
// Utilidades de apresentação
// ---------------------------------------------------------------------------

const linhas: string[] = [];
function p(s = ''): void {
  linhas.push(s);
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`;
}

function quantil(valores: readonly number[], q: number): number {
  if (valores.length === 0) return 0;
  const ord = [...valores].sort((a, b) => a - b);
  const i = Math.min(ord.length - 1, Math.max(0, Math.ceil(q * ord.length) - 1));
  return ord[i] as number;
}

function media(v: readonly number[]): string {
  return v.length === 0 ? '—' : (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1);
}

function corte(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

// ---------------------------------------------------------------------------
// A dedup, nas duas variantes que a decisão comparou
// ---------------------------------------------------------------------------

/**
 * O grupo dentro do qual dois achados podem ser o mesmo defeito.
 *
 * Severidade fica FORA da chave: `{muda_resultado}` e `{muda_resultado,detalhe}`
 * sobre trechos que se contêm são o mesmo defeito com as leituras discordando
 * do peso, e a discordância é informação a preservar na união — não motivo para
 * mostrar o item duas vezes.
 */
function grupoDe(a: AchadoNoMercado): string {
  return a.classe === 'pegadinha' ? 'pegadinha' : `${a.classe}|${a.subtipos.join(',')}`;
}

/** Sufixo de `a` igual a prefixo de `b`, com pelo menos `min` tokens. */
function encavala(a: readonly string[], b: readonly string[], min: number): boolean {
  const teto = Math.min(a.length, b.length);
  for (let n = teto; n >= min; n--) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (a[a.length - n + j] !== b[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

type Resultado = {
  antes: number;
  depois: number;
  fusoes: Map<number, number>;
  ganharamLeitura: number;
  /** Fusões em que o sobrevivente NÃO contém todo mundo que absorveu. */
  invarianteQuebrado: number;
  /** Absorvidos que tinham mais de um container possível (só na absorção). */
  containerAmbiguo: number;
};

/**
 * As três formas de decidir quem funde com quem, medidas lado a lado.
 *
 * - `componentes-encadeadas`: fecho transitivo sobre continência OU
 *   encavalamento de sufixo/prefixo. A leitura literal da spec original.
 * - `componentes-continencia`: fecho transitivo só sobre continência.
 * - `absorcao-continencia`: cada achado é absorvido pelo MAIS LONGO que o
 *   contém, sem transitividade.
 *
 * As duas primeiras são fecho transitivo, e fecho transitivo não preserva o
 * invariante que justifica a regra. `A ⊃ B` e `C ⊃ B` com `A ⊅ C` junta os três
 * num componente cujo sobrevivente não contém o `C`. A terceira é a única em
 * que "o sobrevivente contém tudo que absorveu" é verdade por construção.
 */
type Modo = 'componentes-encadeadas' | 'componentes-continencia' | 'absorcao-continencia';

function rodarDedup(
  porMercado: Map<string, AchadoNoMercado[]>,
  modo: Modo,
  minEncavalamento = 3,
): Resultado {
  const r: Resultado = {
    antes: 0,
    depois: 0,
    fusoes: new Map(),
    ganharamLeitura: 0,
    invarianteQuebrado: 0,
    containerAmbiguo: 0,
  };

  for (const lista of porMercado.values()) {
    r.antes += lista.length;
    const grupos = new Map<string, AchadoNoMercado[]>();
    for (const a of lista) {
      const g = grupos.get(grupoDe(a));
      if (g === undefined) grupos.set(grupoDe(a), [a]);
      else g.push(a);
    }

    for (const g of grupos.values()) {
      // Trecho mais longo primeiro; empate pelo texto normalizado, que é
      // determinístico e não depende da ordem em que o banco devolveu.
      const itens = [...g].sort(
        (x, y) => y.trecho.length - x.trecho.length || x.trechoNorm.localeCompare(y.trechoNorm),
      );
      const toks = itens.map((i) => i.trechoNorm.split(' '));

      const membros =
        modo === 'absorcao-continencia'
          ? absorver(toks, r)
          : componentes(toks, modo === 'componentes-encadeadas' ? minEncavalamento : Infinity);

      r.depois += membros.length;

      for (const c of membros) {
        if (c.length < 2) continue;
        r.fusoes.set(c.length, (r.fusoes.get(c.length) ?? 0) + 1);
        const uniao = new Set<string>();
        let maxIndividual = 0;
        // O sobrevivente é o primeiro da lista: o trecho mais longo.
        const sobrevivente = toks[c[0] as number] as string[];
        let contemTodos = true;
        for (const i of c) {
          const it = itens[i] as AchadoNoMercado;
          for (const l of it.leituras) uniao.add(l);
          maxIndividual = Math.max(maxIndividual, it.leituras.size);
          if (!contem(sobrevivente, toks[i] as string[])) contemTodos = false;
        }
        if (uniao.size > maxIndividual) r.ganharamLeitura++;
        if (!contemTodos) r.invarianteQuebrado++;
      }
    }
  }
  return r;
}

/** Fecho transitivo. Devolve cada componente com o índice mais longo na frente. */
function componentes(toks: readonly string[][], minEncavalamento: number): number[][] {
  const pai = toks.map((_, i) => i);
  const raiz = (i: number): number => {
    while (pai[i] !== i) {
      pai[i] = pai[pai[i] as number] as number;
      i = pai[i] as number;
    }
    return i;
  };
  for (let i = 0; i < toks.length; i++) {
    for (let j = i + 1; j < toks.length; j++) {
      const a = toks[i] as string[];
      const b = toks[j] as string[];
      const junta =
        contem(a, b) ||
        contem(b, a) ||
        (minEncavalamento !== Infinity &&
          (encavala(a, b, minEncavalamento) || encavala(b, a, minEncavalamento)));
      if (junta) pai[raiz(j)] = raiz(i);
    }
  }
  const comps = new Map<number, number[]>();
  for (let i = 0; i < toks.length; i++) {
    const k = raiz(i);
    const c = comps.get(k);
    if (c === undefined) comps.set(k, [i]);
    else c.push(i);
  }
  // `itens` já veio ordenado do mais longo para o mais curto, então o menor
  // índice do componente é o trecho mais longo dele.
  return [...comps.values()].map((c) => [...c].sort((a, b) => a - b));
}

/**
 * Absorção pelo container mais longo, sem transitividade.
 *
 * `toks` chega ordenado do mais longo para o mais curto, então o primeiro
 * container encontrado é o mais longo — e o empate cai no critério de desempate
 * da ordenação, que é o trecho normalizado. Determinístico nos dois eixos.
 */
function absorver(toks: readonly string[][], r: Resultado): number[][] {
  const dono = toks.map(() => -1);
  for (let j = 0; j < toks.length; j++) {
    let candidatos = 0;
    for (let i = 0; i < j; i++) {
      // `i < j` garante container ao menos tão longo; a igualdade de conteúdo
      // não existe aqui porque o `achado_id` da view já a colapsou.
      if (contem(toks[i] as string[], toks[j] as string[])) {
        if (dono[j] === -1) dono[j] = i;
        candidatos++;
      }
    }
    if (candidatos > 1) r.containerAmbiguo++;
  }
  const grupos = new Map<number, number[]>();
  for (let j = 0; j < toks.length; j++) {
    // Um absorvido cujo dono também foi absorvido sobe para o dono final: o
    // container mais longo contém o intermediário, logo contém o absorvido.
    let d = j;
    while (dono[d] !== -1) d = dono[d] as number;
    let g = grupos.get(d);
    if (g === undefined) {
      g = [d];
      grupos.set(d, g);
    }
    if (j !== d) g.push(j);
  }
  return [...grupos.values()];
}

// ---------------------------------------------------------------------------
// O vale, calculado e não estimado
// ---------------------------------------------------------------------------

type Vale = { acima: number; abaixo: number; largura: number; paresAcima: number };

/**
 * O maior salto entre frequências consecutivas na cauda alta da distribuição.
 *
 * O limiar do gate de boilerplate mora no meio deste salto. Calculado e não
 * escolhido a olho: a spec pedia "o corte vai no vale", e vale é uma
 * propriedade da distribuição, não uma opinião.
 *
 * Só olha pares acima de `piso` — o vale que interessa é o que separa
 * boilerplate de peculiaridade, e abaixo disso a distribuição é uma nuvem
 * contínua de milhares de trechos raros onde todo intervalo é minúsculo.
 */
function acharVale(frequencias: readonly number[], piso: number): Vale | null {
  const altos = [...new Set(frequencias.filter((f) => f > piso))].sort((a, b) => b - a);
  if (altos.length < 2) return null;
  let melhor: Vale | null = null;
  for (let i = 0; i < altos.length - 1; i++) {
    const acima = altos[i] as number;
    const abaixo = altos[i + 1] as number;
    const largura = acima - abaixo;
    if (melhor === null || largura > melhor.largura) {
      melhor = {
        acima,
        abaixo,
        largura,
        paresAcima: frequencias.filter((f) => f >= acima).length,
      };
    }
  }
  return melhor;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const d = await lerDigestao();
  const todasLinhas = montarLinhas(d);
  const porTexto = agruparPorTexto(todasLinhas);
  const porMercado = propagar(d, todasLinhas, porTexto);
  const conferencia = conferirContraView(d, porMercado);

  const textos = new Set(d.digests.map((x) => x.description_sha256));
  const mercados = new Set(d.digests.map((x) => x.event_id));
  const nTextos = textos.size;

  const leiturasDoTexto = new Map<string, number>();
  const mercadosDoTexto = new Map<string, Set<string>>();
  for (const x of d.digests) {
    leiturasDoTexto.set(x.description_sha256, (leiturasDoTexto.get(x.description_sha256) ?? 0) + 1);
    let m = mercadosDoTexto.get(x.description_sha256);
    if (m === undefined) {
      m = new Set();
      mercadosDoTexto.set(x.description_sha256, m);
    }
    m.add(x.event_id);
  }

  p('# Medições M1–M4 — tela de Regra');
  p();
  p(`Gerado por \`npm run medir:tela-regra\` (\`scripts/medicoes/tela-regra.ts\`).`);
  p('Só leitura: nenhuma linha deste relatório escreve no banco.');
  p();
  p('## 0. O universo');
  p();
  p(`| | |`);
  p(`| --- | ---: |`);
  p(`| linhas em \`market_rule_digests\` | ${d.digests.length} |`);
  p(`| textos distintos (\`description_sha256\`) | ${nTextos} |`);
  p(`| mercados digeridos | ${mercados.size} |`);
  p(`| linhas em \`digest_pegadinhas\` | ${d.pegadinhas.length} |`);
  p(`| linhas em \`digest_ambiguidades\` | ${d.ambiguidades.length} |`);
  p(`| achados na tela (view) | ${conferencia.total} |`);
  p(`| — acusados | ${conferencia.acusados} |`);
  p(`| — herdados | ${conferencia.herdados} |`);
  p();
  p('Cobertura do roster — o denominador da lista, não o da digestão:');
  p();
  const semDigestao = d.roster.filter((id) => !mercados.has(id));
  const foraDoRoster = [...mercados].filter((id) => !d.roster.includes(id));
  p(`| | |`);
  p(`| --- | ---: |`);
  p(`| mercados em \`v_radar\` | ${d.roster.length} |`);
  p(
    `| — sem digestão nenhuma | ${semDigestao.length} (${pct(semDigestao.length, d.roster.length)}) |`,
  );
  p(`| digeridos que já saíram do roster | ${foraDoRoster.length} |`);
  p();
  p(
    `**Conferência da réplica contra \`digest_achados_por_mercado\`:** ` +
      `${conferencia.linhas} linhas, zero divergência. ` +
      `Se divergisse, este script teria falhado antes de escrever o arquivo.`,
  );

  const distLeituras = new Map<number, number>();
  for (const n of leiturasDoTexto.values()) distLeituras.set(n, (distLeituras.get(n) ?? 0) + 1);
  p();
  p('Leituras por texto — o denominador da concordância:');
  p();
  p('| leituras do texto | textos |');
  p('| ---: | ---: |');
  for (const n of [...distLeituras.keys()].sort((a, b) => a - b)) {
    p(`| ${n} | ${distLeituras.get(n)} |`);
  }

  // -------------------------------------------------------------------------
  // M1
  // -------------------------------------------------------------------------
  const textosDoTipo = new Map<string, Set<string>>();
  for (const at of porTexto.values()) {
    const rotulos =
      at.subtipos.length > 0
        ? at.subtipos.map((s) => `${at.classe}:${s}`)
        : [`${at.classe}:(sem tipo)`];
    for (const r of rotulos) {
      let s = textosDoTipo.get(r);
      if (s === undefined) {
        s = new Set();
        textosDoTipo.set(r, s);
      }
      s.add(at.sha);
    }
  }

  p();
  p('## M1 — frequência de cada tipo sobre os textos distintos');
  p();
  p(`Denominador: ${nTextos} textos distintos de regra.`);
  p();
  p('| tipo | textos | fração |');
  p('| --- | ---: | ---: |');
  for (const [tipo, s] of [...textosDoTipo].sort((a, b) => b[1].size - a[1].size)) {
    p(`| \`${tipo}\` | ${s.size} | ${pct(s.size, nTextos)} |`);
  }
  p();
  p('> **P2 se aplica no grão `(tipo, trecho)`, nunca no grão `tipo`.** Esta tabela');
  p('> NÃO é entrada do gate de boilerplate. Lida como se fosse, ela mandaria');
  p('> recolher `pegadinha:muda_resultado` — o produto da tela — por aparecer em');
  p('> quase todo texto. O que se repete é o TIPO; o trecho que o causa é');
  p('> diferente em cada regulamento. Quem decide o gate é M1b.');

  // --- M1b -----------------------------------------------------------------
  type Par = { chave: string; tipo: string; trecho: string; textos: Set<string> };

  function paresPor(chaveTrecho: (s: string) => string): Map<string, Par> {
    const pares = new Map<string, Par>();
    for (const at of porTexto.values()) {
      const tipo = at.subtipos.length > 0 ? at.subtipos.join('+') : at.classe;
      const k = `${tipo}|${chaveTrecho(at.trecho)}`;
      let par = pares.get(k);
      if (par === undefined) {
        par = { chave: k, tipo, trecho: at.trecho, textos: new Set() };
        pares.set(k, par);
      }
      par.textos.add(at.sha);
    }
    return pares;
  }

  const variantes = [
    { nome: 'chave literal', rotulo: 'trecho normalizado', fn: normalizar },
    { nome: 'chave mascarada', rotulo: 'data e número mascarados', fn: mascararParaGate },
  ] as const;

  p();
  p('## M1b — `(tipo, trecho)`: o grão do gate de boilerplate');
  p();
  p('Duas chaves de agrupamento, porque o boilerplate da Polymarket é o mesmo');
  p('texto com a data trocada — `December 31, 2026, 11:59 PM ET` e');
  p('`June 30, 2027, 11:59 PM ET` são a mesma omissão de fuso. A máscara vale só');
  p('para AGRUPAR: o trecho exibido é sempre o literal, e a dedup da seção 4');
  p('também opera sobre o literal.');

  const valePorVariante = new Map<string, Vale | null>();

  for (const v of variantes) {
    const pares = [...paresPor(v.fn).values()].sort((a, b) => b.textos.size - a.textos.size);
    const freqs = pares.map((x) => (100 * x.textos.size) / nTextos);

    p();
    p(`### ${v.nome} (${v.rotulo})`);
    p();
    p(`Pares distintos: ${pares.length}. Denominador: ${nTextos} textos.`);
    p();
    p('| fração | textos | tipo | trecho |');
    p('| ---: | ---: | --- | --- |');
    for (const x of pares.slice(0, 15)) {
      p(
        `| ${pct(x.textos.size, nTextos)} | ${x.textos.size} | \`${x.tipo}\` | ${corte(x.trecho, 80)} |`,
      );
    }

    // Histograma de 1 ponto na cauda alta, onde o limiar se decide, e faixas
    // largas embaixo, onde não há decisão a tomar.
    p();
    p('Histograma — resolução de 1 ponto acima de 5%, que é onde o corte mora:');
    p();
    p('| faixa | pares |');
    p('| --- | ---: |');
    p(`| 0% – 1% | ${freqs.filter((f) => f <= 1).length} |`);
    p(`| >1% – 3% | ${freqs.filter((f) => f > 1 && f <= 3).length} |`);
    p(`| >3% – 5% | ${freqs.filter((f) => f > 3 && f <= 5).length} |`);
    for (let lo = 5; lo < 50; lo++) {
      const n = freqs.filter((f) => f > lo && f <= lo + 1).length;
      if (n > 0) p(`| >${lo}% – ${lo + 1}% | ${n} |`);
    }
    const acima50 = freqs.filter((f) => f > 50).length;
    p(`| >50% | ${acima50} |`);

    const vale = acharVale(freqs, 5);
    valePorVariante.set(v.nome, vale);
    p();
    if (vale === null) {
      p('Sem vale mensurável acima de 5%.');
    } else {
      p(
        `**Vale:** o maior salto acima de 5% vai de **${vale.abaixo.toFixed(1)}%** a ` +
          `**${vale.acima.toFixed(1)}%** — ${vale.largura.toFixed(1)} pontos sem nenhum par. ` +
          `Acima dele: ${vale.paresAcima} pares.`,
      );
    }
  }

  // --- impacto do gate ------------------------------------------------------
  p();
  p('### Quanto o gate recolhe, por limiar');
  p();
  p('Cada achado do texto vale por todos os mercados daquele texto — é assim que');
  p('ele aparece na tela.');
  p();
  p('| chave | limiar | pares | achados recolhidos | de | fração | mercados atingidos |');
  p('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const v of variantes) {
    const pares = paresPor(v.fn);
    for (const limiar of [80, 50, 45, 40, 35, 30, 20, 12, 10]) {
      const boiler = new Set(
        [...pares.values()]
          .filter((x) => (100 * x.textos.size) / nTextos >= limiar)
          .map((x) => x.chave),
      );
      let recolhidos = 0;
      let total = 0;
      const atingidos = new Set<string>();
      for (const at of porTexto.values()) {
        const n = (mercadosDoTexto.get(at.sha) as Set<string>).size;
        total += n;
        const tipo = at.subtipos.length > 0 ? at.subtipos.join('+') : at.classe;
        if (boiler.has(`${tipo}|${v.fn(at.trecho)}`)) {
          recolhidos += n;
          for (const m of mercadosDoTexto.get(at.sha) as Set<string>) atingidos.add(m);
        }
      }
      p(
        `| ${v.nome} | ${limiar}% | ${boiler.size} | ${recolhidos} | ${total} | ` +
          `${pct(recolhidos, total)} | ${atingidos.size} (${pct(atingidos.size, mercados.size)}) |`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // M2
  // -------------------------------------------------------------------------
  const escolhida = rodarDedup(porMercado, 'absorcao-continencia');
  const compContinencia = rodarDedup(porMercado, 'componentes-continencia');
  const compEncadeada = rodarDedup(porMercado, 'componentes-encadeadas', 3);

  p();
  p('## M2 — quanto a dedup por sobreposição corta');
  p();
  p('| variante | antes | depois | corte | invariante quebrado |');
  p('| --- | ---: | ---: | ---: | ---: |');
  p(`| igualdade exata | ${escolhida.antes} | ${escolhida.antes} | 0,0% | 0 |`);
  p(
    `| **absorção pelo mais longo** (escolhida) | ${escolhida.antes} | ${escolhida.depois} | ` +
      `**${pct(escolhida.antes - escolhida.depois, escolhida.antes)}** | **${escolhida.invarianteQuebrado}** |`,
  );
  p(
    `| componentes conexas por continência | ${compContinencia.antes} | ${compContinencia.depois} | ` +
      `${pct(compContinencia.antes - compContinencia.depois, compContinencia.antes)} | ${compContinencia.invarianteQuebrado} |`,
  );
  p(
    `| componentes conexas com encavalamento ≥ 3 | ${compEncadeada.antes} | ${compEncadeada.depois} | ` +
      `${pct(compEncadeada.antes - compEncadeada.depois, compEncadeada.antes)} | ${compEncadeada.invarianteQuebrado} |`,
  );
  p();
  p('Igualdade exata corta 0% porque o `achado_id` da view já colapsa trechos');
  p('idênticos normalizados. É o que faz o eixo de mutação "igualdade em vez de');
  p('sobreposição" morder de verdade.');
  p();
  p('`invariante quebrado` conta as fusões em que o sobrevivente — o trecho mais');
  p('longo — NÃO contém todo mundo que absorveu.');
  p();
  p('**Continência não basta: o que quebra o invariante é o fecho transitivo.**');
  p('`A ⊃ B` e `C ⊃ B` com `A ⊅ C` põe os três no mesmo componente, e o');
  p('sobrevivente `A` não contém o `C`. Trocar sobreposição por continência');
  p('derruba o número de 410 para 340, não para zero. Zero só sai de abandonar a');
  p('transitividade: cada achado é absorvido pelo mais longo que o contém, e');
  p('quem não tem container sobrevive sozinho. É o que a coluna prova.');
  p();
  p(
    `Absorvidos com mais de um container possível: ${escolhida.containerAmbiguo}. ` +
      `Vão para o mais longo, com desempate pelo trecho normalizado — os dois ` +
      `eixos determinísticos.`,
  );
  p();
  p('Distribuição das fusões (variante escolhida):');
  p();
  p('| itens fundidos em um | ocorrências |');
  p('| ---: | ---: |');
  for (const n of [...escolhida.fusoes.keys()].sort((a, b) => a - b)) {
    p(`| ${n} | ${escolhida.fusoes.get(n)} |`);
  }
  const totalFusoes = [...escolhida.fusoes.values()].reduce((a, b) => a + b, 0);
  p();
  p(
    `Achados cuja contagem de leituras SOBE pela união: **${escolhida.ganharamLeitura}** ` +
      `de ${totalFusoes} fusões. O eixo de mutação "máximo em vez de união" morde ` +
      `em quase toda fusão.`,
  );

  // -------------------------------------------------------------------------
  // M3
  // -------------------------------------------------------------------------
  const porEvento = new Map<string, { total: number; acus: number; herd: number; forte: number }>();
  const dedupPorEvento = new Map<string, number>();
  for (const [k, lista] of porMercado) {
    const ev = k.slice(0, k.indexOf(' '));
    const at = porEvento.get(ev) ?? { total: 0, acus: 0, herd: 0, forte: 0 };
    for (const a of lista) {
      at.total++;
      if (a.origem === 'acusado') at.acus++;
      else at.herd++;
      if (
        a.origem === 'acusado' &&
        a.classe === 'pegadinha' &&
        a.subtipos.some((s) => s === 'muda_resultado' || s === 'muda_timing')
      ) {
        at.forte++;
      }
    }
    porEvento.set(ev, at);
    const r = rodarDedup(new Map([[k, lista]]), 'absorcao-continencia');
    dedupPorEvento.set(ev, (dedupPorEvento.get(ev) ?? 0) + r.depois);
  }

  const vt = [...porEvento.values()].map((x) => x.total);
  const va = [...porEvento.values()].map((x) => x.acus);
  const vh = [...porEvento.values()].map((x) => x.herd);
  const vf = [...porEvento.values()].map((x) => x.forte);
  const vd = [...dedupPorEvento.values()];

  p();
  p('## M3 — achados por mercado');
  p();
  p(`Mercados: ${porEvento.size}.`);
  p();
  p('| corte | mediana | p90 | máximo | média |');
  p('| --- | ---: | ---: | ---: | ---: |');
  const linhaM3 = (nome: string, v: number[]): void =>
    p(`| ${nome} | ${quantil(v, 0.5)} | ${quantil(v, 0.9)} | ${Math.max(...v)} | ${media(v)} |`);
  linhaM3('total', vt);
  linhaM3('acusados', va);
  linhaM3('herdados', vh);
  linhaM3('total após dedup (absorção pelo mais longo)', vd);
  linhaM3('armadilhas acusadas (`muda_resultado`/`muda_timing`)', vf);
  p();
  p(
    `Mercados com **zero** armadilha acusada: ${vf.filter((x) => x === 0).length} ` +
      `(${pct(vf.filter((x) => x === 0).length, vf.length)}) — o estado vazio da seção 7 é raro, e existe.`,
  );
  p(
    `Mercados acima do teto de 5 itens visíveis: ${vf.filter((x) => x > 5).length} ` +
      `(${pct(vf.filter((x) => x > 5).length, vf.length)}).`,
  );

  // -------------------------------------------------------------------------
  // M4
  // -------------------------------------------------------------------------
  const LIMIAR = 2 / 3;
  type Amostra = { event_id: string; conc: string; descricao: string; cenario: string };
  const amostra: Amostra[] = [];

  function contarM4(minLeituras: number): {
    elegiveis: number;
    qualquer: number;
    acusado: number;
    comProsa: number;
    guardarAmostra: boolean;
  } {
    const elegiveis = new Set<string>();
    const qualquer = new Set<string>();
    const acusado = new Set<string>();
    const comProsa = new Set<string>();
    for (const [k, lista] of porMercado) {
      const ev = k.slice(0, k.indexOf(' '));
      const sha = k.slice(k.indexOf(' ') + 1);
      const n = leiturasDoTexto.get(sha) as number;
      if (n < minLeituras) continue;
      elegiveis.add(ev);
      const fortes = lista.filter(
        (a) =>
          a.classe === 'pegadinha' &&
          a.subtipos.includes('muda_resultado') &&
          a.leituras.size / n >= LIMIAR,
      );
      if (fortes.length === 0) continue;
      qualquer.add(ev);
      const acus = fortes.filter((a) => a.origem === 'acusado');
      if (acus.length > 0) acusado.add(ev);
      const prosa = acus.filter((a) => a.descricao !== null && a.cenario !== null);
      if (prosa.length > 0) {
        comProsa.add(ev);
        if (minLeituras === 1 && amostra.length < 20) {
          const melhor = [...prosa].sort(
            (x, y) => y.leituras.size - x.leituras.size,
          )[0] as AchadoNoMercado;
          amostra.push({
            event_id: ev,
            conc: `${melhor.leituras.size}/${n}`,
            descricao: melhor.descricao as string,
            cenario: melhor.cenario as string,
          });
        }
      }
    }
    return {
      elegiveis: elegiveis.size,
      qualquer: qualquer.size,
      acusado: acusado.size,
      comProsa: comProsa.size,
      guardarAmostra: minLeituras === 1,
    };
  }

  p();
  p('## M4 — mercados com pegadinha `muda_resultado` e concordância ≥ 2/3');
  p();
  p(
    '| mínimo de leituras do texto | mercados elegíveis | tem alguma | acusada | acusada com descrição e cenário |',
  );
  p('| ---: | ---: | ---: | ---: | ---: |');
  for (const min of [1, 2, 3]) {
    const r = contarM4(min);
    p(
      `| ${min} | ${r.elegiveis} | ${r.qualquer} (${pct(r.qualquer, r.elegiveis)}) | ` +
        `${r.acusado} (${pct(r.acusado, r.elegiveis)}) | ${r.comProsa} (${pct(r.comProsa, r.elegiveis)}) |`,
    );
  }
  p();
  p('A coluna que decide a seção 8 é a última: manchete-vs-regra sai de');
  p('`descricao` + `cenario`, e no herdado os dois são nulos por construção.');
  p();
  p(
    'A linha de mínimo 1 conta textos lidos uma vez só, onde `1/1` passa em ' +
      '"≥ 2/3" sem ninguém ter concordado com ninguém. As linhas de 2 e 3 são a ' +
      'mesma pergunta com a palavra concordância valendo o que ela diz.',
  );

  p();
  p('### A amostra de 20 que a seção 8 pede');
  p();
  p('A pergunta é se `descricao` + `cenario` se sustentam sozinhos como');
  p('manchete-vs-regra, sem campo novo no prompt.');
  p();
  for (const [i, a] of amostra.entries()) {
    p(`${i + 1}. **${a.event_id}** (concordância ${a.conc})`);
    p(`   - descrição: ${a.descricao}`);
    p(`   - cenário: ${a.cenario}`);
  }

  await mkdir(dirname(SAIDA), { recursive: true });
  await writeFile(SAIDA, `${linhas.join('\n')}\n`);
  console.log(`→ ${SAIDA}`);

  const vale = valePorVariante.get('chave mascarada');
  if (vale !== null && vale !== undefined) {
    console.log(
      `vale da chave mascarada: ${vale.abaixo.toFixed(1)}% – ${vale.acima.toFixed(1)}% ` +
        `(${vale.largura.toFixed(1)} pontos, ${vale.paresAcima} pares acima)`,
    );
  }
}

void main();
