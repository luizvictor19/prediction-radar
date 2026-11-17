import { comSessao, type Sessao } from '../../../../lib/portao';
import { banco } from '../../../../lib/servidor/banco';
import { lerTextoGuardado } from '../../../../lib/servidor/consultas';
import { lerSha } from '../../../../lib/servidor/entrada';
import { invalido, responder } from '../../../../lib/servidor/resposta';

/** The rule text stored under a hash, as a `TextoGuardado`. */
export const GET = comSessao(
  async (_req: Request, { ctx }: Sessao<{ params: Promise<{ sha: string }> }>) => {
    const sha = lerSha((await ctx.params).sha);
    if (!sha.ok) return invalido(sha.motivo);
    return responder(() => lerTextoGuardado(banco(), sha.valor));
  },
);
