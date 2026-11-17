import { comSessao } from '../../../lib/portao';
import { banco } from '../../../lib/servidor/banco';
import { gravarLeg } from '../../../lib/servidor/consultas';
import { validarLeg } from '../../../lib/servidor/entrada';
import { corpoJson, invalido, responder } from '../../../lib/servidor/resposta';

/** Records a leg: one `my_bet_legs` row, built from a whitelist. */
export const POST = comSessao(async (req: Request) => {
  const linha = validarLeg(await corpoJson(req));
  if (!linha.ok) return invalido(linha.motivo);
  return responder(async () => {
    await gravarLeg(banco(), linha.valor);
    return { ok: true };
  }, 201);
});
