import { supabase } from './supabase.js';
import { getSystemConfig, invalidateConfigCache } from './config.js';
import { logEvent } from './logger.js';

/**
 * O estado da carteira — e a recusa quando ele não é conhecido.
 *
 * ## O que mudou, e por quê
 *
 * A versão anterior marcava a mercado lendo a última foto e, quando não achava
 * preço, somava `stake_usd` no lugar:
 *
 *     portfolio_value += Number(leg.stake_usd) || 0;
 *
 * Isso fazia posição SEM marcação parecer posição ESTÁVEL. O P&L não realizado
 * dela dava exatamente zero, que é o número mais tranquilizador possível, e
 * nada na resposta dizia que aquilo não estava sendo medido. Falha silenciosa —
 * o defeito que este projeto mais pagou para aprender.
 *
 * Medido em 20260814: 61 de 61 legs registradas caíam nesse ramo. São mercados
 * de partida de esports, que o radar não coleta por decisão; a carteira antiga
 * não tem conserto e não é para tentar consertar.
 *
 * ## Agora: nulo, com o motivo e a contagem
 *
 * `portfolio_value` e `bankroll` são NULOS quando qualquer leg aberta ficou sem
 * marcação. Não é "zero", não é "o custo": é desconhecido, e o tipo obriga quem
 * consome a decidir o que fazer com isso.
 *
 * `legs_sem_marcacao` e `motivos_sem_marcacao` existem porque nulo sozinho é só
 * silêncio de outro tipo. Número visível é o que impede a falha de ser
 * silenciosa.
 *
 * `portfolio_value_parcial` guarda a soma das legs que TÊM preço, para a
 * informação não se perder — mas ele nunca é o total, e o nome diz isso.
 *
 * ## Quem marca é a view, não este arquivo
 *
 * A marcação lê `v_minhas_posicoes`. Ela já sabe casar rótulo, derivar o lado
 * oposto por aritmética de mercado de dois resultados, deixar `valor_marcado`
 * nulo quando não há preço e dizer o motivo. Refazer isso aqui criaria duas
 * definições de "quanto vale esta posição" que divergiriam na primeira edição.
 */

/**
 * A carteira. `portfolio_value` e `bankroll` são `number | null` de propósito:
 * o `null` é a recusa, e o compilador força cada consumidor a tratá-la.
 */
export interface BankrollState {
  cash: number;
  /** Nulo quando alguma leg aberta ficou sem marcação. Nunca é o custo. */
  portfolio_value: number | null;
  /** A soma só das legs marcadas. NÃO é o total quando há leg sem marcação. */
  portfolio_value_parcial: number;
  /** `cash + portfolio_value`, ou nulo quando o portfólio é desconhecido. */
  bankroll: number | null;
  legs_count: number;
  legs_sem_marcacao: number;
  /** Quantas legs por motivo, vindo de `v_minhas_posicoes.motivo_sem_preco`. */
  motivos_sem_marcacao: Record<string, number>;
  stake_committed: number;
}

interface LegDaView {
  stake_usd: number | string | null;
  valor_marcado: number | string | null;
  motivo_sem_preco: string | null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getBankrollState(): Promise<BankrollState> {
  const config = await getSystemConfig();
  const cash = config.cash_usd ?? 0;

  const vazio: BankrollState = {
    cash,
    portfolio_value: 0,
    portfolio_value_parcial: 0,
    bankroll: cash,
    legs_count: 0,
    legs_sem_marcacao: 0,
    motivos_sem_marcacao: {},
    stake_committed: 0,
  };

  const { data, error } = await supabase
    .from('v_minhas_posicoes')
    .select('stake_usd, valor_marcado, motivo_sem_preco');

  // Falha de leitura NÃO devolve `cash` como se o portfólio fosse zero. Sem a
  // view não se sabe nada sobre as posições, e "não sei" é a resposta certa —
  // a mesma que o resto desta função dá quando falta preço.
  if (error) {
    await logEvent({
      component: 'bankroll',
      status: 'error',
      message: `v_minhas_posicoes read failed: ${error.message}`,
    });
    return {
      ...vazio,
      portfolio_value: null,
      bankroll: null,
      legs_sem_marcacao: 0,
      motivos_sem_marcacao: { 'falha ao ler v_minhas_posicoes': 1 },
    };
  }

  const legs = (data ?? []) as unknown as LegDaView[];
  if (legs.length === 0) return vazio;

  let parcial = 0;
  let stakeCommitted = 0;
  let semMarcacao = 0;
  const motivos: Record<string, number> = {};

  for (const leg of legs) {
    stakeCommitted += num(leg.stake_usd);

    if (leg.valor_marcado === null || leg.valor_marcado === undefined) {
      semMarcacao += 1;
      const motivo = leg.motivo_sem_preco ?? '(sem motivo registrado)';
      motivos[motivo] = (motivos[motivo] ?? 0) + 1;
      continue;
    }

    parcial += num(leg.valor_marcado);
  }

  const portfolio = semMarcacao > 0 ? null : parcial;

  return {
    cash,
    portfolio_value: portfolio,
    portfolio_value_parcial: parcial,
    bankroll: portfolio === null ? null : cash + portfolio,
    legs_count: legs.length,
    legs_sem_marcacao: semMarcacao,
    motivos_sem_marcacao: motivos,
    stake_committed: stakeCommitted,
  };
}

export async function adjustCash(delta: number): Promise<void> {
  if (delta === 0) return;
  const { data: cfg } = await supabase
    .from('system_config')
    .select('cash_usd')
    .eq('id', 1)
    .single();
  const current = Number(cfg?.cash_usd ?? 0);
  await supabase
    .from('system_config')
    .update({ cash_usd: current + delta, updated_at: new Date().toISOString() })
    .eq('id', 1);
  invalidateConfigCache();
}
