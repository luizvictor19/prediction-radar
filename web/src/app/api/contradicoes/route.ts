import { comSessao } from '../../../lib/portao';
import { banco } from '../../../lib/servidor/banco';
import { lerContradicoes } from '../../../lib/servidor/consultas';
import { lerDefeitoIds } from '../../../lib/servidor/entrada';
import { invalido, responder } from '../../../lib/servidor/resposta';

/** `?ids=<md5>,<md5>,…`, at most `MAXIMO_DE_IDS`. */
export const GET = comSessao(async (req: Request) => {
  const ids = lerDefeitoIds(new URL(req.url).searchParams.get('ids'));
  if (!ids.ok) return invalido(ids.motivo);
  return responder(() => lerContradicoes(banco(), ids.valor));
});
