import { registerEnricher } from '../enricher.js';
import { marketHistoryEnricher } from './market-history.js';
import { matchHistoryEnricher } from './match-history.js';
import { polymarketContextEnricher } from './polymarket-context.js';
import { liquipediaEnricher } from './liquipedia.js';
import { oddspapiEnricher } from './oddspapi.js';

/**
 * Os enrichers embutidos (spec 001, item 5).
 *
 * Registro explícito, e não import com efeito colateral: quem lê o boot vê quais
 * enrichers existem sem abrir cada arquivo, e o teste registra o que quiser sem
 * arrastar os outros junto.
 *
 * Chame UMA vez, no boot. `registerEnricher` levanta exceção em id duplicado —
 * de propósito, porque `enricher_id` é a chave de proveniência de
 * `context_fragments` e um registro duplo significaria que alguém importou dois
 * caminhos para o mesmo enricher.
 */
export function registerBuiltInEnrichers(): void {
  registerEnricher(marketHistoryEnricher);
  // `match-history`, e não `market-history`: um responde sobre a partida (times,
  // confrontos, desfechos), o outro sobre o mercado (preço, liquidez). Os nomes
  // são parecidos porque as perguntas são vizinhas; os `kind` que eles produzem
  // não se sobrepõem em nada.
  //
  // Sem chave de config, pela mesma razão de `market-history`: a fonte é o nosso
  // próprio banco. Não há credencial para faltar, limite de taxa para estourar
  // nem terceiro para ficar fora do ar — não há o que desligar em incidente.
  registerEnricher(matchHistoryEnricher);
  registerEnricher(polymarketContextEnricher);
  // Registrado SEMPRE, e desligado por dentro. O registry é síncrono e a decisão
  // de ligar depende de `system_config` (leitura assíncrona) e de duas variáveis
  // de ambiente; registrar condicionalmente exigiria await no boot e deixaria o
  // conjunto de enrichers dependendo de quando o processo subiu. Quem decide se
  // ele faz alguma coisa é o próprio `fetch`, que devolve vazio sem tocar a rede
  // enquanto `esports_enricher_liquipedia_enabled` for false ou faltar
  // credencial.
  registerEnricher(liquipediaEnricher);
  // Mesma razão do de cima para registrar SEMPRE: quem decide se ele faz alguma
  // coisa é o próprio `fetch`, que devolve vazio sem tocar a rede enquanto
  // `esports_enricher_oddspapi_enabled` for false ou faltar `ODDSPAPI_API_KEY`.
  // Ele só atende as verticais cujo `sportId` foi medido — hoje, só cs2.
  registerEnricher(oddspapiEnricher);
}

export { marketHistoryEnricher } from './market-history.js';
export { matchHistoryEnricher } from './match-history.js';
export { polymarketContextEnricher } from './polymarket-context.js';
export { liquipediaEnricher } from './liquipedia.js';
export { oddspapiEnricher } from './oddspapi.js';
