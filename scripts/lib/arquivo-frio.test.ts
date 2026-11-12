import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';

import {
  comprimirSemSetval,
  conferirDump,
  contarBlocosCopy,
  ehSetval,
  listaDeExclusao,
  montarManifest,
  montarMigration,
  validarMes,
} from './arquivo-frio.js';

async function* linhas(texto: string) {
  for (const l of texto.split('\n')) yield l;
}

const COPY = (t: string) => `COPY "public"."${t}" ("id", "event_id", "captured_at") FROM stdin;`;

describe('validarMes', () => {
  it('recusa o mês no dia 8 do mês seguinte e libera no dia 9', () => {
    assert.throws(
      () => validarMes('2026-11', new Date('2026-12-08T23:59:59Z')),
      /só pode sair a partir de 2026-12-09/,
    );
    const m = validarMes('2026-11', new Date('2026-12-09T00:00:00Z'));
    assert.equal(m.particao, 'polymarket_snapshots_p202611');
    assert.equal(m.inicio.toISOString(), '2026-11-01T00:00:00.000Z');
    assert.equal(m.fim.toISOString(), '2026-12-01T00:00:00.000Z');
  });

  it('recusa o mês corrente e o futuro', () => {
    assert.throws(
      () => validarMes('2026-12', new Date('2026-12-20T00:00:00Z')),
      /ainda não fechou/,
    );
    assert.throws(
      () => validarMes('2027-01', new Date('2026-12-20T00:00:00Z')),
      /ainda não fechou/,
    );
  });

  it('dezembro libera no dia 9 de janeiro do ano seguinte', () => {
    assert.throws(() => validarMes('2026-12', new Date('2027-01-08T12:00:00Z')), /2027-01-09/);
    assert.equal(
      validarMes('2026-12', new Date('2027-01-09T00:00:00Z')).particao,
      'polymarket_snapshots_p202612',
    );
  });

  it('recusa formato e mês inválidos', () => {
    for (const ruim of ['2026-1', '202611', '2026-13', '2026-00', ' 2026-11']) {
      assert.throws(() => validarMes(ruim, new Date('2030-01-01T00:00:00Z')), /mês inválido/);
    }
  });
});

describe('listaDeExclusao', () => {
  const tabelas = [
    'public.events',
    'public.polymarket_snapshots_p202611',
    'public.polymarket_snapshots_p202612',
    'public.system_logs',
  ];

  it('exclui tudo menos o alvo', () => {
    assert.equal(
      listaDeExclusao(tabelas, 'polymarket_snapshots_p202611'),
      'public.events,public.polymarket_snapshots_p202612,public.system_logs',
    );
  });

  it('recusa um alvo que não existe no banco', () => {
    assert.throws(() => listaDeExclusao(tabelas, 'polymarket_snapshots_p202610'), /não existe/);
  });
});

describe('contarBlocosCopy', () => {
  it('conta as linhas de cada bloco e ignora o resto do dump', async () => {
    const dump = [
      'SET statement_timeout = 0;',
      COPY('polymarket_snapshots_p202611'),
      '1\tabc\t2026-11-01',
      '2\tabc\t2026-11-02',
      '\\.',
      '',
      'SELECT pg_catalog.setval(\'"public"."system_logs_id_seq"\', 10, true);',
    ].join('\n');
    assert.deepEqual(await contarBlocosCopy(linhas(dump)), [
      { tabela: 'public.polymarket_snapshots_p202611', linhas: 2 },
    ]);
  });

  it('conta bloco vazio como zero e devolve dois blocos quando há dois', async () => {
    const dump = [COPY('a'), '\\.', COPY('b'), '1\tx\ty', '\\.'].join('\n');
    assert.deepEqual(await contarBlocosCopy(linhas(dump)), [
      { tabela: 'public.a', linhas: 0 },
      { tabela: 'public.b', linhas: 1 },
    ]);
  });

  it('linha de dado parecida com terminador não fecha o bloco', async () => {
    const dump = [COPY('a'), '\\.x', ' \\.', '\\.'].join('\n');
    assert.deepEqual(await contarBlocosCopy(linhas(dump)), [{ tabela: 'public.a', linhas: 2 }]);
  });

  it('bloco sem terminador é erro, não contagem parcial', async () => {
    await assert.rejects(
      contarBlocosCopy(linhas([COPY('a'), '1\tx\ty'].join('\n'))),
      /sem terminador/,
    );
  });
});

describe('conferirDump', () => {
  const alvo = 'polymarket_snapshots_p202611';

  it('aceita exatamente o alvo com a contagem do banco', () => {
    conferirDump([{ tabela: `public.${alvo}`, linhas: 5 }], alvo, 5);
  });

  it('recusa contagem diferente da do banco, para mais e para menos', () => {
    assert.throws(
      () => conferirDump([{ tabela: `public.${alvo}`, linhas: 4 }], alvo, 5),
      /4 linhas no dump, 5 no banco/,
    );
    assert.throws(
      () => conferirDump([{ tabela: `public.${alvo}`, linhas: 6 }], alvo, 5),
      /6 linhas no dump/,
    );
  });

  it('recusa dump sem o alvo, com outra tabela ou com tabela a mais', () => {
    assert.throws(() => conferirDump([], alvo, 0), /tem: nenhum/);
    assert.throws(
      () => conferirDump([{ tabela: 'public.events', linhas: 5 }], alvo, 5),
      /tem: public.events/,
    );
    assert.throws(
      () =>
        conferirDump(
          [
            { tabela: `public.${alvo}`, linhas: 5 },
            { tabela: 'public.events', linhas: 1 },
          ],
          alvo,
          5,
        ),
      /devia ter só/,
    );
  });
});

describe('ehSetval', () => {
  it('reconhece só a linha de setval do pg_dump', () => {
    assert.equal(ehSetval('SELECT pg_catalog.setval(\'"public"."x_id_seq"\', 1, true);'), true);
    assert.equal(ehSetval("SELECT pg_catalog.set_config('search_path', '', false);"), false);
    assert.equal(ehSetval('1\tSELECT pg_catalog.setval(\tdado'), false);
  });
});

describe('montarManifest', () => {
  it('leva mês, issue, contagem e receita de restauração com os limites do mês', () => {
    const mes = validarMes('2026-11', new Date('2026-12-10T00:00:00Z'));
    const man = montarManifest({
      criadoEm: new Date('2026-12-10T03:04:05.678Z'),
      mes,
      entrada: {
        table: 'public.polymarket_snapshots_p202611',
        file: 'polymarket_snapshots_p202611.sql.gz',
        rows: 7,
        rows_in_db: 7,
        bytes: 100,
        sha256: 'ab',
      },
    });
    assert.equal(man.created_at, '2026-12-10T03:04:05Z');
    assert.equal(man.month, '2026-11');
    assert.equal(man.issue, 60);
    assert.equal(man.tables[0]?.rows, 7);
    assert.match(man.restore, /polymarket_snapshots_p202611 partition of/);
    assert.match(man.restore, /2026-11-01T00:00:00.000Z.*2026-12-01T00:00:00.000Z/);
    assert.match(man.format, /setval lines removed/);
  });
});

describe('montarMigration', () => {
  const mes = validarMes('2026-11', new Date('2026-12-10T00:00:00Z'));
  const sql = montarMigration({
    mes,
    linhas: 1234567,
    pastaDrive: 'gdrive:prediction-radar-arquivo-frio/2026-12-10',
    arquivo: 'polymarket_snapshots_p202611.sql.gz',
    sha256: 'deadbeef',
  });

  it('trava, reconta, recusa a mais e só então apaga a partição do mês', () => {
    assert.match(sql, /expected constant bigint := 1234567;/);
    const lock = sql.indexOf('lock table public.polymarket_snapshots_p202611 in share mode');
    const count = sql.indexOf(
      'select count(*) into actual from public.polymarket_snapshots_p202611',
    );
    const guard = sql.indexOf('if actual > expected then');
    const drop = sql.indexOf('drop table public.polymarket_snapshots_p202611;');
    assert.ok(
      lock > 0 && lock < count && count < guard && guard < drop,
      'ordem lock, count, guarda, drop',
    );
  });

  it('mensagem da guarda em português e lock_timeout de 10 s', () => {
    assert.match(sql, /tem % linhas e o arquivo só tem %; nada foi apagado/);
    assert.match(sql, /set_config\('lock_timeout', '10s', true\)/);
  });

  it('não toca outra partição', () => {
    const outras = sql.match(/polymarket_snapshots_p\d{6}/g) ?? [];
    assert.deepEqual([...new Set(outras)], ['polymarket_snapshots_p202611']);
  });
});

describe('comprimirSemSetval', () => {
  it('conta os blocos e grava o gzip sem nenhuma linha de setval, com o resto intacto', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arquivo-frio-'));
    try {
      const bruto = join(dir, 'p.sql');
      const gz = join(dir, 'p.sql.gz');
      const linhasDoDump = [
        'SET statement_timeout = 0;',
        COPY('polymarket_snapshots_p202611'),
        '1\tabc\t2026-11-01',
        '2\tabc\t2026-11-02',
        '\\.',
        'SELECT pg_catalog.setval(\'"public"."system_logs_id_seq"\', 10, true);',
        'SELECT pg_catalog.setval(\'"public"."polymarket_snapshots_id_seq"\', 99, true);',
        '-- fim',
      ];
      await writeFile(bruto, `${linhasDoDump.join('\n')}\n`);

      const blocos = await comprimirSemSetval(bruto, gz);

      assert.deepEqual(blocos, [{ tabela: 'public.polymarket_snapshots_p202611', linhas: 2 }]);
      const texto = gunzipSync(await readFile(gz)).toString('utf8');
      assert.equal(texto, `${linhasDoDump.filter((l) => !l.includes('setval')).join('\n')}\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
