import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * O dev server é o proxy.
 *
 * Por que existe: o Supabase **recusa a service key vinda de navegador** — ele
 * detecta pelo User-Agent e devolve 401. Então a v1 não pode falar direto com o
 * PostgREST, e as views do radar têm `revoke all from anon, authenticated`, o
 * que descarta a chave anônima. Sobra um intermediário, e o mais barato que
 * existe é o servidor que já está rodando: o próprio Vite.
 *
 * O efeito colateral é o melhor da mudança: **a service key nunca entra no
 * bundle**. Ela é lida aqui, no processo do Node, a partir de variáveis SEM o
 * prefixo `VITE_` — e o Vite só inlina o que tem esse prefixo. Antes, a chave
 * viajava para o navegador e a única defesa era uma trava de runtime; agora ela
 * não tem caminho até lá.
 *
 * O navegador manda uma chave placeholder. O proxy a descarta e põe a de
 * verdade, junto com um User-Agent próprio — se o do navegador for repassado, o
 * Supabase bloqueia igual.
 */
export default defineConfig(({ command, mode }) => {
  // Prefixo vazio: carrega TODAS as variáveis de `web/.env.local`, inclusive as
  // sem `VITE_`. Elas ficam neste processo e não são expostas ao cliente.
  const env = loadEnv(mode, process.cwd(), '');
  const url = env['SUPABASE_URL'] ?? '';
  const key = env['SUPABASE_SERVICE_KEY'] ?? '';

  if (command === 'serve' && (!url || !key)) {
    throw new Error(
      'Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_KEY em `web/.env.local`.\n\n' +
        'ATENÇÃO: sem o prefixo VITE_. O prefixo faria o Vite inlinar a chave no ' +
        'bundle, que é exatamente o que este desenho existe para evitar — a chave ' +
        'é usada aqui, no proxy do dev server.',
    );
  }

  return {
    plugins: [react()],
    server: {
      // `src/lib/prob-self.ts` mora fora de `web/` e é importado por caminho
      // relativo. Em nenhuma hipótese um segundo parser de probabilidade.
      fs: { allow: ['..'] },

      proxy:
        url && key
          ? {
              '/sb': {
                target: `${url}/rest/v1`,
                changeOrigin: true,
                // O cliente pede `/sb/rest/v1/<coisa>` (o `/rest/v1` é o
                // supabase-js que monta). O alvo já termina em `/rest/v1`,
                // então o prefixo inteiro sai daqui.
                rewrite: (p: string) => p.replace(/^\/sb\/rest\/v1/, ''),
                configure: (proxy: {
                  on: (
                    ev: string,
                    cb: (req: { setHeader: (n: string, v: string) => void }) => void,
                  ) => void;
                }) => {
                  proxy.on('proxyReq', proxyReq => {
                    // A chave do navegador é placeholder e é substituída aqui.
                    proxyReq.setHeader('apikey', key);
                    proxyReq.setHeader('Authorization', `Bearer ${key}`);
                    // Sem isto o User-Agent do navegador é repassado e o
                    // Supabase bloqueia a service key do mesmo jeito — que é o
                    // 401 que motivou este proxy.
                    proxyReq.setHeader('User-Agent', 'prediction-radar-web/0.1 (vite dev proxy)');
                  });
                },
              },
            }
          : undefined,
    },
  };
});
