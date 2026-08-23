import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cabecalhoDoMd,
  campoETermo,
  causaDe,
  divergencias,
  ehHedge,
  histograma,
  lerFalhasDoMd,
} from './digest-nulo.js';

/**
 * A run report shaped like the real one, small enough to hold in the head.
 *
 * Three markets, and the middle one SUCCEEDED. That is the whole point of the
 * fixture: a success sitting between two failures is what makes "the second
 * failure" and "the second market" different positions, which is the mistake
 * this module exists to not make.
 */
const MD = `# Digestão de regras — degrau 3, prompt \`v4\`

- **mercados:** 3
- **chamadas:** 3

## ⚠️ Contradições internas — 1

- **leitura A:** uma leitura que mora depois do cabeçalho
- **leitura B:** e outra

## As digestões

### 1. Primeira pergunta?

<sub>\`slug-um\` · tema · hash \`aaa\` · 10 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

\`\`\`
REGRA UM
\`\`\`

</details>

> **FALHOU** (\`opiniao\`): saída contém opinião sobre desfecho em resolve_nao ("provável"): ...trecho um...

---

### 2. Segunda pergunta?

<sub>\`slug-dois\` · tema · hash \`bbb\` · 10 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

\`\`\`
REGRA DOIS
\`\`\`

</details>

**Resolve SIM:**

- esta deu certo

---

### 3. Terceira pergunta?

<sub>\`slug-tres\` · tema · hash \`ccc\` · 10 caracteres de regra</sub>

<details><summary>a regra, íntegra</summary>

\`\`\`
REGRA TRES
\`\`\`

</details>

> **FALHOU** (\`api_error\`): fetch failed
`;

describe('lerFalhasDoMd', () => {
  /**
   * The assertion is the SEQUENCE of pairs, not the count and not the set.
   *
   * Counting would not bite. The defect being locked out here -- joining the
   * `.json`'s completion order onto the `.md`'s sample order -- swaps which
   * rule belongs to which failure and leaves every total identical: still two
   * failures, still one `opiniao` and one `api_error`, still the same two
   * slugs. Only the pairing moves, so only the pairing can catch it.
   */
  it('dá a cada falha o mercado, a regra e o trecho DELA', () => {
    const falhas = lerFalhasDoMd(MD);

    assert.deepEqual(
      falhas.map(f => [f.slug, f.codigo, f.regra, f.mensagem]),
      [
        [
          'slug-um',
          'opiniao',
          'REGRA UM',
          'saída contém opinião sobre desfecho em resolve_nao ("provável"): ...trecho um...',
        ],
        ['slug-tres', 'api_error', 'REGRA TRES', 'fetch failed'],
      ],
    );
  });

  it('pula o mercado que não falhou sem deslocar os que vêm depois', () => {
    const falhas = lerFalhasDoMd(MD);

    assert.equal(falhas.length, 2);
    // `slug-dois` succeeded: it is absent, and its absence did not push
    // `slug-tres` onto the rule of the market before it.
    assert.equal(
      falhas.some(f => f.slug === 'slug-dois'),
      false,
    );
    assert.equal(falhas[1]?.regra, 'REGRA TRES');
  });

  it('devolve lista vazia quando nada falhou', () => {
    assert.deepEqual(lerFalhasDoMd(MD.replace(/> \*\*FALHOU\*\*.*/g, '')), []);
  });
});

describe('cabecalhoDoMd', () => {
  /**
   * The report's contradictions block opens each reading with
   * `- **leitura A:**`, and a whole-file filter dragged eleven of them into the
   * run's identity table on the first draft of this command.
   */
  it('para na primeira seção e não colhe as leituras de baixo', () => {
    const { linhas } = cabecalhoDoMd(MD);

    assert.deepEqual(linhas, ['- **mercados:** 3', '- **chamadas:** 3']);
  });

  it('lê o carimbo quando a corrida o gravou, e null quando não', () => {
    assert.equal(cabecalhoDoMd(MD).rodouEm, null);
    assert.equal(
      cabecalhoDoMd('# t\n\n- **rodou em:** 2026-08-22T05:39:43.872Z\n\n## x\n').rodouEm,
      '2026-08-22T05:39:43.872Z',
    );
  });
});

describe('ehHedge', () => {
  /**
   * The four combinations the 2026-08-22 run produced, and the reason each
   * falls where it does. `provável` is the adjective out of the rule's own
   * "prospective, contingent, probable or conditional"; `provavelmente` is the
   * model saying it is not sure.
   */
  it('separa o advérbio de dúvida e o campo de leitura do vocabulário da regra', () => {
    assert.equal(ehHedge('resolve_nao', 'provável'), false);
    assert.equal(ehHedge('pegadinhas', 'provável'), false);
    assert.equal(ehHedge('resolve_sim', 'oportunidade'), false);
    assert.equal(ehHedge('resolve_nao', 'chance de'), false);

    assert.equal(ehHedge('ambiguidades', 'provavelmente'), true);
    assert.equal(ehHedge('pegadinhas', 'provavelmente'), true);
    assert.equal(ehHedge('ambiguidades', 'chance de'), true);
  });
});

describe('campoETermo', () => {
  it('recupera campo e termo da mensagem que a trava escreveu', () => {
    assert.deepEqual(
      campoETermo('saída contém opinião sobre desfecho em pegadinhas ("provavelmente"): ...x...'),
      { campo: 'pegadinhas', termo: 'provavelmente' },
    );
  });

  it('devolve null para mensagem de outro código', () => {
    assert.equal(campoETermo('fetch failed'), null);
  });
});

describe('causaDe', () => {
  it('agrupa por resposta e não por código', () => {
    assert.equal(causaDe('api_error')?.chave, 'transporte');
    assert.equal(causaDe('not_json')?.chave, 'transporte');
    assert.equal(causaDe('tipo_invalido')?.chave, 'saida_malformada');
    assert.equal(causaDe('opiniao')?.chave, 'guarda_opiniao');
  });

  it('devolve null para código que a lista ainda não conhece', () => {
    assert.equal(causaDe('codigo_que_nao_existe'), null);
  });
});

describe('divergencias', () => {
  it('cala quando os dois arquivos são da mesma corrida', () => {
    assert.deepEqual(divergencias(histograma(['opiniao', 'opiniao']), histograma(['opiniao', 'opiniao'])), []);
  });

  it('acusa o código que só um dos dois tem', () => {
    assert.deepEqual(divergencias(histograma(['opiniao', 'api_error']), histograma(['opiniao'])), [
      'api_error: 1 no .json, 0 no .md',
    ]);
  });
});
