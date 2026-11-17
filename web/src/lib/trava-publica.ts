/**
 * What took `trava.ts`'s place (issue 85, code review on PR 92).
 *
 * Next inlines every `NEXT_PUBLIC_*` variable into the browser bundle. This
 * screen needs none, so a public variable that names a secret, or holds a
 * value that looks like one, is someone reopening the path from the key to
 * the browser. `next.config.ts` runs this on every `next build` and `next dev`
 * and stops them; on Vercel that includes variables set in the dashboard,
 * which CI never sees.
 *
 * It looks at the name AND the value: a secret under an innocent name leaks
 * the same. It reports names only, never values.
 */

const NOME_SUSPEITO = /KEY|SECRET|SENHA|SEGREDO|SERVICE/i;

/** Does the value look like a server secret, or like a CI canary? */
function pareceSegredo(valor: string): boolean {
  const v = valor.trim();
  if (v.startsWith('sb_secret_') || v.startsWith('canario-') || v.includes('service_role')) {
    return true;
  }
  // Legacy Supabase key: a JWT whose payload declares the role.
  const partes = v.split('.');
  if (partes.length === 3 && partes[0]!.startsWith('eyJ')) {
    try {
      const payload = JSON.parse(Buffer.from(partes[1]!, 'base64url').toString('utf8')) as {
        role?: unknown;
      } | null;
      return payload?.role === 'service_role';
    } catch {
      return false;
    }
  }
  return false;
}

export function variaveisPublicasSuspeitas(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([nome]) => nome.startsWith('NEXT_PUBLIC_'))
    .filter(([nome, valor]) => NOME_SUSPEITO.test(nome) || pareceSegredo(valor ?? ''))
    .map(([nome]) => nome)
    .sort();
}

export function conferirVariaveisPublicas(env: Record<string, string | undefined>): void {
  const suspeitas = variaveisPublicasSuspeitas(env);
  if (suspeitas.length === 0) return;
  throw new Error(
    `ABORTADO: ${suspeitas.join(', ')} ${suspeitas.length === 1 ? 'tem' : 'têm'} cara de segredo.\n\n` +
      'Toda variável NEXT_PUBLIC_ é copiada para o bundle do navegador. Esta tela não precisa ' +
      'de nenhuma: SUPABASE_URL, SUPABASE_SERVICE_KEY, RADAR_SENHA e RADAR_SEGREDO_DE_SESSAO ' +
      'ficam sem prefixo e são lidas só no servidor. Tire o prefixo, ou a variável.',
  );
}
