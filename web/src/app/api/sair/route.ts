import { comSessao, sair } from '../../../lib/portao';

// Works without a valid session, so an expired cookie can still be cleared.
export const POST = comSessao(sair);
