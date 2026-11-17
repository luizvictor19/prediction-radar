import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Radar · entrar' };

/**
 * A plain HTML form posted to `/api/entrar`: it works without JavaScript, and
 * the password never goes into a URL.
 */
export default function Entrar() {
  return (
    <main className="entrar">
      <h1>Radar</h1>
      <form method="post" action="/api/entrar">
        <label>
          senha
          <input type="password" name="senha" autoComplete="current-password" required autoFocus />
        </label>
        <button type="submit">entrar</button>
      </form>
    </main>
  );
}
