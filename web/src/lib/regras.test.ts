import { test } from 'node:test';
import assert from 'node:assert/strict';

import { juntarRadarComDigest, leiturasPorTexto, textosParaLer } from './regras.js';
import type {
  ContagemDigest,
  LeituraRegra,
  LinhaAchados,
  MercadoRadar,
} from './tipos.js';

/**
 * FIXTURE SINTÉTICO — não é caso observado.
 *
 * Medido em 22/08/2026 por `npm run medir:tela-regra`,
 * `digest_achados_por_mercado` tinha 1033 linhas para 1033 mercados: NENHUM
 * mercado tem hoje dois textos de regra. O caso abaixo é
 * construído à mão, e o que ele trava é um defeito LATENTE: a granularidade da
 * view é (mercado, texto), a Polymarket editar uma descrição produz a segunda
 * linha, e nesse dia o defeito passa a morder em produção.
 *
 * `dados.ts` já registra a mesma expectativa no `lerAchados`, que devolve lista
 * em vez de usar `.single()` justamente porque "a granularidade da view é
 * (mercado, texto de regra)".
 */

function mercado(id: string): MercadoRadar {
  return {
    id,
    slug: `slug-${id}`,
    pergunta: `pergunta de ${id}`,
    categoria: null,
    tema: null,
    assunto: null,
    outcome: 'Yes',
    best_bid: null,
    best_ask: null,
    mid_price: null,
    spread: null,
    preco_em: null,
    preco_idade_min: null,
    var_24h: null,
    var_24h_base: null,
    var_7d: null,
    var_7d_base: null,
    liquidez: null,
    fecha_em: null,
    dias_restantes: null,
    tamanho_regra: null,
    prob_self: null,
    prob_self_em: null,
    prob_self_estrategia: null,
  };
}

function contagem(
  eventId: string,
  sha: string,
  campos: Partial<ContagemDigest> = {},
): ContagemDigest {
  return {
    event_id: eventId,
    description_sha256: sha,
    leituras_do_texto: 3,
    mercados_do_texto: 1,
    achados_total: 0,
    achados_acusados: 0,
    achados_herdados: 0,
    pegadinhas: 0,
    ambiguidades: 0,
    contradicoes: 0,
    pegadinhas_muda_resultado: 0,
    confirmacao_maxima: 0,
    ...campos,
  };
}

test('mercado com dois textos de regra não perde as contagens de nenhum deles', () => {
  // A descrição foi editada: duas linhas na view para o MESMO event_id, uma por
  // hash. Um Map chaveado só por event_id faz a segunda apagar a primeira.
  const radar = [mercado('e1')];
  const contagens = [
    contagem('e1', 'sha-antigo', { contradicoes: 2, achados_total: 5 }),
    contagem('e1', 'sha-novo', { contradicoes: 1, achados_total: 3 }),
  ];

  const [linha] = juntarRadarComDigest(radar, contagens);

  assert.equal(
    linha?.digests?.length,
    2,
    `os dois textos têm que sobreviver, veio ${JSON.stringify(linha?.digests)}`,
  );
  // E as contagens dos DOIS: com o Map por event_id, a segunda linha vencia e o
  // mercado exibia 1 contradição no lugar das 3 que carrega.
  assert.equal(
    (linha?.digests ?? []).reduce((acc, d) => acc + d.contradicoes, 0),
    3,
  );
});

test('dois mercados que compartilham o mesmo texto de regra recebem cada um o seu', () => {
  // Propagação por hash: mercados irmãos com a MESMA regra. Cada um tem a sua
  // linha na view, e uma não pode servir pelo outro.
  const radar = [mercado('e1'), mercado('e2')];
  const contagens = [
    contagem('e1', 'sha-comum', { contradicoes: 4 }),
    contagem('e2', 'sha-comum', { contradicoes: 4 }),
  ];

  const linhas = juntarRadarComDigest(radar, contagens);

  assert.deepEqual(
    linhas.map(l => l.digests.map(d => d.event_id)),
    [['e1'], ['e2']],
  );
});

test('mercado do radar sem digestão continua na lista, com lista vazia', () => {
  // 20 dos 942 do roster estão assim, medido em 22/08/2026 por
  // `npm run medir:tela-regra`. Sumir da lista seria descarte silencioso.
  const linhas = juntarRadarComDigest([mercado('e1')], []);

  assert.equal(linhas.length, 1);
  assert.deepEqual(linhas[0]?.digests, []);
});

// ---------------------------------------------------------------------------
// textosParaLer / leiturasPorTexto — a tela de detalhe
// ---------------------------------------------------------------------------

function linha(eventId: string, sha: string): LinhaAchados {
  return { ...contagem(eventId, sha), slug: `slug-${eventId}`, title: 't', achados: [] };
}

function leitura(sha: string, n: number): LeituraRegra {
  return {
    id: `${sha}-${n}`,
    event_id: 'e1',
    description_sha256: sha,
    leitura_n: n,
    resolve_sim: [],
    resolve_nao: [],
    fonte: null,
    prazo: null,
    anula_se: [],
    model: 'deepseek-v4-flash',
    prompt_version: 'v4',
    created_at: '2026-08-22T00:00:00Z',
  };
}

test('mercado com dois textos de regra pede as leituras dos DOIS', () => {
  // FIXTURE SINTÉTICO — ver o cabeçalho deste arquivo. Com um só hash buscado, o
  // segundo bloco da tela renderiza a leitura do primeiro texto: uma regra
  // exibida no lugar de outra.
  const linhas = [linha('e1', 'sha-antigo'), linha('e1', 'sha-novo')];

  assert.deepEqual(textosParaLer(linhas), ['sha-antigo', 'sha-novo']);
});

test('mercado sem digestão não pede leitura nenhuma', () => {
  assert.deepEqual(textosParaLer([]), []);
});

test('cada texto recebe só as suas leituras', () => {
  const porTexto = leiturasPorTexto([
    leitura('sha-antigo', 1),
    leitura('sha-novo', 1),
    leitura('sha-antigo', 2),
  ]);

  assert.deepEqual(
    porTexto.get('sha-antigo')?.map(l => l.leitura_n),
    [1, 2],
  );
  assert.deepEqual(
    porTexto.get('sha-novo')?.map(l => l.leitura_n),
    [1],
  );
});
