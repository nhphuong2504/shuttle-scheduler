/**
 * Format registry.
 *
 * The seam a tournament format plugs into. `listFormatProviders` is what a future sports-agnostic
 * setup screen would enumerate.
 */

import type { FormatProvider } from "../../../scheduling/providers";
import { placementAbcdFormat } from "./placement-abcd";
import { roundRobinFormat } from "./round-robin";
import { singleEliminationFormat } from "./single-elimination";

const registry = new Map<string, FormatProvider<never>>();

export function registerFormatProvider<In>(provider: FormatProvider<In>): void {
  const id = provider.id;
  if (registry.has(id)) throw new Error(`Duplicate format provider id: ${id}`);
  registry.set(id, provider as FormatProvider<never>);
}

export function getFormatProvider<In = unknown>(id: string): FormatProvider<In> {
  const provider = registry.get(id);
  if (!provider) throw new Error(`Unknown format provider id: ${id}`);
  return provider as unknown as FormatProvider<In>;
}

export function hasFormatProvider(id: string): boolean {
  return registry.has(id);
}

export function listFormatProviders(): readonly FormatProvider<never>[] {
  return [...registry.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

registerFormatProvider(roundRobinFormat);
registerFormatProvider(singleEliminationFormat);
registerFormatProvider(placementAbcdFormat);

export { placementAbcdFormat, roundRobinFormat, singleEliminationFormat };
export { buildPlacementAbcd, type PlacementAbcdInput, type PlacementTierInput } from "./placement-abcd";
export { buildRoundRobin, type RoundRobinInput } from "./round-robin";
export {
  buildSingleElimination,
  nextPowerOfTwo,
  standardSeedOrder,
  type SingleEliminationInput,
} from "./single-elimination";
