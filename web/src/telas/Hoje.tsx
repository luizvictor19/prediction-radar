import { useMemo, useState } from 'react';
import type { MercadoNaLista } from '../lib/tipos';
import { dinheiro, prazo, preco, urlPolymarket, variacao, VAZIO } from '../lib/formato';
import { somaDigest, temDigestao } from '../lib/regras';

/**
 * A lista.
 *
 * REGRA INEGOCIÁVEL desta tela: ordenar e destacar por FATO, nunca por nota.
 * Prazo, variação, liquidez, spread, número de achados e "tem contradição" são
 * fatos. Não existe aqui nenhum número, cor, ícone ou ordenação derivada de
 * juízo do sistema sobre o mercado ser bom, atraente ou arriscado — porque no
 * instante em que a tela sugere, o dono deixa de ser o previsor e a medição
 * passa a medir o sistema com ele no meio.
 *
 * A ordenação é escolhida num seletor explícito. Nunca "inteligente".
 */

type Ordem = 'prazo' | 'var24' | 'var7d' | 'contradicao' | 'liquidez';

const ORDENS: { chave: Ordem; rotulo: string }[] = [
  { chave: 'prazo', rotulo: 'vence em breve' },
  { chave: 'var24', rotulo: 'maior variação em 24h' },
  { chave: 'var7d', rotulo: 'maior variação em 7d' },
  { chave: 'contradicao', rotulo: 'tem contradição interna' },
  { chave: 'liquidez', rotulo: 'maior liquidez' },
];

type Faixa = 'todos' | '2' | '7' | '30' | 'mais';

const FAIXAS: { chave: Faixa; rotulo: string }[] = [
  { chave: 'todos', rotulo: 'qualquer prazo' },
  { chave: '2', rotulo: 'até 2 dias' },
  { chave: '7', rotulo: 'até 7 dias' },
  { chave: '30', rotulo: 'até 30 dias' },
  { chave: 'mais', rotulo: 'mais de 30 dias' },
];

/** Nulo vai para o fim SEMPRE, em qualquer direção. Nulo não é zero. */
function ordenar<T>(itens: T[], valor: (x: T) => number | null, dir: 'asc' | 'desc'): T[] {
  return [...itens].sort((a, b) => {
    const va = valor(a);
    const vb = valor(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return dir === 'asc' ? va - vb : vb - va;
  });
}

export function Hoje({
  mercados,
  onAbrirRegra,
  onOperar,
}: {
  mercados: MercadoNaLista[];
  onAbrirRegra: (id: string) => void;
  onOperar: (id: string) => void;
}) {
  const [ordem, setOrdem] = useState<Ordem>('prazo');
  const [tema, setTema] = useState<string>('todos');
  const [faixa, setFaixa] = useState<Faixa>('todos');
  const [soContradicao, setSoContradicao] = useState(false);

  const temas = useMemo(() => {
    const s = new Set<string>();
    for (const m of mercados) s.add(m.tema ?? '(sem tema)');
    return [...s].sort();
  }, [mercados]);

  const { lista, derrubados } = useMemo(() => {
    let atual = mercados;
    const derrubados: string[] = [];

    const conta = (antes: number, rotulo: string) => {
      const fora = antes - atual.length;
      if (fora > 0) derrubados.push(`${fora} por ${rotulo}`);
    };

    if (tema !== 'todos') {
      const antes = atual.length;
      atual = atual.filter(m => (m.tema ?? '(sem tema)') === tema);
      conta(antes, 'tema');
    }
    if (faixa !== 'todos') {
      const antes = atual.length;
      atual = atual.filter(m => {
        const d = m.dias_restantes;
        if (d === null) return false;
        if (faixa === 'mais') return d > 30;
        return d <= Number(faixa);
      });
      conta(antes, 'prazo');
    }
    if (soContradicao) {
      const antes = atual.length;
      atual = atual.filter(m => (somaDigest(m, 'contradicoes') ?? 0) > 0);
      conta(antes, 'contradição');
    }

    const ordenada =
      ordem === 'prazo'
        ? ordenar(atual, m => m.dias_restantes, 'asc')
        : ordem === 'var24'
          ? ordenar(atual, m => (m.var_24h === null ? null : Math.abs(m.var_24h)), 'desc')
          : ordem === 'var7d'
            ? ordenar(atual, m => (m.var_7d === null ? null : Math.abs(m.var_7d)), 'desc')
            : ordem === 'contradicao'
              ? ordenar(atual, m => somaDigest(m, 'contradicoes'), 'desc')
              : ordenar(atual, m => m.liquidez, 'desc');

    return { lista: ordenada, derrubados };
  }, [mercados, ordem, tema, faixa, soContradicao]);

  return (
    <div className="hoje">
      <div className="controles">
        <label>
          ordenar por{' '}
          <select value={ordem} onChange={e => setOrdem(e.target.value as Ordem)}>
            {ORDENS.map(o => (
              <option key={o.chave} value={o.chave}>
                {o.rotulo}
              </option>
            ))}
          </select>
        </label>
        <label>
          tema{' '}
          <select value={tema} onChange={e => setTema(e.target.value)}>
            <option value="todos">todos</option>
            {temas.map(t => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          prazo{' '}
          <select value={faixa} onChange={e => setFaixa(e.target.value as Faixa)}>
            {FAIXAS.map(f => (
              <option key={f.chave} value={f.chave}>
                {f.rotulo}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={soContradicao}
            onChange={e => setSoContradicao(e.target.checked)}
          />{' '}
          só com contradição
        </label>
      </div>

      {/* Descarte que não é contado é cobertura perdida sem ninguém saber. */}
      <div className="contagem">
        {mercados.length} → <strong>{lista.length}</strong>
        {derrubados.length > 0 && <span className="fora"> ({derrubados.join(', ')})</span>}
      </div>

      <ul className="cards">
        {lista.map(m => (
          <li key={m.id} className="card">
            <div className="cabeca">
              <h2>{m.pergunta}</h2>
              <span className="tema">{m.tema ?? VAZIO}</span>
            </div>

            <div className="numeros">
              <span title="mid do livro">
                preço{' '}
                <strong>
                  {preco(m.mid_price)}
                  {m.mid_price === null && (
                    <em className="nota-nulo"> livro de um lado só</em>
                  )}
                </strong>
                {m.outcome && <em className="lado"> ({m.outcome})</em>}
              </span>
              <span>
                24h <strong>{variacao(m.var_24h)}</strong>
                {m.var_24h !== null && <em className="base"> {m.var_24h_base}</em>}
              </span>
              <span>
                7d <strong>{variacao(m.var_7d)}</strong>
                {m.var_7d !== null && <em className="base"> {m.var_7d_base}</em>}
              </span>
              <span>
                spread <strong>{preco(m.spread)}</strong>
              </span>
              <span>
                liquidez <strong>{dinheiro(m.liquidez)}</strong>
              </span>
              <span>
                prazo <strong>{prazo(m.dias_restantes)}</strong>
              </span>
            </div>

            <div className="achados-resumo">
              {temDigestao(m) ? (
                <>
                  <span>
                    {somaDigest(m, 'achados_total')} achados (
                    {somaDigest(m, 'achados_acusados')} acusados,{' '}
                    {somaDigest(m, 'achados_herdados')} herdados)
                  </span>
                  {(somaDigest(m, 'contradicoes') ?? 0) > 0 && (
                    <span className="selo">contradição na regra</span>
                  )}
                </>
              ) : (
                <span className="sem-digestao">sem digestão</span>
              )}
              {m.prob_self !== null && (
                <span className="ja-registrei">
                  minha última: {(m.prob_self * 100).toFixed(1)}%
                </span>
              )}
            </div>

            <div className="acoes">
              <button onClick={() => onAbrirRegra(m.id)}>ler a regra</button>
              <button onClick={() => onOperar(m.id)}>operar</button>
              {urlPolymarket(m.slug) && (
                <a href={urlPolymarket(m.slug)!} target="_blank" rel="noreferrer">
                  Polymarket ↗
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
