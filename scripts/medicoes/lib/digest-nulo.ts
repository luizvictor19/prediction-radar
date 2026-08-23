/**
 * Reading a digestion run's failures out of its artifacts, and naming a cause.
 *
 * Pure: no filesystem, no network, no database. The runner is
 * `scripts/medicoes/digest-nulo.ts`; everything here is what the test can hold
 * still.
 */

// ---------------------------------------------------------------------------
// The causes
// ---------------------------------------------------------------------------

/**
 * A cause is a bucket of `DigestFailureCode` that shares ONE response.
 *
 * The grouping is by response and not by code because that is the question
 * issue #7 asks: a refusal is a prompt problem, a transport error is a retry
 * problem, and lumping them keeps both unanswered. Codes that never fired stay
 * in the table with zero -- a cause that stops appearing is information, and a
 * table that only lists what happened hides exactly that.
 */
export interface Causa {
  chave: string;
  titulo: string;
  codigos: readonly string[];
  resposta: string;
}

export const CAUSAS: readonly Causa[] = [
  {
    chave: 'guarda_opiniao',
    titulo: 'trava de opinião disparou',
    codigos: ['opiniao'],
    resposta: 'problema de extração/prompt — ver a quebra por termo e campo abaixo',
  },
  {
    chave: 'transporte',
    titulo: 'a resposta não chegou inteira',
    codigos: ['api_error', 'not_json'],
    resposta: 'problema de retry',
  },
  {
    chave: 'recusa_do_modelo',
    titulo: 'o modelo recusou',
    codigos: ['refusal'],
    resposta: 'problema de prompt',
  },
  {
    chave: 'truncado',
    titulo: 'bateu no teto de tokens',
    codigos: ['truncated'],
    resposta: 'problema de max_tokens',
  },
  {
    chave: 'saida_malformada',
    titulo: 'a saída não obedeceu ao contrato',
    codigos: ['schema', 'sem_resolve_sim', 'severidade_invalida', 'tipo_invalido'],
    resposta: 'problema de prompt',
  },
  {
    chave: 'configuracao',
    titulo: 'a corrida foi mal configurada',
    codigos: ['no_text', 'unknown_model', 'unknown_prompt', 'unknown_provider'],
    resposta: 'problema de configuração — não deveria alcançar uma corrida real',
  },
];

export function causaDe(codigo: string): Causa | null {
  return CAUSAS.find(c => c.codigos.includes(codigo)) ?? null;
}

/**
 * Inside the opinion guard: rule vocabulary, or the model hedging?
 *
 * The two need different answers. When the flagged term is the model restating
 * a resolution condition the RULE spells out -- Polymarket's boilerplate
 * "prospective, contingent, probable or conditional statements do not count",
 * or "photo opportunities will not count" -- the word is load-bearing and the
 * model had no way to extract the condition without it. When it is the model
 * hedging its own reading ("probably EDT", "probably NASDAQ"), the word is
 * removable with nothing lost.
 *
 * This is a HEURISTIC, and the report prints it next to each excerpt so it can
 * be argued with instead of believed. It rests on a distinction and not on a
 * coincidence of one run: `provavelmente` is an adverb of speaker uncertainty,
 * while `provável`/`prováveis` is the adjective that appears inside the rule's
 * own enumerations of what does not count; and `ambiguidades.leitura_*` is the
 * one field whose job is to narrate the model's interpretation. Measured
 * against a by-hand read of all 17 hits of the 2026-08-22 run it agreed on 17
 * of 17 -- ONE run, so it is a starting point for the next one, not a settled
 * rule.
 */
export function ehHedge(campo: string, termo: string): boolean {
  return termo === 'provavelmente' || campo === 'ambiguidades';
}

/** The flagged field and term, back out of the guard's own message. */
export function campoETermo(mensagem: string): { campo: string; termo: string } | null {
  const m = /em (\w+) \("([^"]+)"\)/.exec(mensagem);
  return m === null ? null : { campo: m[1] as string, termo: m[2] as string };
}

// ---------------------------------------------------------------------------
// The failures
// ---------------------------------------------------------------------------

export interface Falha {
  slug: string;
  pergunta: string;
  regra: string;
  codigo: string;
  mensagem: string;
}

/**
 * The failures of a run's `.md`, each one whole.
 *
 * Read from the `.md` and NOT joined against the `.json`, and that is a
 * correction of a real defect rather than a preference. The `.json` carries
 * `event_id` and the `.md` carries the slug, the question and the rule text;
 * neither carries the other's, so the only key they share is position. And
 * position does not hold: the `.json` is written in COMPLETION order -- four
 * calls run at once and `saidas.push` records whoever finishes first -- while
 * the `.md` walks the sample in order. On the 2026-08-22 run the two orders
 * disagree on two swapped pairs, so a positional join hands 4 of the 21
 * failures another market's rule.
 *
 * The `.md` block already has the code, the message, the slug and the rule side
 * by side, all written from the same market. Nothing needs to be joined.
 */
export function lerFalhasDoMd(md: string): Falha[] {
  const out: Falha[] = [];
  for (const secao of md.split(/\n### \d+\. /).slice(1)) {
    const m = /> \*\*FALHOU\*\* \(`([^`]+)`\): (.*)/.exec(secao);
    if (m === null) continue;
    out.push({
      pergunta: secao.split('\n', 1)[0] ?? '',
      slug: /<sub>`([^`]+)`/.exec(secao)?.[1] ?? '?',
      regra: /```\n([\s\S]*?)\n```/.exec(secao)?.[1] ?? '',
      codigo: m[1] as string,
      mensagem: (m[2] as string).trim(),
    });
  }
  return out;
}

/** The run's identity lines: only what precedes the first section. */
export function cabecalhoDoMd(md: string): { linhas: string[]; rodouEm: string | null } {
  // The contradictions block further down opens each reading with
  // `- **leitura A:**`, and a whole-file filter dragged eleven of them into the
  // run's identity table.
  const ate = md.indexOf('\n## ');
  const topo = ate === -1 ? md : md.slice(0, ate);
  return {
    linhas: topo.split('\n').filter(l => l.startsWith('- **')),
    rodouEm: /- \*\*rodou em:\*\* (.+)/.exec(topo)?.[1]?.trim() ?? null,
  };
}

export function histograma(codigos: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of codigos) out.set(c, (out.get(c) ?? 0) + 1);
  return out;
}

/**
 * Where the two records of one run disagree, code by code.
 *
 * Empty means they are siblings. Anything else means the `.md` and the `.json`
 * came from different runs, and every rate computed from the pair would be a
 * blend of the two.
 */
export function divergencias(
  doJson: ReadonlyMap<string, number>,
  doMd: ReadonlyMap<string, number>,
): string[] {
  return [...new Set([...doJson.keys(), ...doMd.keys()])]
    .filter(k => (doJson.get(k) ?? 0) !== (doMd.get(k) ?? 0))
    .map(k => `${k}: ${doJson.get(k) ?? 0} no .json, ${doMd.get(k) ?? 0} no .md`);
}
