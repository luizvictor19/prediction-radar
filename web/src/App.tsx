import { useEffect, useMemo, useState } from 'react';
import { lerContagens, lerRadar } from './lib/dados';
import { juntarRadarComDigest } from './lib/regras';
import { cronometroApos, HOJE, mercadoDaRota, type Rota } from './lib/rota';
import type { MercadoNaLista } from './lib/tipos';
import { Hoje } from './telas/Hoje';
import { Regra } from './telas/Regra';
import { Operar } from './telas/Operar';

export function App() {
  const [mercados, setMercados] = useState<MercadoNaLista[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  // One route instead of a tab plus a selected id. The market rides in the
  // route, so "Operar with no market" is not a state that can be written down.
  const [rota, setRota] = useState<Rota>(HOJE);

  /**
   * O cronômetro do critério de pronto: quando saiu da lista rumo a operar.
   * Medir isso é parte do trabalho — "rápido" sem número é opinião.
   */
  const [inicioMs, setInicioMs] = useState<number | null>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        // Em paralelo: são duas views independentes.
        const [radar, contagens] = await Promise.all([lerRadar(), lerContagens()]);
        if (!vivo) return;
        setMercados(juntarRadarComDigest(radar, contagens));
      } catch (e) {
        if (vivo) setErro(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  const selecionado = useMemo(() => {
    const id = mercadoDaRota(rota);
    return id === null ? null : (mercados?.find(m => m.id === id) ?? null);
  }, [mercados, rota]);

  /**
   * The one way the screen changes. The stopwatch decision travels with the
   * route change instead of living in each handler -- which is what let
   * `abrirOperar` restart it on every call.
   */
  function ir(proxima: Rota) {
    setInicioMs(cronometroApos(rota, proxima, inicioMs, performance.now()));
    setRota(proxima);
  }

  if (erro) {
    return (
      <div className="aviso erro">
        <h1>Não deu para ler o banco</h1>
        <pre>{erro}</pre>
        <p>
          Esta tela lê o banco através do proxy do dev server (<code>/sb</code>), porque o
          Supabase recusa service key vinda de navegador. Duas causas prováveis:{' '}
          <code>web/.env.local</code> sem <code>SUPABASE_URL</code> /{' '}
          <code>SUPABASE_SERVICE_KEY</code> (sem o prefixo <code>VITE_</code>), ou a página
          aberta a partir de um build em vez de <code>npm run dev</code> — aí não existe
          proxy.
        </p>
      </div>
    );
  }

  if (!mercados) return <div className="aviso">carregando o roster…</div>;

  // The route carries an id; it does not promise the roster still has it. A
  // market that dropped out between load and click is a different state from
  // "no market", and it says so instead of rendering an empty screen.
  if (rota.tela !== 'hoje' && selecionado === null) {
    return (
      <div className="app">
        <button className="voltar" onClick={() => ir(HOJE)}>
          ← Hoje
        </button>
        <p className="aviso">
          Este mercado não está no roster carregado (<code>{rota.mercadoId}</code>).
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      {rota.tela === 'hoje' && (
        <Hoje
          mercados={mercados}
          onAbrirRegra={id => ir({ tela: 'regra', mercadoId: id })}
        />
      )}
      {rota.tela === 'regra' && selecionado && (
        <Regra
          mercado={selecionado}
          onVoltar={() => ir(HOJE)}
          onOperar={() => ir({ tela: 'operar', mercadoId: selecionado.id })}
        />
      )}
      {rota.tela === 'operar' && selecionado && (
        <Operar
          mercado={selecionado}
          inicioMs={inicioMs}
          onVoltarParaRegra={() => ir({ tela: 'regra', mercadoId: selecionado.id })}
          onVoltar={() => ir(HOJE)}
        />
      )}
    </div>
  );
}
