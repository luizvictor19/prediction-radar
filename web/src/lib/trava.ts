/**
 * A última linha.
 *
 * O desenho já impede a service key de chegar ao navegador: ela é lida no
 * `vite.config.ts`, de variáveis SEM o prefixo `VITE_`, e usada no proxy do dev
 * server. O Vite só inlina o que tem o prefixo, então não há caminho.
 *
 * O que esta trava cobre é o erro humano de reabrir esse caminho — alguém
 * acrescentar `VITE_SUPABASE_SERVICE_KEY` ao `.env.local` porque "não estava
 * funcionando". Aí a chave volta para o bundle, e "eu lembro de não fazer isso"
 * não é um mecanismo.
 *
 * Ela olha o VALOR, não o nome: um segredo com nome inocente vaza igual.
 */

/** Devolve o motivo, se o valor tem cara de chave secreta. `null` se não tem. */
export function pareceSegredo(valor: string): string | null {
  const v = valor.trim();
  if (!v) return null;

  // Formato novo do Supabase.
  if (v.startsWith('sb_secret_')) return 'começa com `sb_secret_`';

  // Formato legado: JWT cujo payload declara o papel.
  const partes = v.split('.');
  if (partes.length === 3 && partes[0]?.startsWith('eyJ')) {
    try {
      const cru = partes[1]!.replace(/-/g, '+').replace(/_/g, '/');
      const payload: unknown = JSON.parse(atob(cru));
      const papel = (payload as { role?: unknown } | null)?.role;
      if (papel === 'service_role') return 'é um JWT com `role: service_role`';
    } catch {
      // Não é um JWT legível. Não é motivo para abortar — a checagem abaixo
      // ainda pega o caso do literal solto.
    }
  }

  if (v.includes('service_role')) return 'contém `service_role`';
  return null;
}

/**
 * Varre o env que o Vite expôs ao cliente. Aborta na inicialização.
 *
 * `import.meta.env` é substituído por um objeto literal no build, então isto
 * funciona igual em `dev` e em `build`.
 */
export function conferirEnvDoCliente(env: Record<string, unknown>): void {
  for (const [nome, valor] of Object.entries(env)) {
    if (!nome.startsWith('VITE_')) continue;
    if (typeof valor !== 'string') continue;

    const motivo = pareceSegredo(valor);
    if (!motivo) continue;

    throw new Error(
      `ABORTADO: a variável ${nome} ${motivo}.\n\n` +
        'Tudo com prefixo VITE_ é inlinado no bundle e vai para o navegador. ' +
        'Uma chave secreta ali é o banco inteiro exposto — leitura e escrita, ' +
        'sem RLS no caminho.\n\n' +
        'Esta tela não precisa de chave nenhuma no cliente: ela fala com ' +
        '`/sb`, que é o proxy do dev server, e o proxy põe a chave real ' +
        '(`vite.config.ts`). Por isso a variável em `web/.env.local` chama-se ' +
        'SUPABASE_SERVICE_KEY, SEM o prefixo.\n\n' +
        'E por isso esta tela só roda em `npm run dev`: sem o dev server não há ' +
        'proxy, e sem proxy não há acesso ao banco. Um build publicado não ' +
        'funcionaria — e se funcionasse, seria porque a chave vazou.',
    );
  }
}
