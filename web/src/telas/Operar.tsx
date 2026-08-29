import { useState } from 'react';
// O parser mora no backend e é importado por caminho relativo. Em nenhuma
// hipótese um segundo parser: `prob_self` tem que sair na mesma escala de
// `mid_price` e de `kelly({ probability })`, e o jeito de garantir isso é haver
// um arquivo só. Ele é TypeScript puro, sem nada de Node.
import { formatarProb, lerProbabilidade } from '../../../src/lib/prob-self';
import { decideSide } from '../../../src/lib/prob-self-outcome';
import { gravarLeg, gravarPrevisao } from '../lib/dados';
import type { MercadoNaLista } from '../lib/tipos';
import { data, idade, preco, segundos, urlPolymarket } from '../lib/formato';

/**
 * O momento da aposta.
 *
 * A probabilidade é registrada ANTES de ir para a Polymarket, e essa ordem é o
 * requisito inteiro desta aba — não é detalhe de UX. Número escrito depois de
 * ver o resultado da entrada não vale como previsão, e o Brier de daqui a dois
 * meses não tem como saber a diferença.
 *
 * Por isso o botão que abre o mercado só existe DEPOIS do insert.
 */

type Estado =
  | { fase: 'digitando' }
  | { fase: 'confirmando'; prob: number }
  | { fase: 'salvando' }
  | { fase: 'salvo'; betId: string; prob: number; levouMs: number | null };

export function Operar({
  mercado,
  inicioMs,
  onVoltarParaRegra,
  onVoltar,
}: {
  mercado: MercadoNaLista;
  inicioMs: number | null;
  onVoltarParaRegra: () => void;
  onVoltar: () => void;
}) {
  const [bruto, setBruto] = useState('');
  const [nota, setNota] = useState('');
  const [mostrarNota, setMostrarNota] = useState(false);
  const [estado, setEstado] = useState<Estado>({ fase: 'digitando' });
  const [erro, setErro] = useState<string | null>(null);

  const url = urlPolymarket(mercado.slug, mercado.event_group_slug);

  function conferir() {
    const leitura = lerProbabilidade(bruto);
    if (!leitura.ok) {
      setErro(leitura.motivo);
      return;
    }
    setErro(null);
    setEstado({ fase: 'confirmando', prob: leitura.prob });
  }

  const lado = decideSide({ kind: 'single_market', outcome: mercado.outcome });

  async function salvar(prob: number) {
    setEstado({ fase: 'salvando' });
    setErro(null);
    try {
      const betId = await gravarPrevisao({
        eventId: mercado.id,
        prob,
        categoria: mercado.categoria,
        nota: nota.trim() || null,
        // A linha de base. `mid_price` nulo grava NULL — nunca 0,50.
        precoMercado: mercado.mid_price,
        precoMercadoEm: mercado.preco_em,
        precoMercadoOutcome: mercado.outcome,
        // The side the question above named. It is the same expression as
        // `precoMercadoOutcome` and it is not the same fact: this one is only
        // true because the question names the side, so the number answered is
        // about it. Take the label out of the question and this write becomes
        // a guess wearing a label.
        //
        // Through `decideSide` so the screen and the bot cannot answer this
        // differently. `refuse` cannot arrive here: the render above returns
        // early on a market with no side, so the form never opens.
        probSelfOutcome: lado.kind === 'label' ? lado.outcome : null,
      });
      setEstado({
        fase: 'salvo',
        betId,
        prob,
        levouMs: inicioMs === null ? null : performance.now() - inicioMs,
      });
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
      setEstado({ fase: 'confirmando', prob });
    }
  }

  // No side, no question to ask.
  //
  // The side comes from the last snapshot, so a roster market that has never
  // been captured has none. Measured on 29/08/2026: 0 of 1074 roster markets,
  // so this is a guard and not a common path. It exists because the two ways
  // out of here are both worse than refusing: the insert would be rejected by
  // `my_bets_prob_self_tem_lado`, which would surface as a raw Postgres error
  // on top of a filled-in form; and a probability recorded with no side is not
  // scorable later, which is the whole defect this screen was fixed for.
  if (lado.kind === 'refuse') {
    return (
      <div className="operar">
        <button className="voltar" onClick={onVoltarParaRegra}>
          ← A regra
        </button>
        <h1>{mercado.pergunta}</h1>
        <p className="erro">
          Este mercado ainda não tem lado: nenhuma foto do livro chegou. Sem
          saber de que desfecho é a probabilidade, ela não pode ser pontuada
          depois, então a tela não grava. Tenta de novo quando o radar capturar.
        </p>
      </div>
    );
  }

  return (
    <div className="operar">
      {/* The way back up the flow. The tab bar used to be it, and removing the
          tabs without this would strand a half-filled form with no exit until
          the insert went through. */}
      <button className="voltar" onClick={onVoltarParaRegra}>
        ← A regra
      </button>

      <h1>{mercado.pergunta}</h1>

      <div className="base-de-mercado">
        <span>
          preço do mercado agora: <strong>{preco(mercado.mid_price)}</strong>
          {mercado.outcome && <em> ({mercado.outcome})</em>}
        </span>
        <span>
          foto de {data(mercado.preco_em)} · {idade(mercado.preco_idade_min)} atrás
        </span>
        {mercado.mid_price === null && (
          <span className="nota-nulo">
            livro de um lado só — a linha de base vai NULA, não 0,50
          </span>
        )}
      </div>

      {estado.fase === 'digitando' && (
        <div className="passo">
          <label>
            {/* The side is named here, and that is what makes the recorded
                `prob_self_outcome` true rather than lucky. "Isso acontecer"
                let the reader supply their own side, and the row then stored
                a label derived from the market instead of from the answer. */}
            <span className="pergunta">
              Sua probabilidade de <strong>{mercado.outcome}</strong>, em %?
            </span>
            <input
              autoFocus
              value={bruto}
              placeholder="ex: 72"
              onChange={e => setBruto(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && conferir()}
            />
          </label>
          {erro && <p className="erro">{erro}</p>}

          {mostrarNota ? (
            <label className="nota">
              nota (opcional)
              <input value={nota} onChange={e => setNota(e.target.value)} />
            </label>
          ) : (
            <button className="link" onClick={() => setMostrarNota(true)}>
              + nota
            </button>
          )}

          <button className="principal" onClick={conferir}>
            conferir
          </button>
        </div>
      )}

      {estado.fase === 'confirmando' && (
        <div className="passo confirmacao">
          <h2>Confere?</h2>
          {/* O resumo é a defesa contra "0.72" quando se queria 72%: o parser não
              adivinha, a tela mostra o número interpretado antes de gravar. */}
          {/* Both lines carry the same side, so the pair reads as one
              comparison. Before, "72,0%" sat above "mercado: 0,37 (No)" and
              the two were sides of the same market shown as comparable. */}
          <p className="numero">
            {formatarProb(estado.prob)} ({mercado.outcome})
          </p>
          <p className="contra">
            mercado: {preco(mercado.mid_price)} ({mercado.outcome})
          </p>
          {nota.trim() && <p className="nota-resumo">nota: {nota.trim()}</p>}
          {erro && <p className="erro">{erro}</p>}
          <div className="acoes">
            <button onClick={() => setEstado({ fase: 'digitando' })}>voltar e corrigir</button>
            <button className="principal" onClick={() => salvar(estado.prob)}>
              salvar
            </button>
          </div>
        </div>
      )}

      {estado.fase === 'salvando' && <div className="passo">gravando…</div>}

      {estado.fase === 'salvo' && (
        <div className="passo salvo">
          <h2>Registrado: {formatarProb(estado.prob)}</h2>
          {estado.levouMs !== null && (
            <p className="cronometro">da lista até aqui: {segundos(estado.levouMs)}</p>
          )}
          {/* Só agora. */}
          {url ? (
            <a className="principal" href={url} target="_blank" rel="noreferrer">
              abrir na Polymarket ↗
            </a>
          ) : (
            <p className="erro">Este mercado não tem slug — não dá para montar a URL.</p>
          )}
          <DepoisDeOperar betId={estado.betId} mercado={mercado} />
          <button onClick={onVoltar}>voltar para a lista</button>
        </div>
      )}
    </div>
  );
}

/**
 * A operação em si, opcional e depois. O campo obrigatório era a probabilidade,
 * e ela já está gravada.
 *
 * Enquanto isto não for preenchido, a linha em `my_bets` não tem leg — e é
 * assim que "previsão sem operação" fica derivável, sem flag nenhuma.
 */
function DepoisDeOperar({ betId, mercado }: { betId: string; mercado: MercadoNaLista }) {
  const [aberto, setAberto] = useState(false);
  const [outcome, setOutcome] = useState(mercado.outcome ?? '');
  const [entrada, setEntrada] = useState('');
  const [stake, setStake] = useState('');
  const [feito, setFeito] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  if (feito) return <p className="ok">Operação registrada na aposta.</p>;

  if (!aberto) {
    return (
      <button className="link" onClick={() => setAberto(true)}>
        + registrar a operação (lado, preço de entrada, stake)
      </button>
    );
  }

  async function salvar() {
    const precoEntrada = Number(entrada.replace(',', '.'));
    const valor = Number(stake.replace(',', '.'));
    if (!outcome.trim()) return setErro('falta o lado');
    if (!Number.isFinite(precoEntrada) || precoEntrada <= 0 || precoEntrada > 1)
      return setErro('preço de entrada tem que estar em (0, 1]');
    if (!Number.isFinite(valor) || valor <= 0) return setErro('stake tem que ser > 0');
    try {
      await gravarLeg({
        betId,
        eventId: mercado.id,
        outcome: outcome.trim(),
        entryPrice: precoEntrada,
        stakeUsd: valor,
      });
      setFeito(true);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="leg">
      <p className="explica">
        O preço de entrada <strong>não</strong> é o preço de mercado: entrada tem taxa e
        slippage dentro. A linha de base já foi gravada com a previsão.
      </p>
      <label>
        lado <input value={outcome} onChange={e => setOutcome(e.target.value)} />
      </label>
      <label>
        preço de entrada (0–1){' '}
        <input value={entrada} onChange={e => setEntrada(e.target.value)} placeholder="0.62" />
      </label>
      <label>
        stake (US$) <input value={stake} onChange={e => setStake(e.target.value)} placeholder="25" />
      </label>
      {erro && <p className="erro">{erro}</p>}
      <button onClick={salvar}>gravar a operação</button>
    </div>
  );
}
