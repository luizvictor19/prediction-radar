import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractEntities, tokenize } from './market-pairing.js';

describe('tokenize', () => {
  it('derruba palavra gramatical e normaliza caixa', () => {
    assert.deepEqual(tokenize('Will the Lakers beat the Celtics?'), ['lakers', 'beat', 'celtics']);
  });

  it('preserva número, percentual e cifrão', () => {
    assert.deepEqual(tokenize('Will $BTC be above 100k in 2027?'), [
      '$btc',
      'above',
      '100k',
      '2027',
    ]);
  });
});

describe('extractEntities', () => {
  it('pega nome próprio composto', () => {
    const e = extractEntities('Will Donald Trump win Pennsylvania?');
    assert.ok(e.includes('donald trump'));
    assert.ok(e.includes('pennsylvania'));
  });

  it('não trata o "Will" inicial como nome próprio', () => {
    const e = extractEntities('Will Bitcoin hit 200000 before July?');
    assert.ok(!e.some((x) => x.startsWith('will ')));
    assert.ok(e.includes('bitcoin'));
  });

  it('mas "Will" no meio da frase segue sendo nome', () => {
    const e = extractEntities('Does Will Smith host the Oscars?');
    assert.ok(e.includes('will smith'));
  });

  it('pega ticker e sigla', () => {
    const e = extractEntities('Will NVDA beat GDP growth?');
    assert.ok(e.includes('nvda'));
    assert.ok(e.includes('gdp'));
  });

  it('normaliza separador de milhar', () => {
    const a = extractEntities('Bitcoin above 100,000?');
    const b = extractEntities('Bitcoin above 100000?');
    assert.ok(a.includes('100000'));
    assert.ok(b.includes('100000'));
  });
});
