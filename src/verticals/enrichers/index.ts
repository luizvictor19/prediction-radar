import { registerEnricher } from '../enricher.js';
import { marketHistoryEnricher } from './market-history.js';
import { polymarketContextEnricher } from './polymarket-context.js';

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
  registerEnricher(polymarketContextEnricher);
}

export { marketHistoryEnricher } from './market-history.js';
export { polymarketContextEnricher } from './polymarket-context.js';
