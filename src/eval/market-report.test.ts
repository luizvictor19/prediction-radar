import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O relatório do mercado é texto, e é por texto que ele engana.
 *
 * As contas estão cobertas em `metrics.test.ts` e a montagem em
 * `market-dataset.test.ts`. O que se confere AQUI são as três frases sem as
 * quais um número certo produz a decisão que o número desaconselha:
 *
 *   - "não sei" e "não sobrevive" não podem sair como o mesmo `0`;
 *   - gap sem barra não é achado fraco, é não-achado;
 *   - série sem âncora não é preço recuperável.
 *
 * Nada aqui toca banco.
 */
process.env['SUPABASE_URL'] ??= 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] ??= 'test-key';

const { renderMarketReport } = await import('./market-report.js');

type MarketPoint = import('./market-dataset.js').MarketPoint;
type MarketDataset = import('./market-dataset.js').MarketDataset;
type LegacyCoverage = import('./market-dataset.js').LegacyCoverage;
type AnchorlessCoverage = import('./market-dataset.js').AnchorlessCoverage;

function point(index: number, overrides: Partial<MarketPoint> = {}): MarketPoint {
  const day = String((index % 20) + 1).padStart(2, '0');
  return {
    matchId: `m${index}`,
    matchSlug: `cs2-p${index}`,
    eventId: `e${index}`,
    checkpointMinutes: 60,
    scheduledAt: `2026-08-${day}T12:00:00.000Z`,
    anchorSource: 'scheduled_at',
    targetAt: `2026-08-${day}T11:00:00.000Z`,
    capturedAt: `2026-08-${day}T11:00:00.000Z`,
    offsetSeconds: 0,
    price: 0.45,
    spread: 0.02,
    outcome: 1,
    ...overrides,
  };
}

function dataset(points: readonly MarketPoint[]): MarketDataset {
  return {
    points: [...points],
    universe: {
      matches: [],
      resolvedRead: points.length,
      legacy: [],
      anchorless: [],
      discards: {
        anterior_a_serie: 0,
        sem_time_a: 0,
        sem_ancora: 0,
        sem_moneyline: 0,
        sem_outcome_a_index: 0,
        evento_ausente: 0,
        rotulo_nao_resolvido: 0,
      },
      duplicateMoneyline: 0,
    },
    coverage: new Map([[60, { semSnapshotNaTolerancia: 3, semMid: 0, janelasTruncadas: 0 }]]),
    snapshotsRead: points.length,
    queries: points.length,
  };
}

test('sem baldes testáveis nas duas metades, a linha 3 diz NÃO SEI e não zero', () => {
  // Dez partidas: qualquer balde tem no máximo cinco de cada lado do corte, então
  // nenhum é conclusivo nos dois. "0 sobreviventes" aqui seria falta de amostra
  // vestida de resultado negativo.
  const points = Array.from({ length: 10 }, (_, i) => point(i));
  const text = renderMarketReport(dataset(points), null, null);

  assert.match(text, /3\. divisão temporal: NÃO SEI/);
  assert.doesNotMatch(text, /3\. divisão temporal: 0 de 0/);
});

test('a barra aparece com o número, e o gap abaixo dela não vira candidato', () => {
  // 25 partidas no balde 0,40–0,50, todas com desfecho 1: previsto ~0,45,
  // observado 1,0. Amostra suficiente, gap enorme — o teste é que a barra saia
  // impressa junto, porque é ela que decide se o gap paga a travessia.
  const points = Array.from({ length: 25 }, (_, i) => point(i));
  const text = renderMarketReport(dataset(points), null, null);

  assert.match(text, /\|gap\| > 0\.0100 {2}\(½ de um spread típico de 0\.0200\)/);
  assert.match(text, /Baldes conclusivos \(≥ 20 partidas distintas\): 1 de 1/);
});

test('sem spread nenhum não há barra, e o relatório diz isso em vez de assumir uma', () => {
  const points = Array.from({ length: 25 }, (_, i) => point(i, { spread: null }));
  const text = renderMarketReport(dataset(points), null, null);

  assert.match(text, /o spread típico NÃO EXISTE nesta amostra/);
  assert.doesNotMatch(text, /CANDIDATO A EDGE/);
});

test('série sem âncora não é contada como preço recuperável', () => {
  const legacy: LegacyCoverage = {
    candidates: 7,
    probed: 7,
    comSeriePolymarket: 0,
    comSerieEsports: 0,
    comCheckpoint: 0,
    linhasRecuperaveis: 0,
    queries: 14,
  };
  const anchorless: AnchorlessCoverage = {
    candidates: 1755,
    probed: 1755,
    comSeriePolymarket: 0,
    comSerieEsports: 25,
    ultimaCaptura: '2026-08-06T02:15:01.407+00:00',
    queries: 3510,
  };

  const text = renderMarketReport(dataset([point(0)]), legacy, anchorless);

  // Existe série (25) e não existe linha recuperável (0). O relatório tem que
  // dizer as duas coisas — e a que decide o tamanho do universo é a segunda.
  assert.match(text, /NADA recuperável como linha/);
  assert.match(text, /25 partida\(s\) ainda têm alguma/);
  assert.doesNotMatch(text, /Há série recuperável/);
});
