import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './estilo.css';

const raiz = document.getElementById('raiz');
if (!raiz) throw new Error('div#raiz não existe no index.html');

/**
 * O import do client é dinâmico de propósito: a trava de produção (e a checagem
 * de env) mora no topo do módulo e roda no import. Importando assim, a mensagem
 * de erro chega à tela em vez de morrer num módulo que nunca terminou de
 * carregar — o app aborta, e o dono lê por quê.
 */
try {
  const { App } = await import('./App');
  createRoot(raiz).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (e) {
  raiz.innerHTML = '';
  const box = document.createElement('pre');
  box.className = 'abortado';
  box.textContent = e instanceof Error ? e.message : String(e);
  raiz.appendChild(box);
}
