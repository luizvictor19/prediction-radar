import { useEffect, useState } from 'react';
import {
  lerAchados,
  lerContradicoes,
  lerCorpusDigerido,
  lerLeituras,
  lerTextoDaRegra,
} from '../lib/dados';
import { separarBoilerplate, type Frequencia } from '../lib/boilerplate';
import { anexarLeituras } from '../lib/concordancia';
import { fundirPorAbsorcao } from '../lib/dedup';
import type { CorpusDigerido } from '../lib/dados';
import { estadoVazio, type EstadoVazio } from '../lib/vazios';
import type { Achado, Contradicao, LeituraRegra, LinhaAchados, MercadoNaLista } from '../lib/tipos';
import {
  CAMPOS,
  camposDivergentes,
  divergem,
  leituraExibida,
  MINIMO_LEITURAS,
  procedencia,
  seloDeConfirmacao,
  valores,
} from '../lib/leituras';
import { leiturasPorTexto, sha256Hex, textosParaLer } from '../lib/regras';
import { ehArmadilha, ehArmadilhaDeResultado, escolherVeredito } from '../lib/veredito';
import { separarHerdados } from '../lib/herdados';
import { ancorasDeSegmentos, destacar, type Segmento } from '../lib/destaque';
import { mostraTrechoNaEsquerda } from '../lib/evidencia';
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

/**
 * Qual tratamento visual de SELEÇÃO está ativo.
 *
 * `sel-escolhida` em 23/08/2026, e as três candidatas — `sel-v1`, `sel-v2`,
 * `sel-v3` — continuam em `estilo.css` como registro da decisão. Trocar esta
 * string troca o tratamento inteiro; é a única linha a mexer para comparar de
 * novo, e o cabeçalho da seção lá diz por que a mistura venceu.
 *
 * A restrição que gerou as três: **cor já carrega significado nesta tela.**
 * `--alerta` forte diz "muda o resultado" e claro diz "padrão da casa". Se a
 * seleção usasse esses tons de fundo, dois significados disputariam o mesmo
 * canal e ninguém saberia se o item está tingido por ser grave ou por estar
 * selecionado. Então a seleção usa OUTROS canais — barra, contorno, relevo — e
 * o mesmo dos dois lados, para o vínculo ser óbvio.
 */
const VARIANTE_DE_SELECAO = 'sel-v2';

/**
 * O regulamento tem QUATRO estados, e conflatá-los foi o defeito.
 *
 * `string | null` dizia "lendo" e "não existe" com o mesmo valor, então um
 * mercado sem `events.description` ficava para sempre em "lendo o
 * regulamento…" — uma espera que nunca termina, indistinguível de uma lenta.
 *
 * `ausente` é resposta, não falta de resposta: é a mesma distinção que
 * `somaDigest` faz devolvendo `null` em vez de `0`, e que a tela já honra em
 * toda parte menos aqui.
 */
type EstadoDoRegulamento =
  | { fase: 'lendo' }
  | { fase: 'ausente' }
  | { fase: 'erro'; motivo: string }
  | { fase: 'lido'; texto: string; sha: string };

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

  const [regulamento, setRegulamento] = useState<EstadoDoRegulamento>({ fase: 'lendo' });

  /**
   * `null` enquanto as três consultas de frequência não voltam, e `null` também
   * se elas falharem. É estado legítimo, não erro: sem índice tudo aparece e
   * nada recolhe. O achado se mostra de qualquer jeito — só ainda não sabe se é
   * padrão da casa. Por isso nenhum spinner segura os achados.
   */
  const [corpus, setCorpus] = useState<CorpusDigerido | null>(null);

  useEffect(() => {
    let vivo = true;
    setLinhas(null);
    setLeituras(new Map());
    setAlcance(new Map());
    setRegulamento({ fase: 'lendo' });
    setErro(null);

    (async () => {
      try {
        // O regulamento sai junto com os achados: ele deixou de ser uma dobra
        // que se abre sob demanda e virou a coluna direita, que abre com a tela.
        lerTextoDaRegra(mercado.id)
          .then(async texto => {
            if (!vivo) return;
            // `null` é resposta, não espera: o mercado não tem descrição
            // guardada. Sem distinguir as duas, a coluna ficava para sempre em
            // "lendo o regulamento…" — uma espera que nunca termina.
            if (texto === null) return setRegulamento({ fase: 'ausente' });
            const sha = await sha256Hex(texto);
            if (vivo) setRegulamento({ fase: 'lido', texto, sha });
          })
          .catch(e => {
            // O erro fica NA COLUNA. Mandá-lo para `erro` derrubava a tela
            // inteira e jogava fora os achados, o veredito e as leituras que já
            // tinham chegado — perder o que funcionou por causa do que falhou.
            if (vivo) setRegulamento({ fase: 'erro', motivo: e instanceof Error ? e.message : String(e) });
          });

        // Em paralelo, e sem travar nada: o índice é do corpus inteiro e chega
        // quando chegar. Falha dele não é erro de tela — é só o gate não
        // recolhendo, que é o estado seguro.
        lerCorpusDigerido()
          .then(c => {
            if (vivo) setCorpus(c);
          })
          .catch(() => {});

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
    <div className={`regra ${VARIANTE_DE_SELECAO}`}>
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

      {linhas.map(linha => (
        <BlocoDeTexto
          key={linha.description_sha256}
          linha={linha}
          varios={linhas.length > 1}
          leituras={leituras.get(linha.description_sha256) ?? []}
          alcance={alcance}
          mercado={mercado}
          regulamento={regulamento}
          corpus={corpus}
        />
      ))}
    </div>
  );
}

/**
 * Um texto de regra: as duas faixas, as duas colunas.
 *
 * É componente próprio porque os dois lados compartilham estado — qual armadilha
 * está acesa, e quantas estão visíveis. Estado num `map` do pai seria hook
 * dentro de laço, e o teto de armadilhas precisa ser o MESMO número dos dois
 * lados: destacar as escondidas atrás do "ver mais" pinta quase todo parágrafo e
 * o destaque deixa de distinguir coisa nenhuma.
 */
function BlocoDeTexto({
  linha,
  varios,
  leituras,
  alcance,
  mercado,
  regulamento,
  corpus,
}: {
  linha: LinhaAchados;
  varios: boolean;
  leituras: LeituraRegra[];
  alcance: Map<string, Contradicao>;
  mercado: MercadoNaLista;
  regulamento: EstadoDoRegulamento;
  corpus: CorpusDigerido | null;
}) {
  /** O achado sob o cursor. Acende o trecho dele na coluna direita. */
  const [aceso, setAceso] = useState<string | null>(null);
  /**
   * A armadilha FIXADA pelo clique. Hover é transitório e some ao sair; o
   * clique fica. Clicar na mesma desmarca, e só uma vive por vez — duas
   * selecionadas fariam o vínculo com a direita deixar de ser um-para-um.
   */
  const [fixado, setFixado] = useState<string | null>(null);
  const [todasArmadilhas, setTodasArmadilhas] = useState(false);

  const brutos = linha.achados ?? [];

  /**
   * A fusão por absorção — item 2, seção 4 — finalmente no caminho de render.
   *
   * Ela precisa do CONJUNTO de `digest_id` por achado, e a view entrega só a
   * contagem. `anexarLeituras` faz a junção com as linhas-filhas que a mesma
   * leitura do corpus já trouxe para o gate; o que não casar sai em
   * `semLeituras` e a tela avisa, porque um conjunto vazio silencioso viraria
   * concordância `0/n` num achado que a view diz ter sido encontrado.
   *
   * Sem o corpus, nada funde: os achados aparecem como a view os entrega. É o
   * mesmo estado válido do índice nulo — a tela mostra tudo e só ainda não
   * agrupou.
   */
  const { achados, naoAnexados } = (() => {
    if (corpus === null) return { achados: brutos, naoAnexados: 0 };

    const { comLeituras, semLeituras } = anexarLeituras(
      linha.description_sha256,
      brutos,
      corpus.leiturasPorChave,
    );

    const fundidos = fundirPorAbsorcao(comLeituras);
    // A concordância exibida passa a ser o tamanho da UNIÃO, não o número da
    // view: é o ponto inteiro da fusão.
    const comContagem = fundidos.map(a => ({ ...a, vezes_encontrado: a.leituras.length }));

    return {
      achados: [...comContagem, ...semLeituras] as Achado[],
      naoAnexados: semLeituras.length,
    };
  })();

  // A origem separa antes de tudo: o que este mercado acusou fica nas seções, o
  // que ele herdou desce para a dobra. Contradição herdada desce junto — é
  // decisão do item 5, seção 4, e o motivo é que um achado sem `leitura_a` nem
  // `leitura_b` é o menos acionável da tela disfarçado do mais grave.
  const { acusados, herdados } = separarHerdados(achados);

  // O gate roda DEPOIS da separação por origem e SÓ sobre os acusados: um
  // herdado já está recolhido, e recolhê-lo de novo por ser padrão da casa o
  // faria aparecer em dois blocos ou em nenhum. Índice nulo devolve tudo em
  // `visiveis`, que é o estado enquanto as três consultas não voltaram.
  const { visiveis: acusadosVisiveis, comuns } = separarBoilerplate(acusados, corpus?.indice ?? null);

  const porConcordancia = (a: Achado, b: Achado) => b.vezes_encontrado - a.vezes_encontrado;
  const armadilhas = acusadosVisiveis
    .filter(ehArmadilha)
    .sort(porConcordancia);
  const contradicoes = acusadosVisiveis.filter(a => a.classe === 'contradicao');
  const resto = acusadosVisiveis
    .filter(a => a.classe !== 'contradicao' && !armadilhas.includes(a))
    .sort(porConcordancia);

  // O que saiu da vista principal, e é o número do azulejo "recolhidos".
  const recolhidos = comuns.length + herdados.length;

  const vazioArmadilhas = estadoVazio({
    leituras: leituras.length,
    acusados: armadilhas.length,
    // `ehArmadilha` e não `ehArmadilhaDeResultado`: a pergunta aqui é sobre as
    // HERDADAS, e um predicado que exige `acusado` responderia zero sempre.
    herdados: herdados.filter(ehArmadilha).length,
  });
  const vazioContradicoes = estadoVazio({
    leituras: leituras.length,
    acusados: contradicoes.length,
    herdados: herdados.filter(a => a.classe === 'contradicao').length,
  });

  const visiveis = todasArmadilhas ? armadilhas : armadilhas.slice(0, TETO_DE_ARMADILHAS);

  // A armadilha que virou veredito não repete a prosa aqui embaixo: a faixa do
  // topo já a escreveu inteira, palavra por palavra.
  const veredito = escolherVeredito(achados);

  /**
   * O destaque é calculado AQUI, e não dentro da coluna direita, porque as duas
   * colunas precisam do mesmo conjunto: o invariante de `evidencia.ts` é que o
   * trecho aparece exatamente uma vez, e para a esquerda saber se deve mostrá-lo
   * ela tem que saber o que a direita marcou de fato.
   *
   * "De fato" é a palavra que importa: `naoLocalizados` não entra em
   * `destacados`, então uma armadilha com âncora quebrada volta a mostrar a
   * citação no item, em vez de sumir dos dois lados.
   */
  const mesmoTexto =
    regulamento.fase === 'lido' && regulamento.sha === linha.description_sha256;
  const { segmentos, naoLocalizados } = destacar(
    mesmoTexto && regulamento.fase === 'lido' ? regulamento.texto : '',
    mesmoTexto
      ? [
          // `forte` = muda o resultado ou o prazo, e só as VISÍVEIS na
          // esquerda: destacar as escondidas atrás do "ver mais" pinta quase
          // todo parágrafo, e destaque que cobre tudo não distingue nada.
          ...visiveis.map(a => ({ id: a.achado_id, trecho: a.trecho, marca: 'forte' as const })),
          // `clara` = comum a quase todo regulamento. O gate agora tem as
          // frequências, então este tom finalmente tem fonte — antes dele
          // nada era claro, e a legenda documentava uma cor que não existia.
          // São passagens curtas e poucas (3 pares recolhidos em 22/08/2026),
          // não um segundo paredão.
          ...comuns.map(({ achado }) => ({
            id: achado.achado_id,
            trecho: achado.trecho,
            marca: 'clara' as const,
          })),
        ]
      : [],
  );
  const destacados = new Set(segmentos.flatMap(s => s.ids));

  function irAteOTrecho(id: string) {
    // `data-trecho` e não `id`: um elemento tem UM id, e dois achados que citam
    // a mesma passagem começam no mesmo segmento. Com `id`, um dos dois ficava
    // sem âncora e o clique não rolava a lugar nenhum, sem nada dizendo por quê.
    // `~=` casa um token dentro da lista separada por espaço.
    document
      .querySelector(`[data-trecho~="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  const ligacao = (a: Achado) => ({
    aceso: aceso === a.achado_id,
    selecionado: fixado === a.achado_id,
    onAcender: () => setAceso(a.achado_id),
    onApagar: () => setAceso(null),
    onIr: () => {
      const mesmo = fixado === a.achado_id;
      setFixado(mesmo ? null : a.achado_id);
      // Desmarcar não rola: o leitor já está olhando o trecho.
      if (!mesmo) irAteOTrecho(a.achado_id);
    },
  });

  return (
        <div className="texto-de-regra">
      {varios && (
        <p className="aviso-dois-textos">
          Este mercado tem mais de um texto de regra digerido (a descrição foi editada).
          Bloco do texto <code>{linha.description_sha256.slice(0, 8)}</code>.
        </p>
      )}

      {/* Primeira dobra: as duas faixas resumem O MERCADO, não uma coluna, e é
          por isso que atravessam a largura inteira. Quem está varrendo lê as
          duas e sai; quem veio estudar segue. */}
      {naoAnexados > 0 && (
        // Taxa de anexação abaixo de 100% é defeito de junção, não
        // característica dos dados: estes achados existem na view e não
        // encontraram as linhas que os produziram, então a concordância deles é
        // a da view e não a união. Aparece porque um número errado calado é
        // pior que um número errado anunciado.
        <p className="aviso-juncao">
          <strong>{naoAnexados}</strong> achado{naoAnexados === 1 ? '' : 's'} sem as leituras
          de origem: a concordância deles é a da view, sem fusão. É falha de junção — o
          esperado é zero.
        </p>
      )}

      <MancheteVsRegra
        achados={achados}
        leituras={leituras}
        leiturasDoTexto={linha.leituras_do_texto}
      />
      <LinhaDeNumeros achados={achados} recolhidos={recolhidos} liquidez={mercado.liquidez} />

      <div className="duas-colunas">
        {/* ESQUERDA: opera. Ordenada pelo que decide primeiro. */}
        <div className="coluna-esquerda">
          <section className="armadilhas">
            <h2>Armadilhas que mudam o resultado</h2>

            <Vazio estado={vazioArmadilhas} o="armadilha que mude o resultado" />

            <ul className="achados">
              {visiveis.map(a => (
                <AchadoItem
                  key={a.achado_id}
                  achado={a}
                  mostraTrecho={mostraTrechoNaEsquerda(a, destacados)}
                  jaNoVeredito={a.achado_id === veredito?.achado_id}
                  {...ligacao(a)}
                />
              ))}
            </ul>

            {armadilhas.length > visiveis.length && (
              <button className="link" onClick={() => setTodasArmadilhas(true)}>
                ver mais {armadilhas.length - visiveis.length}
              </button>
            )}
          </section>

          <section>
            <h2>Contradições internas</h2>
            <Vazio estado={vazioContradicoes} o="contradição interna" />
            {contradicoes.map(c => (
              <Contradicao_ key={c.achado_id} achado={c} alcance={alcance.get(c.achado_id)} />
            ))}
          </section>

          <details className="dobra">
            <summary>A regra, lida</summary>
            <CamposDaRegra leituras={leituras} />
          </details>

          {resto.length > 0 && (
            <details className="dobra">
              <summary>Outras ambiguidades acusadas ({resto.length})</summary>
              <ul className="achados">
                {resto.map(a => (
                  <AchadoItem
                    key={a.achado_id}
                    achado={a}
                    mostraTrecho={mostraTrechoNaEsquerda(a, destacados)}
                  />
                ))}
              </ul>
            </details>
          )}

          {comuns.length > 0 && (
            <details className="dobra">
              <summary>
                {comuns.length} comuns a quase todos os regulamentos
              </summary>
              {/* P3 de novo: o mecanismo se explica UMA vez, no cabeçalho. */}
              <p className="mecanismo">
                Passagens que aparecem em quase todo regulamento da Polymarket. São texto
                padrão da plataforma, não característica deste mercado — e a frequência ao
                lado de cada uma é o que transforma ruído em contexto.
              </p>
              <ul className="achados">
                {comuns.map(({ achado, frequencia }) =>
                  // Contradição comum passa pelo `Contradicao_`, como no bloco
                  // herdado: as duas passagens dela não estão destacadas em
                  // lugar nenhum, e o item sozinho não as mostraria.
                  achado.classe === 'contradicao' ? (
                    <li key={achado.achado_id} className="achado contradicao">
                      <Contradicao_ achado={achado} alcance={alcance.get(achado.achado_id)} />
                    </li>
                  ) : (
                    <AchadoItem
                      key={achado.achado_id}
                      achado={achado}
                      frequencia={frequencia}
                      mostraTrecho={mostraTrechoNaEsquerda(achado, destacados)}
                    />
                  ),
                )}
              </ul>
            </details>
          )}

          {herdados.length > 0 && (
            <details className="dobra">
              <summary>
                {herdados.length} achados herdados de outros mercados com o mesmo texto de regra
              </summary>
              {/* O parágrafo do mecanismo, UMA vez (P3). Antes ele vinha
                  colado em cada item — dez vezes na mesma tela no mercado do
                  Bolsonaro. É o critério 4 da spec, e é aqui que ele fecha. */}
              <p className="mecanismo">
                O modelo nunca leu <em>este</em> mercado: estes achados vieram de mercados
                irmãos com o mesmo texto de regra. Por isso a descrição, o cenário e as duas
                leituras são nulos aqui — preenchê-los com os do vizinho faria propagação
                parecer detecção.
              </p>
              <ul className="achados">
                {herdados.map(a =>
                  // A contradição herdada mantém as DUAS passagens: elas não
                  // estão destacadas na coluna direita, então aqui é o único
                  // lugar onde a evidência dela existe. Tirá-las deixaria o
                  // item com um selo e nada mais.
                  a.classe === 'contradicao' ? (
                    <li key={a.achado_id} className="achado contradicao">
                      <Contradicao_ achado={a} alcance={alcance.get(a.achado_id)} />
                    </li>
                  ) : (
                    <AchadoItem
                      key={a.achado_id}
                      achado={a}
                      mostraTrecho={mostraTrechoNaEsquerda(a, destacados)}
                    />
                  ),
                )}
              </ul>
            </details>
          )}
        </div>

        {/* DIREITA: prova. A cláusula onde ela vive, não recortada. */}
        <ColunaDireita
          regulamento={regulamento}
          mesmoTexto={mesmoTexto}
          shaDoBloco={linha.description_sha256}
          segmentos={segmentos}
          naoLocalizados={naoLocalizados.length}
          aceso={aceso}
          selecionado={fixado}
          tamanho={mercado.tamanho_regra}
        />
      </div>
    </div>
  );
}

/**
 * A largura em que as duas colunas deixam de caber lado a lado.
 *
 * O mesmo número está no `@media` do `estilo.css`. Ele vive nos dois lugares
 * porque um é layout e o outro é comportamento — e é por isso que a constante
 * carrega o aviso: mexer num sem o outro faz o regulamento empilhar aberto, que
 * é exatamente o que a etapa 5 existe para evitar.
 */
const ESTREITO = '(max-width: 900px)';

/** A tela está estreita agora? Reavalia quando a janela cruza o limiar. */
function useEstreito(): boolean {
  const [estreito, setEstreito] = useState(
    () => typeof matchMedia === 'function' && matchMedia(ESTREITO).matches,
  );

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(ESTREITO);
    const ouvir = (e: MediaQueryListEvent) => setEstreito(e.matches);
    mq.addEventListener('change', ouvir);
    setEstreito(mq.matches);
    return () => mq.removeEventListener('change', ouvir);
  }, []);

  return estreito;
}

/**
 * O estado vazio de uma seção, e nunca a ausência dela.
 *
 * As quatro frases da seção 5 do item 5. `estadoVazio` decide qual; aqui só se
 * escreve. Cada uma diz uma coisa diferente, e a que mais importa é a terceira:
 * anunciar "nenhuma" enquanto existem herdadas logo abaixo faria a tela mentir
 * sobre o que ela própria está exibindo.
 */
function Vazio({ estado, o }: { estado: EstadoVazio | null; o: string }) {
  if (estado === null) return null;

  if (estado.tipo === 'sem-leitura')
    return <p className="nada">Sem leitura registrada para este texto.</p>;

  if (estado.tipo === 'so-herdados')
    return (
      <p className="nada">
        Nenhuma {o} apontada por uma leitura <em>deste</em> mercado. Há{' '}
        <strong>{estado.herdados}</strong> herdada
        {estado.herdados === 1 ? '' : 's'} de outros mercados com o mesmo texto — no bloco
        recolhido abaixo.
      </p>
    );

  return (
    <p className="nada">
      {estado.leituras} leitura{estado.leituras === 1 ? '' : 's'}, nenhuma {o}.
    </p>
  );
}


/**
 * O teto de itens visíveis na seção de armadilhas.
 *
 * Cinco, calibrado e não chutado: M3 mediu, em 22/08/2026 por
 * `npm run medir:tela-regra`, mediana 3 e p90 6 de armadilhas acusadas por
 * mercado. O "ver mais N" aparece em 109 dos 1033 mercados (10,6%) — raro o
 * bastante para não virar ruído, comum o bastante para valer existir.
 */
const TETO_DE_ARMADILHAS = 5;


/**
 * Faixa 1 da primeira dobra: o veredito.
 *
 * The one question the whole project exists to answer -- where does the title
 * lie -- said in the place a reader looks first. It is selection, not writing:
 * `escolherVeredito` picks the strongest accused `muda_resultado` trap and its
 * two prose fields already carry the shape.
 *
 * The agreement badge travels with it. A 1/5 headline and a 5/5 headline are
 * both worth showing and are not worth the same, and the badge is what says so.
 */
function MancheteVsRegra({
  achados,
  leituras,
  leiturasDoTexto,
}: {
  achados: Achado[];
  leituras: LeituraRegra[];
  /** Quantas leituras o TEXTO teve, somando os mercados que o compartilham. */
  leiturasDoTexto: number;
}) {
  const veredito = escolherVeredito(achados);
  const exibida = leituraExibida(leituras);
  const plural = leituras.length === 1 ? 'leitura' : 'leituras';

  return (
    <section className="veredito">
      <h2>Manchete vs regra</h2>

      {veredito === null ? (
        // "Read and clean" is different information from "not read", and the
        // section says which one -- it never just fails to render.
        <p className="nada">
          {leituras.length === 0
            ? 'Sem leitura registrada para este texto.'
            : `${leituras.length} ${plural}, nenhuma armadilha que mude o resultado.`}
        </p>
      ) : (
        <>
          <p className="descricao">{veredito.descricao}</p>
          <p className="cenario">
            <span className="rotulo">cenário</span>
            {veredito.cenario}
          </p>
        </>
      )}

      {exibida && (
        <div className="proveniencia">
          {veredito && <SeloKN achado={veredito} />}
          {/* Cada número com o seu escopo: o selo conta leituras do TEXTO, e a
              linha contava as DESTE mercado. Lado a lado e sem rótulo, os dois
              liam como contradição. */}
          <span>
            {procedencia(leituras.length, leiturasDoTexto)} ·{' '}
            {exibida.model}/{exibida.prompt_version}
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * Faixa 2 da primeira dobra: a linha de números.
 *
 * Counted with `ehArmadilhaDeResultado`, the same predicate the verdict is
 * chosen with. A second copy would drift, and the band would show a headline
 * drawn from a trap its own counter does not count.
 */
function LinhaDeNumeros({
  achados,
  recolhidos,
  liquidez,
}: {
  achados: Achado[];
  recolhidos: number;
  liquidez: number | null;
}) {
  const armadilhas = achados.filter(ehArmadilhaDeResultado).length;
  const contradicoes = achados.filter(
    a => a.classe === 'contradicao' && a.origem === 'acusado',
  ).length;

  return (
    <div className="numeros-do-mercado">
      <span>
        <strong>{armadilhas}</strong> que mudam o resultado
      </span>
      <span>
        <strong>{contradicoes}</strong> contradições acusadas
      </span>
      {/* Padrão da casa mais herdados. Vem das listas que a tela realmente
          desenha, nunca de `ContagemDigest.achados_herdados` — aquele contador
          é anterior à separação e anunciaria um número que os blocos abaixo
          não confirmam. */}
      <span>
        <strong>{recolhidos}</strong> recolhidos
      </span>
      <span>
        <strong>{dinheiro(liquidez)}</strong> de liquidez
      </span>
    </div>
  );
}

/**
 * A coluna direita: o regulamento inteiro, com cada trecho marcado DENTRO dele.
 *
 * É o ponto do desenho. Recorte fora de contexto é exatamente como a manchete
 * engana, e mostrar a cláusula onde ela vive é o antídoto — por isso a coluna é
 * `sticky`: rolar as armadilhas não pode tirar o regulamento da vista.
 *
 * ## O hash é conferido, não presumido
 *
 * `market_rule_digests` guarda o hash do texto digerido, nunca o texto. O texto
 * mora em `events.description`, que é a descrição ATUAL. Quando a descrição foi
 * editada depois da digestão os dois deixam de ser a mesma coisa, e destacar os
 * trechos de uma versão sobre a outra atribuiria citação a um texto que não a
 * contém. Nesse caso a coluna não destaca nada e DIZ por quê — a versão antiga
 * não é recuperável, porque ninguém a guardou.
 */
function ColunaDireita({
  regulamento,
  mesmoTexto,
  shaDoBloco,
  segmentos,
  naoLocalizados,
  aceso,
  selecionado,
  tamanho,
}: {
  regulamento: EstadoDoRegulamento;
  /** O texto na tela é o que produziu estes achados? */
  mesmoTexto: boolean;
  shaDoBloco: string;
  /** Já calculado em `BlocoDeTexto`: as duas colunas leem o MESMO destaque. */
  segmentos: Segmento[];
  naoLocalizados: number;
  aceso: string | null;
  selecionado: string | null;
  tamanho: number | null;
}) {
  /**
   * No estreito o regulamento entra RECOLHIDO. Empilhado e aberto, um paredão
   * de texto em inglês fica logo abaixo do veredito e enterra as armadilhas —
   * que são o que a tela existe para mostrar primeiro. Aberto, o destaque
   * continua valendo igual.
   *
   * Controlado, e não só `open` inicial: o leitor pode abrir e fechar, e o
   * padrão volta a valer quando a janela cruza o limiar.
   */
  const estreito = useEstreito();
  const [aberto, setAberto] = useState(!estreito);
  useEffect(() => setAberto(!estreito), [estreito]);

  const cabecalho = (
    <summary>
      O regulamento
      {tamanho !== null && <span className="proveniencia">{tamanho} caracteres</span>}
    </summary>
  );

  if (regulamento.fase === 'lendo') {
    return (
      <aside className="coluna-direita">
        <p className="aviso">lendo o regulamento…</p>
      </aside>
    );
  }

  if (regulamento.fase === 'ausente') {
    return (
      <aside className="coluna-direita">
        <p className="aviso-versao">
          Este mercado não tem descrição guardada, então não há regulamento para mostrar.
          Os achados da esquerda continuam valendo — eles vieram de um texto que existiu
          quando a digestão rodou.
        </p>
      </aside>
    );
  }

  if (regulamento.fase === 'erro') {
    // Erro DESTA coluna, e só dela: o resto da tela continua em pé.
    return (
      <aside className="coluna-direita">
        <p className="erro">Não deu para ler o regulamento: {regulamento.motivo}</p>
      </aside>
    );
  }

  // O texto na tela é o de OUTRA versão da regra: não destaca.
  if (!mesmoTexto) {
    return (
      <aside className="coluna-direita">
        <details open={aberto} onToggle={e => setAberto(e.currentTarget.open)}>
          {cabecalho}
          <p className="aviso-versao">
            Os achados desta seção saíram de outra versão da regra (
            <code>{shaDoBloco.slice(0, 8)}</code>), e esse texto não está guardado — o
            banco registra o hash, não o texto. Abaixo está a descrição atual do
            mercado, <strong>sem destaques</strong>: marcar os trechos de uma versão
            sobre a outra apontaria citação para um texto que não a contém.
          </p>
          <pre className="regulamento">{regulamento.texto}</pre>
        </details>
      </aside>
    );
  }

  const tons = new Set(segmentos.map(s => s.marca).filter(Boolean));

  const ancoras = ancorasDeSegmentos(segmentos);

  return (
    <aside className="coluna-direita">
      <details open={aberto} onToggle={e => setAberto(e.currentTarget.open)}>
      {cabecalho}

      <pre className="regulamento">
        {segmentos.map((s, i) =>
          s.marca === null ? (
            <span key={i}>{s.texto}</span>
          ) : (
            <mark
              key={i}
              data-trecho={ancoras.get(i)?.join(' ')}
              className={[
                s.marca,
                aceso !== null && s.ids.includes(aceso) ? 'aceso' : '',
                selecionado !== null && s.ids.includes(selecionado) ? 'selecionado' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {s.texto}
            </mark>
          ),
        )}
      </pre>

      {naoLocalizados > 0 && (
        // A razão de `destacar` devolver duas coisas. Sem isto a coluna
        // mostraria menos destaques do que a esquerda mostra achados, e
        // ninguém contaria os dois lados para perceber.
        <p className="nao-localizado">
          {naoLocalizados}{' '}
          {naoLocalizados === 1 ? 'trecho não localizado' : 'trechos não localizados'} no texto
          acima. A citação desses achados voltou para o item, à esquerda — o que falhou foi a
          âncora, não a evidência.
        </p>
      )}

      {/* Cada entrada só aparece se aquele tom estiver REALMENTE na tela.
          Legenda de cor ausente descreve algo que o leitor procura e não
          acha. */}
      {tons.has('forte') && (
        <p className="legenda">
          <mark className="forte">tom forte</mark> muda o resultado ou o prazo
        </p>
      )}
      {tons.has('clara') && (
        <p className="legenda">
          <mark className="clara">tom claro</mark> comum a quase todo regulamento
        </p>
      )}
      </details>
    </aside>
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
          // A SEGUNDA cópia do parágrafo do mecanismo vivia aqui. Foi embora:
          // a contradição herdada agora mora no bloco recolhido, cujo cabeçalho
          // já explica por que estas duas leituras são nulas. Era o outro lado
          // do critério 4 — o parágrafo aparecia uma vez por item em duas
          // seções diferentes.
          null
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

/**
 * Um achado na coluna esquerda: o que ele SIGNIFICA.
 *
 * **Sem o trecho citado.** Ele está destacado dentro do regulamento, à direita,
 * e repeti-lo aqui é exatamente a duplicação que a coluna direita existe para
 * acabar — o recorte solto era o problema, não a solução. Aqui ficam descrição e
 * cenário; a evidência mora onde ela vive.
 *
 * `aceso`/`onIr` ligam os dois lados. Sete armadilhas à esquerda e sete
 * destaques à direita, sem ligação, não deixam saber qual é qual: o cursor
 * acende o trecho, o clique rola até ele.
 */
function AchadoItem({
  achado,
  mostraTrecho = true,
  jaNoVeredito = false,
  frequencia,
  aceso = false,
  selecionado = false,
  onAcender,
  onApagar,
  onIr,
}: {
  achado: Achado;
  /** Ver `evidencia.ts`: falso só quando o trecho está destacado à direita. */
  mostraTrecho?: boolean;
  jaNoVeredito?: boolean;
  frequencia?: Frequencia;
  aceso?: boolean;
  selecionado?: boolean;
  onAcender?: () => void;
  onApagar?: () => void;
  onIr?: () => void;
}) {
  const herdado = achado.origem === 'herdado';
  const ligavel = onIr !== undefined;

  return (
    <li
      className={[
        'achado',
        achado.classe,
        aceso ? 'aceso' : '',
        selecionado ? 'selecionado' : '',
        ligavel ? 'ligavel' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-current={selecionado ? 'true' : undefined}
      onMouseEnter={onAcender}
      onMouseLeave={onApagar}
      onClick={onIr}
    >
      <div className="linha-topo">
        {/* `pegadinha` e `muda_resultado` lado a lado dizem a mesma coisa. Fica
            o subtipo, que é o mais específico dos dois; a classe só aparece
            quando não há subtipo para falar por ela. */}
        {(achado.subtipos ?? []).length === 0 && (
          <span className="classe">{achado.classe}</span>
        )}
        <Selos achado={achado} />
      </div>

      {mostraTrecho && achado.trecho && (
        // A citação, quando ela não está marcada dentro do regulamento. O
        // invariante de `evidencia.ts`: exatamente um dos dois lados a mostra.
        <blockquote>{achado.trecho}</blockquote>
      )}

      {frequencia && (
        // A frequência é o produto, não o efeito colateral: saber que um
        // defeito aparece em 47% dos 267 regulamentos lidos é o que transforma
        // ruído em contexto. Sempre com o denominador — fração solta é opinião.
        <p className="frequencia">
          aparece em {Math.round(frequencia.fracao * 100)}% dos {frequencia.denominador}{' '}
          regulamentos lidos
        </p>
      )}

      {jaNoVeredito ? (
        // A faixa do topo já escreveu esta prosa inteira. Repeti-la aqui é a
        // mesma armadilha aparecendo duas vezes na mesma tela.
        <p className="ja-no-veredito">É a armadilha do veredito, no topo desta tela.</p>
      ) : herdado ? (
        // Nada aqui: o parágrafo do mecanismo mora no cabeçalho do bloco, uma
        // vez só (P3). O item leva o selo `herdado` de `Selos` e mais nada.
        null
      ) : (
        <>
          {achado.descricao && <p>{achado.descricao}</p>}
          {achado.cenario && (
            <p className="cenario">
              <span className="rotulo">cenário</span>
              {achado.cenario}
            </p>
          )}
          {/* A prosa da ambiguidade SÃO as duas leituras: a view anula
              `descricao` e `cenario` nela por construção. Sem isto, uma
              ambiguidade acusada renderiza como uma fileira de selos e nada
              mais. */}
          {achado.leitura_a && (
            <p className="leitura">
              <span className="rotulo">leitura A</span>
              {achado.leitura_a}
            </p>
          )}
          {achado.leitura_b && (
            <p className="leitura">
              <span className="rotulo">leitura B</span>
              {achado.leitura_b}
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

