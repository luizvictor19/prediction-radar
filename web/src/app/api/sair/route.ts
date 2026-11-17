import { comSessao, sair } from '../../../lib/portao';

export const POST = comSessao(async (req: Request) => sair(req));
