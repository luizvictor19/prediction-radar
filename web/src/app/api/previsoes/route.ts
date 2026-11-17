import { comSessao } from '../../../lib/portao';
import { banco } from '../../../lib/servidor/banco';
import { gravarPrevisao } from '../../../lib/servidor/consultas';
import { validarPrevisao } from '../../../lib/servidor/entrada';
import { corpoJson, invalido, responder } from '../../../lib/servidor/resposta';

/** Records a prediction: one `my_bets` row, built from a whitelist. Answers `{ id }`. */
export const POST = comSessao(async (req: Request) => {
  const linha = validarPrevisao(await corpoJson(req));
  if (!linha.ok) return invalido(linha.motivo);
  return responder(async () => ({ id: await gravarPrevisao(banco(), linha.valor) }), 201);
});
