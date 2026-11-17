import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { App } from '../App';
import { lerConfiguracao, NOME_DO_COOKIE, verificarSessao } from '../lib/sessao';

/**
 * The screen. Proxy already redirected a request without a session; this
 * second check keeps the page closed if the matcher ever stops covering `/`.
 * The data itself only comes through `/api`, which checks a third time.
 */
export default async function Inicio() {
  const cfg = lerConfiguracao(process.env);
  const valor = (await cookies()).get(NOME_DO_COOKIE)?.value;
  if (cfg === null || !verificarSessao(valor, cfg, Date.now())) redirect('/entrar');

  return (
    <>
      <App />
      <form className="sair" method="post" action="/api/sair">
        <button type="submit">sair</button>
      </form>
    </>
  );
}
