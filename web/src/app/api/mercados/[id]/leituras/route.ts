import { comSessao } from '../../../../../lib/portao';
import { banco } from '../../../../../lib/servidor/banco';
import { lerLeituras } from '../../../../../lib/servidor/consultas';
import { lerEventId, lerSha } from '../../../../../lib/servidor/entrada';
import { invalido, responder } from '../../../../../lib/servidor/resposta';

/** `?sha=<description_sha256>`: the readings of one rule text within one market. */
export const GET = comSessao(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const id = lerEventId((await ctx.params).id);
  if (!id.ok) return invalido(id.motivo);
  const sha = lerSha(new URL(req.url).searchParams.get('sha'));
  if (!sha.ok) return invalido(sha.motivo);
  return responder(() => lerLeituras(banco(), id.valor, sha.valor));
});
