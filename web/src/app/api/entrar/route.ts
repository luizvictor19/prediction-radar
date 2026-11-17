import { comSessao, entrar } from '../../../lib/portao';

// Answers without a session (`CAMINHOS_SEM_SESSAO`); `comSessao` still answers
// 503 without configuration, 421 to an unknown host and 403 to a foreign Origin.
export const POST = comSessao(entrar);
