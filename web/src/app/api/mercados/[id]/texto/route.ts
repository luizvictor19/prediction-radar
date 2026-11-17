import { comSessao } from '../../../../../lib/portao';
import { banco } from '../../../../../lib/servidor/banco';
import { lerTextoDaRegra } from '../../../../../lib/servidor/consultas';
import { lerEventId } from '../../../../../lib/servidor/entrada';
import { invalido, responder } from '../../../../../lib/servidor/resposta';

/** The market's current description, as `{ texto: string | null }`. */
export const GET = comSessao(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const id = lerEventId((await ctx.params).id);
  if (!id.ok) return invalido(id.motivo);
  return responder(async () => ({ texto: await lerTextoDaRegra(banco(), id.valor) }));
});
