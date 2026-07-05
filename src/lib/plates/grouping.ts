// Shared plate-grouping primitives.
//
// A "plate" is what can physically share one printer setup: the same filament
// (material + color) AND the same nozzle + plate type. The /plates page and the
// composer MUST agree on how a job maps to a group key, so that logic lives here
// once instead of being duplicated (and silently drifting) between them.

export const DEFAULT_NOZZLE = 0.4;
export const DEFAULT_PLATE = "default";

// Printer-side facts a filament imposes, keyed by material||color. Used to fill
// in a plate's plate type / nozzle needs when the resolved file didn't pin them.
export interface FilamentSpec {
  hex: string | null;
  defaultPlateType: string | null;
  hardened: boolean;
  needsEnclosure: boolean;
}

/** material||color, lowercased. The filament identity half of a plate group. */
export function filamentKey(material: string, color: string): string {
  return `${material.toLowerCase()}||${color.toLowerCase()}`;
}

/** Full plate group key: filament + nozzle + plate type. */
export function plateGroupKey(
  material: string,
  color: string,
  nozzle: number,
  plateType: string,
): string {
  return `${filamentKey(material, color)}||${nozzle}||${plateType.toLowerCase()}`;
}

/** Resolve a job's plate type: the file's pin, else the filament default, else generic. */
export function resolvePlateType(
  filePlateType: string | null | undefined,
  spec: FilamentSpec | undefined,
): string {
  return filePlateType ?? spec?.defaultPlateType ?? DEFAULT_PLATE;
}

/** Resolve a job's nozzle: the file's value, else the shop default. */
export function resolveNozzle(fileNozzle: number | null | undefined): number {
  return fileNozzle ?? DEFAULT_NOZZLE;
}
