import { createClient } from '@supabase/supabase-js';
import { conferirEnvDoCliente } from './trava';

/**
 * O client da tela. Ele NÃO tem credencial.
 *
 * O Supabase recusa a service key vinda de navegador — detecta pelo User-Agent
 * e devolve 401. E a chave anônima não serve: as três views do radar têm
 * `revoke all from anon, authenticated` (`20260814151752_...sql:439`,
 * `20260817040920_...sql:452`, `20260817033302_...sql:236`) e nenhuma tabela
 * tem policy de RLS.
 *
 * Então o caminho é um intermediário, e o mais barato é o servidor que já está
 * rodando: o dev server do Vite. Ele encaminha `/sb` para o PostgREST trocando
 * `apikey`, `Authorization` e `User-Agent` (`vite.config.ts`).
 *
 * A chave abaixo é placeholder e o proxy a descarta. Ela existe porque o
 * supabase-js exige uma string — não porque autentique alguma coisa.
 *
 * Consequência boa: a service key nunca entra no bundle. Ela é lida no
 * `vite.config.ts`, de variáveis sem prefixo `VITE_`, e o Vite não inlina
 * essas. Não é uma trava, é ausência de caminho.
 *
 * Consequência: esta tela só funciona em `npm run dev`. Sem dev server não há
 * proxy, e sem proxy não há banco.
 */

// Aborta se alguém reabrir o caminho da chave até o navegador.
conferirEnvDoCliente(import.meta.env as unknown as Record<string, unknown>);

const PLACEHOLDER = 'trocada-pelo-proxy-do-vite';

/**
 * `location.origin` e não `localhost:5173` fixo: o Vite troca de porta quando a
 * padrão está ocupada, e uma porta chumbada quebraria em silêncio.
 */
const BASE = `${window.location.origin}/sb`;

export const supabase = createClient(BASE, PLACEHOLDER, {
  auth: { persistSession: false, autoRefreshToken: false },
});
