import type { Context } from 'grammy';

const HELP_TEXT = `📡 *Sinais*
/signals — Listar sinais ativos detectados

📈 *Posições*
/positions — Listar posições abertas
/register — Registrar bet feita fora do bot (manual)
/edit — Editar legs abertas

⚙️ *Sistema*
/status — Resumo geral (bankroll, bets, sinais)
/bankroll — Ver ou ajustar bankroll
/config — Mostrar configuração atual
/help — Esta mensagem`;

export async function helpHandler(ctx: Context): Promise<void> {
  await ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' });
}
