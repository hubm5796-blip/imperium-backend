import { MINOR_UNITS_PER_UNIT } from '../types/index.js';

/**
 * Convert a BIGINT-stored currency value (as it comes back from pg, i.e. a
 * string) into a display number. WHOLE-UNIT STORAGE (2026-08-18): the plugin
 * now stores 1 unit = 1 unit (migration V28 divided the old ×100 minor-unit
 * rows once), so MINOR_UNITS_PER_UNIT is 1 and this is a parse/identity shim
 * kept so every reader keeps the same API shape. Returns 0 for falsy input.
 */
export function minorUnitsToDisplay(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const asNumber = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (Number.isNaN(asNumber)) return 0;
  return asNumber / MINOR_UNITS_PER_UNIT;
}
