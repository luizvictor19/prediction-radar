import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getPrompt, promptVersions } from './analyst-prompts.js';
import type { PromptInput } from './analyst-prompts.js';

function input(overrides: Partial<PromptInput> = {}): PromptInput {
  return {
    matchSlug: 'cs2-faze-navi-2026-08-09',
    verticalId: 'cs2',
    teamA: 'FaZe',
    teamB: 'Natus Vincere',
    bestOf: 3,
    stage: 'Playoffs',
    league: 'IEM',
    scheduledAt: '2026-08-09T18:00:00.000Z',
    asOf: '2026-08-09T12:00:00.000Z',
    minutesToStart: 360,
    market: { mid: 0.62, liquidity: 12_000, spread: 0.02 },
    fragments: [
      {
        label: 'F1',
        enricherId: 'match-history',
        kind: 'h2h',
        asOf: '2026-06-14T22:00:00.000Z',
        observedAt: '2026-08-09T11:30:00.000Z',
        confidence: 0.9,
        summary: 'Confronto direto FaZe x Natus Vincere: 3-1 para FaZe.',
        payload: { record_for_team_a: { wins: 3, losses: 1, voids: 0 } },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// O registro
// ---------------------------------------------------------------------------

test('as duas versões estão registradas, e a v1 continua lá', () => {
  // A v1 sair do código quebraria o rollback: `analyst_prompt_version` é UPDATE,
  // não redeploy, e o job recusa rodar com versão que o registro não conhece.
  assert.deepEqual(promptVersions(), ['v1', 'v2']);
  assert.notEqual(getPrompt('v1'), null);
  assert.notEqual(getPrompt('v2'), null);
});

test('versão desconhecida devolve null, e não a v1 disfarçada', () => {
  // Cair na v1 seria pior que falhar: a config diria uma coisa e a linha gravada
  // registraria outra, e o corte do eval por versão passaria a mentir.
  assert.equal(getPrompt('v3'), null);
  assert.equal(getPrompt(''), null);
});

// ---------------------------------------------------------------------------
// A garantia de uma variável só
// ---------------------------------------------------------------------------

test('v1 e v2 mandam exatamente a mesma mensagem de usuário', () => {
  // É o que faz o corte do eval por `prompt_version` responder "a v2 é melhor?"
  // em vez de "alguma das duas coisas que mudaram fez efeito". Se este teste
  // cair, ou a mudança foi intencional e o corte tem duas variáveis, ou foi
  // acidente — e nos dois casos alguém precisa decidir antes de medir.
  const built = input();
  const one = getPrompt('v1')?.(built);
  const two = getPrompt('v2')?.(built);

  assert.equal(one?.user, two?.user);
  assert.notEqual(one?.system, two?.system);
});

test('a mensagem de usuário carrega partida, mercado e fragmentos', () => {
  const built = getPrompt('v2')?.(input());
  assert.ok(built !== undefined);

  assert.match(built.user, /cs2-faze-navi-2026-08-09/);
  assert.match(built.user, /Time A: FaZe/);
  assert.match(built.user, /faltam 360 min/);
  assert.match(built.user, /preço do time A: 0\.620/);
  assert.match(built.user, /\[F1\] match-history \/ h2h/);
  assert.match(built.user, /3-1 para FaZe/);
  // O payload vai junto do summary: o resumo é a leitura, o payload é o dado.
  assert.match(built.user, /"wins":3/);
});

test('partida sem fragmento diz isso, em vez de mandar seção vazia', () => {
  const built = getPrompt('v2')?.(input({ fragments: [] }));
  assert.match(built?.user ?? '', /\(nenhum fragmento\)/);
});

// ---------------------------------------------------------------------------
// O que a v2 acrescenta
// ---------------------------------------------------------------------------

test('a v2 nomeia os quatro níveis e os enrichers de cada um', () => {
  const system = getPrompt('v2')?.(input()).system ?? '';

  assert.match(system, /Nível 1 — fato sobre a partida, medido por nós/);
  assert.match(system, /Nível 2 — dado estruturado de terceiro/);
  assert.match(system, /Nível 3 — o estado do nosso mercado/);
  assert.match(system, /Nível 4 — texto gerado por LLM de terceiro/);

  // Sem o id do enricher, o modelo não tem como mapear o nível no fragmento que
  // recebeu — a hierarquia viraria conselho abstrato.
  assert.match(system, /`match-history`/);
  assert.match(system, /`oddspapi`/);
  assert.match(system, /`market-history`/);
  assert.match(system, /`polymarket-context`/);

  // Os três kinds do nível 1, que é o que a v1 não dava.
  assert.match(system, /`h2h`/);
  assert.match(system, /`form`/);
  assert.match(system, /`market_calibration`/);
});

test('a v2 diz que a ordem é de valor probatório, não de exatidão', () => {
  // Sem esta frase o modelo pode passar a desconfiar dos números de
  // `market-history`, que são os mais exatos que ele recebe — o nível 3 está
  // abaixo do 2 por não sustentar discordância, não por ser impreciso.
  const system = getPrompt('v2')?.(input()).system ?? '';

  assert.match(system, /VALOR PROBATÓRIO/);
  assert.match(system, /não de exatidão/);
  assert.match(system, /medidas mais exatas que você recebe/);
});

test('a v2 dá a regra de precedência e o que não sustenta tese', () => {
  const system = getPrompt('v2')?.(input()).system ?? '';

  assert.match(system, /o nível mais alto ganha/);
  assert.match(system, /só por nível 4: não deve existir/);
  assert.match(system, /só por nível 3: é descrição de preço/);
  // Ausência de nível 1 não pode ser lida como ausência de problema.
  assert.match(system, /Nível ausente não é nível neutro/);
});

test('a v2 avisa que h2h e form são amostra, e que calibração não vira fator', () => {
  const system = getPrompt('v2')?.(input()).system ?? '';

  assert.match(system, /só partidas que tiveram mercado listado na Polymarket/);
  assert.match(system, /não como o histórico completo do time/);
  assert.match(system, /amostra pequena não vira ajuste numérico/i);
});

test('a v2 preserva o resto da v1 palavra por palavra', () => {
  // A v2 muda a hierarquia de fontes e nada mais. Se estas seções divergirem, a
  // comparação do eval deixa de isolar a mudança que se quis medir.
  const v1 = getPrompt('v1')?.(input()).system ?? '';
  const v2 = getPrompt('v2')?.(input()).system ?? '';

  const shared = [
    'Discordar é o produto. Discordar sem fundamento é o defeito.',
    'Não invente convicção para preencher o formulário.',
    'Julgamento seu (a leitura do que os fatos significam) não é afirmação factual',
    'De 2 a 4 frases. Comece pela conclusão, depois o que a sustenta.',
    'trate como um adversário informado, não como referência a ser reproduzida',
  ];

  for (const sentence of shared) {
    assert.ok(v1.includes(sentence), `v1 perdeu: ${sentence}`);
    assert.ok(v2.includes(sentence), `v2 perdeu: ${sentence}`);
  }
});

test('a v1 não ganhou a hierarquia por acidente', () => {
  // Editar a v1 apaga o lado de comparação e reescreve o passado: análises já
  // gravadas dizem `prompt_version = 'v1'` e passariam a ser atribuídas a um
  // texto que não foi o que rodou.
  const v1 = getPrompt('v1')?.(input()).system ?? '';

  assert.doesNotMatch(v1, /Nível 1/);
  assert.doesNotMatch(v1, /match-history/);
  assert.doesNotMatch(v1, /VALOR PROBATÓRIO/);
  // O aviso original sobre a fonte fraca continua onde estava.
  assert.match(v1, /polymarket-context.*texto gerado por LLM da própria Polymarket/s);
});
