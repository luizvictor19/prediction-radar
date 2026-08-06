import { supabase } from './supabase.js';

/**
 * Batimento de ciclo dos coletores.
 *
 * O problema que isto resolve: o collector geral ficou 48h travado sem ninguém
 * notar. Falha silenciosa não gera erro, e sem erro não há nada para alertar —
 * o sintoma é a AUSÊNCIA de trabalho, que só existe como sinal se alguém a
 * registrar. Daí a marca positiva: cada ciclo que termina carimba a hora.
 *
 * ## Por que tabela própria, e não `system_logs`
 *
 * `system_logs` não serve de batimento porque a cadência de log não é a cadência
 * de ciclo, e a diferença é grande em dois dos quatro componentes:
 *
 *   - `open_legs_collector` retorna cedo, sem logar nada, quando não há aposta
 *     aberta (`legs.length === 0`). Esse é o estado normal na maior parte do
 *     tempo. Um monitor lendo `system_logs` alertaria para sempre, e um alerta
 *     que mente é um alerta que se aprende a ignorar.
 *   - `watchlist_collector` tica a cada 5s mas agrega o log em uma linha a cada
 *     5 min. O silêncio entre elas é normal.
 *
 * E há o motivo de custo: `system_logs` já chegou a 755 MB / 2,7M linhas neste
 * projeto. Pendurar batimento lá seria escrever linha nova a cada ciclo de um
 * coletor que roda a cada 5 segundos.
 *
 * Aqui é UPSERT numa tabela de 4 linhas. Não cresce.
 *
 * ## Duas tabelas, dois donos
 *
 * `collector_heartbeats` é escrita pelo processo dos coletores. O estado do
 * alerta mora em `collector_health_alerts`, escrita pelo processo do bot. Não é
 * separação decorativa: um upsert do PostgREST só toca as colunas que recebe,
 * mas depender disso para duas escritas concorrentes de processos diferentes é
 * apostar num detalhe de implementação para não perder estado de alerta.
 */

/**
 * Janela mínima entre duas escritas do mesmo componente.
 *
 * A watchlist tica a cada 5s: sem isto seriam ~17k upserts/dia só dela. O
 * batimento só precisa de resolução mais fina que o menor limiar de alerta, que
 * é de minutos — 60s dá duas ordens de grandeza de folga e derruba o volume para
 * ~1.4k/dia por componente.
 *
 * Consequência aceita: o `last_cycle_at` pode estar até 60s atrasado em relação
 * ao ciclo real. Irrelevante contra limiares de 10-20 min.
 */
const MIN_WRITE_INTERVAL_MS = 60_000;

/**
 * Quanto tempo esperar antes de tentar de novo depois de descobrir que a tabela
 * não existe. Mesma lógica do `ColumnProbe`: a migration é aplicada à mão, sem
 * redeploy, e um cache negativo eterno faria o batimento nunca começar a valer.
 */
const TABLE_RETRY_MS = 10 * 60_000;

export type HeartbeatStatus = 'success' | 'partial' | 'error';

const lastWriteAt = new Map<string, number>();

let tableMissingSince: number | null = null;

/** Só para os testes: zera o estado entre casos. */
export function resetHeartbeatState(): void {
  lastWriteAt.clear();
  tableMissingSince = null;
}

/**
 * Decide se este batimento vira escrita.
 *
 * Separada de `beat` para que a janela seja testável sem tocar no banco —
 * mesmo padrão de `shouldWriteDisabledLog`.
 *
 * `force` existe para o ciclo que termina em erro: a transição de estado é o que
 * o monitor mais quer ver, e engoli-la por causa da janela atrasaria o
 * diagnóstico em até um minuto sem economizar nada relevante.
 */
export function shouldWriteHeartbeat(
  component: string,
  now: number = Date.now(),
  force = false,
): boolean {
  const last = lastWriteAt.get(component);
  if (!force && last !== undefined && now - last < MIN_WRITE_INTERVAL_MS) return false;

  lastWriteAt.set(component, now);
  return true;
}

/**
 * Carimba o fim de um ciclo.
 *
 * Nunca lança e nunca deixa o coletor esperando por um erro de escrita: um
 * monitor que derruba o que ele monitora é pior que não ter monitor. Falha de
 * escrita vira `console.warn` e o ciclo segue.
 *
 * `status` é o do ciclo, não do batimento. Um ciclo que terminou com erro
 * bateu — ele está vivo, só não está bem, e as duas coisas são alertas
 * diferentes.
 */
export async function beat(
  component: string,
  status: HeartbeatStatus,
  detail?: string,
): Promise<void> {
  const now = Date.now();

  if (tableMissingSince !== null) {
    if (now - tableMissingSince < TABLE_RETRY_MS) return;
    tableMissingSince = null;
  }

  if (!shouldWriteHeartbeat(component, now, status === 'error')) return;

  try {
    const { error } = await supabase.from('collector_heartbeats').upsert(
      {
        component,
        last_cycle_at: new Date(now).toISOString(),
        last_status: status,
        // Truncado aqui, e não na coluna: a mensagem vai para o Telegram, onde
        // o que importa é caber na linha, não o texto inteiro.
        last_detail: detail?.slice(0, 200) ?? null,
      },
      { onConflict: 'component' },
    );

    if (error) {
      // 42P01 = relação não existe. É o estado esperado entre o deploy do código
      // e o apply da migration, não um incidente — ver a Parte E da spec 000.
      if (error.code === '42P01') {
        tableMissingSince = now;
        console.warn(
          `[heartbeat] collector_heartbeats ainda não existe — batimento inativo por ${TABLE_RETRY_MS / 60000} min`,
        );
        return;
      }
      console.warn(`[heartbeat] falha ao gravar ${component}: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[heartbeat] exceção ao gravar ${component}: ${String(err)}`);
  }
}
