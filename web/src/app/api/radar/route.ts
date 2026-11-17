import { comSessao } from '../../../lib/portao';
import { banco } from '../../../lib/servidor/banco';
import { lerRadar } from '../../../lib/servidor/consultas';
import { responder } from '../../../lib/servidor/resposta';

export const GET = comSessao(async () => responder(() => lerRadar(banco())));
