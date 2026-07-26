import { MINOR_UNITS_PER_UNIT } from '../types/index.js';

/**
 * Convert a BIGINT-stored minor-unit value (as it comes back from pg, i.e. a
 * string) into a display value by dividing by 100. Returns 0 for falsy input.
 *
 * The plugin stores 1 Denarius = 100 minor units.
 */
export function minorUnitsToDisplay(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const asNumber = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (Number.isNaN(asNumber)) return 0;
  return asNumber / MINOR_UNITS_PER_UNIT;
}
