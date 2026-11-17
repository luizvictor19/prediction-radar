import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { conferirCanarios, procurarCanarios } from './canario-no-bundle';

/**
 * The scan that proves the service key is not in the browser bundle of `web/`.
 * It reads bytes, not lines, so a NUL byte cannot hide a file from it: the
 * `dataset.ts` case in `CLAUDE.md`, where `grep` skipped a whole file in
 * silence.
 */

const CANARIO = 'canario-chave-de-servico-0123456789';

function pasta(arquivos: Record<string, string | Buffer>): string {
  const raiz = mkdtempSync(join(tmpdir(), 'canario-'));
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const caminho = join(raiz, nome);
    mkdirSync(join(caminho, '..'), { recursive: true });
    writeFileSync(caminho, conteudo);
  }
  return raiz;
}

test('acha o canário num arquivo, em qualquer subpasta', () => {
  const raiz = pasta({
    'chunks/a.js': 'console.log(1)',
    'chunks/fundo/b.js': `const k = "${CANARIO}";`,
    'css/c.css': 'body{}',
  });
  try {
    const r = procurarCanarios(raiz, [CANARIO]);
    assert.equal(r.arquivos, 3, 'devia ter lido os três arquivos');
    assert.deepEqual(
      r.achados.map((a) => a.arquivo),
      ['chunks/fundo/b.js'],
    );
  } finally {
    rmSync(raiz, { recursive: true });
  }
});

test('sem o canário, nada é achado', () => {
  const raiz = pasta({ 'a.js': 'console.log(1)', 'b.js': 'canario-outro' });
  try {
    assert.deepEqual(procurarCanarios(raiz, [CANARIO]).achados, []);
  } finally {
    rmSync(raiz, { recursive: true });
  }
});

test('um byte NUL no arquivo não esconde o canário', () => {
  const conteudo = Buffer.concat([
    Buffer.from('antes'),
    Buffer.from([0]),
    Buffer.from(`depois ${CANARIO}`),
  ]);
  const raiz = pasta({ 'binario.js': conteudo });
  try {
    assert.deepEqual(
      procurarCanarios(raiz, [CANARIO]).achados.map((a) => a.arquivo),
      ['binario.js'],
    );
  } finally {
    rmSync(raiz, { recursive: true });
  }
});

test('o veredito: limpo só quando leu arquivo e não achou canário', () => {
  const limpa = pasta({ 'a.js': 'x' });
  const suja = pasta({ 'a.js': CANARIO });
  const vazia = pasta({});
  try {
    assert.deepEqual(
      [
        conferirCanarios(limpa, { SUPABASE_SERVICE_KEY: CANARIO }).ok,
        conferirCanarios(suja, { SUPABASE_SERVICE_KEY: CANARIO }).ok,
        // An empty or missing folder is not a clean bundle: it was not read.
        conferirCanarios(vazia, { SUPABASE_SERVICE_KEY: CANARIO }).ok,
        conferirCanarios(join(vazia, 'nao-existe'), { SUPABASE_SERVICE_KEY: CANARIO }).ok,
      ],
      [true, false, false, false],
    );
  } finally {
    for (const r of [limpa, suja, vazia]) rmSync(r, { recursive: true });
  }
});

test('recusa rodar sem canário, ou com um valor que não é canário', () => {
  const raiz = pasta({ 'a.js': 'x' });
  try {
    const casos = [
      conferirCanarios(raiz, {}),
      conferirCanarios(raiz, { SUPABASE_SERVICE_KEY: 'sb_secret_de_verdade' }),
      conferirCanarios(raiz, { SUPABASE_SERVICE_KEY: CANARIO, RADAR_SENHA: 'senha-real' }),
    ];
    assert.deepEqual(
      casos.map((c) => c.ok),
      [false, false, false],
      'a conferência rodou sem canário de verdade',
    );
    // The message names the variable, never its value.
    assert.ok(!casos[1]!.mensagem.includes('sb_secret_de_verdade'), 'a mensagem vazou o valor');
  } finally {
    rmSync(raiz, { recursive: true });
  }
});
