import { test } from 'node:test';
import assert from 'node:assert/strict';

import { conferirVariaveisPublicas, variaveisPublicasSuspeitas } from './trava-publica';

/**
 * The guard that took `trava.ts`'s place: a `NEXT_PUBLIC_*` variable is
 * inlined into the browser bundle, so one that names or holds a secret stops
 * the build (`next.config.ts`). It reports names, never values.
 */

const JWT_SERVICE =
  'eyJhbGciOiJIUzI1NiJ9.' +
  Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') +
  '.assinatura';

test('nome ou valor com cara de segredo numa NEXT_PUBLIC_ é apontado', () => {
  const env = {
    NEXT_PUBLIC_SUPABASE_SERVICE_KEY: 'x',
    NEXT_PUBLIC_API_KEY: 'x',
    NEXT_PUBLIC_RADAR_SENHA: 'x',
    NEXT_PUBLIC_SEGREDO: 'x',
    NEXT_PUBLIC_CLIENT_SECRET: 'x',
    NEXT_PUBLIC_INOCENTE_1: 'sb_secret_abc',
    NEXT_PUBLIC_INOCENTE_2: JWT_SERVICE,
    NEXT_PUBLIC_INOCENTE_3: 'tem service_role no meio',
    NEXT_PUBLIC_INOCENTE_4: 'canario-qualquer',
    NEXT_PUBLIC_TITULO: 'Radar',
    SUPABASE_SERVICE_KEY: 'sb_secret_abc',
    RADAR_SENHA: 'fica no servidor',
  };
  assert.deepEqual(variaveisPublicasSuspeitas(env), [
    'NEXT_PUBLIC_API_KEY',
    'NEXT_PUBLIC_CLIENT_SECRET',
    'NEXT_PUBLIC_INOCENTE_1',
    'NEXT_PUBLIC_INOCENTE_2',
    'NEXT_PUBLIC_INOCENTE_3',
    'NEXT_PUBLIC_INOCENTE_4',
    'NEXT_PUBLIC_RADAR_SENHA',
    'NEXT_PUBLIC_SEGREDO',
    'NEXT_PUBLIC_SUPABASE_SERVICE_KEY',
  ]);
});

test('sem NEXT_PUBLIC_ suspeita a conferência passa; com uma ela lança sem mostrar o valor', () => {
  assert.doesNotThrow(() => conferirVariaveisPublicas({ NEXT_PUBLIC_TITULO: 'Radar' }));
  assert.throws(
    () => conferirVariaveisPublicas({ NEXT_PUBLIC_X: 'sb_secret_valor_real' }),
    (e: Error) => /NEXT_PUBLIC_X/.test(e.message) && !e.message.includes('sb_secret_valor_real'),
    'a trava não lançou, ou lançou mostrando o valor',
  );
});
