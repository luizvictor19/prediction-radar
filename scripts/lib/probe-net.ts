/**
 * O cliente HTTP e o formato de snapshot das sondas — extraídos da fase 1.
 *
 * Nasceu dentro de `probe-xtracker.ts` e saiu de lá quando a fase 2 precisou das
 * mesmas quatro coisas: espaçar as chamadas, contá-las, gravar a resposta crua
 * com os dois hashes, e imprimir tabela alinhada. Copiar teria criado duas
 * versões do contador — e um relatório que diz "gastei 25 requisições" enquanto
 * a outra metade do programa gasta mais 3000 sem contar é pior que não contar.
 *
 * Nada aqui fala de XTracker, Gamma ou CLOB: é rede e formatação, e é isso.
 */

/** Espaçamento entre requisições. Cortesia, não limite documentado. */
export const SPACING_MS = 250;

export interface CallResult {
  status: number;
  etag: string | null;
  lastModified: string | null;
  text: string;
  body: unknown;
  bytes: number;
  ms: number;
}

/**
 * Quantas requisições foram para cada host.
 *
 * Map e não objeto de chaves fixas: a fase 2 acrescentou `data-api` e a 3
 * acrescentará outro. Um contador que precisa de alteração de tipo para
 * registrar um host novo é um contador que alguém vai contornar.
 */
const counters = new Map<string, number>();
let lastCallAt = 0;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function callCounts(): Array<[string, number]> {
  return [...counters.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

export function totalCalls(): number {
  let total = 0;
  for (const n of counters.values()) total += n;
  return total;
}

/**
 * Uma requisição GET, espaçada e contada.
 *
 * O `Accept` explícito não é decoração: o CLOB devolve 403 para cliente que não
 * manda cabeçalho nenhum — medido, ao portar a sonda de curl para código.
 */
export async function call(url: string, host: string): Promise<CallResult> {
  const wait = SPACING_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);

  const started = Date.now();
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  lastCallAt = Date.now();
  counters.set(host, (counters.get(host) ?? 0) + 1);

  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  return {
    status: response.status,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    text,
    body,
    bytes: text.length,
    ms: Date.now() - started,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** O XTracker embrulha tudo em `{ success, data }`. */
export function unwrap(body: unknown): unknown {
  return isRecord(body) && 'data' in body ? body['data'] : body;
}

// ---------------------------------------------------------------------------
// Snapshots — mesmo formato dos da OddsPapi
// ---------------------------------------------------------------------------

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function sha256(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Grava a resposta CRUA com endpoint, params e os dois hashes.
 *
 * O hash canônico responde "o conteúdo mudou?"; o cru responde "a serialização
 * mudou?". Separá-los é o que impede uma reordenação de chaves — que servidor
 * nenhum promete estável — de parecer que o passado foi reescrito.
 */
export async function writeSnapshot(
  label: string,
  file: string,
  kind: string,
  endpoint: string,
  params: Record<string, string>,
  res: CallResult,
): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');

  const snapshot = {
    kind,
    version: 1,
    fetchedAt: new Date().toISOString(),
    endpoint,
    params,
    status: res.status,
    etag: res.etag,
    lastModified: res.lastModified,
    rawSha256: await sha256(res.text),
    canonicalSha256: await sha256(canonical(res.body)),
    body: res.body,
  };

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.error(`[${label}] snapshot: ${file} (${(res.bytes / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

export function num(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

export function table(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  leftAlign: readonly number[] = [],
): string {
  if (rows.length === 0) return '  (vazio)';

  const left = new Set([0, ...leftAlign]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );

  const line = (cells: readonly string[]): string =>
    '  ' +
    cells
      .map((cell, i) => (left.has(i) ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();

  return [
    line(headers),
    ('  ' + widths.map((w) => '-'.repeat(w)).join('  ')).trimEnd(),
    ...rows.map(line),
  ].join('\n');
}

export function section(title: string): string {
  return `\n${title}\n${'='.repeat(title.length)}\n`;
}
