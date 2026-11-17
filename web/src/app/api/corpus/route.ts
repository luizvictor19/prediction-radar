import { comSessao } from '../../../lib/portao';
import { banco } from '../../../lib/servidor/banco';
import { lerCorpus } from '../../../lib/servidor/consultas';
import { responder } from '../../../lib/servidor/resposta';

export const GET = comSessao(async () => responder(() => lerCorpus(banco())));
