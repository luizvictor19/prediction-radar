import { comSessao, type Sessao } from '../../../../../lib/portao';
import { banco } from '../../../../../lib/servidor/banco';
import { lerTextoDaRegra } from '../../../../../lib/servidor/consultas';
import { lerEventId } from '../../../../../lib/servidor/entrada';
import { invalido, NaoEncontrado, responder } from '../../../../../lib/servidor/resposta';

/** The market's current description, as `{ texto: string | null }`; 404 for an unknown market. */
export const GET = comSessao(
  async (_req: Request, { ctx }: Sessao<{ params: Promise<{ id: string }> }>) => {
    const id = lerEventId((await ctx.params).id);
    if (!id.ok) return invalido(id.motivo);
    return responder(async () => {
      const r = await lerTextoDaRegra(banco(), id.valor);
      if (!r.encontrado) throw new NaoEncontrado('mercado não encontrado');
      return { texto: r.texto };
    });
  },
);
