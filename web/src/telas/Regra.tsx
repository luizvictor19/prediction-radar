import { useEffect, useState } from 'react';
import { lerAchados, lerContradicoes, lerLeituras, lerTextoDaRegra } from '../lib/dados';
import type { Achado, Contradicao, LeituraRegra, LinhaAchados, MercadoNaLista } from '../lib/tipos';
import {
  CAMPOS,
  camposDivergentes,
  divergem,
  leituraExibida,
  MINIMO_LEITURAS,
  seloDeConfirmacao,
  valores,
} from '../lib/leituras';
import { leiturasPorTexto, textosParaLer } from '../lib/regras';
import { dinheiro, urlPolymarket } from '../lib/formato';

/**
 * O detalhe de um mercado, na ordem que o prompt fixa: contradições primeiro,
 * depois os campos da regra, depois pegadinhas e ambiguidades.
 *
 * Dois rótulos acompanham cada achado, e os dois são CONTAGEM, não opinião —
 * por isso são permitidos e por isso podem ordenar:
 *
 *   `2/3`               em quantas leituras daquele texto o achado apareceu.
 *   acusado / herdado   se o modelo leu este mercado, ou se veio de um irmão
 *                       com o mesmo texto de regra.
 *
 * Herdado tem leituras NULAS por construção (`left join` em
 * `20260817033302_...sql:170`). A tela deixa vazio e diz por quê. Preencher com
 * a leitura do vizinho seria inventar uma detecção que não houve.
 */

export function Regra({
  mercado,
  onVoltar,
  onOperar,
}: {
  mercado: MercadoNaLista;
  onVoltar: () => void;
  onOperar: () => void;
}) {
  const [linhas, setLinhas] = useState<LinhaAchados[] | null>(null);
  // Chaveado pelo hash do texto: cada bloco da tela recebe as leituras DELE.
  const [leituras, setLeituras] = useState<Map<string, LeituraRegra[]>>(new Map());
  const [alcance, setAlcance] = useState<Map<string, Contradicao>>(new Map());
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setLinhas(null);
    setLeituras(new Map());
    setAlcance(new Map());
    setErro(null);

    (async () => {
      try {
        const ls = await lerAchados(mercado.id);
        if (!vivo) return;
        setLinhas(ls);

        const shas = textosParaLer(ls);
        if (shas.length === 0) return;

        const [porTexto, contras] = await Promise.all([
          Promise.all(shas.map(sha => lerLeituras(mercado.id, sha))),
          lerContradicoes(
            ls
              .flatMap(l => l.achados ?? [])
              .filter(a => a.classe === 'contradicao')
              .map(a => a.achado_id),
          ),
        ]);
        if (!vivo) return;
        setLeituras(leiturasPorTexto(porTexto.flat()));
        setAlcance(new Map(contras.map(c => [c.defeito_id, c])));
      } catch (e) {
        if (vivo) setErro(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      vivo = false;
    };
  }, [mercado.id]);

  if (erro) return <div className="aviso erro">{erro}</div>;
  if (!linhas) return <div className="aviso">lendo a digestão…</div>;

  const url = urlPolymarket(mercado.slug);

  return (
    <div className="regra">
      <button className="voltar" onClick={onVoltar}>
        ← Hoje
      </button>

      <header>
        <h1>{mercado.pergunta}</h1>
        {/* One primary button per screen, and this is it. Polymarket is the
            secondary: leaving for the exchange before the probability is
            written down is the order the whole flow exists to prevent. */}
        <div className="acoes">
          {url && (
            <a href={url} target="_blank" rel="noreferrer">
              Polymarket ↗
            </a>
          )}
          <button className="principal" onClick={onOperar}>
            Operar neste mercado
          </button>
        </div>
      </header>

      {linhas.length === 0 && (
        <p className="sem-digestao">
          Este mercado ainda não foi digerido. A regra existe, a leitura dela não.
        </p>
      )}

      {linhas.map(linha => {
        const achados = linha.achados ?? [];
        const contradicoes = achados.filter(a => a.classe === 'contradicao');
        const resto = achados
          .filter(a => a.classe !== 'contradicao')
          .sort((a, b) => b.vezes_encontrado - a.vezes_encontrado);

        return (
          <div key={linha.description_sha256} className="texto-de-regra">
            {linhas.length > 1 && (
              <p className="aviso-dois-textos">
                Este mercado tem mais de um texto de regra digerido (a descrição foi
                editada). Bloco do texto <code>{linha.description_sha256.slice(0, 8)}</code>.
              </p>
            )}

            {/* 1. Contradições, primeiro. */}
            <section>
              <h2>Contradições</h2>
              {contradicoes.length === 0 && (
                <p className="nada">Nenhuma contradição apontada neste texto.</p>
              )}
              {contradicoes.map(c => (
                <Contradicao_ key={c.achado_id} achado={c} alcance={alcance.get(c.achado_id)} />
              ))}
            </section>

            {/* 2. Os campos da regra. */}
            <CamposDaRegra leituras={leituras.get(linha.description_sha256) ?? []} />

            {/* 3. Pegadinhas e ambiguidades. */}
            <section>
              <h2>Pegadinhas e ambiguidades</h2>
              {resto.length === 0 && <p className="nada">Nada apontado.</p>}
              <ul className="achados">
                {resto.map(a => (
                  <AchadoItem key={a.achado_id} achado={a} />
                ))}
              </ul>
            </section>

            <TextoOriginal eventId={mercado.id} tamanho={mercado.tamanho_regra} />
          </div>
        );
      })}
    </div>
  );
}

function Selos({ achado }: { achado: Achado }) {
  return (
    <span className="selos">
      <SeloKN achado={achado} />
      <span className={`origem ${achado.origem}`}>{achado.origem}</span>
      {(achado.subtipos ?? []).map(s => (
        <span key={s} className="subtipo">
          {s}
        </span>
      ))}
    </span>
  );
}

function SeloKN({ achado }: { achado: Achado }) {
  const selo = seloDeConfirmacao(achado.vezes_encontrado, achado.leituras_do_texto);
  return (
    <span
      className={selo.comparavel ? 'kn' : 'kn nao-comparavel'}
      title={
        selo.comparavel
          ? 'em quantas leituras deste texto o achado apareceu'
          : `o texto tem menos de ${MINIMO_LEITURAS} leituras: nao ha maioria para medir`
      }
    >
      {selo.texto}
    </span>
  );
}

function Contradicao_({ achado, alcance }: { achado: Achado; alcance: Contradicao | undefined }) {
  const herdado = achado.origem === 'herdado';
  return (
    <article className="contradicao">
      <Selos achado={achado} />

      <div className="passagens">
        <blockquote>
          <span className="rotulo">passagem A</span>
          {achado.trecho ?? '—'}
        </blockquote>
        <blockquote>
          <span className="rotulo">passagem B</span>
          {achado.trecho_conflito ?? '—'}
        </blockquote>
      </div>

      <div className="leituras-do-achado">
        {herdado ? (
          <p className="herdado-explica">
            Achado <strong>herdado</strong>: outro mercado com o mesmo texto de regra foi
            lido e apontou esta contradição. As duas leituras não existem para{' '}
            <em>este</em> mercado — e a do vizinho não vale aqui.
          </p>
        ) : (
          <>
            <div>
              <span className="rotulo">leitura A</span>
              {achado.leitura_a ?? '—'}
            </div>
            <div>
              <span className="rotulo">leitura B</span>
              {achado.leitura_b ?? '—'}
            </div>
          </>
        )}
      </div>

      {achado.descricao && !herdado && <p className="descricao">{achado.descricao}</p>}
      {achado.cenario && !herdado && (
        <p className="cenario">
          <span className="rotulo">cenário</span>
          {achado.cenario}
        </p>
      )}

      {alcance && (
        <p className="alcance">
          Este defeito de texto atinge <strong>{alcance.mercados_atingidos}</strong> mercados
          ({alcance.mercados_acusados} acusados, {alcance.mercados_herdados} herdados),{' '}
          {dinheiro(alcance.liquidez_total)} de liquidez somada.
        </p>
      )}
    </article>
  );
}

function AchadoItem({ achado }: { achado: Achado }) {
  const herdado = achado.origem === 'herdado';
  return (
    <li className={`achado ${achado.classe}`}>
      <div className="linha-topo">
        <span className="classe">{achado.classe}</span>
        <Selos achado={achado} />
      </div>
      {achado.trecho && <blockquote>{achado.trecho}</blockquote>}
      {herdado ? (
        <p className="herdado-explica">
          Herdado de um mercado com o mesmo texto de regra. A descrição e o cenário são
          nulos aqui porque não houve leitura deste mercado.
        </p>
      ) : (
        <>
          {achado.descricao && <p>{achado.descricao}</p>}
          {achado.cenario && (
            <p className="cenario">
              <span className="rotulo">cenário</span>
              {achado.cenario}
            </p>
          )}
        </>
      )}
    </li>
  );
}

/**
 * Os campos da regra, vindos de `market_rule_digests` — uma linha por leitura.
 *
 * Exibe a leitura de maior `leitura_n`. Quando as leituras divergem num campo,
 * um selo factual diz isso e o painel abre todas. Divergência não é ruído a
 * esconder: leitura diferente de "resolve SIM se" sobre a mesma regra é o sinal
 * de que a regra é ambígua, e é o que se quer saber no instante de decidir.
 */
function CamposDaRegra({ leituras }: { leituras: LeituraRegra[] }) {
  const [abertas, setAbertas] = useState(false);
  const exibida = leituraExibida(leituras);
  const divergentes = camposDivergentes(leituras);

  if (!exibida) {
    return (
      <section>
        <h2>A regra, lida</h2>
        <p className="nada">Sem leitura registrada para este texto.</p>
      </section>
    );
  }

  return (
    <section className="campos">
      <h2>
        A regra, lida
        <span className="proveniencia">
          leitura {exibida.leitura_n} de {leituras.length} · {exibida.model}/
          {exibida.prompt_version}
        </span>
        {divergentes.length > 0 && (
          <button className="selo-divergencia" onClick={() => setAbertas(v => !v)}>
            {leituras.length} leituras, divergem em {divergentes.length}{' '}
            {divergentes.length === 1 ? 'campo' : 'campos'} {abertas ? '▲' : '▼'}
          </button>
        )}
      </h2>

      {CAMPOS.map(campo => {
        const itens = valores(exibida, campo.chave);
        const diverge = divergem(leituras, campo.chave);
        return (
          <div key={campo.chave} className="campo">
            <h3>
              {campo.rotulo}
              {diverge && <span className="marca-divergencia">divergem</span>}
            </h3>
            {itens.length === 0 ? (
              <p className="nulo-explicado">
                {campo.chave === 'fonte'
                  ? 'A regra não nomeia fonte — isso é achado, não falta de dado.'
                  : '—'}
              </p>
            ) : (
              <ul>
                {itens.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {abertas && (
        <div className="todas-leituras">
          <h3>As {leituras.length} leituras, lado a lado</h3>
          <table>
            <thead>
              <tr>
                <th>campo</th>
                {leituras.map(l => (
                  <th key={l.id}>leitura {l.leitura_n}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAMPOS.map(campo => (
                <tr key={campo.chave} className={divergem(leituras, campo.chave) ? 'difere' : ''}>
                  <th>{campo.rotulo}</th>
                  {leituras.map(l => {
                    const itens = valores(l, campo.chave);
                    return (
                      <td key={l.id}>
                        {itens.length === 0 ? (
                          <span className="vazio">—</span>
                        ) : (
                          <ul>
                            {itens.map((v, i) => (
                              <li key={i}>{v}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** O regulamento cru. Lookup por PK, e só quando pedido. */
function TextoOriginal({ eventId, tamanho }: { eventId: string; tamanho: number | null }) {
  const [texto, setTexto] = useState<string | null>(null);
  const [aberto, setAberto] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function abrir() {
    setAberto(v => !v);
    if (texto === null && !erro) {
      try {
        setTexto(await lerTextoDaRegra(eventId));
      } catch (e) {
        setErro(e instanceof Error ? e.message : String(e));
      }
    }
  }

  return (
    <section className="texto-original">
      <button onClick={abrir}>
        {aberto ? '▲' : '▼'} ver o texto original
        {tamanho !== null && <span className="proveniencia">{tamanho} caracteres</span>}
      </button>
      {aberto && (erro ? <p className="erro">{erro}</p> : <pre>{texto ?? 'lendo…'}</pre>)}
    </section>
  );
}
