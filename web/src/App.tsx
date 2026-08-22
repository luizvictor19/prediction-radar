import { useEffect, useMemo, useState } from 'react';
import { lerContagens, lerRadar } from './lib/dados';
import { juntarRadarComDigest } from './lib/regras';
import type { MercadoNaLista } from './lib/tipos';
import { Hoje } from './telas/Hoje';
import { Regra } from './telas/Regra';
import { Operar } from './telas/Operar';

type Aba = 'hoje' | 'regra' | 'operar';

export function App() {
  const [mercados, setMercados] = useState<MercadoNaLista[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aba, setAba] = useState<Aba>('hoje');
  const [selecionadoId, setSelecionadoId] = useState<string | null>(null);

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

  const selecionado = useMemo(
    () => mercados?.find(m => m.id === selecionadoId) ?? null,
    [mercados, selecionadoId],
  );

  function abrirRegra(id: string) {
    setSelecionadoId(id);
    setAba('regra');
  }

  function abrirOperar(id: string) {
    setSelecionadoId(id);
    setInicioMs(performance.now());
    setAba('operar');
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

  return (
    <div className="app">
      <nav className="abas">
        <button className={aba === 'hoje' ? 'ativa' : ''} onClick={() => setAba('hoje')}>
          Hoje
        </button>
        <button
          className={aba === 'regra' ? 'ativa' : ''}
          disabled={!selecionado}
          onClick={() => setAba('regra')}
        >
          A regra
        </button>
        <button
          className={aba === 'operar' ? 'ativa' : ''}
          disabled={!selecionado}
          onClick={() => {
            if (inicioMs === null) setInicioMs(performance.now());
            setAba('operar');
          }}
        >
          Operar
        </button>
        {selecionado && <span className="selecionado">{selecionado.pergunta}</span>}
      </nav>

      {aba === 'hoje' && (
        <Hoje mercados={mercados} onAbrirRegra={abrirRegra} onOperar={abrirOperar} />
      )}
      {aba === 'regra' && selecionado && (
        <Regra mercado={selecionado} onOperar={() => abrirOperar(selecionado.id)} />
      )}
      {aba === 'operar' && selecionado && (
        <Operar
          mercado={selecionado}
          inicioMs={inicioMs}
          onVoltar={() => {
            setInicioMs(null);
            setAba('hoje');
          }}
        />
      )}
    </div>
  );
}
