import { comSessao, type Sessao } from '../../../../../lib/portao';
import { banco } from '../../../../../lib/servidor/banco';
import { lerAchados } from '../../../../../lib/servidor/consultas';
import { lerEventId } from '../../../../../lib/servidor/entrada';
import { invalido, responder } from '../../../../../lib/servidor/resposta';

export const GET = comSessao(
  async (_req: Request, { ctx }: Sessao<{ params: Promise<{ id: string }> }>) => {
    const id = lerEventId((await ctx.params).id);
    if (!id.ok) return invalido(id.motivo);
    return responder(() => lerAchados(banco(), id.valor));
  },
);
